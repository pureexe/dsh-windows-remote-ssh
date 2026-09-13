/**
 * The seven model tools dsh-windows-remote-ssh registers: two observers
 * (`screen_shot`, `screen_read`), four window-scoped actions (`click`,
 * `type`, `scroll`, `key`), and two application tools (`app_list`,
 * `app_launch`) — all executed on a remote Windows host over SSH. Observers
 * are read-only; every action crosses {@link ActionExecutor} — freshness
 * check, approval gate, process-identity check — before anything happens on
 * the remote desktop. Tool outputs are canonical JSON plus a pure text
 * renderer; `screen_shot` additionally emits an image content block whenever
 * `imageMode` allows one (default: always) — the harness's own attachment
 * and prompt-assembly pipeline is what adapts an image to what the current
 * model route actually accepts, so this plugin does not try to guess that
 * itself.
 *
 * @module dsh-windows-remote-ssh/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ActionExecutor } from './actions.ts'
import { resolveSshTarget, type ResolvedConfig, type ResolvedSshConfig, type SshConfig } from './config.ts'
import { appendAuditEvent, OBSERVED_EVENT, type ObservedEvent } from './events.ts'
import { ObservationStore } from './observe.ts'
import { sanitizePath, sanitizeVisible } from './sanitize.ts'
import type { DesktopBackend, ElementInfo, PixelHint, Rect, WindowInfo, WindowRef, WindowSnapshot } from './platform/types.ts'

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
      'Capture a screenshot of a window on the remote Windows host reachable over SSH: the addressed window, or the current foreground window when no target is given (matching screen_read). Pass wholeScreen: true to instead capture the entire primary screen (ignores target) — that capture has no single owning window, so its windowId is 0 and cannot be used as a basedOn target for click/type/scroll/key afterward; use it only to look at multiple windows/the desktop at once. Returns an observationId that later actions cite in `basedOn`. The result includes the image (unless the plugin is configured with imageMode: "text", in which case it includes only a text description). Read-only: never needs approval.',
    parameters: {
      ...sshOverrideParameter,
      target: {
        type: 'object',
        description: 'Which window to capture (windowId, windowTitle, or processId); omitted = the current foreground window. Ignored when wholeScreen is true.',
        properties: {
          windowId: { type: 'integer', description: 'Native window handle from app_list or screen_read.' },
          windowTitle: { type: 'string', description: 'Visible window title (matched case-insensitively by substring).' },
          processId: { type: 'integer', description: 'Owning process id.' },
        },
        additionalProperties: false,
      },
      wholeScreen: { type: 'boolean', description: 'Capture the entire primary screen instead of one window (default false). The result cannot be used as a basedOn target for a later action.' },
      maxSide: { type: 'integer', description: 'Longest side in pixels; larger captures are downscaled.' },
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
      const parsed = args as { target?: WindowRef; maxSide?: number; wholeScreen?: boolean; ssh?: SshConfig }
      const target = parsed.target ?? {}
      const wholeScreen = parsed.wholeScreen === true
      const sshTarget = resolveSshTarget(parsed.ssh, config.ssh)
      const backend = getBackend(sshTarget)
      const requestedSide = parsed.maxSide
      const maxSide = requestedSide === undefined ? config.maxScreenshotSide : Math.min(requestedSide, config.maxScreenshotSide)
      const shot = await backend.shot(target, maxSide, wholeScreen, exec.signal)
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

/** Every tool definition, in registration order. */
export function allTools(services: ToolServices) {
  return [
    screenShotTool(services),
    screenReadTool(services),
    clickTool(services),
    typeTool(services),
    scrollTool(services),
    keyTool(services),
    appListTool(services),
    appLaunchTool(services),
  ]
}
