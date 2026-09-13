/**
 * Wire vocabulary shared by the harness-side backend and the native
 * PowerShell helper running on the remote Windows host. Helper responses are
 * validated against these types at the wire boundary, because they cross both
 * a process trust line and a network (SSH) trust line.
 *
 * @module dsh-windows-remote-ssh/platform/types
 */

import type { ProcessFacts } from '../events.ts'

/** Error with a stable machine-routing code, model-readable message included. */
export class RemoteSshError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'RemoteSshError'
  }
}

/** How a window may be addressed in an observation request. */
export interface WindowRef {
  windowId?: number
  windowTitle?: string
  processId?: number
}

/** Screen-space rectangle, integer pixel coordinates. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** One top-level application window on the remote desktop. */
export interface WindowInfo {
  windowId: number
  processId: number | null
  title: string
  className: string
  rect: Rect
  executablePath: string | null
  visible: boolean
  /** Whether the window is currently minimized (`IsIconic`). */
  minimized: boolean
  /** Whether the window is currently maximized (`IsZoomed`). */
  maximized: boolean
}

/** One accessibility element inside the observed window. */
export interface ElementInfo {
  /** Stable per-instance element id (UI Automation runtime id, dot-joined). */
  elementId: string
  controlType: string
  name: string
  automationId: string
  rect: Rect
  enabled: boolean
  /** Patterns the element supports (value/invoke/scroll/toggle/...), so the model can pick the right action. */
  patterns: string[]
}

/** One pixel-location hint: a labeled point and its observed color. */
export interface PixelHint {
  label: string
  x: number
  y: number
  color: string
}

/** Fresh identity + content hashes for one window, captured at observation time. */
export interface WindowSnapshot {
  windowId: number
  processId: number
  executablePath: string | null
  title: string
  className: string
  rect: Rect
  foreground: boolean
  treeHash: string
  shotHash: string
  elementCount: number
}

/** A captured screenshot plus the snapshot facts it was taken with. */
export interface Screenshot {
  pngBase64: string
  width: number
  height: number
  snapshot: WindowSnapshot
}

/** An accessibility tree read plus pixel hints. */
export interface Tree {
  snapshot: WindowSnapshot
  elements: ElementInfo[]
  pixels: PixelHint[]
}

/** One running desktop application on the remote host. */
export interface AppInfo {
  processId: number
  name: string
  executablePath: string | null
  windows: WindowInfo[]
}

/**
 * How a `click` step should apply UIA's SelectionItem pattern instead of
 * posting a plain click, for list/grid-style multi-selection. Only takes
 * effect when the addressed element actually supports the pattern; falls
 * back to a plain click otherwise.
 */
export type SelectionMode = 'select' | 'add' | 'remove' | 'toggle'

/** A click request: exactly one of element id or coordinates. */
export interface ClickRequest {
  windowId: number
  elementId?: string
  x?: number
  y?: number
  button: 'left' | 'right'
  /** Use the SelectionItem pattern (Select/AddToSelection/RemoveFromSelection) instead of a plain click, when the element supports it. */
  selectionMode?: SelectionMode
}

/** A type request addressed to a value-pattern element. */
export interface TypeRequest {
  windowId: number
  elementId: string
  text: string
  rollback: boolean
}

/** A scroll request. */
export interface ScrollRequest {
  windowId: number
  elementId?: string
  direction: 'up' | 'down' | 'page-up' | 'page-down'
  amount: number
}

/** A key-combination request (e.g. "Ctrl+S", "Enter"). */
export interface KeyRequest {
  windowId: number
  keys: string
}

/**
 * A mouse move (and, when `drag` is given, a drag) request, addressed the
 * same way as `ClickRequest`. Delivered entirely as posted window messages
 * (`WM_MOUSEMOVE`/`WM_LBUTTONDOWN`/`WM_LBUTTONUP`) — the real OS cursor never
 * moves. See the README for the honest limits of posted-message drag (works
 * for controls that react to simple mouse events, e.g. sliders/canvases; NOT
 * real OLE/shell drag-and-drop between windows).
 */
export interface MoveRequest {
  windowId: number
  elementId?: string
  x?: number
  y?: number
  drag?: {
    toX?: number
    toY?: number
    toElementId?: string
  }
}

/**
 * UIA control patterns `invoke` may call directly on the addressed element,
 * instead of posting a synthetic click/keystroke: `'invoke'`
 * (`InvokePattern.Invoke`), `'toggle'` (`TogglePattern.Toggle`),
 * `'expand'`/`'collapse'` (`ExpandCollapsePattern`),
 * `'select'`/`'addToSelection'`/`'removeFromSelection'`
 * (`SelectionItemPattern`), `'scrollIntoView'` (`ScrollItemPattern`),
 * `'setValue'` (`ValuePattern.SetValue`, string), `'setRangeValue'`
 * (`RangeValuePattern.SetValue`, number).
 */
export type UiaPattern =
  | 'invoke'
  | 'toggle'
  | 'expand'
  | 'collapse'
  | 'select'
  | 'addToSelection'
  | 'removeFromSelection'
  | 'scrollIntoView'
  | 'setValue'
  | 'setRangeValue'

/** An `invoke` request: call one UIA control pattern method directly on the addressed element. */
export interface InvokePatternRequest {
  windowId: number
  elementId: string
  pattern: UiaPattern
  /** Required for `'setValue'` (a string) and `'setRangeValue'` (a number); ignored for every other pattern. */
  value?: string | number
}

/**
 * `read_text`'s result: one text/document element's full content via the UIA
 * Text pattern (`TextPattern.DocumentRange.GetText(-1)`), plus its current
 * selection's text, if any (`TextPattern.GetSelection()`).
 */
export interface TextReadResult {
  text: string
  /** True when `text` was cut short at the configured `maxReadTextLength`. */
  truncated: boolean
  selectionText?: string
}

/**
 * `read_table`'s result: structured grid/table cell data via the
 * Grid/GridItem/Table/TableItem patterns.
 */
export interface TableReadResult {
  /** The grid/table's true row count, even when `cells` was capped short of it. */
  rowCount: number
  /** The grid/table's true column count, even when `cells` was capped short of it. */
  columnCount: number
  /** True when `cells` was cut short at the configured `maxTableCells` (a total-cell cap, not per-dimension). */
  truncated: boolean
  /** Column header names via `TablePattern.GetColumnHeaders()`; omitted when the element supports only `GridPattern`, not `TablePattern`. */
  columnHeaders?: string[]
  /** Row-major cell text: each cell's `ValuePattern.Value` when supported, else its `Name`. */
  cells: string[][]
}

/** A window state-change request. `x`/`y` apply to `move`; `width`/`height` apply to `resize`. */
export interface WindowControlRequest {
  windowId: number
  action: 'minimize' | 'maximize' | 'restore' | 'move' | 'resize' | 'close'
  x?: number
  y?: number
  width?: number
  height?: number
}

/** One display/monitor on the remote desktop, from `System.Windows.Forms.Screen.AllScreens`. */
export interface DisplayInfo {
  index: number
  rect: Rect
  primary: boolean
}

/** The real OS cursor's current position, in the same virtual-screen coordinate space as every window `rect` and every display's `rect`. */
export interface CursorPosition {
  x: number
  y: number
}

/** One running process on the remote host. */
export interface ProcessInfo {
  pid: number
  name: string
  executablePath: string | null
  mainWindowTitle: string | null
}

/** A request to kill one or more remote processes, addressed by pid or by name. */
export interface ProcessKillRequest {
  pid?: number
  name?: string
  force?: boolean
}

/** A screen-space rectangle for a region capture, given in absolute screen coordinates. */
export interface CaptureRegion {
  left: number
  top: number
  right: number
  bottom: number
}

/** Extra `shot` capture options layered on top of the existing window/wholeScreen addressing. Both are optional and backward compatible: omitting both behaves exactly as before. */
export interface CaptureOptions {
  /** Capture exactly this screen-space rectangle instead of a window/whole screen. Takes precedence over `display` when both are given. */
  region?: CaptureRegion
  /** With `wholeScreen: true`, capture this monitor's bounds instead of the primary screen. Ignored for a window capture. */
  display?: number
}

/** The settled outcome of one mutating action, as reported by the helper. */
export interface ActionOutcome {
  windowId: number
  action: string
  delivered: 'uia' | 'posted' | 'none'
  processBefore: ProcessFacts
  processAfter: ProcessFacts
  restored?: boolean
  detail?: string
}

/** The settled outcome of an app launch. */
export interface LaunchOutcome {
  processId: number
  executablePath: string | null
}

/** The settled outcome of running an arbitrary PowerShell script on the remote host. */
export interface PowerShellOutcome {
  exitCode: number
  stdout: string
  stderr: string
  /** True when stdout and/or stderr were cut short at `maxPowerShellOutputLength`. */
  truncated: boolean
}

/**
 * The platform abstraction the SSH runner implements. It must never move
 * remote input focus itself; `focusFallback` is the ONLY sanctioned escape
 * hatch and stays `false` unless config `focusFallback: 'allow'`.
 */
export interface DesktopBackend {
  readonly platform: string
  readonly available: boolean
  readonly unavailableReason?: string

  listWindows(signal?: AbortSignal): Promise<WindowInfo[]>
  /**
   * Capture a screenshot. With `wholeScreen: false`, `ref` addresses a
   * specific window, or — when `ref` is empty — the current foreground
   * window (matching {@link tree}'s own no-target behavior). With
   * `wholeScreen: true`, `ref` is ignored and the whole primary screen is
   * captured instead (`windowId: 0`, a sentinel meaning "not one window" —
   * not a valid `basedOn` target for a later action).
   *
   * @param capture - optional region/display capture options (see
   * {@link CaptureOptions}); omitted entirely, behavior is identical to
   * before these existed. A `region` takes precedence over both `ref` and
   * `wholeScreen`; a `display` index only applies when `wholeScreen: true`.
   */
  shot(ref: WindowRef, maxSide: number, wholeScreen: boolean, capture?: CaptureOptions, signal?: AbortSignal): Promise<Screenshot>
  tree(ref: WindowRef, maxElements: number, maxDepth: number, includePixels: boolean, signal?: AbortSignal): Promise<Tree>
  snapshot(windowId: number, signal?: AbortSignal): Promise<WindowSnapshot>
  click(request: ClickRequest, focusFallback: boolean, signal?: AbortSignal): Promise<ActionOutcome>
  type(request: TypeRequest, focusFallback: boolean, signal?: AbortSignal): Promise<ActionOutcome>
  scroll(request: ScrollRequest, focusFallback: boolean, signal?: AbortSignal): Promise<ActionOutcome>
  key(request: KeyRequest, focusFallback: boolean, signal?: AbortSignal): Promise<ActionOutcome>
  /**
   * Move the mouse (and, with `request.drag`, drag) inside the addressed
   * window entirely via posted window messages — the real OS cursor never
   * moves. Honest limits: this reliably works for controls that react to
   * simple mouse-move/button events (sliders, canvases, custom-drawn
   * controls); it is NOT real OLE/shell drag-and-drop (e.g. dragging a file
   * between two Explorer windows), which requires actual `SendInput`-driven
   * drag detection that posted messages cannot trigger.
   */
  move(request: MoveRequest, focusFallback: boolean, signal?: AbortSignal): Promise<ActionOutcome>
  /** Change a window's state: minimize/maximize/restore/move/resize/close. */
  windowControl(request: WindowControlRequest, focusFallback: boolean, signal?: AbortSignal): Promise<ActionOutcome>
  /**
   * Call one UIA control pattern method directly on the addressed element
   * (see {@link UiaPattern}) instead of posting a synthetic click/keystroke —
   * more reliable for controls that react to their real pattern method but
   * ignore posted input. Mutating: gated by approval like `click`/`type`.
   */
  invokePattern(request: InvokePatternRequest, focusFallback: boolean, signal?: AbortSignal): Promise<ActionOutcome>
  /**
   * Read one text/document element's full content and current selection via
   * the UIA Text pattern — richer than the plain `Name`/`Value` already
   * exposed by `screen_read`. Pure observer: never gated.
   */
  readText(windowId: number, elementId: string, signal?: AbortSignal): Promise<TextReadResult>
  /**
   * Read one grid/table element's structured cell data via the
   * Grid/GridItem/Table/TableItem patterns. Pure observer: never gated.
   */
  readTable(windowId: number, elementId: string, signal?: AbortSignal): Promise<TableReadResult>
  apps(signal?: AbortSignal): Promise<AppInfo[]>
  launch(name: string, args: readonly string[], signal?: AbortSignal): Promise<LaunchOutcome>
  /**
   * Run an arbitrary PowerShell script on the remote host with full user
   * privileges, in the same interactive session every other operation runs
   * in (not sandboxed or restricted in any way beyond the account's own
   * permissions). Only available when the plugin config explicitly enables
   * it (`enablePowerShellTool: true`, default off) — this is categorically
   * more powerful than every window-scoped tool and is gated by approval
   * like any other mutating action, but is not scoped to a window at all.
   */
  powershell(script: string, timeoutMs: number, signal?: AbortSignal): Promise<PowerShellOutcome>
  /**
   * Download one file's exact bytes from the remote host over SFTP. Pure
   * file I/O, independent of the Scheduled Task/interactive-session
   * machinery every window-scoped operation needs — SFTP doesn't care about
   * window stations.
   */
  pullFile(remotePath: string, signal?: AbortSignal): Promise<Buffer>
  /**
   * Upload exact bytes to one path on the remote host over SFTP, optionally
   * creating missing parent directories first.
   * @returns the number of bytes written (== `data.length`; included for a stable, explicit result shape).
   */
  pushFile(remotePath: string, data: Buffer, createDirectories: boolean, signal?: AbortSignal): Promise<{ bytesWritten: number }>
  /**
   * Read the remote clipboard's text, in the same interactive session every
   * other operation runs in (clipboard is per-session, so a non-interactive
   * exec would see a different, empty clipboard).
   */
  clipboardGet(signal?: AbortSignal): Promise<string>
  /** Set the remote clipboard's text. Mutating: gated by approval like any other mutating action. */
  clipboardSet(text: string, signal?: AbortSignal): Promise<void>
  /** List every running process on the remote host. Pure observer: never gated. */
  processList(signal?: AbortSignal): Promise<ProcessInfo[]>
  /** Kill one or more remote processes by pid or by name. Mutating: gated by approval. */
  processKill(request: ProcessKillRequest, signal?: AbortSignal): Promise<{ killedPids: number[] }>
  /** Enumerate every monitor on the remote desktop. Pure observer: never gated. */
  displays(signal?: AbortSignal): Promise<DisplayInfo[]>
  /**
   * The real OS cursor's current position. Pure observer: never gated. Not
   * `basedOn`-checked against anything — the cursor moves constantly on its
   * own, so there is no "stale" cursor position to compare against, only a
   * current one.
   */
  cursorPosition(signal?: AbortSignal): Promise<CursorPosition>
  /**
   * Show a real Windows Action Center toast notification (WinRT
   * `ToastNotificationManager`, not a legacy balloon-tip/`NotifyIcon` popup).
   * Mutating: gated by approval like any other mutating action.
   */
  notify(title: string, message: string, appId: string, signal?: AbortSignal): Promise<void>
}

/** The JSON request written to the remote request file for the helper to read. */
export interface HelperRequest {
  protocol: number
  pluginVersion: string
  requestId: string
  op: string
  args: Record<string, unknown>
}

/** The JSON response the helper writes to the remote response file. */
export type HelperResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } }

/** Assert one helper response field is a finite number; throws on violation. */
export function expectNumber(record: Record<string, unknown>, field: string, op: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RemoteSshError(`helper "${op}" returned a non-numeric "${field}" field`, 'BAD_HELPER_RESPONSE')
  }
  return value
}

/** Assert one helper response field is a string; throws on violation. */
export function expectString(record: Record<string, unknown>, field: string, op: string): string {
  const value = record[field]
  if (typeof value !== 'string') {
    throw new RemoteSshError(`helper "${op}" returned a non-string "${field}" field`, 'BAD_HELPER_RESPONSE')
  }
  return value
}

/** Assert one helper response field is a plain record; throws on violation. */
export function expectRecord(record: Record<string, unknown>, field: string, op: string): Record<string, unknown> {
  const value = record[field]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RemoteSshError(`helper "${op}" returned a non-object "${field}" field`, 'BAD_HELPER_RESPONSE')
  }
  return value as Record<string, unknown>
}

/** Assert an entire helper payload is a plain record; throws on violation. */
export function expectRecordValue(value: unknown, op: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RemoteSshError(`helper "${op}" returned a non-object payload`, 'BAD_HELPER_RESPONSE')
  }
  return value as Record<string, unknown>
}

/** Parse the helper's `processBefore`/`processAfter` facts at the wire boundary. */
export function expectProcessFacts(value: unknown, op: string): ProcessFacts {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RemoteSshError(`helper "${op}" returned malformed process facts`, 'BAD_HELPER_RESPONSE')
  }
  const record = value as Record<string, unknown>
  const pid = expectNumber(record, 'pid', op)
  const executablePath = record['executablePath']
  if (executablePath !== null && typeof executablePath !== 'string') {
    throw new RemoteSshError(`helper "${op}" returned malformed process facts`, 'BAD_HELPER_RESPONSE')
  }
  return { pid, executablePath }
}
