/**
 * The model tools dsh-windows-remote-ssh registers:
 *
 * - Pure observers, never gated: `screen_shot`, `screen_read`, `app_list`,
 *   `display_list`, `wait_for` (polls, but never mutates), `clipboard`
 *   `action: 'get'`, `process` `action: 'list'`, `read_text`, `read_table`
 *   (freshness/identity still checked via {@link ActionExecutor.performRead},
 *   just never gated by approval).
 * - Window-scoped mutating actions, gated by approval and crossing
 *   {@link ActionExecutor}'s freshness/process-identity checks: `click`,
 *   `type`, `scroll`, `key`, `move`, `multi_action`, `window_control`,
 *   `invoke` (direct UIA pattern-method calls in place of a posted click).
 * - No-window mutating actions, gated by approval against a descriptive
 *   subject instead of a cited observation: `app_launch`, `filesystem_pull`,
 *   `filesystem_push`, `clipboard` `action: 'set'`, `process` `action:
 *   'kill'`, `notify`.
 * - `powershell`, an unscoped escape hatch registered only when
 *   `enablePowerShellTool` is on (default off).
 *
 * All execute on a remote Windows host over SSH. Tool outputs are canonical
 * JSON plus a pure text renderer; `screen_shot` (and `filesystem_pull`, for
 * an image file) emit an image content block whenever `imageMode` allows one
 * (default: always) — the harness's own attachment and prompt-assembly
 * pipeline is what adapts an image to what the current model route actually
 * accepts, so this plugin does not try to guess that itself.
 *
 * @module dsh-windows-remote-ssh/tools
 */

import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ActionExecutor } from './actions.ts'
import { MAX_SCREENSHOT_SIDE, MAX_WAIT_FOR_TIMEOUT_MS, MIN_SCREENSHOT_SIDE, MIN_WAIT_FOR_TIMEOUT_MS, resolveSshTarget, type ResolvedConfig, type ResolvedSshConfig, type SshConfig } from './config.ts'
import { appendAuditEvent, OBSERVED_EVENT, type ObservedEvent } from './events.ts'
import { detectImageMediaType, looksLikeText } from './filesystem.ts'
import { ObservationStore } from './observe.ts'
import { redactSensitive, sanitizePath, sanitizeVisible } from './sanitize.ts'
import { elementMatches, windowMatches } from './wait.ts'
import type { DesktopBackend, ElementInfo, PixelHint, Rect, UiaPattern, WindowInfo, WindowRef, WindowSnapshot } from './platform/types.ts'

/** Resolve after `ms`, or immediately once `signal` aborts — the `wait_for` poll cadence. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

/** Everything one tool needs at runtime; injected by `src/index.ts`. */
export interface ToolServices {
  readonly ctx: Context
  readonly config: ResolvedConfig
  /** Resolves a {@link DesktopBackend} bound to a specific SSH target (the connection pool). */
  readonly getBackend: (target: ResolvedSshConfig) => DesktopBackend
  readonly observations: ObservationStore
  readonly actions: ActionExecutor
}

/**
 * The optional per-call SSH target override shared by every entry-point tool
 * (the four that don't already have one implied by a cited observation):
 * `screen_shot`, `screen_read`, `app_list`, `app_launch`. When the plugin has
 * no configured default (`config.ssh` unset), this is how the model supplies
 * one instead. Passing credentials this way means they flow through the
 * model's context and get captured by the harness's own tool-call session
 * logging — a configured default (or at least a `privateKeyPath`) avoids
 * that and is the safer choice whenever a deployment can arrange it.
 */
const sshOverrideParameter = {
  ssh: {
    type: 'object' as const,
    description:
      'Remote SSH target for this call. Required if the plugin has no configured default; when given, overrides it. '
      + 'Prefer a configured default over sending host/user/password here — this argument (including any password) '
      + 'is visible to the model and is captured by the harness\'s tool-call logging. If host/user are given but '
      + 'neither password nor privateKeyPath is, the plugin tries the harness host\'s own default SSH identity '
      + '(~/.ssh/id_ed25519, id_ecdsa, id_rsa) before failing.',
    properties: {
      host: { type: 'string' as const, description: 'Hostname or IP of the remote Windows machine.' },
      port: { type: 'integer' as const, description: 'SSH port (default 22).' },
      user: { type: 'string' as const, description: 'SSH login user.' },
      password: { type: 'string' as const, description: 'SSH password. Omit to use privateKeyPath or the harness host\'s default identity instead.' },
      privateKeyPath: { type: 'string' as const, description: 'Path, on the machine running the harness, to a private key file.' },
      passphrase: { type: 'string' as const, description: 'Passphrase for privateKeyPath, if the key is encrypted.' },
    },
    additionalProperties: false,
  },
}

/** The sanitized, model-visible window facts shared by observer outputs. */
export interface ObservedWindowValue {
  windowId: number
  processId: number
  title: string
  className: string
  executablePath: string | null
  rect: Rect
  foreground: boolean
}

/** Sanitize one snapshot into the model-visible window value. */
function observedWindow(snapshot: WindowSnapshot, maxTextLength: number): ObservedWindowValue {
  return {
    windowId: snapshot.windowId,
    processId: snapshot.processId,
    title: sanitizeVisible(snapshot.title, maxTextLength),
    className: sanitizeVisible(snapshot.className, maxTextLength),
    executablePath: snapshot.executablePath === null ? null : sanitizePath(snapshot.executablePath, maxTextLength),
    rect: { ...snapshot.rect },
    foreground: snapshot.foreground,
  }
}

/** Sanitize one accessibility element into the model-visible form. */
function observedElement(element: ElementInfo, maxTextLength: number) {
  return {
    elementId: element.elementId,
    controlType: sanitizeVisible(element.controlType, 64),
    name: sanitizeVisible(element.name, maxTextLength),
    automationId: sanitizeVisible(element.automationId, 64),
    rect: element.rect,
    enabled: element.enabled,
    patterns: element.patterns,
  }
}

/** Sanitize one pixel hint into the model-visible form. */
function observedPixel(pixel: PixelHint, maxTextLength: number) {
  return {
    label: sanitizeVisible(pixel.label, maxTextLength),
    x: pixel.x,
    y: pixel.y,
    color: pixel.color,
  }
}

/** Sanitize one window listing entry. */
function observedWindowInfo(info: WindowInfo, maxTextLength: number) {
  return {
    windowId: info.windowId,
    processId: info.processId,
    title: sanitizeVisible(info.title, maxTextLength),
    className: sanitizeVisible(info.className, maxTextLength),
    rect: info.rect,
    executablePath: info.executablePath === null ? null : sanitizePath(info.executablePath, maxTextLength),
    visible: info.visible,
    minimized: info.minimized,
    maximized: info.maximized,
  }
}

/** Append the `dsh-windows-remote-ssh/observed` audit event; a failed append is swallowed. */
function auditObservation(exec: ToolRunContext, event: ObservedEvent, auditSessionEvents = true): void {
  if (!auditSessionEvents) return
  const session = exec.agent?.session
  if (session === undefined) return
  try {
    appendAuditEvent(session, OBSERVED_EVENT, event)
  } catch {
    // The tool/result event still logs the model-visible content.
  }
}

/** One-line window identity for render text. */
function windowLine(window: ObservedWindowValue): string {
  return `"${window.title}" (windowId ${window.windowId}, pid ${window.processId}, ${window.executablePath ?? 'unknown executable'})`
}

/** Plain-text fallback description for a captured screenshot. */
function shotDescription(window: ObservedWindowValue, width: number, height: number): string {
  return `${width}x${height} screenshot of the remote ${windowLine(window)}; run screen_read on the same window for the structured element list and pixel positions.`
}

/**
 * Resolve `screen_shot`'s `maxSide`: `configuredDefault` (`config.maxScreenshotSide`)
 * applies only when the call omits `maxSide` - it is a default, not a
 * ceiling, so an explicit request is honored even above it, bounded only by
 * the absolute `MIN_SCREENSHOT_SIDE`/`MAX_SCREENSHOT_SIDE` range (the model
 * may deliberately ask for a higher resolution, e.g. to read small text).
 */
export function resolveScreenshotMaxSide(requested: number | undefined, configuredDefault: number): number {
  if (requested === undefined) return configuredDefault
  if (!Number.isInteger(requested) || requested < MIN_SCREENSHOT_SIDE || requested > MAX_SCREENSHOT_SIDE) {
    throw new Error(`maxSide must be an integer between ${MIN_SCREENSHOT_SIDE} and ${MAX_SCREENSHOT_SIDE}`)
  }
  return requested
}

/**
 * `screen_shot` — capture the addressed window, or the current foreground
 * window when none is given (matching `screen_read`'s own no-target
 * behavior — the two must agree, or a later action's windowId can mismatch
 * whichever observer it was actually taken from). `wholeScreen: true`
 * captures the entire primary screen instead (windowId 0; not a valid
 * `basedOn` target). In `imageMode: 'auto'` (the default) the result carries
 * an image attachment; `imageMode: 'text'` always sends just the
 * description instead.
 */
export function screenShotTool(services: ToolServices) {
  const { ctx, config, getBackend, observations } = services
  return defineTool({
    name: 'screen_shot',
    description:
      'Capture a screenshot of a window on the remote Windows host reachable over SSH: the addressed window, or the current foreground window when no target is given (matching screen_read). Pass wholeScreen: true to instead capture the entire primary screen (ignores target) — that capture has no single owning window, so its windowId is 0 and cannot be used as a basedOn target for click/type/scroll/key afterward; use it only to look at multiple windows/the desktop at once. With wholeScreen: true, pass display: N (from display_list) to capture a specific monitor instead of the primary one. Pass region: {left, top, right, bottom} (absolute screen coordinates, from display_list/app_list/screen_read) to capture exactly that rectangle instead — takes precedence over target/wholeScreen/display. Returns an observationId that later actions cite in `basedOn` (region/display captures are not a valid basedOn target, same as wholeScreen). The result includes the image (unless the plugin is configured with imageMode: "text", in which case it includes only a text description). Read-only: never needs approval.',
    parameters: {
      ...sshOverrideParameter,
      target: {
        type: 'object',
        description: 'Which window to capture (windowId, windowTitle, or processId); omitted = the current foreground window. Ignored when wholeScreen or region is given.',
        properties: {
          windowId: { type: 'integer', description: 'Native window handle from app_list or screen_read.' },
          windowTitle: { type: 'string', description: 'Visible window title (matched case-insensitively by substring).' },
          processId: { type: 'integer', description: 'Owning process id.' },
        },
        additionalProperties: false,
      },
      wholeScreen: { type: 'boolean', description: 'Capture the entire primary screen (or, with display, one specific monitor) instead of one window (default false). The result cannot be used as a basedOn target for a later action.' },
      display: { type: 'integer', description: 'Monitor index from display_list; only applies when wholeScreen is true. Omitted = the primary screen.' },
      region: {
        type: 'object',
        description: 'Capture exactly this screen-space rectangle instead of a window/whole screen (absolute coordinates). Takes precedence over target/wholeScreen/display. The result cannot be used as a basedOn target for a later action.',
        properties: {
          left: { type: 'integer', required: true as const },
          top: { type: 'integer', required: true as const },
          right: { type: 'integer', required: true as const },
          bottom: { type: 'integer', required: true as const },
        },
        additionalProperties: false,
      },
      maxSide: {
        type: 'integer',
        description: `Longest side in pixels (${MIN_SCREENSHOT_SIDE}-${MAX_SCREENSHOT_SIDE}); larger captures are downscaled. Defaults to the configured maxScreenshotSide, but an explicit value here is honored even above that default (up to the absolute ceiling) - ask for more when you genuinely need higher resolution, e.g. to read small text.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', const: true },
          observationId: { type: 'string' },
          window: {
            type: 'object',
            properties: {
              windowId: { type: 'integer' },
              processId: { type: 'integer' },
              title: { type: 'string' },
              className: { type: 'string' },
              executablePath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              rect: {
                type: 'object',
                properties: {
                  x: { type: 'integer' },
                  y: { type: 'integer' },
                  width: { type: 'integer' },
                  height: { type: 'integer' },
                },
                additionalProperties: false,
              },
              foreground: { type: 'boolean' },
            },
            additionalProperties: false,
          },
          image: {
            type: 'object',
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string' },
              bytes: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              name: { type: 'string' },
            },
            additionalProperties: false,
          },
          imageBase64: { type: 'string', description: 'Present only when no attachment store is mounted: raw base64 PNG bytes.' },
          description: { type: 'string' },
        },
        additionalProperties: false,
      },
      render(_args, value): ContentBlock[] {
        const result = value as unknown as {
          observationId: string
          window: ObservedWindowValue
          image?: ImageAttachmentRef
          imageBase64?: string
          description: string
        }
        const blocks: ContentBlock[] = [{
          type: 'text',
          text: `Screenshot of the remote ${windowLine(result.window)} captured.\nobservationId: ${result.observationId}\n${result.image === undefined && result.imageBase64 === undefined ? result.description : 'Image attached; cite this observationId in later actions.'}`,
        }]
        if (result.image !== undefined) blocks.push({ type: 'image', attachment: result.image })
        return blocks
      },
    },
    timeoutMs: config.helperTimeoutMs + config.connectTimeoutMs + 15_000,
    async execute(args, exec) {
      const parsed = args as {
        target?: WindowRef
        maxSide?: number
        wholeScreen?: boolean
        display?: number
        region?: { left: number; top: number; right: number; bottom: number }
        ssh?: SshConfig
      }
      const target = parsed.target ?? {}
      const wholeScreen = parsed.wholeScreen === true
      const sshTarget = resolveSshTarget(parsed.ssh, config.ssh)
      const backend = getBackend(sshTarget)
      const maxSide = resolveScreenshotMaxSide(parsed.maxSide, config.maxScreenshotSide)
      const shot = await backend.shot(target, maxSide, wholeScreen, {
        ...parsed.region !== undefined ? { region: parsed.region } : {},
        ...parsed.display !== undefined ? { display: parsed.display } : {},
      }, exec.signal)
      const sanitized = observedWindow(shot.snapshot, config.maxTextLength)
      const record = observations.record(shot.snapshot, sshTarget)
      const description = shotDescription(sanitized, shot.width, shot.height)

      let image: ImageAttachmentRef | undefined
      let imageBase64: string | undefined
      if (config.imageMode !== 'text') {
        // Always attempt to attach the image (no model-capability probing
        // here): the harness's own attachment admission and prompt-assembly
        // pipeline is what adapts an image to whatever the current model
        // route actually accepts, so this plugin doesn't need to — and
        // shouldn't try to — guess that itself.
        const attachments = ctx.get('attachments') as AttachmentStore | undefined
        if (attachments !== undefined) {
          try {
            image = await attachments.saveImage({
              data: Buffer.from(shot.pngBase64, 'base64'),
              mediaType: 'image/png',
              name: `dsh-windows-remote-ssh-${record.id.slice(0, 12)}.png`,
            })
          } catch {
            // Attachment save failed: fall back to inline base64 below.
            image = undefined
          }
        }
        if (image === undefined) {
          // No attachment store mounted (or it failed): ship the PNG inline
          // rather than silently dropping vision support.
          imageBase64 = shot.pngBase64
        }
      }

      auditObservation(exec, {
        observationId: record.id,
        windowId: shot.snapshot.windowId,
        processId: shot.snapshot.processId,
        executablePath: sanitized.executablePath,
        windowTitle: sanitized.title,
        elementCount: shot.snapshot.elementCount,
        ...image !== undefined ? {
          image: {
            attachmentId: image.attachmentId,
            mediaType: image.mediaType,
            bytes: image.bytes,
            width: image.width,
            height: image.height,
          },
        } : {},
      }, config.auditSessionEvents)

      return {
        ok: true,
        observationId: record.id,
        window: sanitized,
        ...image !== undefined ? { image } : {},
        ...imageBase64 !== undefined ? { imageBase64 } : {},
        description,
      }
    },
  })
}

/**
 * `screen_read` — the structured observation for text-only models: the
 * remote window's accessibility tree plus pixel-location hints. The
 * returned elementIds are what click/type/scroll address.
 */
export function screenReadTool(services: ToolServices) {
  const { config, getBackend, observations } = services
  return defineTool({
    name: 'screen_read',
    description:
      'Read a window on the remote Windows host as structured text: its UI Automation accessibility tree (element ids, types, names, rectangles, supported patterns) plus pixel-location hints with colors. Returns an observationId that later actions cite in `basedOn`; elements are addressed by their elementId. Read-only: never needs approval.',
    parameters: {
      ...sshOverrideParameter,
      target: {
        type: 'object',
        description: 'Which window to read (windowId, windowTitle, or processId); omitted = the foreground window.',
        properties: {
          windowId: { type: 'integer', description: 'Native window handle from app_list or screen_read.' },
          windowTitle: { type: 'string', description: 'Visible window title (matched case-insensitively by substring).' },
          processId: { type: 'integer', description: 'Owning process id.' },
        },
        additionalProperties: false,
      },
      includePixels: { type: 'boolean', description: 'Include pixel-location hints (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', const: true },
          observationId: { type: 'string' },
          window: {
            type: 'object',
            properties: {
              windowId: { type: 'integer' },
              processId: { type: 'integer' },
              title: { type: 'string' },
              className: { type: 'string' },
              executablePath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              rect: {
                type: 'object',
                properties: {
                  x: { type: 'integer' },
                  y: { type: 'integer' },
                  width: { type: 'integer' },
                  height: { type: 'integer' },
                },
                additionalProperties: false,
              },
              foreground: { type: 'boolean' },
            },
            additionalProperties: false,
          },
          elements: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                elementId: { type: 'string' },
                controlType: { type: 'string' },
                name: { type: 'string' },
                automationId: { type: 'string' },
                rect: {
                  type: 'object',
                  properties: {
                    x: { type: 'integer' },
                    y: { type: 'integer' },
                    width: { type: 'integer' },
                    height: { type: 'integer' },
                  },
                  additionalProperties: false,
                },
                enabled: { type: 'boolean' },
                patterns: { type: 'array', items: { type: 'string' } },
              },
              additionalProperties: false,
            },
          },
          pixels: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                x: { type: 'integer' },
                y: { type: 'integer' },
                color: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render(_args, value): ContentBlock[] {
        const result = value as unknown as {
          observationId: string
          window: ObservedWindowValue
          elements: ElementInfo[]
          pixels: PixelHint[]
        }
        const lines = [
          `Remote window read: ${windowLine(result.window)}`,
          `observationId: ${result.observationId}`,
          `${result.elements.length} element(s):`,
        ]
        for (const element of result.elements) {
          lines.push(`- [${element.elementId}] ${element.controlType} ${JSON.stringify(element.name)} at (${element.rect.x}, ${element.rect.y}) ${element.rect.width}x${element.rect.height}${element.enabled ? '' : ' (disabled)'}${element.patterns.length > 0 ? ` patterns: ${element.patterns.join(',')}` : ''}`)
        }
        if (result.pixels.length > 0) {
          lines.push(`${result.pixels.length} pixel hint(s):`)
          for (const pixel of result.pixels) {
            lines.push(`- ${pixel.label} at (${pixel.x}, ${pixel.y}) ${pixel.color}`)
          }
        }
        lines.push('Actions (click/type/scroll/key) must cite this observationId in `basedOn` and address elements by elementId.')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: config.helperTimeoutMs + config.connectTimeoutMs + 15_000,
    async execute(args, exec) {
      const parsed = args as { target?: WindowRef; includePixels?: boolean; ssh?: SshConfig }
      const sshTarget = resolveSshTarget(parsed.ssh, config.ssh)
      const backend = getBackend(sshTarget)
      const tree = await backend.tree(
        parsed.target ?? {},
        config.maxElements,
        config.maxTreeDepth,
        parsed.includePixels ?? true,
        exec.signal,
      )
      const sanitized = observedWindow(tree.snapshot, config.maxTextLength)
      const record = observations.record(tree.snapshot, sshTarget)
      auditObservation(exec, {
        observationId: record.id,
        windowId: tree.snapshot.windowId,
        processId: tree.snapshot.processId,
        executablePath: sanitized.executablePath,
        windowTitle: sanitized.title,
        elementCount: tree.elements.length,
      }, config.auditSessionEvents)
      return {
        ok: true,
        observationId: record.id,
        window: sanitized,
        elements: tree.elements.map(element => observedElement(element, config.maxTextLength)),
        pixels: tree.pixels.map(pixel => observedPixel(pixel, config.maxTextLength)),
      }
    },
  })
}

/** The shared window-action output schema (click/scroll/key). */
function actionOutputSchema(withRestored: boolean) {
  return {
    type: 'object' as const,
    properties: {
      ok: { type: 'boolean' as const, const: true },
      windowId: { type: 'integer' as const },
      delivered: { type: 'string' as const, enum: ['uia', 'posted', 'none'] as const },
      process: {
        type: 'object' as const,
        properties: {
          before: {
            type: 'object' as const,
            properties: {
              pid: { type: 'integer' as const },
              executablePath: { oneOf: [{ type: 'string' as const }, { type: 'null' as const }] as const },
            },
            additionalProperties: false,
          },
          after: {
            type: 'object' as const,
            properties: {
              pid: { type: 'integer' as const },
              executablePath: { oneOf: [{ type: 'string' as const }, { type: 'null' as const }] as const },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      detail: { type: 'string' as const },
      ...withRestored ? { restored: { type: 'boolean' as const } } : {},
    },
    additionalProperties: false,
  }
}

/** The cited-observation parameters shared by the four action tools. */
const basedOnParameters = {
  basedOn: {
    type: 'object' as const,
    description: 'The observation this action is based on; the action fails if the remote screen changed since that observation.',
    properties: {
      observationId: { type: 'string' as const, description: 'observationId returned by screen_shot or screen_read.', required: true as const },
      windowId: { type: 'integer' as const, description: 'windowId of the observed window.', required: true as const },
    },
    additionalProperties: false,
    required: true as const,
  },
}

/** One-line action summary for render text. */
function actionLine(toolName: string, value: {
  windowId: number
  delivered: string
  process: { before: { pid: number; executablePath: string | null }; after: { pid: number; executablePath: string | null } }
  restored?: boolean
}): string {
  const before = value.process.before
  const after = value.process.after
  return `${toolName} delivered via ${value.delivered} to remote window ${value.windowId}; process pid ${before.pid} → ${after.pid}${value.restored === undefined ? '' : value.restored ? ' (original text restored)' : ' (text restore unavailable)'}.`
}

/**
 * `click` — click an element (by elementId) or a coordinate inside the
 * observed remote window. Never steals foreground focus; delivery is UIA
 * invoke where possible, posted window messages otherwise.
 */
export function clickTool(services: ToolServices) {
  const { config, actions } = services
  return defineTool({
    name: 'click',
    description:
      'Click an element or a coordinate inside an observed window on the remote Windows host. Requires `basedOn` (a fresh observationId from screen_shot/screen_read); the call fails if the remote screen changed since that observation. Never steals foreground focus. Requires approval unless the window is allowlisted.',
    parameters: {
      ...basedOnParameters,
      target: {
        type: 'object',
        description: 'Exactly one of elementId or (x, y) — screen coordinates.',
        properties: {
          elementId: { type: 'string', description: 'Element id from screen_read.' },
          x: { type: 'integer', description: 'Screen x coordinate.' },
          y: { type: 'integer', description: 'Screen y coordinate.' },
        },
        additionalProperties: false,
        required: true as const,
      },
      button: { type: 'string', enum: ['left', 'right'] as const, description: 'Mouse button (default left).' },
    },
    output: {
      schema: actionOutputSchema(false),
      render(_args, value): ContentBlock[] {
        return [{ type: 'text', text: actionLine('click', value as unknown as Parameters<typeof actionLine>[1]) }]
      },
    },
    timeoutMs: config.helperTimeoutMs + config.connectTimeoutMs + 15_000,
    async execute(args, exec) {
      const parsed = args as { basedOn: { observationId: string; windowId: number }; target: { elementId?: string; x?: number; y?: number }; button?: 'left' | 'right' }
      const target = parsed.target
      const byElement = target.elementId !== undefined
      const byPoint = target.x !== undefined && target.y !== undefined
      if (byElement === byPoint) {
        throw new Error('click target must name exactly one of elementId or (x, y)')
      }
      const outcome = await actions.perform('click', exec, parsed.basedOn.observationId, parsed.basedOn.windowId, (focusFallback, backend) =>
        backend.click({
          windowId: parsed.basedOn.windowId,
          ...byElement ? { elementId: target.elementId as string } : { x: target.x as number, y: target.y as number },
          button: parsed.button ?? 'left',
        }, focusFallback, exec.signal),
        // By elementId: the helper re-resolves that exact element by its UIA
        // RuntimeId right before clicking and fails loudly if it's gone, so
        // the whole-window tree hash adds no safety here. By coordinate,
        // nothing else re-verifies what's actually at (x, y), so keep it.
        !byElement)
      return {
        ok: true,
        windowId: outcome.windowId,
        delivered: outcome.delivered,
        process: { before: outcome.processBefore, after: outcome.processAfter },
        ...outcome.detail !== undefined ? { detail: outcome.detail } : {},
      }
    },
  })
}

/**
 * `type` — type text into a value-pattern element on the remote host. The
 * helper backs up the control text first and restores it when the action
 * fails (config `rollbackEnabled`).
 */
export function typeTool(services: ToolServices) {
  const { config, actions } = services
  return defineTool({
    name: 'type',
    description:
      'Type text into an editable element of an observed window on the remote Windows host (addressed by elementId from screen_read; the element must expose a value pattern). Requires `basedOn`; fails if the remote screen changed since that observation. Never steals foreground focus. Requires approval unless the window is allowlisted. On failure the previous control text is restored when rollback is enabled.',
    parameters: {
      ...basedOnParameters,
      elementId: { type: 'string', description: 'Editable element id from screen_read.', required: true as const },
      text: { type: 'string', description: 'The exact text to type (up to 10000 characters).', required: true as const },
    },
    output: {
      schema: actionOutputSchema(true),
      render(_args, value): ContentBlock[] {
        return [{ type: 'text', text: actionLine('type', value as unknown as Parameters<typeof actionLine>[1]) }]
      },
    },
    timeoutMs: config.helperTimeoutMs + config.connectTimeoutMs + 15_000,
    async execute(args, exec) {
      const parsed = args as { basedOn: { observationId: string; windowId: number }; elementId: string; text: string }
      if (parsed.text.length > 10_000) {
        throw new Error('type text must be at most 10000 characters')
      }
      const outcome = await actions.perform('type', exec, parsed.basedOn.observationId, parsed.basedOn.windowId, (focusFallback, backend) =>
        backend.type({
          windowId: parsed.basedOn.windowId,
          elementId: parsed.elementId,
          text: parsed.text,
          rollback: config.rollbackEnabled,
        }, focusFallback, exec.signal),
        // elementId is mandatory here: the helper always re-resolves it by
        // UIA RuntimeId right before typing and fails loudly if it's gone,
        // so the whole-window tree hash adds no safety and only
        // false-positives on unrelated content elsewhere in the window.
        false)
      return {
        ok: true,
        windowId: outcome.windowId,
        delivered: outcome.delivered,
        process: { before: outcome.processBefore, after: outcome.processAfter },
        restored: outcome.restored ?? false,
        ...outcome.detail !== undefined ? { detail: outcome.detail } : {},
      }
    },
  })
}

/**
 * `scroll` — scroll an element (scroll pattern) or the observed remote
 * window (posted wheel messages). Never steals foreground focus.
 */
export function scrollTool(services: ToolServices) {
  const { config, actions } = services
  return defineTool({
    name: 'scroll',
    description:
      'Scroll an element (by elementId) or the observed window on the remote Windows host. Requires `basedOn`; fails if the remote screen changed since that observation. Never steals foreground focus. Requires approval unless the window is allowlisted.',
    parameters: {
      ...basedOnParameters,
      elementId: { type: 'string', description: 'Optional scrollable element id from screen_read; omitted = scroll the window itself.' },
      direction: { type: 'string', enum: ['up', 'down', 'page-up', 'page-down'] as const, description: 'Scroll direction.', required: true as const },
      amount: { type: 'integer', description: 'Number of increments (default 3).' },
    },
    output: {
      schema: actionOutputSchema(false),
      render(_args, value): ContentBlock[] {
        return [{ type: 'text', text: actionLine('scroll', value as unknown as Parameters<typeof actionLine>[1]) }]
      },
    },
    timeoutMs: config.helperTimeoutMs + config.connectTimeoutMs + 15_000,
    async execute(args, exec) {
      const parsed = args as { basedOn: { observationId: string; windowId: number }; elementId?: string; direction: 'up' | 'down' | 'page-up' | 'page-down'; amount?: number }
      const amount = parsed.amount ?? 3
      if (!Number.isInteger(amount) || amount < 1) {
        throw new Error('scroll amount must be a positive integer')
      }
      const outcome = await actions.perform('scroll', exec, parsed.basedOn.observationId, parsed.basedOn.windowId, (focusFallback, backend) =>
        backend.scroll({
          windowId: parsed.basedOn.windowId,
          ...parsed.elementId !== undefined ? { elementId: parsed.elementId } : {},
          direction: parsed.direction,
          amount,
        }, focusFallback, exec.signal),
        // By elementId: the helper re-resolves it by UIA RuntimeId before
        // deciding how to scroll and fails loudly if it's gone, so the
        // whole-window tree hash adds no safety here. Scrolling the window
        // itself (no elementId) has no such per-target re-check, so keep it.
        parsed.elementId === undefined)
      return {
        ok: true,
        windowId: outcome.windowId,
        delivered: outcome.delivered,
        process: { before: outcome.processBefore, after: outcome.processAfter },
        ...outcome.detail !== undefined ? { detail: outcome.detail } : {},
      }
    },
  })
}

/**
 * `key` — send a key combination to the observed remote window as posted
 * window messages. Never steals foreground focus; apps that ignore posted
 * input fail with a clear error.
 */
export function keyTool(services: ToolServices) {
  const { config, actions } = services
  return defineTool({
    name: 'key',
    description:
      'Send a key combination (e.g. "Ctrl+S", "Enter", "Alt+F4") to an observed window on the remote Windows host via posted window messages. Requires `basedOn`; fails if the remote screen changed since that observation. Never steals foreground focus — applications that ignore posted input will not react; prefer click/type for those. Requires approval unless the window is allowlisted.',
    parameters: {
      ...basedOnParameters,
      keys: { type: 'string', description: 'Key combination, e.g. "Ctrl+S" or "Enter".', required: true as const },
    },
    output: {
      schema: actionOutputSchema(false),
      render(_args, value): ContentBlock[] {
        return [{ type: 'text', text: actionLine('key', value as unknown as Parameters<typeof actionLine>[1]) }]
      },
    },
    timeoutMs: config.helperTimeoutMs + config.connectTimeoutMs + 15_000,
    async execute(args, exec) {
      const parsed = args as { basedOn: { observationId: string; windowId: number }; keys: string }
      if (parsed.keys.trim() === '') {
        throw new Error('keys must not be empty')
      }
      const outcome = await actions.perform('key', exec, parsed.basedOn.observationId, parsed.basedOn.windowId, (focusFallback, backend) =>
        backend.key({ windowId: parsed.basedOn.windowId, keys: parsed.keys.trim() }, focusFallback, exec.signal))
      return {
        ok: true,
        windowId: outcome.windowId,
        delivered: outcome.delivered,
        process: { before: outcome.processBefore, after: outcome.processAfter },
        ...outcome.detail !== undefined ? { detail: outcome.detail } : {},
      }
    },
  })
}

/**
 * `app_list` — enumerate running desktop applications and their windows on
 * the remote host. Read-only: never needs approval.
 */
export function appListTool(services: ToolServices) {
  const { config, getBackend } = services
  return defineTool({
    name: 'app_list',
    description:
      'List running desktop applications and their visible windows (windowId, title, process id, executable path) on the remote Windows host. Read-only: never needs approval. Use the returned windowIds as screen_shot/screen_read targets.',
    parameters: {
      ...sshOverrideParameter,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', const: true },
          apps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                processId: { type: 'integer' },
                name: { type: 'string' },
                executablePath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                windows: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      windowId: { type: 'integer' },
                      processId: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                      title: { type: 'string' },
                      className: { type: 'string' },
                      rect: {
                        type: 'object',
                        properties: {
                          x: { type: 'integer' },
                          y: { type: 'integer' },
                          width: { type: 'integer' },
                          height: { type: 'integer' },
                        },
                        additionalProperties: false,
                      },
                      executablePath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                      visible: { type: 'boolean' },
                      minimized: { type: 'boolean' },
                      maximized: { type: 'boolean' },
                    },
                    additionalProperties: false,
                  },
                },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render(_args, value): ContentBlock[] {
        const result = value as unknown as { apps: Array<{ processId: number; name: string; executablePath: string | null; windows: WindowInfo[] }> }
        const lines = [`${result.apps.length} running application(s) with windows on the remote host:`]
        for (const app of result.apps) {
          lines.push(`- ${app.name} (pid ${app.processId}, ${app.executablePath ?? 'unknown executable'})`)
          for (const window of app.windows) {
            lines.push(`  - [windowId ${window.windowId}] ${JSON.stringify(window.title)} at (${window.rect.x}, ${window.rect.y}) ${window.rect.width}x${window.rect.height}`)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: config.helperTimeoutMs + config.connectTimeoutMs + 15_000,
    async execute(args, exec) {
      const parsed = args as { ssh?: SshConfig }
      const backend = getBackend(resolveSshTarget(parsed.ssh, config.ssh))
      const apps = await backend.apps(exec.signal)
      return {
        ok: true,
        apps: apps.map(app => ({
          processId: app.processId,
          name: sanitizeVisible(app.name, config.maxTextLength),
          executablePath: app.executablePath === null ? null : sanitizePath(app.executablePath, config.maxTextLength),
          windows: app.windows.map(window => observedWindowInfo(window, config.maxTextLength)),
        })),
      }
    },
  })
}

/**
 * `app_launch` — launch one application by name or path on the remote host.
 * Gated by approval (allowlist matching applies against the requested
 * name/path).
 */
export function appLaunchTool(services: ToolServices) {
  const { config, actions } = services
  return defineTool({
    name: 'app_launch',
    description:
      'Launch a desktop application on the remote Windows host by name (e.g. "notepad") or executable path, with optional arguments. Requires approval unless requireApproval is off or the name/path is allowlisted. Returns the new process identity.',
    parameters: {
      ...sshOverrideParameter,
      name: { type: 'string', description: 'Application name (resolved through the executable search path) or full path.', required: true as const },
      args: { type: 'array', items: { type: 'string' }, description: 'Optional command-line arguments.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', const: true },
          processId: { type: 'integer' },
          executablePath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
        additionalProperties: false,
      },
      render(_args, value): ContentBlock[] {
        const result = value as unknown as { processId: number; executablePath: string | null }
        return [{ type: 'text', text: `Launched on remote host: pid ${result.processId} (${result.executablePath ?? 'unknown executable'}).` }]
      },
    },
    timeoutMs: config.helperTimeoutMs + config.connectTimeoutMs + 15_000,
    async execute(args, exec) {
      const parsed = args as { name: string; args?: string[]; ssh?: SshConfig }
      if (parsed.name.trim() === '') {
        throw new Error('app_launch name must not be empty')
      }
      const sshTarget = resolveSshTarget(parsed.ssh, config.ssh)
      const outcome = await actions.launch(exec, parsed.name.trim(), parsed.args ?? [], sshTarget)
      return {
        ok: true,
        processId: outcome.processId,
        executablePath: outcome.executablePath === null ? null : sanitizePath(outcome.executablePath, config.maxTextLength),
      }
    },
  })
}

/**
 * `powershell` — run an arbitrary script on the remote host with full user
 * privileges. Not scoped to any window, not sandboxed beyond the account's
 * own permissions: this is the "break glass" tool for whatever the
 * structured window/element tools above can't reach. Only registered when
 * `enablePowerShellTool` is on (default off); always gated by approval like
 * every other mutating action.
 */
export function powershellTool(services: ToolServices) {
  const { config, actions } = services
  return defineTool({
    name: 'powershell',
    description:
      'Run an arbitrary PowerShell script on the remote Windows host, with the full privileges of the connected user - not scoped to any window or element, and not sandboxed beyond what that account can already do. Use this only when screen_shot/screen_read/click/type/scroll/key/app_list/app_launch genuinely cannot accomplish the task (e.g. reading/writing files, querying system state, managing services, registry access). Requires approval unless requireApproval is off. Returns stdout, stderr, and the exit code; output longer than the configured cap is truncated.',
    parameters: {
      ...sshOverrideParameter,
      script: { type: 'string', description: 'The PowerShell script/command(s) to run on the remote host.', required: true as const },
      timeoutMs: { type: 'integer', description: 'Timeout for this script in milliseconds (default from plugin config; the process is killed if it runs longer).' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', const: true },
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      render(_args, value): ContentBlock[] {
        const result = value as unknown as { exitCode: number; stdout: string; stderr: string; truncated: boolean }
        const lines = [
          `powershell exited ${result.exitCode}${result.truncated ? ' (output truncated)' : ''}`,
          result.stdout.length > 0 ? `stdout:\n${result.stdout}` : 'stdout: (empty)',
          result.stderr.length > 0 ? `stderr:\n${result.stderr}` : 'stderr: (empty)',
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: config.powerShellTimeoutMs + config.connectTimeoutMs + 15_000,
    async execute(args, exec) {
      const parsed = args as { script: string; timeoutMs?: number; ssh?: SshConfig }
      if (parsed.script.trim() === '') {
        throw new Error('powershell script must not be empty')
      }
      const sshTarget = resolveSshTarget(parsed.ssh, config.ssh)
      const timeoutMs = parsed.timeoutMs ?? config.powerShellTimeoutMs
      const outcome = await actions.runPowerShell(exec, parsed.script, sshTarget, timeoutMs)
      return {
        ok: true,
        exitCode: outcome.exitCode,
        stdout: redactSensitive(outcome.stdout),
        stderr: redactSensitive(outcome.stderr),
        truncated: outcome.truncated,
      }
    },
  })
}

/**
 * `filesystem_pull` — download one file from the remote host to the machine
 * running the harness. An image comes back as a real image attachment
 * (visible to the model, same mechanism `screen_shot` uses); small text
 * comes back inline as a string; anything else is stored as a generic file
 * attachment `filesystem_push` can write straight back. Gated by approval
 * like a mutating action (not a free "observer" like `screen_shot`/
 * `screen_read`): reading an arbitrary path can expose content the operator
 * never put on screen.
 */
export function filesystemPullTool(services: ToolServices) {
  const { ctx, config, actions } = services
  return defineTool({
    name: 'filesystem_pull',
    description:
      'Download one file from the remote Windows host to the machine running the harness, so it can be inspected here. An image comes back as an image attachment (visible directly); small text comes back inline as a string; anything else (large, or not text) is stored as a file attachment — cite the returned reference in filesystem_push to write it back unchanged. Requires approval unless requireApproval is off.',
    parameters: {
      ...sshOverrideParameter,
      remotePath: { type: 'string', description: 'Full path to the file on the remote host, e.g. C:\\Users\\me\\Desktop\\photo.png.', required: true as const },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', const: true },
          remotePath: { type: 'string' },
          sizeBytes: { type: 'integer' },
          kind: { type: 'string', enum: ['text', 'base64', 'image', 'file'] as const },
          content: { type: 'string', description: 'Present for kind "text" (UTF-8) and kind "base64".' },
          image: {
            type: 'object',
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string' },
              bytes: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              name: { type: 'string' },
            },
            additionalProperties: false,
          },
          file: {
            type: 'object',
            properties: {
              attachmentId: { type: 'string' },
              name: { type: 'string' },
              bytes: { type: 'integer' },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      render(_args, value): ContentBlock[] {
        const result = value as unknown as {
          remotePath: string
          sizeBytes: number
          kind: 'text' | 'base64' | 'image' | 'file'
          content?: string
          image?: ImageAttachmentRef
          file?: FileAttachmentRef
        }
        if (result.kind === 'image' && result.image !== undefined) {
          return [
            { type: 'text', text: `Pulled ${result.remotePath} (${result.sizeBytes} bytes) as an image attachment.` },
            { type: 'image', attachment: result.image },
          ]
        }
        if (result.kind === 'file' && result.file !== undefined) {
          return [{
            type: 'text',
            text: `Pulled ${result.remotePath} (${result.sizeBytes} bytes) as a file attachment "${result.file.name}" (attachmentId ${result.file.attachmentId}) — cite this exact reference in filesystem_push's \`file\` argument to write it back unchanged.`,
          }]
        }
        if (result.kind === 'base64') {
          return [{ type: 'text', text: `Pulled ${result.remotePath} (${result.sizeBytes} bytes, base64 below — no attachment store is mounted to hold it as a file):\n${result.content ?? ''}` }]
        }
        return [{ type: 'text', text: `Pulled ${result.remotePath} (${result.sizeBytes} bytes) as text:\n${result.content ?? ''}` }]
      },
    },
    timeoutMs: config.helperTimeoutMs + config.connectTimeoutMs + 30_000,
    async execute(args, exec) {
      const parsed = args as { remotePath: string; ssh?: SshConfig }
      const remotePath = parsed.remotePath.trim()
      if (remotePath === '') {
        throw new Error('filesystem_pull remotePath must not be empty')
      }
      const sshTarget = resolveSshTarget(parsed.ssh, config.ssh)
      const data = await actions.pullFile(exec, remotePath, sshTarget)
      const name = path.win32.basename(remotePath) || 'file'
      const attachments = ctx.get('attachments') as AttachmentStore | undefined

      const imageMediaType = detectImageMediaType(data)
      if (imageMediaType !== undefined && attachments !== undefined) {
        try {
          const image = await attachments.saveImage({ data, mediaType: imageMediaType, name })
          return { ok: true, remotePath, sizeBytes: data.length, kind: 'image' as const, image }
        } catch {
          // Rejected by image validation (corrupt/oversized/policy) — fall through to generic handling below.
        }
      }

      if (data.length <= config.maxInlineFilesystemBytes && looksLikeText(data)) {
        return { ok: true, remotePath, sizeBytes: data.length, kind: 'text' as const, content: data.toString('utf8') }
      }

      if (attachments !== undefined) {
        const file = await attachments.saveFile({ data, name })
        return { ok: true, remotePath, sizeBytes: data.length, kind: 'file' as const, file }
      }

      // No attachment store mounted and this isn't small inline-able text:
      // return it as base64 rather than silently dropping the content.
      return { ok: true, remotePath, sizeBytes: data.length, kind: 'base64' as const, content: data.toString('base64') }
    },
  })
}

/**
 * `filesystem_push` — upload a file to the remote host: literal text/base64
 * content, or an attachment reference (image or generic file) re-supplied
 * exactly as an earlier tool (typically `filesystem_pull`) returned it, so
 * its exact bytes get written back unchanged. Gated by approval like any
 * other mutating action.
 */
export function filesystemPushTool(services: ToolServices) {
  const { ctx, config, actions } = services
  return defineTool({
    name: 'filesystem_push',
    description:
      'Upload a file to the remote Windows host: either literal text/base64 content, or an attachment reference (image or file) previously returned by filesystem_pull — re-supply that exact reference to write its bytes back unchanged. Provide exactly one of content, image, or file. Creates missing parent directories by default. Requires approval unless requireApproval is off.',
    parameters: {
      ...sshOverrideParameter,
      remotePath: { type: 'string', description: 'Full destination path on the remote host.', required: true as const },
      content: { type: 'string', description: 'Literal content to write. Provide exactly one of content, image, or file.' },
      encoding: { type: 'string', enum: ['text', 'base64'] as const, description: 'How to interpret `content` (default text = UTF-8).' },
      image: {
        type: 'object',
        description: 'An image attachment reference exactly as returned by filesystem_pull (or another tool), re-supplied to write its exact bytes back.',
        properties: {
          attachmentId: { type: 'string', required: true as const },
          mediaType: { type: 'string', required: true as const },
          bytes: { type: 'integer', required: true as const },
          width: { type: 'integer', required: true as const },
          height: { type: 'integer', required: true as const },
          name: { type: 'string' },
        },
        additionalProperties: false,
      },
      file: {
        type: 'object',
        description: 'A file attachment reference exactly as returned by filesystem_pull, re-supplied to write its exact bytes back.',
        properties: {
          attachmentId: { type: 'string', required: true as const },
          name: { type: 'string', required: true as const },
          bytes: { type: 'integer', required: true as const },
        },
        additionalProperties: false,
      },
      createDirectories: { type: 'boolean', description: 'Create missing parent directories (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', const: true },
          remotePath: { type: 'string' },
          bytesWritten: { type: 'integer' },
        },
        additionalProperties: false,
      },
      render(_args, value): ContentBlock[] {
        const result = value as unknown as { remotePath: string; bytesWritten: number }
        return [{ type: 'text', text: `Pushed ${result.bytesWritten} bytes to ${result.remotePath} on the remote host.` }]
      },
    },
    timeoutMs: config.helperTimeoutMs + config.connectTimeoutMs + 30_000,
    async execute(args, exec) {
      const parsed = args as {
        remotePath: string
        content?: string
        encoding?: 'text' | 'base64'
        image?: ImageAttachmentRef
        file?: FileAttachmentRef
        createDirectories?: boolean
        ssh?: SshConfig
      }
      const remotePath = parsed.remotePath.trim()
      if (remotePath === '') {
        throw new Error('filesystem_push remotePath must not be empty')
      }
      const sourceCount = [parsed.content !== undefined, parsed.image !== undefined, parsed.file !== undefined].filter(Boolean).length
      if (sourceCount !== 1) {
        throw new Error('filesystem_push requires exactly one of content, image, or file')
      }

      let data: Buffer
      if (parsed.content !== undefined) {
        data = Buffer.from(parsed.content, parsed.encoding === 'base64' ? 'base64' : 'utf8')
      } else {
        const attachments = ctx.get('attachments') as AttachmentStore | undefined
        if (attachments === undefined) {
          throw new Error(`filesystem_push: no attachment store mounted, cannot resolve the given ${parsed.image !== undefined ? 'image' : 'file'} reference`)
        }
        if (parsed.image !== undefined) {
          const stored = await attachments.readImage(parsed.image, exec.signal)
          data = Buffer.from(stored.data)
        } else {
          const chunks: Buffer[] = []
          for await (const chunk of attachments.readFileStream(parsed.file as FileAttachmentRef, exec.signal)) {
            chunks.push(Buffer.from(chunk))
          }
          data = Buffer.concat(chunks)
        }
      }

      const sshTarget = resolveSshTarget(parsed.ssh, config.ssh)
      const outcome = await actions.pushFile(exec, remotePath, data, parsed.createDirectories ?? true, sshTarget)
      return { ok: true, remotePath, bytesWritten: outcome.bytesWritten }
    },
  })
}

/**
 * `move` — mouse move and drag inside an observed window, delivered entirely
 * as posted window messages (never the real OS cursor). See the module-level
 * `DesktopBackend.move` doc and the README for the honest limits of
 * posted-message drag.
 */
export function moveTool(services: ToolServices) {
  const { config, actions } = services
  return defineTool({
    name: 'move',
    description:
      'Move the mouse (and, with `drag`, drag) inside an observed window on the remote Windows host, delivered entirely as posted window messages (WM_MOUSEMOVE/WM_LBUTTONDOWN/WM_LBUTTONUP) — the real OS cursor never moves. Requires `basedOn`; fails if the remote screen changed since that observation. Honest limits: this reliably works for controls that react to simple mouse events (sliders, canvases, custom-drawn controls); it is NOT real OLE/shell drag-and-drop (e.g. dragging a file between two Explorer windows) — that needs actual SendInput-driven drag detection which posted messages cannot trigger. Requires approval unless the window is allowlisted.',
    parameters: {
      ...basedOnParameters,
      target: {
        type: 'object',
        description: 'Exactly one of elementId or (x, y) — the starting point.',
        properties: {
          elementId: { type: 'string', description: 'Element id from screen_read.' },
          x: { type: 'integer', description: 'Screen x coordinate.' },
          y: { type: 'integer', description: 'Screen y coordinate.' },
        },
        additionalProperties: false,
        required: true as const,
      },
      drag: {
        type: 'object',
        description: 'When given, drag from target to this destination instead of just moving. Exactly one of (toX, toY) or toElementId.',
        properties: {
          toX: { type: 'integer', description: 'Destination screen x coordinate.' },
          toY: { type: 'integer', description: 'Destination screen y coordinate.' },
          toElementId: { type: 'string', description: 'Destination element id from screen_read.' },
        },
        additionalProperties: false,
      },
    },
    output: {
      schema: actionOutputSchema(false),
      render(_args, value): ContentBlock[] {
        return [{ type: 'text', text: actionLine('move', value as unknown as Parameters<typeof actionLine>[1]) }]
      },
    },
    timeoutMs: config.helperTimeoutMs + config.connectTimeoutMs + 15_000,
    async execute(args, exec) {
      const parsed = args as {
        basedOn: { observationId: string; windowId: number }
        target: { elementId?: string; x?: number; y?: number }
        drag?: { toX?: number; toY?: number; toElementId?: string }
      }
      const target = parsed.target
      const byElement = target.elementId !== undefined
      const byPoint = target.x !== undefined && target.y !== undefined
      if (byElement === byPoint) {
        throw new Error('move target must name exactly one of elementId or (x, y)')
      }
      let drag: { toX?: number; toY?: number; toElementId?: string } | undefined
      if (parsed.drag !== undefined) {
        const dragByElement = parsed.drag.toElementId !== undefined
        const dragByPoint = parsed.drag.toX !== undefined && parsed.drag.toY !== undefined
        if (dragByElement === dragByPoint) {
          throw new Error('drag destination must name exactly one of toElementId or (toX, toY)')
        }
        drag = parsed.drag
      }
      const outcome = await actions.perform('move', exec, parsed.basedOn.observationId, parsed.basedOn.windowId, (focusFallback, backend) =>
        backend.move({
          windowId: parsed.basedOn.windowId,
          ...byElement ? { elementId: target.elementId as string } : { x: target.x as number, y: target.y as number },
          ...drag !== undefined ? { drag } : {},
        }, focusFallback, exec.signal),
        // Same reasoning as click: elementId re-resolves by UIA RuntimeId
        // right before acting, so the whole-window tree hash adds no safety
        // there; a coordinate-addressed move/drag has nothing else
        // re-verifying the target, so keep it.
        !byElement)
      return {
        ok: true,
        windowId: outcome.windowId,
        delivered: outcome.delivered,
        process: { before: outcome.processBefore, after: outcome.processAfter },
        ...outcome.detail !== undefined ? { detail: outcome.detail } : {},
      }
    },
  })
}

/** One `wait_for` condition's match fields, shared by every kind. */
interface WaitForMatch {
  name?: string
  automationId?: string
  controlType?: string
  title?: string
}

/**
 * `wait_for` — poll (~500ms) until a condition is met or a timeout elapses,
 * then return a fresh observation (same shape as `screen_read`). Entirely a
 * harness-side loop over the existing `tree`/`listWindows` backend calls — no
 * new helper op. Read-only: never needs approval (it never mutates
 * anything). A timeout is a normal, non-throwing result (`met: false,
 * timedOut: true`) carrying whatever was last observed, not an error — the
 * model needs to see what's actually on screen when a wait times out.
 */
export function waitForTool(services: ToolServices) {
  const { config, getBackend, observations } = services
  return defineTool({
    name: 'wait_for',
    description:
      'Poll the remote Windows host roughly every 500ms until a condition is met or a timeout elapses, then return a fresh observation (same shape as screen_read) with observationId set for later actions. condition.kind "element": target names a window (windowId/windowTitle/processId) and match (name/automationId/controlType substring, at least one) names what to look for in its accessibility tree. condition.kind "window": match.title names a substring to look for across all top-level window titles. condition.kind "foreground": target names a window that must exist and be the foreground window. A timeout is NOT an error: the result carries met: false, timedOut: true, and whatever was last observed, so you can see what is actually on screen. Read-only: never needs approval.',
    parameters: {
      ...sshOverrideParameter,
      condition: {
        type: 'object',
        description: 'What to wait for.',
        properties: {
          kind: { type: 'string', enum: ['element', 'window', 'foreground'] as const, description: 'Condition kind.', required: true as const },
          target: {
            type: 'object',
            description: 'Which window to watch (windowId, windowTitle, or processId). Required for kind "element" and "foreground"; ignored for kind "window".',
            properties: {
              windowId: { type: 'integer' },
              windowTitle: { type: 'string' },
              processId: { type: 'integer' },
            },
            additionalProperties: false,
          },
          match: {
            type: 'object',
            description: 'Substring match fields (case-insensitive). kind "element": name/automationId/controlType (at least one). kind "window": title.',
            properties: {
              name: { type: 'string' },
              automationId: { type: 'string' },
              controlType: { type: 'string' },
              title: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
        required: true as const,
      },
      timeoutMs: { type: 'integer', description: `Timeout in milliseconds (default ${services.config.waitForTimeoutMs}, bounded ${MIN_WAIT_FOR_TIMEOUT_MS}..${MAX_WAIT_FOR_TIMEOUT_MS}).` },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', const: true },
          met: { type: 'boolean' },
          timedOut: { type: 'boolean' },
          observationId: { type: 'string' },
          window: {
            type: 'object',
            properties: {
              windowId: { type: 'integer' },
              processId: { type: 'integer' },
              title: { type: 'string' },
              className: { type: 'string' },
              executablePath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              rect: {
                type: 'object',
                properties: {
                  x: { type: 'integer' },
                  y: { type: 'integer' },
                  width: { type: 'integer' },
                  height: { type: 'integer' },
                },
                additionalProperties: false,
              },
              foreground: { type: 'boolean' },
            },
            additionalProperties: false,
          },
          elements: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                elementId: { type: 'string' },
                controlType: { type: 'string' },
                name: { type: 'string' },
                automationId: { type: 'string' },
                rect: {
                  type: 'object',
                  properties: {
                    x: { type: 'integer' },
                    y: { type: 'integer' },
                    width: { type: 'integer' },
                    height: { type: 'integer' },
                  },
                  additionalProperties: false,
                },
                enabled: { type: 'boolean' },
                patterns: { type: 'array', items: { type: 'string' } },
              },
              additionalProperties: false,
            },
          },
          pixels: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                x: { type: 'integer' },
                y: { type: 'integer' },
                color: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render(_args, value): ContentBlock[] {
        const result = value as unknown as {
          met: boolean
          timedOut: boolean
          observationId?: string
          window?: ObservedWindowValue
          elements: ElementInfo[]
        }
        const lines = [
          result.met ? 'wait_for: condition met.' : 'wait_for: TIMED OUT before the condition was met.',
          result.window !== undefined ? `Last observed: ${windowLine(result.window)}` : 'No window could be observed at all.',
          ...result.observationId !== undefined ? [`observationId: ${result.observationId}`] : [],
          `${result.elements.length} element(s) in the last observation.`,
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: MAX_WAIT_FOR_TIMEOUT_MS + config.connectTimeoutMs + 15_000,
    async execute(args, exec) {
      const parsed = args as {
        condition: { kind: 'element' | 'window' | 'foreground'; target?: WindowRef; match?: WaitForMatch }
        timeoutMs?: number
        ssh?: SshConfig
      }
      const condition = parsed.condition
      if (condition === undefined || (condition.kind !== 'element' && condition.kind !== 'window' && condition.kind !== 'foreground')) {
        throw new Error('wait_for condition.kind must be "element", "window", or "foreground"')
      }
      if ((condition.kind === 'element' || condition.kind === 'foreground') && condition.target === undefined) {
        throw new Error(`wait_for condition.kind "${condition.kind}" requires condition.target`)
      }
      if (condition.kind === 'window' && condition.match?.title === undefined) {
        throw new Error('wait_for condition.kind "window" requires condition.match.title')
      }
      const requested = parsed.timeoutMs ?? config.waitForTimeoutMs
      const timeoutMs = Math.min(Math.max(requested, MIN_WAIT_FOR_TIMEOUT_MS), MAX_WAIT_FOR_TIMEOUT_MS)
      const sshTarget = resolveSshTarget(parsed.ssh, config.ssh)
      const backend = getBackend(sshTarget)
      const match = condition.match ?? {}

      let resolvedTarget: WindowRef | undefined = condition.kind === 'window' ? undefined : condition.target
      let met = false
      const start = Date.now()
      for (;;) {
        try {
          if (condition.kind === 'window') {
            const windows = await backend.listWindows(exec.signal)
            const found = windows.find(window => windowMatches({ title: window.title }, match))
            if (found !== undefined) {
              resolvedTarget = { windowId: found.windowId }
              met = true
            }
          } else if (condition.kind === 'foreground') {
            const tree = await backend.tree(resolvedTarget ?? {}, config.maxElements, config.maxTreeDepth, false, exec.signal)
            met = tree.snapshot.foreground
          } else {
            const tree = await backend.tree(resolvedTarget ?? {}, config.maxElements, config.maxTreeDepth, false, exec.signal)
            met = tree.elements.some(element => elementMatches(element, match))
          }
        } catch {
          // The target window doesn't exist yet (or momentarily vanished) -
          // that's "not met yet", not a hard failure; keep polling.
          met = false
        }
        if (met) break
        if (Date.now() - start >= timeoutMs) break
        await sleep(500, exec.signal)
      }

      // Final observation, best-effort: whatever can be read right now,
      // whether or not the condition was ever met.
      let observationId: string | undefined
      let window: ObservedWindowValue | undefined
      let elements: ElementInfo[] = []
      let pixels: PixelHint[] = []
      try {
        const tree = await backend.tree(resolvedTarget ?? {}, config.maxElements, config.maxTreeDepth, true, exec.signal)
        window = observedWindow(tree.snapshot, config.maxTextLength)
        elements = tree.elements
        pixels = tree.pixels
        const record = observations.record(tree.snapshot, sshTarget)
        observationId = record.id
        auditObservation(exec, {
          observationId: record.id,
          windowId: tree.snapshot.windowId,
          processId: tree.snapshot.processId,
          executablePath: window.executablePath,
          windowTitle: window.title,
          elementCount: tree.elements.length,
        }, config.auditSessionEvents)
      } catch {
        // No window could be observed at all (e.g. it closed and nothing
        // else resolves): still return a normal, non-throwing result.
      }

      return {
        ok: true,
        met,
        timedOut: !met,
        ...observationId !== undefined ? { observationId } : {},
        ...window !== undefined ? { window } : {},
        elements: elements.map(element => observedElement(element, config.maxTextLength)),
        pixels: pixels.map(pixel => observedPixel(pixel, config.maxTextLength)),
      }
    },
  })
}

/**
 * `clipboard` — get/set the remote clipboard text, in the same interactive
 * session every other operation runs in (clipboard is per-session).
 * `action: 'get'` is a pure observer (no gate, like `app_list`/`process
 * list`); `action: 'set'` is mutating and gated by approval like
 * `powershell` (no window subject).
 */
export function clipboardTool(services: ToolServices) {
  const { config, getBackend, actions } = services
  return defineTool({
    name: 'clipboard',
    description:
      'Get or set the remote clipboard text. action: "get" reads the current clipboard text (read-only, never needs approval). action: "set" replaces it with `text` — a mutating action, requires approval unless requireApproval is off.',
    parameters: {
      ...sshOverrideParameter,
      action: { type: 'string', enum: ['get', 'set'] as const, description: 'Whether to read or write the clipboard.', required: true as const },
      text: { type: 'string', description: 'Text to set. Required when action is "set"; ignored for "get".' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', const: true },
          action: { type: 'string', enum: ['get', 'set'] as const },
          text: { type: 'string' },
        },
        additionalProperties: false,
      },
      render(_args, value): ContentBlock[] {
        const result = value as unknown as { action: 'get' | 'set'; text: string }
        return [{
          type: 'text',
          text: result.action === 'get'
            ? `Remote clipboard text (${result.text.length} chars):\n${result.text}`
            : `Set remote clipboard text (${result.text.length} chars).`,
        }]
      },
    },
    timeoutMs: config.helperTimeoutMs + config.connectTimeoutMs + 15_000,
    async execute(args, exec) {
      const parsed = args as { action: 'get' | 'set'; text?: string; ssh?: SshConfig }
      const sshTarget = resolveSshTarget(parsed.ssh, config.ssh)
      if (parsed.action === 'get') {
        const backend = getBackend(sshTarget)
        const text = await backend.clipboardGet(exec.signal)
        return { ok: true, action: 'get' as const, text: redactSensitive(text) }
      }
      if (parsed.action === 'set') {
        if (parsed.text === undefined) throw new Error('clipboard action "set" requires text')
        await actions.setClipboard(exec, parsed.text, sshTarget)
        return { ok: true, action: 'set' as const, text: parsed.text }
      }
      throw new Error(`unknown clipboard action "${String(parsed.action)}"`)
    },
  })
}

/**
 * `process` — list or kill remote processes. `action: 'list'` is a pure
 * observer (no gate, like `app_list`); `action: 'kill'` is mutating and
 * gated by approval like `powershell`/`clipboard set` (no window subject).
 */
export function processTool(services: ToolServices) {
  const { config, getBackend, actions } = services
  return defineTool({
    name: 'process',
    description:
      'List running processes on the remote Windows host, or kill one or more by pid or by name. action: "list" is read-only (never needs approval). action: "kill" requires approval unless requireApproval is off.',
    parameters: {
      ...sshOverrideParameter,
      action: { type: 'string', enum: ['list', 'kill'] as const, description: 'Whether to list or kill processes.', required: true as const },
      pid: { type: 'integer', description: 'Process id to kill. Exactly one of pid or name is required for action "kill".' },
      name: { type: 'string', description: 'Process name to kill (every process with this name is killed). Exactly one of pid or name is required for action "kill".' },
      force: { type: 'boolean', description: 'Force-kill (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', const: true },
          action: { type: 'string', enum: ['list', 'kill'] as const },
          processes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                pid: { type: 'integer' },
                name: { type: 'string' },
                executablePath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                mainWindowTitle: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              },
              additionalProperties: false,
            },
          },
          killedPids: { type: 'array', items: { type: 'integer' } },
        },
        additionalProperties: false,
      },
      render(_args, value): ContentBlock[] {
        const result = value as unknown as {
          action: 'list' | 'kill'
          processes?: Array<{ pid: number; name: string; executablePath: string | null; mainWindowTitle: string | null }>
          killedPids?: number[]
        }
        if (result.action === 'list' && result.processes !== undefined) {
          const lines = [`${result.processes.length} running process(es) on the remote host:`]
          for (const process of result.processes) {
            lines.push(`- pid ${process.pid} ${process.name}${process.mainWindowTitle !== null ? ` (${JSON.stringify(process.mainWindowTitle)})` : ''} — ${process.executablePath ?? 'unknown executable'}`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        }
        return [{ type: 'text', text: `Killed pid(s): ${(result.killedPids ?? []).join(', ') || '(none)'}` }]
      },
    },
    timeoutMs: config.helperTimeoutMs + config.connectTimeoutMs + 15_000,
    async execute(args, exec) {
      const parsed = args as { action: 'list' | 'kill'; pid?: number; name?: string; force?: boolean; ssh?: SshConfig }
      const sshTarget = resolveSshTarget(parsed.ssh, config.ssh)
      if (parsed.action === 'list') {
        const backend = getBackend(sshTarget)
        const processes = await backend.processList(exec.signal)
        return {
          ok: true,
          action: 'list' as const,
          processes: processes.map(process => ({
            pid: process.pid,
            name: sanitizeVisible(process.name, config.maxTextLength),
            executablePath: process.executablePath === null ? null : sanitizePath(process.executablePath, config.maxTextLength),
            mainWindowTitle: process.mainWindowTitle === null ? null : sanitizeVisible(process.mainWindowTitle, config.maxTextLength),
          })),
        }
      }
      if (parsed.action === 'kill') {
        const byPid = parsed.pid !== undefined
        const byName = parsed.name !== undefined && parsed.name.trim() !== ''
        if (byPid === byName) {
          throw new Error('process kill requires exactly one of pid or name')
        }
        const outcome = await actions.killProcess(exec, {
          ...byPid ? { pid: parsed.pid as number } : { name: (parsed.name as string).trim() },
          force: parsed.force ?? false,
        }, sshTarget)
        return { ok: true, action: 'kill' as const, killedPids: outcome.killedPids }
      }
      throw new Error(`unknown process action "${String(parsed.action)}"`)
    },
  })
}

/**
 * `display_list` — enumerate every monitor on the remote desktop. Pure
 * observer: never gated, like `app_list`.
 */
export function displayListTool(services: ToolServices) {
  const { config, getBackend } = services
  return defineTool({
    name: 'display_list',
    description:
      'Enumerate every monitor on the remote Windows desktop: index, screen-space rectangle, and whether it is the primary display. Read-only: never needs approval. Use a display index with screen_shot(wholeScreen: true, display: N) to capture one specific monitor, or its rect with screen_shot(region: {...}) to capture part of it.',
    parameters: {
      ...sshOverrideParameter,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', const: true },
          displays: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
                rect: {
                  type: 'object',
                  properties: {
                    x: { type: 'integer' },
                    y: { type: 'integer' },
                    width: { type: 'integer' },
                    height: { type: 'integer' },
                  },
                  additionalProperties: false,
                },
                primary: { type: 'boolean' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render(_args, value): ContentBlock[] {
        const result = value as unknown as { displays: Array<{ index: number; rect: Rect; primary: boolean }> }
        const lines = [`${result.displays.length} display(s) on the remote desktop:`]
        for (const display of result.displays) {
          lines.push(`- display ${display.index}${display.primary ? ' (primary)' : ''}: (${display.rect.x}, ${display.rect.y}) ${display.rect.width}x${display.rect.height}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: config.helperTimeoutMs + config.connectTimeoutMs + 15_000,
    async execute(args, exec) {
      const parsed = args as { ssh?: SshConfig }
      const backend = getBackend(resolveSshTarget(parsed.ssh, config.ssh))
      const displays = await backend.displays(exec.signal)
      return { ok: true, displays }
    },
  })
}

/**
 * `notify` — show a real Windows Action Center toast notification (WinRT
 * `ToastNotificationManager`, not a legacy balloon-tip/`NotifyIcon` popup).
 * Mutating: gated by approval like `powershell` (no window subject).
 */
export function notifyTool(services: ToolServices) {
  const { config, actions } = services
  return defineTool({
    name: 'notify',
    description:
      'Show a real Windows Action Center toast notification on the remote host (WinRT ToastNotificationManager — not a legacy balloon-tip popup). Uses the built-in Windows PowerShell AUMID by default so it works out of the box with no app registration; override with appId if a specific one is needed. Requires approval unless requireApproval is off.',
    parameters: {
      ...sshOverrideParameter,
      title: { type: 'string', description: 'Toast title.', required: true as const },
      message: { type: 'string', description: 'Toast body text.', required: true as const },
      appId: { type: 'string', description: 'AUMID to toast under (default: the plugin-configured notifyAppId, itself defaulting to the built-in Windows PowerShell AUMID).' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', const: true },
          title: { type: 'string' },
          message: { type: 'string' },
          appId: { type: 'string' },
        },
        additionalProperties: false,
      },
      render(_args, value): ContentBlock[] {
        const result = value as unknown as { title: string; message: string; appId: string }
        return [{ type: 'text', text: `Showed a toast notification on the remote host (appId ${result.appId}): ${JSON.stringify(result.title)} — ${JSON.stringify(result.message)}` }]
      },
    },
    timeoutMs: config.helperTimeoutMs + config.connectTimeoutMs + 15_000,
    async execute(args, exec) {
      const parsed = args as { title: string; message: string; appId?: string; ssh?: SshConfig }
      if (parsed.title.trim() === '') throw new Error('notify title must not be empty')
      const sshTarget = resolveSshTarget(parsed.ssh, config.ssh)
      const appId = parsed.appId ?? config.notifyAppId
      await actions.notify(exec, parsed.title, parsed.message, appId, sshTarget)
      return { ok: true, title: parsed.title, message: parsed.message, appId }
    },
  })
}

/** One `multi_action` sub-action, as given by the model. */
interface MultiActionStepInput {
  kind: 'click' | 'type'
  elementId?: string
  x?: number
  y?: number
  button?: 'left' | 'right'
  selectionMode?: 'select' | 'add' | 'remove' | 'toggle'
  text?: string
}

/**
 * `multi_action` — run a batch of click/type sub-actions against ONE cited
 * observation in a single tool call (satisfies both "multi_edit" and
 * "multi_select" from the request). Sequential, stopping at the first
 * failure by default; `continueOnError: true` runs every step regardless.
 * Reuses the existing `ClickRequest`/`TypeRequest` backend calls per step —
 * each step re-verifies its own target exactly the same way a standalone
 * `click`/`type` call already does. `selectionMode` on a click-kind step
 * invokes UIA's SelectionItem pattern (Select/AddToSelection/
 * RemoveFromSelection) directly when the target supports it, falling back to
 * a plain posted click otherwise — more reliable than synthesizing
 * modifier-key+click combinations for list/grid multi-selection.
 */
export function multiActionTool(services: ToolServices) {
  const { config, actions } = services
  return defineTool({
    name: 'multi_action',
    description:
      'Run a batch of click/type sub-actions in sequence against ONE observed window on the remote Windows host (basedOn), in a single tool call. By default stops at the first failing step; continueOnError: true runs every step regardless. Each step is addressed and validated exactly like a standalone click/type call. For list/grid multi-selection, a click-kind step may set selectionMode ("select"/"add"/"remove"/"toggle") to invoke the UIA SelectionItem pattern directly instead of posting a click, when the target element supports it. Requires approval unless the window is allowlisted (one ask covers the whole batch).',
    parameters: {
      ...basedOnParameters,
      steps: {
        type: 'array',
        description: `Sub-actions to run in sequence against the same basedOn observation (1..${services.config.maxMultiActionSteps}).`,
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['click', 'type'] as const, description: 'Sub-action kind.', required: true as const },
            elementId: { type: 'string', description: 'Element id from screen_read (click or type; required for type).' },
            x: { type: 'integer', description: 'Screen x coordinate (click only, alternative to elementId).' },
            y: { type: 'integer', description: 'Screen y coordinate (click only, alternative to elementId).' },
            button: { type: 'string', enum: ['left', 'right'] as const, description: 'Mouse button for a click step (default left).' },
            selectionMode: {
              type: 'string',
              enum: ['select', 'add', 'remove', 'toggle'] as const,
              description: 'Click step only: apply UIA SelectionItem Select/AddToSelection/RemoveFromSelection instead of posting a click, when supported.',
            },
            text: { type: 'string', description: 'Text to type (type step only, up to 10000 characters).' },
          },
          additionalProperties: false,
        },
        required: true as const,
      },
      continueOnError: { type: 'boolean', description: 'Run every step even after one fails (default false: stop at the first failure).' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', const: true },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                windowId: { type: 'integer' },
                delivered: { type: 'string', enum: ['uia', 'posted', 'none'] as const },
                process: {
                  type: 'object',
                  properties: {
                    before: {
                      type: 'object',
                      properties: { pid: { type: 'integer' }, executablePath: { oneOf: [{ type: 'string' }, { type: 'null' }] } },
                      additionalProperties: false,
                    },
                    after: {
                      type: 'object',
                      properties: { pid: { type: 'integer' }, executablePath: { oneOf: [{ type: 'string' }, { type: 'null' }] } },
                      additionalProperties: false,
                    },
                  },
                  additionalProperties: false,
                },
                restored: { type: 'boolean' },
                detail: { type: 'string' },
                error: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render(_args, value): ContentBlock[] {
        const result = value as unknown as { steps: Array<{ ok: boolean; delivered?: string; error?: string }> }
        const lines = [`multi_action ran ${result.steps.length} step(s):`]
        result.steps.forEach((step, index) => {
          lines.push(step.ok ? `- step ${index}: ok (delivered ${step.delivered})` : `- step ${index}: FAILED — ${step.error}`)
        })
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: config.helperTimeoutMs * Math.max(1, config.maxMultiActionSteps) + config.connectTimeoutMs + 15_000,
    async execute(args, exec) {
      const parsed = args as {
        basedOn: { observationId: string; windowId: number }
        steps: MultiActionStepInput[]
        continueOnError?: boolean
      }
      if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
        throw new Error('multi_action requires at least one step')
      }
      if (parsed.steps.length > config.maxMultiActionSteps) {
        throw new Error(`multi_action supports at most ${config.maxMultiActionSteps} steps per call`)
      }
      let anyCoordinateAddressed = false
      const runners: Array<(focusFallback: boolean, backend: DesktopBackend) => Promise<import('./platform/types.ts').ActionOutcome>> = []
      parsed.steps.forEach((step, index) => {
        if (step.kind === 'click') {
          const byElement = step.elementId !== undefined
          const byPoint = step.x !== undefined && step.y !== undefined
          if (byElement === byPoint) {
            throw new Error(`multi_action step ${index}: click requires exactly one of elementId or (x, y)`)
          }
          if (!byElement) anyCoordinateAddressed = true
          runners.push((focusFallback, backend) => backend.click({
            windowId: parsed.basedOn.windowId,
            ...byElement ? { elementId: step.elementId as string } : { x: step.x as number, y: step.y as number },
            button: step.button ?? 'left',
            ...step.selectionMode !== undefined ? { selectionMode: step.selectionMode } : {},
          }, focusFallback, exec.signal))
        } else if (step.kind === 'type') {
          if (step.elementId === undefined) throw new Error(`multi_action step ${index}: type requires elementId`)
          if (step.text === undefined) throw new Error(`multi_action step ${index}: type requires text`)
          if (step.text.length > 10_000) throw new Error(`multi_action step ${index}: type text must be at most 10000 characters`)
          runners.push((focusFallback, backend) => backend.type({
            windowId: parsed.basedOn.windowId,
            elementId: step.elementId as string,
            text: step.text as string,
            rollback: config.rollbackEnabled,
          }, focusFallback, exec.signal))
        } else {
          throw new Error(`multi_action step ${index}: unknown kind "${String((step as { kind: unknown }).kind)}"`)
        }
      })
      const results = await actions.performMulti(
        'multi_action',
        exec,
        parsed.basedOn.observationId,
        parsed.basedOn.windowId,
        runners,
        parsed.continueOnError ?? false,
        anyCoordinateAddressed,
      )
      return {
        ok: true,
        steps: results.map((result) => {
          if (result.ok) {
            return {
              ok: true as const,
              windowId: result.outcome.windowId,
              delivered: result.outcome.delivered,
              process: { before: result.outcome.processBefore, after: result.outcome.processAfter },
              ...result.outcome.restored !== undefined ? { restored: result.outcome.restored } : {},
              ...result.outcome.detail !== undefined ? { detail: result.outcome.detail } : {},
            }
          }
          return { ok: false as const, error: result.error }
        }),
      }
    },
  })
}

/**
 * `window_control` — minimize/maximize/restore/move/resize/close a window.
 * Mutating: gated by approval like `click`/`scroll`/`key` (window-subject
 * pattern, participates in `autoApproveWindows`).
 */
export function windowControlTool(services: ToolServices) {
  const { config, actions } = services
  return defineTool({
    name: 'window_control',
    description:
      'Minimize, maximize, restore, move, resize, or close an observed window on the remote Windows host. Requires `basedOn`; fails if the remote screen changed since that observation. Requires approval unless the window is allowlisted.',
    parameters: {
      ...basedOnParameters,
      action: { type: 'string', enum: ['minimize', 'maximize', 'restore', 'move', 'resize', 'close'] as const, description: 'Window action.', required: true as const },
      x: { type: 'integer', description: 'New screen x coordinate (action "move" only).' },
      y: { type: 'integer', description: 'New screen y coordinate (action "move" only).' },
      width: { type: 'integer', description: 'New width in pixels (action "resize" only).' },
      height: { type: 'integer', description: 'New height in pixels (action "resize" only).' },
    },
    output: {
      schema: actionOutputSchema(false),
      render(_args, value): ContentBlock[] {
        return [{ type: 'text', text: actionLine('window_control', value as unknown as Parameters<typeof actionLine>[1]) }]
      },
    },
    timeoutMs: config.helperTimeoutMs + config.connectTimeoutMs + 15_000,
    async execute(args, exec) {
      const parsed = args as {
        basedOn: { observationId: string; windowId: number }
        action: 'minimize' | 'maximize' | 'restore' | 'move' | 'resize' | 'close'
        x?: number
        y?: number
        width?: number
        height?: number
      }
      if (parsed.action === 'move' && (parsed.x === undefined || parsed.y === undefined)) {
        throw new Error('window_control action "move" requires x and y')
      }
      if (parsed.action === 'resize' && (parsed.width === undefined || parsed.height === undefined)) {
        throw new Error('window_control action "resize" requires width and height')
      }
      const outcome = await actions.perform('window_control', exec, parsed.basedOn.observationId, parsed.basedOn.windowId, (focusFallback, backend) =>
        backend.windowControl({
          windowId: parsed.basedOn.windowId,
          action: parsed.action,
          ...parsed.x !== undefined ? { x: parsed.x } : {},
          ...parsed.y !== undefined ? { y: parsed.y } : {},
          ...parsed.width !== undefined ? { width: parsed.width } : {},
          ...parsed.height !== undefined ? { height: parsed.height } : {},
        }, focusFallback, exec.signal))
      return {
        ok: true,
        windowId: outcome.windowId,
        delivered: outcome.delivered,
        process: { before: outcome.processBefore, after: outcome.processAfter },
        ...outcome.detail !== undefined ? { detail: outcome.detail } : {},
      }
    },
  })
}

/** UIA pattern names `invoke` accepts, in the order documented in its description. */
const UIA_PATTERNS = [
  'invoke', 'toggle', 'expand', 'collapse',
  'select', 'addToSelection', 'removeFromSelection',
  'scrollIntoView', 'setValue', 'setRangeValue',
] as const

/**
 * `invoke` — call a UI Automation control pattern method directly on an
 * addressed element (`InvokePattern.Invoke`, `TogglePattern.Toggle`,
 * `ExpandCollapsePattern.Expand`/`Collapse`,
 * `SelectionItemPattern.Select`/`AddToSelection`/`RemoveFromSelection`,
 * `ScrollItemPattern.ScrollIntoView`, `ValuePattern.SetValue`,
 * `RangeValuePattern.SetValue`) instead of posting a synthetic click or
 * keystroke — more reliable for controls that react to their real pattern
 * method but ignore posted input. Always addressed by `elementId` (never
 * coordinates): the helper re-resolves that exact element by its UIA
 * RuntimeId immediately before acting and fails loudly if it's gone, or if
 * it doesn't support the requested pattern, so the whole-window tree hash
 * adds no safety here (same reasoning as elementId-addressed `click`/`type`).
 */
export function invokeTool(services: ToolServices) {
  const { config, actions } = services
  return defineTool({
    name: 'invoke',
    description:
      'Call a UI Automation control pattern method directly on an element of an observed window on the remote Windows host, instead of posting a synthetic click or keystroke. pattern: "invoke" (InvokePattern.Invoke), "toggle" (TogglePattern.Toggle), "expand"/"collapse" (ExpandCollapsePattern.Expand/Collapse), "select"/"addToSelection"/"removeFromSelection" (SelectionItemPattern), "scrollIntoView" (ScrollItemPattern.ScrollIntoView), "setValue" (ValuePattern.SetValue — requires a string `value`), "setRangeValue" (RangeValuePattern.SetValue — requires a numeric `value`). Fails with a clear error naming the pattern and the element\'s control type if the element does not support the requested pattern — never silently no-ops. Requires `basedOn`; fails if the remote screen changed since that observation. Requires approval unless the window is allowlisted.',
    parameters: {
      ...basedOnParameters,
      elementId: { type: 'string', description: 'Element id from screen_read.', required: true as const },
      pattern: { type: 'string', enum: UIA_PATTERNS, description: 'Which UIA pattern method to call.', required: true as const },
      value: {
        oneOf: [
          { type: 'string' as const, description: 'For pattern "setValue": the exact text to set via ValuePattern.SetValue().' },
          { type: 'number' as const, description: 'For pattern "setRangeValue": the numeric value to set via RangeValuePattern.SetValue().' },
        ] as const,
        description: 'Required for pattern "setValue" (string) or "setRangeValue" (number); ignored for every other pattern.',
      },
    },
    output: {
      schema: actionOutputSchema(false),
      render(_args, value): ContentBlock[] {
        return [{ type: 'text', text: actionLine('invoke', value as unknown as Parameters<typeof actionLine>[1]) }]
      },
    },
    timeoutMs: config.helperTimeoutMs + config.connectTimeoutMs + 15_000,
    async execute(args, exec) {
      const parsed = args as {
        basedOn: { observationId: string; windowId: number }
        elementId: string
        pattern: typeof UIA_PATTERNS[number]
        value?: string | number
      }
      if (!(UIA_PATTERNS as readonly string[]).includes(parsed.pattern)) {
        throw new Error(`invoke pattern must be one of: ${UIA_PATTERNS.join(', ')}`)
      }
      if (parsed.pattern === 'setValue' && typeof parsed.value !== 'string') {
        throw new Error('invoke pattern "setValue" requires a string value')
      }
      if (parsed.pattern === 'setRangeValue' && typeof parsed.value !== 'number') {
        throw new Error('invoke pattern "setRangeValue" requires a numeric value')
      }
      const outcome = await actions.perform('invoke', exec, parsed.basedOn.observationId, parsed.basedOn.windowId, (focusFallback, backend) =>
        backend.invokePattern({
          windowId: parsed.basedOn.windowId,
          elementId: parsed.elementId,
          pattern: parsed.pattern as UiaPattern,
          ...parsed.value !== undefined ? { value: parsed.value } : {},
        }, focusFallback, exec.signal),
        // Always elementId-addressed: the helper re-resolves it by UIA
        // RuntimeId right before calling the pattern method, exactly like
        // elementId-addressed click/type, so the whole-window tree hash adds
        // no safety here.
        false)
      return {
        ok: true,
        windowId: outcome.windowId,
        delivered: outcome.delivered,
        process: { before: outcome.processBefore, after: outcome.processAfter },
        ...outcome.detail !== undefined ? { detail: outcome.detail } : {},
      }
    },
  })
}

/**
 * `read_text` — read one text/document element's full content and current
 * selection via the UIA Text pattern (`TextPattern.DocumentRange.GetText(-1)`
 * / `GetSelection()`), richer than the plain `Name`/`Value` already exposed
 * by `screen_read`. Pure observer: never gated by approval, but still
 * resolves its target through the cited `basedOn` observation and confirms
 * the window's identity hasn't changed underneath it (via
 * {@link ActionExecutor.performRead}).
 */
export function readTextTool(services: ToolServices) {
  const { config, actions } = services
  return defineTool({
    name: 'read_text',
    description:
      'Read one text/document/edit element\'s full content and current text selection (if any) via the UI Automation Text pattern, on an observed window on the remote Windows host. Richer than the plain name/value screen_read already returns: the Text pattern exposes a document\'s full content (and current selection) even when it is far longer than what a plain Name/Value property would carry. Fails with a clear error naming the element\'s control type if it does not support the Text pattern. Requires `basedOn`; fails if the remote screen changed since that observation. Read-only: never needs approval.',
    parameters: {
      ...basedOnParameters,
      elementId: { type: 'string', description: 'Text/document/edit element id from screen_read.', required: true as const },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', const: true },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
          selectionText: { type: 'string' },
        },
        additionalProperties: false,
      },
      render(_args, value): ContentBlock[] {
        const result = value as unknown as { text: string; truncated: boolean; selectionText?: string }
        const lines = [
          `Text pattern content (${result.text.length} chars${result.truncated ? ', truncated' : ''}):`,
          result.text,
        ]
        if (result.selectionText !== undefined) {
          lines.push(`Current selection (${result.selectionText.length} chars):`, result.selectionText)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: config.helperTimeoutMs + config.connectTimeoutMs + 15_000,
    async execute(args, exec) {
      const parsed = args as { basedOn: { observationId: string; windowId: number }; elementId: string }
      const result = await actions.performRead('read_text', exec, parsed.basedOn.observationId, parsed.basedOn.windowId, backend =>
        backend.readText(parsed.basedOn.windowId, parsed.elementId, exec.signal))
      return {
        ok: true,
        text: result.text,
        truncated: result.truncated,
        ...result.selectionText !== undefined ? { selectionText: result.selectionText } : {},
      }
    },
  })
}

/**
 * `read_table` — read one grid/table element's structured cell data via the
 * Grid/GridItem/Table/TableItem patterns, on an observed window on the
 * remote Windows host. Pure observer: never gated by approval, but still
 * resolves its target through the cited `basedOn` observation and confirms
 * the window's identity hasn't changed underneath it (via
 * {@link ActionExecutor.performRead}).
 */
export function readTableTool(services: ToolServices) {
  const { config, actions } = services
  return defineTool({
    name: 'read_table',
    description:
      'Read one grid/list/table element\'s structured cell data (row count, column count, cell text, and column headers when available) via the UI Automation Grid/GridItem/Table/TableItem patterns, on an observed window on the remote Windows host. Each cell prefers its ValuePattern value, falling back to its Name. Column headers are included only when the element supports TablePattern (omitted, not an error, when it supports only GridPattern). Cells are capped at the configured maxTableCells (a total-cell cap, not per-dimension); rowCount/columnCount are always reported truthfully even when cells was capped short of them, and `truncated: true` marks that. Fails with a clear error naming the element\'s control type if it supports neither pattern. Requires `basedOn`; fails if the remote screen changed since that observation. Read-only: never needs approval.',
    parameters: {
      ...basedOnParameters,
      elementId: { type: 'string', description: 'Grid/list/table element id from screen_read.', required: true as const },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', const: true },
          rowCount: { type: 'integer' },
          columnCount: { type: 'integer' },
          truncated: { type: 'boolean' },
          columnHeaders: { type: 'array', items: { type: 'string' } },
          cells: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        },
        additionalProperties: false,
      },
      render(_args, value): ContentBlock[] {
        const result = value as unknown as {
          rowCount: number
          columnCount: number
          truncated: boolean
          columnHeaders?: string[]
          cells: string[][]
        }
        const lines = [
          `Table: ${result.rowCount} row(s) x ${result.columnCount} column(s)${result.truncated ? ' (cells truncated at the configured cap)' : ''}.`,
        ]
        if (result.columnHeaders !== undefined) {
          lines.push(`Headers: ${result.columnHeaders.join(' | ')}`)
        }
        for (const row of result.cells) {
          lines.push(row.join(' | '))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: config.helperTimeoutMs + config.connectTimeoutMs + 15_000,
    async execute(args, exec) {
      const parsed = args as { basedOn: { observationId: string; windowId: number }; elementId: string }
      const result = await actions.performRead('read_table', exec, parsed.basedOn.observationId, parsed.basedOn.windowId, backend =>
        backend.readTable(parsed.basedOn.windowId, parsed.elementId, exec.signal))
      return {
        ok: true,
        rowCount: result.rowCount,
        columnCount: result.columnCount,
        truncated: result.truncated,
        ...result.columnHeaders !== undefined ? { columnHeaders: result.columnHeaders } : {},
        cells: result.cells,
      }
    },
  })
}

/** Every tool definition, in registration order. */
export function allTools(services: ToolServices) {
  return [
    screenShotTool(services),
    screenReadTool(services),
    clickTool(services),
    typeTool(services),
    scrollTool(services),
    keyTool(services),
    moveTool(services),
    waitForTool(services),
    multiActionTool(services),
    windowControlTool(services),
    invokeTool(services),
    readTextTool(services),
    readTableTool(services),
    appListTool(services),
    appLaunchTool(services),
    filesystemPullTool(services),
    filesystemPushTool(services),
    clipboardTool(services),
    processTool(services),
    displayListTool(services),
    notifyTool(services),
    ...services.config.enablePowerShellTool ? [powershellTool(services)] : [],
  ]
}
