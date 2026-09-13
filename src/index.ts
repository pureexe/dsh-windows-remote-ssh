/**
 * `dsh-windows-remote-ssh` — control a remote Windows desktop over SSH from
 * DeepSeek Harness (inspired by the local `dsh-click` plugin's tool surface
 * and safety model, retargeted at a remote host reached over SSH instead of
 * a local subprocess).
 *
 * Host-only function plugin — no default export (the Loader unwraps
 * `exports.default ?? exports`). It registers a growing family of tools
 * (screen/window observers, click/type/scroll/key/move/window_control/
 * multi_action mutators, app/process/clipboard/display/notify/filesystem
 * helpers, and the optional `powershell` escape hatch) behind one shared
 * safety boundary: observations are structured text (accessibility tree +
 * pixel hints) so text-only models work, mutating actions must cite a fresh
 * observation and pass approval (or the configured window allowlist), the
 * remote helper never steals foreground focus, and every action verifies the
 * target process identity before and after. Nothing needs to be
 * pre-installed on the target beyond a working SSH server (Win32-OpenSSH):
 * the single PowerShell helper this package ships is staged over SFTP the
 * first time it is needed.
 *
 * @module dsh-windows-remote-ssh
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { ActionExecutor } from './actions.ts'
import { Config, resolveConfig } from './config.ts'
import { ObservationStore } from './observe.ts'
import { createBackendPool } from './platform/selection.ts'
import { allTools, type ToolServices } from './tools.ts'

export const name = 'dsh-windows-remote-ssh'

/** Hard services: the tool registry every contribution lands in. */
export const inject = ['tools']

export { Config, resolveConfig, resolveSshTarget } from './config.ts'
export { VERSION, HELPER_PROTOCOL_VERSION } from './version.ts'
export { RemoteSshError } from './platform/types.ts'
export { ObservationStore, observationIdOf, type ObservationRecord, type FreshnessVerdict } from './observe.ts'
export { ActionExecutor, type ActionExecutorDeps, type ApprovalKind } from './actions.ts'
export { createBackendPool } from './platform/selection.ts'
export { SshHelperBackend } from './platform/runner.ts'
export { allTools, type ToolServices } from './tools.ts'
export { OBSERVED_EVENT, ACTION_EVENT, type ObservedEvent, type ActionEvent, type ProcessFacts } from './events.ts'
export { sanitizeText, sanitizePath, redactSensitive, sanitizeVisible } from './sanitize.ts'

/**
 * Mount the plugin: resolve config (including the SSH connection), build the
 * backend, and register every tool through `ctx.tools.register` (each
 * registration is an effect whose disposer removes exactly that tool on
 * stop/HMR). The SSH connection itself is lazy — nothing dials the remote
 * host until the first tool call — and is closed when the plugin unmounts.
 *
 * @param ctx - context carrying the tools registry.
 * @param config - raw loader config; defaults applied through {@link resolveConfig}.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)
  const pool = createBackendPool(resolved)
  const getBackend = pool.getBackend.bind(pool)
  const observations = new ObservationStore(resolved)
  const actions = new ActionExecutor({ ctx, config: resolved, getBackend, observations })

  const services: ToolServices = { ctx, config: resolved, getBackend, observations, actions }

  ctx.effect(() => () => pool.close(), 'dsh-windows-remote-ssh: close every pooled SSH connection')

  for (const tool of allTools(services)) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-windows-remote-ssh: ${tool.name} tool`)
  }
}
