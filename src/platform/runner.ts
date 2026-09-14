/**
 * The SSH backend: every operation stages a JSON request file on the remote
 * host over SFTP, runs the native PowerShell helper once (one request = one
 * process, matching the local `dsh-click` design this plugin adapts), and
 * reads the JSON response file back over SFTP. File-based exchange (rather
 * than piping through the exec channel's stdin/stdout) sidesteps Windows
 * console code-page and encoding pitfalls; each call is deadline-bounded
 * (config `helperTimeoutMs`) and aborts with the caller's signal.
 *
 * @module dsh-windows-remote-ssh/platform/runner
 */

import { randomUUID } from 'node:crypto'
import type { ResolvedConfig, ResolvedSshConfig } from '../config.ts'
import { HELPER_PROTOCOL_VERSION, VERSION } from '../version.ts'
import { RemoteBootstrap } from '../ssh/bootstrap.ts'
import { SshConnectionManager } from '../ssh/client.ts'
import {
  RemoteSshError,
  expectNumber,
  expectProcessFacts,
  expectRecordValue,
  expectString,
  type ActionOutcome,
  type AppInfo,
  type CaptureOptions,
  type ClickRequest,
  type CursorPosition,
  type DesktopBackend,
  type DisplayInfo,
  type ElementInfo,
  type HelperRequest,
  type HelperResponse,
  type InvokePatternRequest,
  type KeyRequest,
  type LaunchOutcome,
  type MoveRequest,
  type PowerShellOutcome,
  type PixelHint,
  type ProcessInfo,
  type ProcessKillRequest,
  type Rect,
  type Screenshot,
  type ScrollRequest,
  type TableReadResult,
  type TextReadResult,
  type Tree,
  type WindowControlRequest,
  type WindowInfo,
  type WindowRef,
  type WindowSnapshot,
  type TypeRequest,
} from './types.ts'

/** Resolve after `ms`, or immediately once `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

/** Validate a helper rect at the wire boundary. */
function expectRect(value: unknown, op: string): Rect {
  const record = expectRecordValue(value, op)
  return {
    x: expectNumber(record, 'x', op),
    y: expectNumber(record, 'y', op),
    width: expectNumber(record, 'width', op),
    height: expectNumber(record, 'height', op),
  }
}

function expectCursorPosition(value: unknown, op: string): CursorPosition {
  const record = expectRecordValue(value, op)
  return {
    x: expectNumber(record, 'x', op),
    y: expectNumber(record, 'y', op),
  }
}

/** Validate one helper window record. */
function expectWindow(value: unknown, op: string): WindowInfo {
  const record = expectRecordValue(value, op)
  const processIdRaw = record['processId']
  const processId = typeof processIdRaw === 'number' ? processIdRaw : null
  const executablePath = record['executablePath']
  if (executablePath !== null && typeof executablePath !== 'string') {
    throw new RemoteSshError(`helper "${op}" returned malformed executablePath`, 'BAD_HELPER_RESPONSE')
  }
  return {
    windowId: expectNumber(record, 'windowId', op),
    processId,
    title: expectString(record, 'title', op),
    className: expectString(record, 'className', op),
    rect: expectRect(record['rect'], op),
    executablePath,
    visible: record['visible'] !== false,
    minimized: record['minimized'] === true,
    maximized: record['maximized'] === true,
  }
}

/** Validate one helper display record. */
function expectDisplay(value: unknown, op: string): DisplayInfo {
  const record = expectRecordValue(value, op)
  return {
    index: expectNumber(record, 'index', op),
    rect: expectRect(record['rect'], op),
    primary: record['primary'] === true,
  }
}

/** Validate one helper process record. */
function expectProcess(value: unknown, op: string): ProcessInfo {
  const record = expectRecordValue(value, op)
  const executablePath = record['executablePath']
  if (executablePath !== null && typeof executablePath !== 'string') {
    throw new RemoteSshError(`helper "${op}" returned malformed executablePath`, 'BAD_HELPER_RESPONSE')
  }
  const mainWindowTitle = record['mainWindowTitle']
  if (mainWindowTitle !== null && typeof mainWindowTitle !== 'string') {
    throw new RemoteSshError(`helper "${op}" returned malformed mainWindowTitle`, 'BAD_HELPER_RESPONSE')
  }
  return {
    pid: expectNumber(record, 'pid', op),
    name: expectString(record, 'name', op),
    executablePath,
    mainWindowTitle,
  }
}

/** Validate one helper snapshot record. */
function expectSnapshot(value: unknown, op: string): WindowSnapshot {
  const record = expectRecordValue(value, op)
  const executablePath = record['executablePath']
  if (executablePath !== null && typeof executablePath !== 'string') {
    throw new RemoteSshError(`helper "${op}" returned malformed executablePath`, 'BAD_HELPER_RESPONSE')
  }
  return {
    windowId: expectNumber(record, 'windowId', op),
    processId: expectNumber(record, 'processId', op),
    executablePath,
    title: expectString(record, 'title', op),
    className: expectString(record, 'className', op),
    rect: expectRect(record['rect'], op),
    foreground: record['foreground'] === true,
    treeHash: expectString(record, 'treeHash', op),
    shotHash: expectString(record, 'shotHash', op),
    elementCount: expectNumber(record, 'elementCount', op),
  }
}

/** Validate one helper element record. */
function expectElement(value: unknown, op: string): ElementInfo {
  const record = expectRecordValue(value, op)
  const patterns = record['patterns']
  if (!Array.isArray(patterns) || patterns.some(item => typeof item !== 'string')) {
    throw new RemoteSshError(`helper "${op}" returned malformed element patterns`, 'BAD_HELPER_RESPONSE')
  }
  return {
    elementId: expectString(record, 'elementId', op),
    controlType: expectString(record, 'controlType', op),
    name: expectString(record, 'name', op),
    automationId: expectString(record, 'automationId', op),
    rect: expectRect(record['rect'], op),
    enabled: record['enabled'] === true,
    patterns: patterns as string[],
  }
}

/** Validate one helper pixel hint. */
function expectPixel(value: unknown, op: string): PixelHint {
  const record = expectRecordValue(value, op)
  return {
    label: expectString(record, 'label', op),
    x: expectNumber(record, 'x', op),
    y: expectNumber(record, 'y', op),
    color: expectString(record, 'color', op),
  }
}

/** Validate one helper action outcome. */
function expectActionOutcome(value: unknown, op: string): ActionOutcome {
  const record = expectRecordValue(value, op)
  const delivered = expectString(record, 'delivered', op)
  if (delivered !== 'uia' && delivered !== 'posted' && delivered !== 'hardware' && delivered !== 'none') {
    throw new RemoteSshError(`helper "${op}" returned an unknown delivered mechanism`, 'BAD_HELPER_RESPONSE')
  }
  const restored = record['restored']
  if (restored !== undefined && typeof restored !== 'boolean') {
    throw new RemoteSshError(`helper "${op}" returned a non-boolean restored flag`, 'BAD_HELPER_RESPONSE')
  }
  const detail = record['detail']
  if (detail !== undefined && typeof detail !== 'string') {
    throw new RemoteSshError(`helper "${op}" returned a non-string detail`, 'BAD_HELPER_RESPONSE')
  }
  return {
    windowId: expectNumber(record, 'windowId', op),
    action: expectString(record, 'action', op),
    delivered,
    processBefore: expectProcessFacts(record['processBefore'], op),
    processAfter: expectProcessFacts(record['processAfter'], op),
    ...restored !== undefined ? { restored } : {},
    ...detail !== undefined ? { detail } : {},
  }
}

/** Validate one helper `read_text` result. */
function expectTextReadResult(value: unknown, op: string): TextReadResult {
  const record = expectRecordValue(value, op)
  const text = expectString(record, 'text', op)
  const selectionText = record['selectionText']
  if (selectionText !== undefined && typeof selectionText !== 'string') {
    throw new RemoteSshError(`helper "${op}" returned a non-string selectionText`, 'BAD_HELPER_RESPONSE')
  }
  return {
    text,
    truncated: record['truncated'] === true,
    ...selectionText !== undefined ? { selectionText } : {},
  }
}

/** Validate one helper `read_table` result. */
function expectTableReadResult(value: unknown, op: string): TableReadResult {
  const record = expectRecordValue(value, op)
  const cellsRaw = record['cells']
  if (!Array.isArray(cellsRaw) || cellsRaw.some(row => !Array.isArray(row) || row.some(cell => typeof cell !== 'string'))) {
    throw new RemoteSshError(`helper "${op}" returned malformed cells`, 'BAD_HELPER_RESPONSE')
  }
  const columnHeadersRaw = record['columnHeaders']
  let columnHeaders: string[] | undefined
  if (columnHeadersRaw !== undefined) {
    if (!Array.isArray(columnHeadersRaw) || columnHeadersRaw.some(item => typeof item !== 'string')) {
      throw new RemoteSshError(`helper "${op}" returned malformed columnHeaders`, 'BAD_HELPER_RESPONSE')
    }
    columnHeaders = columnHeadersRaw as string[]
  }
  return {
    rowCount: expectNumber(record, 'rowCount', op),
    columnCount: expectNumber(record, 'columnCount', op),
    truncated: record['truncated'] === true,
    cells: cellsRaw as string[][],
    ...columnHeaders !== undefined ? { columnHeaders } : {},
  }
}

/** One pooled connection: an SSH session plus the helper staged on it. */
interface PoolEntry {
  ssh: SshConnectionManager
  bootstrap: RemoteBootstrap
}

/** Canonical key identifying one remote target, for the connection pool. */
function targetKey(target: ResolvedSshConfig): string {
  return `${target.user}@${target.host}:${target.port}`
}

/**
 * Owns one SSH connection pool — keyed by (user, host, port) — and hands out
 * a {@link DesktopBackend} bound to any given target via {@link getBackend}.
 * A pool (rather than one fixed connection) exists because the SSH target
 * isn't always known until a tool call runs: `screen_shot`/`screen_read`/
 * `app_list`/`app_launch` accept a per-call `ssh` override (see
 * `resolveSshTarget` in `../config.ts`) for deployments with no static
 * `config.ssh` default, and a single conversation could legitimately address
 * more than one remote host.
 */
export class SshHelperBackend {
  private readonly connections = new Map<string, PoolEntry>()

  constructor(private readonly config: ResolvedConfig) {}

  /** Get (or lazily create) the pooled connection for one target. */
  private connectionFor(target: ResolvedSshConfig): PoolEntry {
    const key = targetKey(target)
    let entry = this.connections.get(key)
    if (entry === undefined) {
      const ssh = new SshConnectionManager(target, this.config.connectTimeoutMs)
      entry = { ssh, bootstrap: new RemoteBootstrap(ssh, target) }
      this.connections.set(key, entry)
    }
    return entry
  }

  /** A {@link DesktopBackend} bound to one resolved SSH target. */
  getBackend(target: ResolvedSshConfig): DesktopBackend {
    return new TargetedBackend(this, target, this.config)
  }

  /** Close every pooled connection. Safe to call even if none ever connected. */
  close(): void {
    for (const entry of this.connections.values()) entry.ssh.close()
    this.connections.clear()
  }

  /**
   * Run one helper operation end-to-end against one target and return its
   * validated result payload.
   *
   * A plain SSH exec is not enough: Win32-OpenSSH runs exec'd commands for a
   * standard authenticated session in a non-interactive Session 0 / window
   * station, completely isolated from the interactive desktop (Session 1,
   * where the user's windows actually live) — `EnumWindows`, UI Automation,
   * and screen capture all come back empty from there even though the
   * process itself runs fine. So instead of executing the helper directly,
   * this schedules it as a one-shot Scheduled Task bound to the connected
   * user with `/IT` ("only when logged on", i.e. attach to their interactive
   * session), triggers it immediately, and polls for the response file the
   * task writes — the standard workaround for driving a Windows GUI over
   * plain SSH.
   */
  /**
   * @param minWaitMs - floor on how long to poll for the response, when this
   * particular call is allowed to take longer than the general
   * `config.helperTimeoutMs` budget (currently only `powershell`, whose
   * script gets its own, separately configurable `timeoutMs` that can
   * legitimately exceed `helperTimeoutMs` - without this, a script that
   * takes, say, 45s but was given a 60s allowance would still be cut off by
   * the generic 30s default, even though the helper itself was never going
   * to give up on it that early).
   */
  async invoke(target: ResolvedSshConfig, op: string, args: Record<string, unknown>, signal?: AbortSignal, minWaitMs?: number): Promise<unknown> {
    const { ssh, bootstrap } = this.connectionFor(target)
    const layout = await bootstrap.ensure()
    const requestId = randomUUID()
    // A short id for the on-disk file names and the task's /TR command line:
    // that line is capped at 261 characters by schtasks itself, and it
    // already has to carry the full helper path, so every other token on it
    // stays as small as possible.
    const shortId = requestId.replaceAll('-', '').slice(0, 12)
    const reqPath = `${layout.remoteWorkdir}\\req-${shortId}.json`
    const respPath = `${layout.remoteWorkdir}\\resp-${shortId}.json`
    const cmdPath = `${layout.remoteWorkdir}\\run-${shortId}.cmd`
    const taskName = `dsh-windows-remote-ssh-${requestId}`
    const request: HelperRequest = {
      protocol: HELPER_PROTOCOL_VERSION,
      pluginVersion: VERSION,
      requestId,
      op,
      args,
    }

    const deadline = AbortSignal.timeout(Math.max(this.config.helperTimeoutMs, minWaitMs ?? 0))
    const fused = signal === undefined ? deadline : AbortSignal.any([signal, deadline])

    const cleanup = (): void => {
      void ssh.unlink(reqPath)
      void ssh.unlink(respPath)
      void ssh.unlink(cmdPath)
      void this.deleteTaskWithRetry(ssh, taskName)
    }

    await ssh.writeFile(reqPath, JSON.stringify(request))
    // A per-call .cmd file carries the real, normally-double-quoted
    // PowerShell invocation, so the /TR command line below never has to
    // nest quotes: it just names this file. "-Dir"/"-Id" (not full
    // request/response paths) is what keeps that file itself short — every
    // full path is reconstructed by the helper from $env:TEMP + Dir + Id
    // once it's actually running remotely.
    const helperCommand = `@echo off\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${layout.helperPath}" -Dir "${target.remoteWorkdir}" -Id "${shortId}"\r\n`
    await ssh.writeFile(cmdPath, helperCommand)
    // wscript.exe + run-hidden.vbs (WScript.Shell.Run with window style 0)
    // is the reliable way to run this with truly no visible window: unlike
    // "powershell.exe -WindowStyle Hidden", it has no race where a console
    // flashes on screen before the hidden style takes effect — this task
    // runs in the connected user's real interactive session, so a visible
    // console would pop up, steal a taskbar slot, and show up in
    // screen_shot.
    const taskCommand = `wscript.exe //B "${layout.vbsPath}" "${cmdPath}"`
    const createCommand = `schtasks /Create /TN "${taskName}" /SC ONCE /ST 23:59 /RU "${target.user}" /IT /RL HIGHEST /F /TR "${taskCommand}"`

    let createResult: Awaited<ReturnType<SshConnectionManager['exec']>>
    try {
      createResult = await ssh.exec(createCommand, fused)
    } catch (error: unknown) {
      cleanup()
      throw error
    }
    if (createResult.code !== 0) {
      cleanup()
      throw new RemoteSshError(
        `could not schedule the helper task: ${(createResult.stderr || createResult.stdout).trim()}`,
        'SCHEDULE_FAILED',
      )
    }

    let runResult: Awaited<ReturnType<SshConnectionManager['exec']>>
    try {
      runResult = await ssh.exec(`schtasks /Run /TN "${taskName}"`, fused)
    } catch (error: unknown) {
      cleanup()
      throw error
    }
    if (runResult.code !== 0) {
      cleanup()
      throw new RemoteSshError(
        `could not start the helper task: ${(runResult.stderr || runResult.stdout).trim()}`,
        'SCHEDULE_FAILED',
      )
    }

    let responseText: string
    try {
      responseText = (await this.pollForResponse(ssh, respPath, fused)).toString('utf8')
    } catch (error: unknown) {
      cleanup()
      // The response never showed up — re-stage the helper next call in case
      // it (or its containing directory) was removed from under us.
      bootstrap.reset()
      const message = error instanceof Error ? error.message : String(error)
      throw new RemoteSshError(`helper "${op}" produced no response before the deadline: ${message}`, 'HELPER_TIMEOUT')
    }
    cleanup()

    let response: HelperResponse
    try {
      response = JSON.parse(responseText) as HelperResponse
    } catch {
      throw new RemoteSshError(`helper "${op}" produced malformed JSON`, 'BAD_HELPER_RESPONSE')
    }
    if (typeof response !== 'object' || response === null || typeof response.ok !== 'boolean') {
      throw new RemoteSshError(`helper "${op}" returned a malformed response envelope`, 'BAD_HELPER_RESPONSE')
    }
    if (!response.ok) {
      const error = response.error
      if (typeof error !== 'object' || error === null
        || typeof error.code !== 'string' || typeof error.message !== 'string') {
        throw new RemoteSshError(`helper "${op}" returned a malformed error envelope`, 'BAD_HELPER_RESPONSE')
      }
      throw new RemoteSshError(`helper "${op}": ${error.message}`, error.code)
    }
    return response.result
  }

  /**
   * Delete the scheduled task, retrying briefly: right after the response
   * file appears, Task Scheduler can still report the task instance as
   * "Running" for a moment, and refuses `/Delete` until it settles — a
   * best-effort single attempt would silently leave the task behind fairly
   * often. This never throws; a task that still can't be deleted after every
   * retry is orphaned (harmless — it never fires again) rather than failing
   * the call that already returned a result.
   */
  private async deleteTaskWithRetry(ssh: SshConnectionManager, taskName: string, attempts = 5, delayMs = 300): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const result = await ssh.exec(`schtasks /Delete /TN "${taskName}" /F`)
        if (result.code === 0) return
      } catch {
        // fall through to retry
      }
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }

  /** Poll for the helper's response file to appear, respecting `signal`. */
  private async pollForResponse(ssh: SshConnectionManager, respPath: string, signal: AbortSignal, pollIntervalMs = 400): Promise<Buffer> {
    for (;;) {
      try {
        return await ssh.readFile(respPath)
      } catch (error: unknown) {
        if (signal.aborted) {
          throw error instanceof Error ? error : new Error(String(error))
        }
        await sleep(pollIntervalMs, signal)
      }
    }
  }

  /**
   * Download one file's exact bytes over SFTP. Plain file I/O — no helper,
   * no Scheduled Task, since SFTP doesn't need the interactive session. Stats
   * the file first and refuses outright over `maxFilesystemTransferBytes`
   * rather than reading a potentially huge file just to reject it after.
   */
  async pullFile(target: ResolvedSshConfig, remotePath: string): Promise<Buffer> {
    const { ssh } = this.connectionFor(target)
    const size = await ssh.statSize(remotePath)
    if (size > this.config.maxFilesystemTransferBytes) {
      throw new RemoteSshError(
        `${remotePath} is ${size} bytes, over the maxFilesystemTransferBytes cap (${this.config.maxFilesystemTransferBytes})`,
        'FILE_TOO_LARGE',
      )
    }
    return ssh.readFile(remotePath)
  }

  /**
   * Upload exact bytes to one remote path over SFTP, optionally creating
   * missing parent directories first. Refuses outright over
   * `maxFilesystemTransferBytes` — truncating would just corrupt the upload.
   */
  async pushFile(target: ResolvedSshConfig, remotePath: string, data: Buffer, createDirectories: boolean): Promise<{ bytesWritten: number }> {
    if (data.length > this.config.maxFilesystemTransferBytes) {
      throw new RemoteSshError(
        `refusing to write ${data.length} bytes to ${remotePath}: over the maxFilesystemTransferBytes cap (${this.config.maxFilesystemTransferBytes})`,
        'FILE_TOO_LARGE',
      )
    }
    const { ssh } = this.connectionFor(target)
    if (createDirectories) {
      const dir = remotePath.slice(0, Math.max(remotePath.lastIndexOf('\\'), remotePath.lastIndexOf('/')))
      if (dir.length > 0) await ssh.ensureRemoteDir(dir)
    }
    await ssh.writeFile(remotePath, data)
    return { bytesWritten: data.length }
  }
}

/** A {@link DesktopBackend} bound to one resolved SSH target, backed by a shared {@link SshHelperBackend} pool. */
class TargetedBackend implements DesktopBackend {
  readonly available = true
  readonly platform = 'win32 (remote via ssh)'

  constructor(
    private readonly pool: SshHelperBackend,
    private readonly target: ResolvedSshConfig,
    private readonly config: ResolvedConfig,
  ) {}

  async listWindows(signal?: AbortSignal): Promise<WindowInfo[]> {
    const result = await this.pool.invoke(this.target, 'windows', {}, signal)
    if (!Array.isArray(result)) throw new RemoteSshError('helper "windows" returned a non-array result', 'BAD_HELPER_RESPONSE')
    return result.map(item => expectWindow(item, 'windows'))
  }

  async shot(ref: WindowRef, maxSide: number, wholeScreen: boolean, capture?: CaptureOptions, signal?: AbortSignal): Promise<Screenshot> {
    const result = await this.pool.invoke(this.target, 'shot', {
      target: ref,
      maxSide,
      wholeScreen,
      maxElements: this.config.maxElements,
      maxDepth: this.config.maxTreeDepth,
      ...capture?.region !== undefined ? { region: capture.region } : {},
      ...capture?.display !== undefined ? { display: capture.display } : {},
    }, signal)
    const record = expectRecordValue(result, 'shot')
    return {
      pngBase64: expectString(record, 'pngBase64', 'shot'),
      width: expectNumber(record, 'width', 'shot'),
      height: expectNumber(record, 'height', 'shot'),
      snapshot: expectSnapshot(record['snapshot'], 'shot'),
    }
  }

  async tree(ref: WindowRef, maxElements: number, maxDepth: number, includePixels: boolean, signal?: AbortSignal): Promise<Tree> {
    const result = await this.pool.invoke(this.target, 'tree', { target: ref, maxElements, maxDepth, includePixels }, signal)
    const record = expectRecordValue(result, 'tree')
    const elements = record['elements']
    const pixels = record['pixels']
    if (!Array.isArray(elements) || !Array.isArray(pixels)) {
      throw new RemoteSshError('helper "tree" returned malformed elements/pixels arrays', 'BAD_HELPER_RESPONSE')
    }
    return {
      snapshot: expectSnapshot(record['snapshot'], 'tree'),
      elements: elements.map(item => expectElement(item, 'tree')),
      pixels: pixels.map(item => expectPixel(item, 'tree')),
    }
  }

  async snapshot(windowId: number, signal?: AbortSignal): Promise<WindowSnapshot> {
    const result = await this.pool.invoke(this.target, 'snapshot', {
      windowId,
      maxElements: this.config.maxElements,
      maxDepth: this.config.maxTreeDepth,
    }, signal)
    return expectSnapshot(result, 'snapshot')
  }

  async click(request: ClickRequest, focusFallback: boolean, signal?: AbortSignal): Promise<ActionOutcome> {
    const result = await this.pool.invoke(this.target, 'click', { request, focusFallback }, signal)
    return expectActionOutcome(result, 'click')
  }

  async type(request: TypeRequest, focusFallback: boolean, signal?: AbortSignal): Promise<ActionOutcome> {
    const result = await this.pool.invoke(this.target, 'type', { request, focusFallback }, signal)
    return expectActionOutcome(result, 'type')
  }

  async scroll(request: ScrollRequest, focusFallback: boolean, signal?: AbortSignal): Promise<ActionOutcome> {
    const result = await this.pool.invoke(this.target, 'scroll', { request, focusFallback }, signal)
    return expectActionOutcome(result, 'scroll')
  }

  async key(request: KeyRequest, focusFallback: boolean, signal?: AbortSignal): Promise<ActionOutcome> {
    const result = await this.pool.invoke(this.target, 'key', { request, focusFallback }, signal)
    return expectActionOutcome(result, 'key')
  }

  async move(request: MoveRequest, focusFallback: boolean, signal?: AbortSignal): Promise<ActionOutcome> {
    const result = await this.pool.invoke(this.target, 'move', { request, focusFallback }, signal)
    return expectActionOutcome(result, 'move')
  }

  async windowControl(request: WindowControlRequest, focusFallback: boolean, signal?: AbortSignal): Promise<ActionOutcome> {
    const result = await this.pool.invoke(this.target, 'windowControl', { request, focusFallback }, signal)
    return expectActionOutcome(result, 'windowControl')
  }

  async invokePattern(request: InvokePatternRequest, focusFallback: boolean, signal?: AbortSignal): Promise<ActionOutcome> {
    const result = await this.pool.invoke(this.target, 'invokePattern', { request, focusFallback }, signal)
    return expectActionOutcome(result, 'invokePattern')
  }

  async readText(windowId: number, elementId: string, signal?: AbortSignal): Promise<TextReadResult> {
    const result = await this.pool.invoke(this.target, 'readText', { windowId, elementId, maxLength: this.config.maxReadTextLength }, signal)
    return expectTextReadResult(result, 'readText')
  }

  async readTable(windowId: number, elementId: string, signal?: AbortSignal): Promise<TableReadResult> {
    const result = await this.pool.invoke(this.target, 'readTable', { windowId, elementId, maxCells: this.config.maxTableCells }, signal)
    return expectTableReadResult(result, 'readTable')
  }

  async apps(signal?: AbortSignal): Promise<AppInfo[]> {
    const result = await this.pool.invoke(this.target, 'apps', {}, signal)
    if (!Array.isArray(result)) throw new RemoteSshError('helper "apps" returned a non-array result', 'BAD_HELPER_RESPONSE')
    return result.map((item) => {
      const record = expectRecordValue(item, 'apps')
      const windows = record['windows']
      if (!Array.isArray(windows)) throw new RemoteSshError('helper "apps" returned malformed windows', 'BAD_HELPER_RESPONSE')
      const executablePath = record['executablePath']
      if (executablePath !== null && typeof executablePath !== 'string') {
        throw new RemoteSshError('helper "apps" returned malformed executablePath', 'BAD_HELPER_RESPONSE')
      }
      return {
        processId: expectNumber(record, 'processId', 'apps'),
        name: expectString(record, 'name', 'apps'),
        executablePath,
        windows: windows.map(windowInfo => expectWindow(windowInfo, 'apps')),
      }
    })
  }

  async launch(name: string, args: readonly string[], signal?: AbortSignal): Promise<LaunchOutcome> {
    const result = await this.pool.invoke(this.target, 'launch', { name, args }, signal)
    const record = expectRecordValue(result, 'launch')
    const executablePath = record['executablePath']
    if (executablePath !== null && typeof executablePath !== 'string') {
      throw new RemoteSshError('helper "launch" returned malformed executablePath', 'BAD_HELPER_RESPONSE')
    }
    return {
      processId: expectNumber(record, 'processId', 'launch'),
      executablePath,
    }
  }

  async powershell(script: string, timeoutMs: number, signal?: AbortSignal): Promise<PowerShellOutcome> {
    // The response can't show up before the helper's own script timeout
    // elapses (plus the time to actually kill/collect it) - poll at least
    // that long, not just the generic helperTimeoutMs.
    const minWaitMs = timeoutMs + 15_000
    const result = await this.pool.invoke(this.target, 'powershell', {
      script,
      timeoutMs,
      maxOutputLength: this.config.maxPowerShellOutputLength,
    }, signal, minWaitMs)
    const record = expectRecordValue(result, 'powershell')
    return {
      exitCode: expectNumber(record, 'exitCode', 'powershell'),
      stdout: expectString(record, 'stdout', 'powershell'),
      stderr: expectString(record, 'stderr', 'powershell'),
      truncated: record['truncated'] === true,
    }
  }

  async pullFile(remotePath: string): Promise<Buffer> {
    return this.pool.pullFile(this.target, remotePath)
  }

  async pushFile(remotePath: string, data: Buffer, createDirectories: boolean): Promise<{ bytesWritten: number }> {
    return this.pool.pushFile(this.target, remotePath, data, createDirectories)
  }

  async clipboardGet(signal?: AbortSignal): Promise<string> {
    const result = await this.pool.invoke(this.target, 'clipboard', { action: 'get' }, signal)
    const record = expectRecordValue(result, 'clipboard')
    return expectString(record, 'text', 'clipboard')
  }

  async clipboardSet(text: string, signal?: AbortSignal): Promise<void> {
    await this.pool.invoke(this.target, 'clipboard', { action: 'set', text }, signal)
  }

  async processList(signal?: AbortSignal): Promise<ProcessInfo[]> {
    const result = await this.pool.invoke(this.target, 'process', { action: 'list' }, signal)
    const record = expectRecordValue(result, 'process')
    const processes = record['processes']
    if (!Array.isArray(processes)) throw new RemoteSshError('helper "process" returned a non-array processes field', 'BAD_HELPER_RESPONSE')
    return processes.map(item => expectProcess(item, 'process'))
  }

  async processKill(request: ProcessKillRequest, signal?: AbortSignal): Promise<{ killedPids: number[] }> {
    const result = await this.pool.invoke(this.target, 'process', { action: 'kill', ...request }, signal)
    const record = expectRecordValue(result, 'process')
    const killedPids = record['killedPids']
    if (!Array.isArray(killedPids) || killedPids.some(item => typeof item !== 'number')) {
      throw new RemoteSshError('helper "process" returned a non-numeric-array killedPids field', 'BAD_HELPER_RESPONSE')
    }
    return { killedPids: killedPids as number[] }
  }

  async displays(signal?: AbortSignal): Promise<DisplayInfo[]> {
    const result = await this.pool.invoke(this.target, 'displays', {}, signal)
    if (!Array.isArray(result)) throw new RemoteSshError('helper "displays" returned a non-array result', 'BAD_HELPER_RESPONSE')
    return result.map(item => expectDisplay(item, 'displays'))
  }

  async notify(title: string, message: string, appId: string, signal?: AbortSignal): Promise<void> {
    await this.pool.invoke(this.target, 'notify', { title, message, appId }, signal)
  }

  async cursorPosition(signal?: AbortSignal): Promise<CursorPosition> {
    const result = await this.pool.invoke(this.target, 'cursorPosition', {}, signal)
    return expectCursorPosition(result, 'cursorPosition')
  }
}
