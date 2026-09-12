/**
 * A persistent, reconnecting SSH connection to the remote Windows host, plus
 * the small set of primitives the platform runner needs on top of it: exec
 * (to invoke `powershell.exe`) and SFTP file transfer (to stage the helper
 * script and exchange per-call request/response files). Using files instead
 * of piping JSON through the exec channel's stdin/stdout sidesteps Windows
 * console code-page and UTF-16/UTF-8 pitfalls entirely — SFTP moves bytes
 * exactly as given.
 *
 * @module dsh-windows-remote-ssh/ssh/client
 */

import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2'
import { RemoteSshError } from '../platform/types.ts'
import type { ResolvedSshConfig } from '../config.ts'

/** The result of one non-interactive remote command. */
export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Owns one SSH connection to one remote host: connects lazily, reuses the
 * live connection across calls, and reconnects transparently after a drop.
 * Concurrent callers awaiting connection share the same in-flight attempt.
 */
export class SshConnectionManager {
  private client: Client | undefined
  private connecting: Promise<Client> | undefined
  private cachedRemoteTemp: Promise<string> | undefined

  constructor(private readonly config: ResolvedSshConfig, private readonly connectTimeoutMs: number) {}

  /** Get the live connection, connecting (or reconnecting) as needed. */
  private async getConnection(): Promise<Client> {
    if (this.client !== undefined) return this.client
    this.connecting ??= this.connect()
    return this.connecting
  }

  private connect(): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client()
      let settled = false
      client.on('ready', () => {
        if (settled) return
        settled = true
        this.client = client
        this.connecting = undefined
        resolve(client)
      })
      client.on('error', (error: Error) => {
        this.client = undefined
        this.connecting = undefined
        if (!settled) {
          settled = true
          reject(new RemoteSshError(`SSH connection to ${this.config.host}:${this.config.port} failed: ${error.message}`, 'SSH_CONNECT_FAILED'))
        }
      })
      client.on('close', () => {
        this.client = undefined
        this.connecting = undefined
      })
      client.connect({
        host: this.config.host,
        port: this.config.port,
        username: this.config.user,
        readyTimeout: this.connectTimeoutMs,
        keepaliveInterval: 15_000,
        ...this.config.password !== undefined ? { password: this.config.password } : {},
        ...this.config.privateKey !== undefined ? { privateKey: this.config.privateKey } : {},
        ...this.config.passphrase !== undefined ? { passphrase: this.config.passphrase } : {},
        ...this.config.strictHostKeyChecking ? {} : { hostVerifier: () => true },
      })
    })
  }

  /**
   * Run one non-interactive remote command to completion.
   *
   * @param command - the full command line (executed by the remote default shell — `cmd.exe` on stock Win32-OpenSSH).
   * @param signal - cancels the command by closing the channel.
   */
  async exec(command: string, signal?: AbortSignal): Promise<ExecResult> {
    const client = await this.getConnection()
    return new Promise<ExecResult>((resolve, reject) => {
      client.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          reject(new RemoteSshError(`SSH exec failed: ${err.message}`, 'SSH_EXEC_FAILED'))
          return
        }
        let stdout = ''
        let stderr = ''
        const onAbort = (): void => {
          stream.destroy()
          reject(new RemoteSshError('remote command aborted', 'ABORTED'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        stream.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
        stream.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
        stream.on('close', (code: number | null) => {
          signal?.removeEventListener('abort', onAbort)
          resolve({ code, stdout, stderr })
        })
        stream.on('error', (streamErr: Error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(new RemoteSshError(`SSH channel error: ${streamErr.message}`, 'SSH_EXEC_FAILED'))
        })
      })
    })
  }

  /** Open a fresh SFTP subsystem channel (not cached: cheap, and avoids sharing state across calls). */
  private async sftp(): Promise<SFTPWrapper> {
    const client = await this.getConnection()
    return new Promise((resolve, reject) => {
      client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) reject(new RemoteSshError(`SFTP channel failed: ${err.message}`, 'SFTP_FAILED'))
        else resolve(sftp)
      })
    })
  }

  /** Write a file's exact bytes to the remote host over SFTP. */
  async writeFile(remotePath: string, data: Buffer | string): Promise<void> {
    const sftp = await this.sftp()
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(remotePath, data, (err?: Error | null) => {
        sftp.end()
        if (err) reject(new RemoteSshError(`writing ${remotePath} over SFTP failed: ${err.message}`, 'SFTP_FAILED'))
        else resolve()
      })
    })
  }

  /** Read a file's exact bytes back from the remote host over SFTP. */
  async readFile(remotePath: string): Promise<Buffer> {
    const sftp = await this.sftp()
    return new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(remotePath, (err: Error | undefined, handle: Buffer) => {
        sftp.end()
        if (err) reject(new RemoteSshError(`reading ${remotePath} over SFTP failed: ${err.message}`, 'SFTP_FAILED'))
        else resolve(handle)
      })
    })
  }

  /**
   * Create a remote directory; a failure that turns out to mean "it's
   * already there" is not an error. Windows OpenSSH's SFTP server reports
   * that case as a bare, generic "Failure" status (not a distinguishable
   * "already exists" message), so on any mkdir failure this stats the path
   * and only raises when it genuinely isn't a directory.
   */
  async mkdir(remotePath: string): Promise<void> {
    const sftp = await this.sftp()
    const mkdirError = await new Promise<Error | undefined>((resolve) => {
      sftp.mkdir(remotePath, (err?: Error | null) => { resolve(err ?? undefined) })
    })
    if (mkdirError === undefined) { sftp.end(); return }
    const stats = await new Promise<import('ssh2').Stats | undefined>((resolve) => {
      sftp.stat(remotePath, (statErr, result) => { resolve(statErr ? undefined : result) })
    })
    sftp.end()
    if (stats?.isDirectory() === true) return
    throw new RemoteSshError(`creating remote directory ${remotePath} failed: ${mkdirError.message}`, 'SFTP_FAILED')
  }

  /** Best-effort remote file deletion; failures are swallowed (cleanup only). */
  async unlink(remotePath: string): Promise<void> {
    try {
      const sftp = await this.sftp()
      await new Promise<void>((resolve) => {
        sftp.unlink(remotePath, () => { sftp.end(); resolve() })
      })
    } catch {
      // Best-effort cleanup; a leftover temp file does not affect correctness.
    }
  }

  /**
   * Discover the connected user's writable temp directory on the remote host
   * (`%TEMP%`), cached for the lifetime of this connection. Using the user's
   * own profile temp dir (rather than a hardcoded path) avoids permission
   * surprises across differently-configured hosts.
   */
  async getRemoteTempDir(): Promise<string> {
    this.cachedRemoteTemp ??= this.exec('cmd.exe /c echo %TEMP%').then((result) => {
      const dir = result.stdout.trim()
      if (result.code !== 0 || dir === '' || dir === '%TEMP%') {
        throw new RemoteSshError('could not discover the remote %TEMP% directory', 'SSH_BOOTSTRAP_FAILED')
      }
      return dir
    }).catch((error: unknown) => {
      this.cachedRemoteTemp = undefined
      throw error
    })
    return this.cachedRemoteTemp
  }

  /** Close the connection (idempotent). */
  close(): void {
    this.client?.end()
    this.client = undefined
    this.connecting = undefined
    this.cachedRemoteTemp = undefined
  }
}
