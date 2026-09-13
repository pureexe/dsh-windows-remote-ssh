/**
 * Plugin configuration and its explicit resolve step. `resolveConfig`
 * re-validates every default and bound so a config object built by hand
 * (bypassing Schemastery normalization) still fails loud instead of running
 * with hidden defaults.
 *
 * SSH connection details may be given three ways, checked in this order for
 * each field: the row's `config.ssh.*`, then the matching `SSH_*` environment
 * variable, then (host/port/user only) a built-in default. Secrets
 * (`password`, `passphrase`) are never logged or echoed back to the model.
 *
 * @module dsh-windows-remote-ssh/config
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

/**
 * How `screen_shot` renders its result: `'auto'` always attaches the image
 * (the harness's own attachment/prompt-assembly pipeline adapts it to
 * whatever the current model route accepts — this plugin does not probe
 * model capability itself); `'text'` always sends just the text description,
 * for a deployment that never wants image bytes leaving the plugin.
 */
export type ImageMode = 'auto' | 'text'

/** Whether mutating actions may ever bring the target window to the foreground. */
export type FocusFallback = 'never' | 'allow'

export const DEFAULT_SSH_PORT = 22
export const DEFAULT_HELPER_TIMEOUT_MS = 30_000
export const MAX_HELPER_TIMEOUT_MS = 300_000
export const DEFAULT_CONNECT_TIMEOUT_MS = 20_000
export const MAX_CONNECT_TIMEOUT_MS = 120_000
export const DEFAULT_MAX_SCREENSHOT_SIDE = 1600
export const MIN_SCREENSHOT_SIDE = 320
export const MAX_SCREENSHOT_SIDE = 7680
export const DEFAULT_MAX_OBSERVATION_AGE_MS = 300_000
export const MIN_OBSERVATION_AGE_MS = 1_000
export const MAX_OBSERVATION_AGE_MS = 600_000
export const DEFAULT_MAX_CACHED_OBSERVATIONS = 8
export const MAX_CACHED_OBSERVATIONS = 64
export const DEFAULT_MAX_ELEMENTS = 500
export const MAX_ELEMENTS = 2_000
export const DEFAULT_MAX_TREE_DEPTH = 32
export const MAX_TREE_DEPTH = 64
export const DEFAULT_MAX_TEXT_LENGTH = 200
export const MAX_TEXT_LENGTH = 10_000
// Short on purpose: it rides inside a Scheduled Task's /TR command line
// (261-character limit) alongside the full helper path and a request id, so
// every character here is a character a long %TEMP% path can't spend.
export const DEFAULT_REMOTE_WORKDIR = 'dsh-rssh'

export const DEFAULT_POWERSHELL_TIMEOUT_MS = 30_000
export const MAX_POWERSHELL_TIMEOUT_MS = 600_000
export const DEFAULT_MAX_POWERSHELL_OUTPUT_LENGTH = 20_000
export const MAX_POWERSHELL_OUTPUT_LENGTH = 200_000

/** Default cap on one filesystem_pull/filesystem_push transfer (10 MB). */
export const DEFAULT_MAX_FILESYSTEM_TRANSFER_BYTES = 10_000_000
/** Ceiling on the transfer cap (100 MB) — SFTP over the SSH link, not a fast local copy. */
export const MAX_FILESYSTEM_TRANSFER_BYTES = 100_000_000
/** Default cap on inlining a pulled file's bytes as text/base64 in the tool result, above which it's saved as an attachment instead. */
export const DEFAULT_MAX_INLINE_FILESYSTEM_BYTES = 100_000

/** Default `wait_for` poll timeout (10s): long enough for a typical app to open/settle, short enough not to tie up a tool call indefinitely. */
export const DEFAULT_WAIT_FOR_TIMEOUT_MS = 10_000
/** Floor on a `wait_for` timeout — below this the ~500ms poll interval barely gets one iteration in. */
export const MIN_WAIT_FOR_TIMEOUT_MS = 500
/** Ceiling on a `wait_for` timeout (2 minutes) — long enough for slow app startup without one tool call blocking indefinitely. */
export const MAX_WAIT_FOR_TIMEOUT_MS = 120_000

/**
 * Default AUMID `notify` targets when no `appId` is given: the well-known
 * built-in Windows PowerShell App User Model ID. Toasting through it is the
 * standard community technique for showing a real Action Center notification
 * from PowerShell without registering a new app on the target — it works out
 * of the box on stock Windows 10/11.
 */
export const DEFAULT_NOTIFY_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/** Default cap on the number of sub-actions one `multi_action` call may batch. */
export const DEFAULT_MAX_MULTI_ACTION_STEPS = 20
/** Ceiling on `maxMultiActionSteps` — a single tool call staying bounded, not a substitute for a real scripting loop. */
export const MAX_MULTI_ACTION_STEPS = 100

/** SSH connection parameters for the remote Windows host. */
export interface SshConfig {
  /** Hostname or IP; falls back to env `SSH_HOST`. */
  host?: string
  /** TCP port; falls back to env `SSH_PORT`, then 22. */
  port?: number
  /** Login user; falls back to env `SSH_USER`. */
  user?: string
  /** Password auth; falls back to env `SSH_PASSWORD`. Prefer a key when possible. */
  password?: string
  /** Path to a private key file; falls back to env `SSH_KEY_PATH`. */
  privateKeyPath?: string
  /** Passphrase for the private key; falls back to env `SSH_KEY_PASSPHRASE`. */
  passphrase?: string
  /** Reject unknown host keys (default true); set false only for lab/test targets. */
  strictHostKeyChecking?: boolean
  /** Remote working directory (any writable path) the helper and its per-call request/response files live under; default a per-user temp subfolder discovered at connect time. */
  remoteWorkdir?: string
}

/** Resolved, secret-bearing SSH connection facts. Never logged as a whole. */
export interface ResolvedSshConfig {
  host: string
  port: number
  user: string
  password: string | undefined
  privateKey: Buffer | undefined
  passphrase: string | undefined
  strictHostKeyChecking: boolean
  remoteWorkdir: string
}

/** Configuration for the dsh-windows-remote-ssh desktop-control tools. */
export interface Config {
  /** Remote target connection. All fields also read from `SSH_*` env vars. */
  ssh?: SshConfig
  /** Gate every mutating action (click/type/scroll/key/app_launch) behind approval (default true). */
  requireApproval?: boolean
  /** Window title or executable-path regexes that skip the approval ask (still audited; default []). */
  autoApproveWindows?: string[]
  /** Whether session audit events are appended to the session log (default true). */
  auditSessionEvents?: boolean
  /** Whether mutating actions may bring the target window to the foreground as a fallback (default 'never'). */
  focusFallback?: FocusFallback
  /** How `screen_shot` renders: `'auto'` (default) always attaches the image; `'text'` always sends only the description. */
  imageMode?: ImageMode
  /** Per-SSH-connect timeout in milliseconds (default 20000). */
  connectTimeoutMs?: number
  /** Per-helper-call timeout in milliseconds (default 30000). */
  helperTimeoutMs?: number
  /** Longest side of a captured screenshot in pixels (default 1600). */
  maxScreenshotSide?: number
  /**
   * Compare the accessibility tree of the whole window before every action
   * and refuse if anything in it differs from the cited observation — not
   * just the targeted element (default true; the stale-state boundary).
   * Already skipped automatically for `type` and for `click`/`scroll` when
   * addressed by `elementId` — those re-resolve that exact element by its
   * UIA RuntimeId immediately before acting and fail loudly if it's gone, so
   * the whole-tree hash adds no real safety there. Still applies to
   * coordinate-based `click` and to `key`, neither of which has anything
   * else re-verifying the target; disable this only if even those trip too
   * often for a fast-changing target window. Identity
   * (window/pid/exe/title/class/rect) and the observation-age check still
   * apply regardless.
   */
  staleCheckTree?: boolean
  /** Compare a fresh pixel hash before every action (default true; the stale-state boundary). */
  staleCheckPixels?: boolean
  /** Maximum age in ms of an observation that an action may still base on (default 300000, i.e. 5 minutes). */
  maxObservationAgeMs?: number
  /** Cap on cached observations (default 8). */
  maxCachedObservations?: number
  /** Cap on elements the accessibility walk returns (default 500). */
  maxElements?: number
  /** Maximum depth of the accessibility tree walk (default 32). */
  maxTreeDepth?: number
  /** Truncation length for sanitized model-visible strings (default 200). */
  maxTextLength?: number
  /** Back up and restore control text when `type` fails (default true). */
  rollbackEnabled?: boolean
  /**
   * Register the `powershell` tool, which runs an arbitrary script on the
   * remote host with full user privileges — not scoped to any window, not
   * sandboxed beyond the account's own permissions (default false: this is
   * categorically more powerful than every other tool this plugin
   * registers, and must be opted into deliberately). Still gated by
   * approval like any other mutating action when enabled.
   */
  enablePowerShellTool?: boolean
  /** Per-`powershell`-call timeout in milliseconds, independent of `helperTimeoutMs` since scripts may legitimately run longer (default 30000). */
  powerShellTimeoutMs?: number
  /** Cap on stdout/stderr length one `powershell` call returns, each truncated independently (default 20000). */
  maxPowerShellOutputLength?: number
  /**
   * Cap on one `filesystem_pull`/`filesystem_push` transfer in bytes (default
   * 10000000, i.e. 10 MB). A pull of a larger remote file, or a push of
   * larger content, is refused outright rather than silently truncated —
   * truncating binary content would just corrupt it.
   */
  maxFilesystemTransferBytes?: number
  /**
   * Above this many bytes, `filesystem_pull` saves the file as an attachment
   * (image or generic file) instead of inlining it as text/base64 in the
   * tool result (default 100000). Keeps a merely-large-but-under-the-transfer-cap
   * text file from bloating the model's context.
   */
  maxInlineFilesystemBytes?: number
  /**
   * Default timeout in milliseconds for `wait_for` when the call doesn't
   * supply its own (default 10000; bounded 500..120000). `wait_for` polls
   * roughly every 500ms until its condition is met or this elapses.
   */
  waitForTimeoutMs?: number
  /**
   * Default AUMID `notify` toasts under when a call doesn't supply its own
   * `appId` (default the well-known built-in Windows PowerShell AUMID, which
   * works on stock Windows 10/11 with no app registration).
   */
  notifyAppId?: string
  /**
   * Cap on the number of sub-actions one `multi_action` call may batch
   * (default 20, max 100) — a single tool call staying bounded, not a
   * substitute for a real scripting loop.
   */
  maxMultiActionSteps?: number
}

/** Fully resolved configuration captured at plugin load. */
export interface ResolvedConfig {
  /**
   * The default SSH target, when one is configured. `undefined` when neither
   * `config.ssh` nor any `SSH_*` env var is set — in that case every tool
   * call must supply its own `ssh` argument (see {@link resolveSshTarget}).
   */
  ssh: ResolvedSshConfig | undefined
  requireApproval: boolean
  autoApproveMatchers: ReadonlyArray<RegExp>
  auditSessionEvents: boolean
  focusFallback: FocusFallback
  imageMode: ImageMode
  connectTimeoutMs: number
  helperTimeoutMs: number
  maxScreenshotSide: number
  staleCheckTree: boolean
  staleCheckPixels: boolean
  maxObservationAgeMs: number
  maxCachedObservations: number
  maxElements: number
  maxTreeDepth: number
  maxTextLength: number
  rollbackEnabled: boolean
  enablePowerShellTool: boolean
  powerShellTimeoutMs: number
  maxPowerShellOutputLength: number
  maxFilesystemTransferBytes: number
  maxInlineFilesystemBytes: number
  waitForTimeoutMs: number
  notifyAppId: string
  maxMultiActionSteps: number
}

/** Schemastery schema for loader-validated configuration. */
export const Config: z<Config> = z.object({
  ssh: z.object({
    host: z.string(),
    port: z.number(),
    user: z.string(),
    password: z.string(),
    privateKeyPath: z.string(),
    passphrase: z.string(),
    strictHostKeyChecking: z.boolean().default(true),
    remoteWorkdir: z.string(),
  }),
  requireApproval: z.boolean().default(true),
  autoApproveWindows: z.array(z.string()).default([]),
  auditSessionEvents: z.boolean().default(true),
  focusFallback: z.union(['never', 'allow'] as const).default('never'),
  imageMode: z.union(['auto', 'text'] as const).default('auto'),
  connectTimeoutMs: z.number().min(1).max(MAX_CONNECT_TIMEOUT_MS).default(DEFAULT_CONNECT_TIMEOUT_MS),
  helperTimeoutMs: z.number().min(1).max(MAX_HELPER_TIMEOUT_MS).default(DEFAULT_HELPER_TIMEOUT_MS),
  maxScreenshotSide: z.number().min(MIN_SCREENSHOT_SIDE).max(MAX_SCREENSHOT_SIDE).default(DEFAULT_MAX_SCREENSHOT_SIDE),
  staleCheckTree: z.boolean().default(true),
  staleCheckPixels: z.boolean().default(true),
  maxObservationAgeMs: z.number().min(MIN_OBSERVATION_AGE_MS).max(MAX_OBSERVATION_AGE_MS).default(DEFAULT_MAX_OBSERVATION_AGE_MS),
  maxCachedObservations: z.number().min(1).max(MAX_CACHED_OBSERVATIONS).default(DEFAULT_MAX_CACHED_OBSERVATIONS),
  maxElements: z.number().min(1).max(MAX_ELEMENTS).default(DEFAULT_MAX_ELEMENTS),
  maxTreeDepth: z.number().min(1).max(MAX_TREE_DEPTH).default(DEFAULT_MAX_TREE_DEPTH),
  maxTextLength: z.number().min(16).max(MAX_TEXT_LENGTH).default(DEFAULT_MAX_TEXT_LENGTH),
  rollbackEnabled: z.boolean().default(true),
  enablePowerShellTool: z.boolean().default(false),
  powerShellTimeoutMs: z.number().min(1).max(MAX_POWERSHELL_TIMEOUT_MS).default(DEFAULT_POWERSHELL_TIMEOUT_MS),
  maxPowerShellOutputLength: z.number().min(1).max(MAX_POWERSHELL_OUTPUT_LENGTH).default(DEFAULT_MAX_POWERSHELL_OUTPUT_LENGTH),
  maxFilesystemTransferBytes: z.number().min(1).max(MAX_FILESYSTEM_TRANSFER_BYTES).default(DEFAULT_MAX_FILESYSTEM_TRANSFER_BYTES),
  maxInlineFilesystemBytes: z.number().min(1).max(MAX_FILESYSTEM_TRANSFER_BYTES).default(DEFAULT_MAX_INLINE_FILESYSTEM_BYTES),
  waitForTimeoutMs: z.number().min(MIN_WAIT_FOR_TIMEOUT_MS).max(MAX_WAIT_FOR_TIMEOUT_MS).default(DEFAULT_WAIT_FOR_TIMEOUT_MS),
  notifyAppId: z.string().default(DEFAULT_NOTIFY_APP_ID),
  maxMultiActionSteps: z.number().min(1).max(MAX_MULTI_ACTION_STEPS).default(DEFAULT_MAX_MULTI_ACTION_STEPS),
})

/** Throw the standard fail-loud config error for one invalid field. */
function invalid(field: string, detail: string): never {
  throw new Error(`dsh-windows-remote-ssh: config.${field} ${detail}`)
}

/** Compile one allowlist pattern; an invalid regex fails at load, not at match time. */
function compileMatcher(source: string, index: number): RegExp {
  try {
    return new RegExp(source, 'iu')
  } catch {
    invalid('autoApproveWindows', `entry ${index} (${JSON.stringify(source)}) is not a valid regular expression`)
  }
}

/** The `SSH_*` env vars a static (deployment-level) target may fold in. */
const SSH_ENV_KEYS = ['SSH_HOST', 'SSH_PORT', 'SSH_USER', 'SSH_PASSWORD', 'SSH_KEY_PATH', 'SSH_KEY_PASSPHRASE', 'SSH_REMOTE_WORKDIR'] as const

/**
 * The identity-establishing `ssh` fields: setting any one of these is what
 * counts as "attempting to configure a target." `port`, `strictHostKeyChecking`,
 * and `remoteWorkdir` are deliberately excluded — this plugin's own shipped
 * `cordis.patch.yml` template sets those to concrete defaults (22, true,
 * "dsh-rssh") right alongside `host`/`user`/etc left as `null`, and counting
 * them would make that template's "no default configured, use a per-call ssh"
 * intent impossible to express: every row would look "configured" even with
 * every credential field null.
 */
const SSH_IDENTITY_FIELDS = ['host', 'user', 'password', 'privateKeyPath', 'passphrase'] as const

/** Whether any identity-establishing field of a raw `ssh` row is actually set (not undefined/null/empty). */
function hasAnySshField(ssh: SshConfig | undefined): boolean {
  if (ssh === undefined) return false
  return SSH_IDENTITY_FIELDS.some((field) => {
    const value = ssh[field]
    return value !== undefined && value !== null && value !== ''
  })
}

/** Whether any `SSH_*` env var is set. */
function hasAnySshEnv(): boolean {
  return SSH_ENV_KEYS.some((key) => {
    const value = process.env[key]
    return value !== undefined && value !== ''
  })
}

/**
 * Default private-key filenames to try, in the same preference order the
 * standard `ssh` CLI uses, under `~/.ssh` on the machine running the
 * harness (NOT the remote Windows target) — the same default-identity
 * fallback a plain `ssh user@host` would use when no `-i`/password is given.
 */
const DEFAULT_IDENTITY_FILENAMES = ['id_ed25519', 'id_ecdsa', 'id_rsa'] as const

/** The default-identity search path, for use in "not found" error messages. */
const DEFAULT_IDENTITY_DESCRIPTION = DEFAULT_IDENTITY_FILENAMES.map(name => `~/.ssh/${name}`).join(', ')

/**
 * Try each default identity file in turn and return the first one that
 * exists and can be read.
 *
 * @returns the key bytes and the path they came from, or `undefined` if none apply.
 */
function findDefaultPrivateKey(): { path: string; key: Buffer } | undefined {
  for (const filename of DEFAULT_IDENTITY_FILENAMES) {
    const candidate = path.join(homedir(), '.ssh', filename)
    if (!existsSync(candidate)) continue
    try {
      return { path: candidate, key: readFileSync(candidate) }
    } catch {
      // Unreadable (permissions, race with deletion, ...): try the next one.
    }
  }
  return undefined
}

/** Read one string field: row value, else (when `useEnv`) the env var, else undefined. */
function stringField(rowValue: string | undefined | null, envName: string, useEnv: boolean): string | undefined {
  // A YAML/loader row commonly spells "unset" as an explicit `null` (this
  // plugin's own cordis.patch.yml template does exactly that for every
  // optional ssh.* field) rather than omitting the key outright, so `null`
  // must be treated the same as `undefined` here.
  if (rowValue !== undefined && rowValue !== null && rowValue !== '') return rowValue
  if (!useEnv) return undefined
  const fromEnv = process.env[envName]
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined
}

/**
 * Validate and resolve one `ssh` row into a full connection target. Shared by
 * the static (deployment) path — which also folds in `SSH_*` env vars and
 * fails loud through {@link invalid} at plugin load — and the per-call
 * override path, which does not consult env vars (a tool call is meant to be
 * self-contained) and fails through a plain, model-readable `Error` instead.
 *
 * @param ssh - the raw row.
 * @param useEnv - whether to fall back to `SSH_*` env vars for unset fields.
 * @param fail - called with `(field, detail)` for any invalid/missing field; must throw.
 */
function buildResolvedSsh(
  ssh: SshConfig | undefined,
  useEnv: boolean,
  fail: (field: string, detail: string) => never,
): ResolvedSshConfig {
  const host = stringField(ssh?.host, 'SSH_HOST', useEnv)
  if (host === undefined) fail('host', useEnv ? 'is required (set config.ssh.host or the SSH_HOST env var)' : 'is required')

  const user = stringField(ssh?.user, 'SSH_USER', useEnv)
  if (user === undefined) fail('user', useEnv ? 'is required (set config.ssh.user or the SSH_USER env var)' : 'is required')

  const portRaw = ssh?.port ?? (useEnv && process.env['SSH_PORT'] !== undefined ? Number(process.env['SSH_PORT']) : DEFAULT_SSH_PORT)
  if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65_535) {
    fail('port', 'must be an integer between 1 and 65535')
  }

  const password = stringField(ssh?.password, 'SSH_PASSWORD', useEnv)
  const passphrase = stringField(ssh?.passphrase, 'SSH_KEY_PASSPHRASE', useEnv)
  const privateKeyPath = stringField(ssh?.privateKeyPath, 'SSH_KEY_PATH', useEnv)
  let privateKey: Buffer | undefined
  if (privateKeyPath !== undefined) {
    try {
      privateKey = readFileSync(privateKeyPath)
    } catch (error: unknown) {
      fail('privateKeyPath', `could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // Neither a password nor an explicit key: fall back to the harness host's
  // own default SSH identity, exactly like a plain `ssh user@host` would.
  if (password === undefined && privateKey === undefined) {
    const defaultIdentity = findDefaultPrivateKey()
    if (defaultIdentity !== undefined) privateKey = defaultIdentity.key
  }
  if (password === undefined && privateKey === undefined) {
    fail('', useEnv
      ? `requires either a password (config.ssh.password / SSH_PASSWORD) or a private key (config.ssh.privateKeyPath / SSH_KEY_PATH) — no default identity found either (checked ${DEFAULT_IDENTITY_DESCRIPTION} on this machine)`
      : `requires either a password or a privateKeyPath — no default identity found either (checked ${DEFAULT_IDENTITY_DESCRIPTION} on this machine)`)
  }

  const strictHostKeyChecking = ssh?.strictHostKeyChecking ?? true
  if (typeof strictHostKeyChecking !== 'boolean') fail('strictHostKeyChecking', 'must be a boolean')

  const remoteWorkdir = ssh?.remoteWorkdir ?? (useEnv ? process.env['SSH_REMOTE_WORKDIR'] : undefined) ?? DEFAULT_REMOTE_WORKDIR
  if (typeof remoteWorkdir !== 'string' || remoteWorkdir.length === 0) fail('remoteWorkdir', 'must be a non-empty string')

  return Object.freeze({
    host,
    port: portRaw,
    user,
    password,
    privateKey,
    passphrase,
    strictHostKeyChecking,
    remoteWorkdir,
  })
}

/** Resolve the static (deployment-level) SSH default, folding in `SSH_*` env vars. */
function resolveSsh(ssh: SshConfig | undefined): ResolvedSshConfig | undefined {
  if (!hasAnySshField(ssh) && !hasAnySshEnv()) return undefined
  return buildResolvedSsh(ssh, true, (field, detail) => invalid(field === '' ? 'ssh' : `ssh.${field}`, detail))
}

/**
 * Resolve the SSH target for one tool call: the call's own `ssh` argument
 * when it supplies anything, else the configured default. Deliberately does
 * NOT consult `SSH_*` env vars — a per-call override is meant to be
 * self-contained, not silently blended with the process environment.
 *
 * This is the seam that lets a deployment with no static `config.ssh`
 * default still work: the model supplies host/user and a password or
 * `privateKeyPath` directly in the tool call. Passing credentials this way
 * means they flow through the model's context and get captured by the
 * harness's own tool-call session logging — configuring `config.ssh` once
 * (or a `privateKeyPath` there) avoids that and is the safer default for any
 * deployment that can arrange it.
 *
 * @param raw - the tool call's own `ssh` argument, if given.
 * @param fallback - the resolved static default, if configured.
 * @returns the resolved target for this one call.
 */
export function resolveSshTarget(raw: SshConfig | undefined, fallback: ResolvedSshConfig | undefined): ResolvedSshConfig {
  if (!hasAnySshField(raw)) {
    if (fallback === undefined) {
      throw new Error(
        'no SSH target available for this call: pass `ssh` (host, user, and password or privateKeyPath) as a tool argument, '
        + 'or configure a default target once via this plugin\'s config.ssh',
      )
    }
    return fallback
  }
  return buildResolvedSsh(raw, false, (field, detail) => {
    throw new Error(`ssh.${field === '' ? '(password/privateKeyPath)' : field} in this tool call ${detail}`)
  })
}

/**
 * Resolve raw config to the runtime policy, re-validating defaults and bounds.
 *
 * @param config - raw loader config; `undefined` for a bare row.
 * @returns the frozen resolved config.
 */
export function resolveConfig(config: Config | undefined): ResolvedConfig {
  const ssh = resolveSsh(config?.ssh)

  const requireApproval = config?.requireApproval ?? true
  if (typeof requireApproval !== 'boolean') invalid('requireApproval', 'must be a boolean')

  const autoApproveMatchers = (config?.autoApproveWindows ?? []).map(compileMatcher)
  const auditSessionEvents = config?.auditSessionEvents ?? true
  if (typeof auditSessionEvents !== 'boolean') invalid('auditSessionEvents', 'must be a boolean')

  const focusFallback = config?.focusFallback ?? 'never'
  if (focusFallback !== 'never' && focusFallback !== 'allow') invalid('focusFallback', 'must be "never" or "allow"')

  const imageMode = config?.imageMode ?? 'auto'
  if (imageMode !== 'auto' && imageMode !== 'text') invalid('imageMode', 'must be "auto" or "text"')

  const connectTimeoutMs = config?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 1 || connectTimeoutMs > MAX_CONNECT_TIMEOUT_MS) {
    invalid('connectTimeoutMs', `must be a finite number between 1 and ${MAX_CONNECT_TIMEOUT_MS}`)
  }

  const helperTimeoutMs = config?.helperTimeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS
  if (!Number.isFinite(helperTimeoutMs) || helperTimeoutMs < 1 || helperTimeoutMs > MAX_HELPER_TIMEOUT_MS) {
    invalid('helperTimeoutMs', `must be a finite number between 1 and ${MAX_HELPER_TIMEOUT_MS}`)
  }

  const maxScreenshotSide = config?.maxScreenshotSide ?? DEFAULT_MAX_SCREENSHOT_SIDE
  if (!Number.isInteger(maxScreenshotSide) || maxScreenshotSide < MIN_SCREENSHOT_SIDE || maxScreenshotSide > MAX_SCREENSHOT_SIDE) {
    invalid('maxScreenshotSide', `must be an integer between ${MIN_SCREENSHOT_SIDE} and ${MAX_SCREENSHOT_SIDE}`)
  }

  const staleCheckTree = config?.staleCheckTree ?? true
  if (typeof staleCheckTree !== 'boolean') invalid('staleCheckTree', 'must be a boolean')

  const staleCheckPixels = config?.staleCheckPixels ?? true
  if (typeof staleCheckPixels !== 'boolean') invalid('staleCheckPixels', 'must be a boolean')

  const maxObservationAgeMs = config?.maxObservationAgeMs ?? DEFAULT_MAX_OBSERVATION_AGE_MS
  if (!Number.isFinite(maxObservationAgeMs) || maxObservationAgeMs < MIN_OBSERVATION_AGE_MS || maxObservationAgeMs > MAX_OBSERVATION_AGE_MS) {
    invalid('maxObservationAgeMs', `must be a finite number between ${MIN_OBSERVATION_AGE_MS} and ${MAX_OBSERVATION_AGE_MS}`)
  }

  const maxCachedObservations = config?.maxCachedObservations ?? DEFAULT_MAX_CACHED_OBSERVATIONS
  if (!Number.isInteger(maxCachedObservations) || maxCachedObservations < 1 || maxCachedObservations > MAX_CACHED_OBSERVATIONS) {
    invalid('maxCachedObservations', `must be an integer between 1 and ${MAX_CACHED_OBSERVATIONS}`)
  }

  const maxElements = config?.maxElements ?? DEFAULT_MAX_ELEMENTS
  if (!Number.isInteger(maxElements) || maxElements < 1 || maxElements > MAX_ELEMENTS) {
    invalid('maxElements', `must be an integer between 1 and ${MAX_ELEMENTS}`)
  }

  const maxTreeDepth = config?.maxTreeDepth ?? DEFAULT_MAX_TREE_DEPTH
  if (!Number.isInteger(maxTreeDepth) || maxTreeDepth < 1 || maxTreeDepth > MAX_TREE_DEPTH) {
    invalid('maxTreeDepth', `must be an integer between 1 and ${MAX_TREE_DEPTH}`)
  }

  const maxTextLength = config?.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH
  if (!Number.isInteger(maxTextLength) || maxTextLength < 16 || maxTextLength > MAX_TEXT_LENGTH) {
    invalid('maxTextLength', `must be an integer between 16 and ${MAX_TEXT_LENGTH}`)
  }

  const rollbackEnabled = config?.rollbackEnabled ?? true
  if (typeof rollbackEnabled !== 'boolean') invalid('rollbackEnabled', 'must be a boolean')

  const enablePowerShellTool = config?.enablePowerShellTool ?? false
  if (typeof enablePowerShellTool !== 'boolean') invalid('enablePowerShellTool', 'must be a boolean')

  const powerShellTimeoutMs = config?.powerShellTimeoutMs ?? DEFAULT_POWERSHELL_TIMEOUT_MS
  if (!Number.isFinite(powerShellTimeoutMs) || powerShellTimeoutMs < 1 || powerShellTimeoutMs > MAX_POWERSHELL_TIMEOUT_MS) {
    invalid('powerShellTimeoutMs', `must be a finite number between 1 and ${MAX_POWERSHELL_TIMEOUT_MS}`)
  }

  const maxPowerShellOutputLength = config?.maxPowerShellOutputLength ?? DEFAULT_MAX_POWERSHELL_OUTPUT_LENGTH
  if (!Number.isInteger(maxPowerShellOutputLength) || maxPowerShellOutputLength < 1 || maxPowerShellOutputLength > MAX_POWERSHELL_OUTPUT_LENGTH) {
    invalid('maxPowerShellOutputLength', `must be an integer between 1 and ${MAX_POWERSHELL_OUTPUT_LENGTH}`)
  }

  const maxFilesystemTransferBytes = config?.maxFilesystemTransferBytes ?? DEFAULT_MAX_FILESYSTEM_TRANSFER_BYTES
  if (!Number.isInteger(maxFilesystemTransferBytes) || maxFilesystemTransferBytes < 1 || maxFilesystemTransferBytes > MAX_FILESYSTEM_TRANSFER_BYTES) {
    invalid('maxFilesystemTransferBytes', `must be an integer between 1 and ${MAX_FILESYSTEM_TRANSFER_BYTES}`)
  }

  const maxInlineFilesystemBytes = config?.maxInlineFilesystemBytes ?? DEFAULT_MAX_INLINE_FILESYSTEM_BYTES
  if (!Number.isInteger(maxInlineFilesystemBytes) || maxInlineFilesystemBytes < 1 || maxInlineFilesystemBytes > MAX_FILESYSTEM_TRANSFER_BYTES) {
    invalid('maxInlineFilesystemBytes', `must be an integer between 1 and ${MAX_FILESYSTEM_TRANSFER_BYTES}`)
  }

  const waitForTimeoutMs = config?.waitForTimeoutMs ?? DEFAULT_WAIT_FOR_TIMEOUT_MS
  if (!Number.isFinite(waitForTimeoutMs) || waitForTimeoutMs < MIN_WAIT_FOR_TIMEOUT_MS || waitForTimeoutMs > MAX_WAIT_FOR_TIMEOUT_MS) {
    invalid('waitForTimeoutMs', `must be a finite number between ${MIN_WAIT_FOR_TIMEOUT_MS} and ${MAX_WAIT_FOR_TIMEOUT_MS}`)
  }

  const notifyAppId = config?.notifyAppId ?? DEFAULT_NOTIFY_APP_ID
  if (typeof notifyAppId !== 'string' || notifyAppId.length === 0) invalid('notifyAppId', 'must be a non-empty string')

  const maxMultiActionSteps = config?.maxMultiActionSteps ?? DEFAULT_MAX_MULTI_ACTION_STEPS
  if (!Number.isInteger(maxMultiActionSteps) || maxMultiActionSteps < 1 || maxMultiActionSteps > MAX_MULTI_ACTION_STEPS) {
    invalid('maxMultiActionSteps', `must be an integer between 1 and ${MAX_MULTI_ACTION_STEPS}`)
  }

  return Object.freeze({
    ssh,
    requireApproval,
    autoApproveMatchers: Object.freeze(autoApproveMatchers),
    auditSessionEvents,
    focusFallback,
    imageMode,
    connectTimeoutMs,
    helperTimeoutMs,
    maxScreenshotSide,
    staleCheckTree,
    staleCheckPixels,
    maxObservationAgeMs,
    maxCachedObservations,
    maxElements,
    maxTreeDepth,
    maxTextLength,
    rollbackEnabled,
    enablePowerShellTool,
    powerShellTimeoutMs,
    maxPowerShellOutputLength,
    maxFilesystemTransferBytes,
    maxInlineFilesystemBytes,
    waitForTimeoutMs,
    notifyAppId,
    maxMultiActionSteps,
  })
}
