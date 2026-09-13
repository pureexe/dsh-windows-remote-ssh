/**
 * The action executor: the safety boundary every mutating action crosses
 * before it reaches the remote Windows host. One shared flow for
 * click/type/scroll/key — re-observe the window over SSH and refuse on
 * staleness, gate through approval (or the allowlist), perform through the
 * backend, verify process identity before/after — plus a separate
 * gate-and-launch flow for `app_launch`. Every decision and outcome lands in
 * the `dsh-windows-remote-ssh/action` session audit event.
 *
 * @module dsh-windows-remote-ssh/actions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type { ResolvedConfig, ResolvedSshConfig } from './config.ts'
import { appendAuditEvent, ACTION_EVENT, type ActionEvent, type ProcessFacts } from './events.ts'
import { ObservationStore, type ObservationRecord } from './observe.ts'
import { sanitizeVisible } from './sanitize.ts'
import { RemoteSshError, type ActionOutcome, type DesktopBackend, type LaunchOutcome, type WindowSnapshot } from './platform/types.ts'

/** Which gate allowed an action, for the audit trail. */
export type ApprovalKind = 'approval' | 'allowlist' | 'none'

/** Approval failure detail, model-readable. */
const APPROVAL_DETAIL: Readonly<Record<string, string>> = {
  rejected: 'rejected by the approval answerer',
  cancelled: 'cancelled while waiting for approval',
  unavailable: 'no approval answerer is available (fail closed)',
}

/** The executor's dependencies, all injected at construction. */
export interface ActionExecutorDeps {
  readonly ctx: Context
  readonly config: ResolvedConfig
  /** Resolves a {@link DesktopBackend} bound to a specific SSH target (the connection pool). */
  readonly getBackend: (target: ResolvedSshConfig) => DesktopBackend
  readonly observations: ObservationStore
}

/** Executes mutating remote-desktop actions behind the full safety boundary. */
export class ActionExecutor {
  constructor(private readonly deps: ActionExecutorDeps) {}

  private get ctx(): Context {
    return this.deps.ctx
  }

  private get config(): ResolvedConfig {
    return this.deps.config
  }

  /** Append one action audit event; a failed append never changes the outcome. */
  private audit(exec: ToolRunContext, event: ActionEvent): void {
    if (!this.config.auditSessionEvents) return
    const session = exec.agent?.session
    if (session === undefined) return
    try {
      appendAuditEvent(session, ACTION_EVENT, event)
    } catch {
      // The tool/result event still logs the model-visible content; the audit
      // append is supplementary and must not flip an action that already ran.
    }
  }

  /**
   * The staleness boundary: resolve the cited observation, re-observe the
   * remote window right now, and compare.
   */
  private async requireFreshWindow(observationId: string, windowId: number, signal: AbortSignal): Promise<{ record: ObservationRecord; fresh: WindowSnapshot }> {
    const record = this.deps.observations.get(observationId)
    if (record === undefined) {
      throw new RemoteSshError(
        `unknown observation "${observationId}" — run screen_read or screen_shot again and cite the returned observationId`,
        'UNKNOWN_OBSERVATION',
      )
    }
    if (record.windowId !== windowId) {
      throw new RemoteSshError(
        `observation ${observationId} belongs to window ${record.windowId}, not ${windowId}`,
        'UNKNOWN_OBSERVATION',
      )
    }
    const fresh = await this.deps.getBackend(record.target).snapshot(windowId, signal)
    const verdict = this.deps.observations.verify(record, fresh)
    if (!verdict.ok) {
      throw new RemoteSshError(
        `${verdict.detail} — run screen_read or screen_shot again before acting`,
        verdict.code,
      )
    }
    return { record, fresh }
  }

  /**
   * The approval gate. Matchers run against the sanitized window title and
   * the executable path; a match skips the ask (still audited as allowlist).
   * With no matcher, a missing approval service or a missing calling agent
   * fails closed; the real approval service is asked otherwise.
   */
  private async gate(
    exec: ToolRunContext,
    toolName: string,
    subject: { title: string | null; executablePath: string | null },
    signal: AbortSignal,
  ): Promise<ApprovalKind> {
    if (!this.config.requireApproval) return 'none'
    const matched = this.config.autoApproveMatchers.some(matcher =>
      (subject.title !== null && matcher.test(subject.title))
      || (subject.executablePath !== null && matcher.test(subject.executablePath)))
    if (matched) return 'allowlist'

    const approval = this.ctx.get('approval') as ApprovalService | undefined
    if (approval === undefined) {
      throw new RemoteSshError(
        'approval is required but the approval service is not mounted — mount @deepseek-ai/dsh-user-approval or allowlist this window',
        'APPROVAL_UNAVAILABLE',
      )
    }
    if (exec.agent === undefined) {
      throw new RemoteSshError('approval is required but no agent owns this call — refusing (fail closed)', 'APPROVAL_UNAVAILABLE')
    }
    const target = subject.title ?? subject.executablePath ?? 'unknown target'
    const outcome = await approval.request({
      agent: exec.agent,
      toolName,
      callId: exec.callId,
      reason: `${toolName} on the remote host at ${sanitizeVisible(target, this.config.maxTextLength)}`,
      signal,
    })
    if (outcome !== 'allowed-once') {
      // A `'rejected'` outcome under session policy `'never'` is not a human
      // (or any answerer) denying this specific action - `dsh-user-approval`
      // documents `'never'` as "never prompt anyone: every ask resolves
      // 'rejected' deterministically" (the CI/unattended lockdown stance).
      // Surface that distinction so "approval denied" doesn't read as this
      // plugin refusing on its own judgment when it's really the session-wide
      // policy auto-rejecting everything.
      const session = exec.agent?.session
      const policyHint = outcome === 'rejected' && session !== undefined && approval.overrideOf(session) === 'never'
        ? ' — the session\'s approval policy is set to "never", which auto-rejects every request without prompting anyone (the deterministic CI/unattended stance, not a per-action denial); switch it back to "ask" to be prompted, or set this plugin\'s own requireApproval: false (or an autoApproveWindows entry) if you want these actions to proceed without any prompt'
        : ''
      throw new RemoteSshError(
        `action denied by approval: ${APPROVAL_DETAIL[outcome] ?? outcome}${policyHint}`,
        'APPROVAL_DENIED',
      )
    }
    return 'approval'
  }

  /** Compare the process identity captured before and after an action. */
  private assertProcessUnchanged(before: ProcessFacts, after: ProcessFacts): void {
    if (before.pid !== after.pid || before.executablePath !== after.executablePath) {
      throw new RemoteSshError(
        `the target process changed during the action (before: pid ${before.pid} ${before.executablePath ?? '?'}; after: pid ${after.pid} ${after.executablePath ?? '?'}) — the action was delivered to a different process identity and must be reviewed`,
        'PROCESS_CHANGED',
      )
    }
  }

  /**
   * Run one window-scoped mutating action through the shared boundary:
   * freshness, approval, perform, process check, audit. `run` is handed the
   * backend already resolved from the cited observation's own target — never
   * whatever target this call happens to be associated with — so an action
   * always replays against the exact host it was observed on.
   */
  async perform(
    toolName: string,
    exec: ToolRunContext,
    observationId: string,
    windowId: number,
    run: (focusFallback: boolean, backend: DesktopBackend) => Promise<ActionOutcome>,
  ): Promise<ActionOutcome> {
    let approved: ApprovalKind = 'none'
    let observationIdAudited: string | undefined
    let windowIdAudited: number | undefined
    try {
      const { record } = await this.requireFreshWindow(observationId, windowId, exec.signal)
      observationIdAudited = observationId
      windowIdAudited = windowId
      approved = await this.gate(exec, toolName, {
        title: record.title,
        executablePath: record.executablePath,
      }, exec.signal)
      const outcome = await run(this.config.focusFallback === 'allow', this.deps.getBackend(record.target))
      this.assertProcessUnchanged(outcome.processBefore, outcome.processAfter)
      this.audit(exec, {
        tool: toolName,
        approved,
        outcome: 'ok',
        observationId: observationIdAudited,
        windowId: windowIdAudited,
        processBefore: outcome.processBefore,
        processAfter: outcome.processAfter,
        ...outcome.restored !== undefined ? { restored: outcome.restored } : {},
        ...outcome.detail !== undefined ? { detail: outcome.detail } : {},
      })
      return outcome
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.audit(exec, {
        tool: toolName,
        approved,
        outcome: 'error',
        ...observationIdAudited !== undefined ? { observationId: observationIdAudited } : {},
        ...windowIdAudited !== undefined ? { windowId: windowIdAudited } : {},
        detail: message,
      })
      throw error
    }
  }

  /**
   * Gate and launch one application on the remote host. No window
   * observation exists yet, so the gate runs against the requested name/path
   * alone and the launch outcome's process facts are the post-identity proof.
   *
   * @param target - the SSH target to launch on (resolved by the tool from
   * its own call argument or the plugin's configured default).
   */
  async launch(exec: ToolRunContext, name: string, args: readonly string[], target: ResolvedSshConfig): Promise<LaunchOutcome> {
    const toolName = 'app_launch'
    let approved: ApprovalKind = 'none'
    try {
      approved = await this.gate(exec, toolName, { title: null, executablePath: name }, exec.signal)
      const outcome = await this.deps.getBackend(target).launch(name, args, exec.signal)
      this.audit(exec, {
        tool: toolName,
        approved,
        outcome: 'ok',
        processAfter: { pid: outcome.processId, executablePath: outcome.executablePath },
        detail: name,
      })
      return outcome
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.audit(exec, { tool: toolName, approved, outcome: 'error', detail: message })
      throw error
    }
  }
}
