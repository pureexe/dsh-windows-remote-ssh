/**
 * Backend pool creation. Unlike a purely local desktop-control plugin, this
 * backend works from any harness host OS — Linux, macOS, or Windows — since
 * all the actual Windows-native work happens over SSH on the target, and it
 * is a pool (not one fixed connection): the SSH target may be the plugin's
 * static `config.ssh` default, or supplied per tool call (see
 * `resolveSshTarget` in `../config.ts`), so more than one remote host can be
 * addressed from one plugin instance. Connection failures surface per-call
 * from the SSH layer, not at pool-creation time.
 *
 * @module dsh-windows-remote-ssh/platform/selection
 */

import type { ResolvedConfig } from '../config.ts'
import { SshHelperBackend } from './runner.ts'

/**
 * Create the backend connection pool for this deployment.
 *
 * @param config - resolved plugin config (default SSH target, if any, + helper limits).
 * @returns the SSH connection pool; call `.getBackend(target)` to address one host.
 */
export function createBackendPool(config: ResolvedConfig): SshHelperBackend {
  return new SshHelperBackend(config)
}
