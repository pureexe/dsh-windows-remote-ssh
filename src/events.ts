/**
 * Session audit events for dsh-windows-remote-ssh (declaration merging into
 * the harness's `SessionEventMap`) and the adaptive append gate. Both events
 * are log-only; tool arguments and rendered results are already logged by the
 * tool runtime as `tool/call` + `tool/result` — these events carry the facts
 * that exist outside them: remote window identity, process identity, and the
 * approval/outcome audit trail for mutating actions.
 *
 * @module dsh-windows-remote-ssh/events
 */

import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { KNOWN_SESSION_EVENT_TYPES, type Session } from '@deepseek-ai/dsh-session'

/** Process identity facts captured immediately before and after an action. */
export interface ProcessFacts {
  /** Process id owning the target window. */
  pid: number
  /** Executable path, or null when the helper could not read it (permissions). */
  executablePath: string | null
}

/** One image saved into the attachment store by `screen_shot`. */
export interface ObservedImage {
  attachmentId: string
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A screen observation was produced by `screen_shot` or `screen_read` on
     * the remote host — log-only audit. `observationId` is the id later
     * actions cite in `basedOn`.
     */
    'dsh-windows-remote-ssh/observed': {
      observationId: string
      windowId: number
      processId: number
      executablePath: string | null
      windowTitle: string
      elementCount: number
      image?: ObservedImage
    }
    /**
     * A mutating action was gated and executed (or refused) on the remote
     * host — log-only audit.
     */
    'dsh-windows-remote-ssh/action': {
      tool: string
      approved: 'approval' | 'allowlist' | 'none'
      outcome: 'ok' | 'error'
      observationId?: string
      windowId?: number
      processBefore?: ProcessFacts
      processAfter?: ProcessFacts
      restored?: boolean
      detail?: string
    }
  }
}

export const OBSERVED_EVENT = 'dsh-windows-remote-ssh/observed' as const
export const ACTION_EVENT = 'dsh-windows-remote-ssh/action' as const

export type ObservedEvent = {
  observationId: string
  windowId: number
  processId: number
  executablePath: string | null
  windowTitle: string
  elementCount: number
  image?: ObservedImage
}

export type ActionEvent = {
  tool: string
  approved: 'approval' | 'allowlist' | 'none'
  outcome: 'ok' | 'error'
  observationId?: string
  windowId?: number
  processBefore?: ProcessFacts
  processAfter?: ProcessFacts
  restored?: boolean
  detail?: string
}

/** Loose append shape probed at runtime, mirroring the harness's own compatibility gate. */
type AppendProbe = (type: string, data: unknown, options?: { ignorable: true }) => unknown

/**
 * Append one audit event when the host can carry it safely; skip silently
 * otherwise (the tool/call + tool/result events remain the model-visible
 * log, so nothing model-visible is lost).
 *
 * @param session - the calling session.
 * @param type - the audit event type.
 * @param data - the audit payload.
 */
export function appendAuditEvent(
  session: Session,
  type: typeof OBSERVED_EVENT | typeof ACTION_EVENT,
  data: ObservedEvent | ActionEvent,
): void {
  if (KNOWN_SESSION_EVENT_TYPES.has(type)) {
    if (type === OBSERVED_EVENT) session.append(type, data as ObservedEvent)
    else session.append(type, data as ActionEvent)
    return
  }
  const append = session.append as AppendProbe
  if (Function.prototype.toString.call(append).includes('ignorable')) {
    append.call(session, type, data, { ignorable: true })
  }
}
