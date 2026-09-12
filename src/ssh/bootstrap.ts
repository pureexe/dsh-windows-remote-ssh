/**
 * Bootstraps the native helper onto the remote Windows host. Nothing needs to
 * be pre-installed there: the helper is a single PowerShell script (5.1-safe,
 * ships in this package, no third-party modules) plus a tiny VBScript
 * launcher (see `run-hidden.vbs` — the reason the PowerShell process never
 * flashes a console window onto the user's screen), both staged into the
 * remote user's temp directory over SFTP the first time they're needed.
 * Re-bootstrap is content-addressed — a combined SHA-256 of both scripts is
 * compared against a marker file next to them, so an already-current remote
 * copy is left alone.
 *
 * @module dsh-windows-remote-ssh/ssh/bootstrap
 */

import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RemoteSshError } from '../platform/types.ts'
import type { SshConnectionManager } from './client.ts'
import type { ResolvedSshConfig } from '../config.ts'

/** Where the helper and its launcher are staged on the remote host. */
export interface RemoteLayout {
  remoteWorkdir: string
  helperPath: string
  vbsPath: string
  markerPath: string
}

/** Locate a shipped native asset next to this package, in source or built layout. */
function findLocalAsset(envOverride: string, filename: string): string {
  const override = process.env[envOverride]
  if (override !== undefined && override !== '') return override
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, 'native', 'win32', filename)
    if (existsSync(candidate)) return candidate
    dir = path.dirname(dir)
  }
  throw new RemoteSshError(`cannot locate native/win32/${filename} next to the package`, 'HELPER_MISSING')
}

/** Ensures the helper + launcher are present and current on one connection; caches the result. */
export class RemoteBootstrap {
  private layout: Promise<RemoteLayout> | undefined

  constructor(private readonly ssh: SshConnectionManager, private readonly target: ResolvedSshConfig) {}

  /** Force the next {@link ensure} call to re-stage the helper (e.g. after a HELPER_MISSING failure). */
  reset(): void {
    this.layout = undefined
  }

  /** Ensure the helper + launcher are staged and current on the remote host; returns their remote layout. */
  async ensure(): Promise<RemoteLayout> {
    this.layout ??= this.stage().catch((error: unknown) => {
      this.layout = undefined
      throw error
    })
    return this.layout
  }

  private async stage(): Promise<RemoteLayout> {
    const helperSource = readFileSync(findLocalAsset('DSH_WINDOWS_REMOTE_SSH_HELPER', 'dsh-windows-remote-ssh-helper.ps1'))
    const vbsSource = readFileSync(findLocalAsset('DSH_WINDOWS_REMOTE_SSH_VBS', 'run-hidden.vbs'))
    const hash = createHash('sha256').update(helperSource).update(vbsSource).digest('hex')

    const tempDir = await this.ssh.getRemoteTempDir()
    const remoteWorkdir = `${tempDir}\\${this.target.remoteWorkdir}`
    const helperPath = `${remoteWorkdir}\\helper.ps1`
    const vbsPath = `${remoteWorkdir}\\run-hidden.vbs`
    const markerPath = `${remoteWorkdir}\\helper.sha256`

    await this.ssh.mkdir(remoteWorkdir)

    const current = await this.currentMarker(markerPath)
    if (current !== hash) {
      await this.ssh.writeFile(helperPath, helperSource)
      await this.ssh.writeFile(vbsPath, vbsSource)
      await this.ssh.writeFile(markerPath, hash)
    }

    return { remoteWorkdir, helperPath, vbsPath, markerPath }
  }

  private async currentMarker(markerPath: string): Promise<string | undefined> {
    try {
      const bytes = await this.ssh.readFile(markerPath)
      return bytes.toString('utf8').trim()
    } catch {
      return undefined
    }
  }
}
