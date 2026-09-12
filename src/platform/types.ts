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

/** A click request: exactly one of element id or coordinates. */
export interface ClickRequest {
  windowId: number
  elementId?: string
  x?: number
  y?: number
  button: 'left' | 'right'
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
  shot(ref: WindowRef, maxSide: number, signal?: AbortSignal): Promise<Screenshot>
  tree(ref: WindowRef, maxElements: number, maxDepth: number, includePixels: boolean, signal?: AbortSignal): Promise<Tree>
  snapshot(windowId: number, signal?: AbortSignal): Promise<WindowSnapshot>
  click(request: ClickRequest, focusFallback: boolean, signal?: AbortSignal): Promise<ActionOutcome>
  type(request: TypeRequest, focusFallback: boolean, signal?: AbortSignal): Promise<ActionOutcome>
  scroll(request: ScrollRequest, focusFallback: boolean, signal?: AbortSignal): Promise<ActionOutcome>
  key(request: KeyRequest, focusFallback: boolean, signal?: AbortSignal): Promise<ActionOutcome>
  apps(signal?: AbortSignal): Promise<AppInfo[]>
  launch(name: string, args: readonly string[], signal?: AbortSignal): Promise<LaunchOutcome>
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
