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
import { RemoteSshError, type ActionOutcome, type DesktopBackend, type LaunchOutcome, type PowerShellOutcome, type ProcessKillRequest, type WindowSnapshot } from './platform/types.ts'

/** The outcome of one sub-action within a `multi_action` batch. */
export type MultiActionStepOutcome =
  | { ok: true; outcome: ActionOutcome }
  | { ok: false; error: string }

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
  private async requireFreshWindow(observationId: string, windowId: number, signal: AbortSignal, checkTree: boolean): Promise<{ record: ObservationRecord; fresh: WindowSnapshot }> {
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
    const verdict = this.deps.observations.verify(record, fresh, undefined, checkTree)
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
   *
   * @param checkTree - whether the whole-window tree-hash freshness check
   * applies to this call (default true). Pass `false` when the action
   * addresses a specific `elementId`: the helper re-resolves that exact
   * element by its UIA RuntimeId immediately before acting and fails loudly
   * if it's gone, so the coarser tree hash adds no safety there and only
   * false-positives on unrelated live content elsewhere in the window.
   */
  async perform(
    toolName: string,
    exec: ToolRunContext,
    observationId: string,
    windowId: number,
    run: (focusFallback: boolean, backend: DesktopBackend) => Promise<ActionOutcome>,
    checkTree = true,
  ): Promise<ActionOutcome> {
    let approved: ApprovalKind = 'none'
    let observationIdAudited: string | undefined
    let windowIdAudited: number | undefined
    try {
      const { record } = await this.requireFreshWindow(observationId, windowId, exec.signal, checkTree)
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
   * Run a batch of window-scoped mutating sub-actions (`multi_action`)
   * against ONE cited observation, sequentially, in a single approval ask —
   * not one ask per step. Freshness is checked once up front, exactly like
   * {@link perform}; each step's own backend call (click/type) still
   * re-verifies its own exact target immediately before acting the same way
   * the standalone `click`/`type` tools already do (elementId re-resolution
   * by UIA RuntimeId), so nothing here re-checks staleness per step. By
   * default the first failing step stops the batch; `continueOnError: true`
   * runs every step regardless, collecting one outcome per step either way.
   *
   * @param checkTree - forwarded to the one up-front freshness check, same
   * meaning as {@link perform}'s own `checkTree`.
   */
  async performMulti(
    toolName: string,
    exec: ToolRunContext,
    observationId: string,
    windowId: number,
    steps: ReadonlyArray<(focusFallback: boolean, backend: DesktopBackend) => Promise<ActionOutcome>>,
    continueOnError: boolean,
    checkTree = true,
  ): Promise<MultiActionStepOutcome[]> {
    let approved: ApprovalKind = 'none'
    let observationIdAudited: string | undefined
    let windowIdAudited: number | undefined
    const results: MultiActionStepOutcome[] = []
    try {
      const { record } = await this.requireFreshWindow(observationId, windowId, exec.signal, checkTree)
      observationIdAudited = observationId
      windowIdAudited = windowId
      approved = await this.gate(exec, toolName, {
        title: record.title,
        executablePath: record.executablePath,
      }, exec.signal)
      const backend = this.deps.getBackend(record.target)
      const focusFallback = this.config.focusFallback === 'allow'
      for (const step of steps) {
        try {
          const outcome = await step(focusFallback, backend)
          this.assertProcessUnchanged(outcome.processBefore, outcome.processAfter)
          results.push({ ok: true, outcome })
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          results.push({ ok: false, error: message })
          if (!continueOnError) break
        }
      }
      const succeeded = results.filter(result => result.ok).length
      this.audit(exec, {
        tool: toolName,
        approved,
        outcome: results.every(result => result.ok) ? 'ok' : 'error',
        observationId: observationIdAudited,
        windowId: windowIdAudited,
        detail: `${succeeded}/${results.length} step(s) ok`,
      })
      return results
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

  /**
   * Gate and run one arbitrary PowerShell script on the remote host. No
   * window observation exists (this is not window-scoped at all), so the
   * gate runs against a sanitized preview of the script itself. Categorically
   * more powerful than every other action this executor performs — full user
   * privileges, no window/element scoping — so it is always gated by
   * approval on the same terms as everything else, never treated as
   * inherently trusted.
   *
   * @param target - the SSH target to run on (resolved by the tool from its
   * own call argument or the plugin's configured default).
   */
  async runPowerShell(exec: ToolRunContext, script: string, target: ResolvedSshConfig, timeoutMs: number): Promise<PowerShellOutcome> {
    const toolName = 'powershell'
    let approved: ApprovalKind = 'none'
    try {
      const preview = sanitizeVisible(script, this.config.maxTextLength)
      approved = await this.gate(exec, toolName, { title: null, executablePath: preview }, exec.signal)
      const outcome = await this.deps.getBackend(target).powershell(script, timeoutMs, exec.signal)
      this.audit(exec, {
        tool: toolName,
        approved,
        outcome: 'ok',
        detail: `exit ${outcome.exitCode}: ${preview}`,
      })
      return outcome
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.audit(exec, { tool: toolName, approved, outcome: 'error', detail: message })
      throw error
    }
  }

  /**
   * Gate and download one file from the remote host. Reading an arbitrary
   * path can expose content the operator never put on screen (credentials,
   * cached secrets, ...), so — unlike screen_shot/screen_read, which only
   * reveal what's already visibly on screen — this is gated by approval like
   * a mutating action, not treated as a free "observer".
   */
  async pullFile(exec: ToolRunContext, remotePath: string, target: ResolvedSshConfig): Promise<Buffer> {
    const toolName = 'filesystem_pull'
    let approved: ApprovalKind = 'none'
    try {
      approved = await this.gate(exec, toolName, { title: null, executablePath: remotePath }, exec.signal)
      const data = await this.deps.getBackend(target).pullFile(remotePath, exec.signal)
      this.audit(exec, { tool: toolName, approved, outcome: 'ok', detail: `${remotePath} (${data.length} bytes)` })
      return data
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.audit(exec, { tool: toolName, approved, outcome: 'error', detail: message })
      throw error
    }
  }

  /** Gate and upload one file to the remote host. */
  async pushFile(exec: ToolRunContext, remotePath: string, data: Buffer, createDirectories: boolean, target: ResolvedSshConfig): Promise<{ bytesWritten: number }> {
    const toolName = 'filesystem_push'
    let approved: ApprovalKind = 'none'
    try {
      approved = await this.gate(exec, toolName, { title: null, executablePath: remotePath }, exec.signal)
      const outcome = await this.deps.getBackend(target).pushFile(remotePath, data, createDirectories, exec.signal)
      this.audit(exec, { tool: toolName, approved, outcome: 'ok', detail: `${remotePath} (${outcome.bytesWritten} bytes)` })
      return outcome
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.audit(exec, { tool: toolName, approved, outcome: 'error', detail: message })
      throw error
    }
  }

  /**
   * Gate and set the remote clipboard's text. No window is involved (the
   * clipboard is per-session, not per-window), so — like
   * `runPowerShell`/`pullFile`/`pushFile` — the gate runs against a
   * descriptive subject rather than a cited observation. `clipboard` with
   * `action: 'get'` is a pure observer and does NOT go through this (or any)
   * gate, the same way `app_list`/`process list`/`display_list` don't.
   */
  async setClipboard(exec: ToolRunContext, text: string, target: ResolvedSshConfig): Promise<void> {
    const toolName = 'clipboard'
    let approved: ApprovalKind = 'none'
    try {
      const preview = sanitizeVisible(text, this.config.maxTextLength)
      approved = await this.gate(exec, toolName, { title: null, executablePath: `set clipboard: ${preview}` }, exec.signal)
      await this.deps.getBackend(target).clipboardSet(text, exec.signal)
      this.audit(exec, { tool: toolName, approved, outcome: 'ok', detail: `set clipboard (${text.length} chars)` })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.audit(exec, { tool: toolName, approved, outcome: 'error', detail: message })
      throw error
    }
  }

  /**
   * Gate and kill one or more remote processes by pid or name. No window is
   * involved, so the gate runs against a descriptive subject the same way
   * `runPowerShell` does. `process` with `action: 'list'` is a pure observer
   * and does not go through this gate.
   */
  async killProcess(exec: ToolRunContext, request: ProcessKillRequest, target: ResolvedSshConfig): Promise<{ killedPids: number[] }> {
    const toolName = 'process'
    let approved: ApprovalKind = 'none'
    try {
      const subject = request.pid !== undefined ? `kill pid ${request.pid}` : `kill process "${sanitizeVisible(request.name ?? '', this.config.maxTextLength)}"`
      approved = await this.gate(exec, toolName, { title: null, executablePath: subject }, exec.signal)
      const outcome = await this.deps.getBackend(target).processKill(request, exec.signal)
      this.audit(exec, { tool: toolName, approved, outcome: 'ok', detail: `${subject}: killed pid(s) ${outcome.killedPids.join(',') || '(none)'}` })
      return outcome
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.audit(exec, { tool: toolName, approved, outcome: 'error', detail: message })
      throw error
    }
  }

  /**
   * Gate and show one Windows Action Center toast notification on the remote
   * host. No window is involved, so the gate runs against a descriptive
   * subject the same way `runPowerShell` does.
   */
  async notify(exec: ToolRunContext, title: string, message: string, appId: string, target: ResolvedSshConfig): Promise<void> {
    const toolName = 'notify'
    let approved: ApprovalKind = 'none'
    try {
      const preview = `${sanitizeVisible(title, this.config.maxTextLength)}: ${sanitizeVisible(message, this.config.maxTextLength)}`
      approved = await this.gate(exec, toolName, { title: null, executablePath: preview }, exec.signal)
      await this.deps.getBackend(target).notify(title, message, appId, exec.signal)
      this.audit(exec, { tool: toolName, approved, outcome: 'ok', detail: preview })
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.audit(exec, { tool: toolName, approved, outcome: 'error', detail: errorMessage })
      throw error
    }
  }
}
