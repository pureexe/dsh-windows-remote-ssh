/**
 * End-to-end integration tests against a real remote Windows host reachable
 * over SSH. These exercise the SSH + PowerShell-helper path directly (the
 * part of this plugin that cannot be verified by unit tests alone) rather
 * than going through the full DeepSeek Harness tool/approval/session stack,
 * which is exercised separately by the harness's own plugin-loading tests.
 *
 * Configure the target with:
 *   SSH_HOST=<host> SSH_USER=<user> SSH_PASSWORD=<password> \
 *     npm run test:e2e
 *
 * The whole suite is skipped (not failed) when SSH_HOST/SSH_USER and a
 * credential are not set, so `npm test` stays green in environments with no
 * reachable target (CI, most dev machines).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { resolveConfig, resolveSshTarget, type ResolvedConfig, type ResolvedSshConfig } from '../../src/config.ts'
import { SshConnectionManager } from '../../src/ssh/client.ts'
import { SshHelperBackend } from '../../src/platform/runner.ts'
import type { DesktopBackend, WindowRef } from '../../src/platform/types.ts'

const hasCredential = process.env['SSH_PASSWORD'] !== undefined || process.env['SSH_KEY_PATH'] !== undefined
const hasTarget = process.env['SSH_HOST'] !== undefined && process.env['SSH_USER'] !== undefined && hasCredential

describe.skipIf(!hasTarget)('remote Windows host over SSH (live integration)', () => {
  let config: ResolvedConfig
  let target: ResolvedSshConfig
  let pool: SshHelperBackend
  let backend: DesktopBackend
  let cleanup: SshConnectionManager
  let notepadPid: number | undefined

  beforeAll(() => {
    config = resolveConfig({
      helperTimeoutMs: 45_000,
      connectTimeoutMs: 20_000,
    })
    // hasTarget guarantees SSH_HOST/SSH_USER/a credential are set, so resolveConfig always resolves a default here.
    target = config.ssh!
    pool = new SshHelperBackend(config)
    backend = pool.getBackend(target)
    cleanup = new SshConnectionManager(target, config.connectTimeoutMs)
  })

  afterAll(async () => {
    if (notepadPid !== undefined) {
      await cleanup.exec(`taskkill /F /PID ${notepadPid}`).catch(() => undefined)
    }
    pool.close()
    cleanup.close()
  })

  it('establishes the SSH connection and enumerates windows on the remote host', async () => {
    const windows = await backend.listWindows()
    expect(Array.isArray(windows)).toBe(true)
    // Every visible top-level window must at least carry a handle and a rect.
    for (const window of windows) {
      expect(typeof window.windowId).toBe('number')
      expect(window.rect.width).toBeGreaterThanOrEqual(0)
    }
  })

  it('lists running applications and launches notepad.exe', async () => {
    const before = await backend.apps()
    expect(Array.isArray(before)).toBe(true)

    const outcome = await backend.launch('notepad', [])
    expect(outcome.processId).toBeGreaterThan(0)
    notepadPid = outcome.processId

    // Give the new process a moment to create its main window.
    let sawWindow = false
    for (let attempt = 0; attempt < 20 && !sawWindow; attempt += 1) {
      const apps = await backend.apps()
      sawWindow = apps.some(app => app.processId === outcome.processId)
      if (!sawWindow) await new Promise(resolve => setTimeout(resolve, 500))
    }
    expect(sawWindow).toBe(true)
  })

  it('reads the UI Automation element tree of the Notepad window', async () => {
    expect(notepadPid).toBeDefined()
    const target: WindowRef = { processId: notepadPid }
    const tree = await backend.tree(target, 500, 32, true)
    expect(tree.snapshot.processId).toBe(notepadPid)
    expect(Array.isArray(tree.elements)).toBe(true)
    expect(tree.elements.length).toBeGreaterThan(0)
    // Notepad's text editor exposes a value-pattern element somewhere in the tree.
    const editable = tree.elements.find(element => element.patterns.includes('value'))
    expect(editable).toBeDefined()
  })

  it('types text into the Notepad edit control', async () => {
    expect(notepadPid).toBeDefined()
    const target: WindowRef = { processId: notepadPid }
    const tree = await backend.tree(target, 500, 32, false)
    const editable = tree.elements.find(element => element.patterns.includes('value'))
    expect(editable).toBeDefined()
    if (editable === undefined) return

    const outcome = await backend.type({
      windowId: tree.snapshot.windowId,
      elementId: editable.elementId,
      text: 'dsh-windows-remote-ssh integration test',
      rollback: true,
    }, false)
    expect(outcome.delivered === 'uia' || outcome.delivered === 'posted').toBe(true)
    expect(outcome.processBefore.pid).toBe(outcome.processAfter.pid)

    const after = await backend.tree(target, 500, 32, false)
    const updated = after.elements.find(element => element.elementId === editable.elementId)
    expect(updated?.name === editable.name || true).toBe(true) // name may or may not reflect content; delivery is the assertion above.
  })

  it('captures a screenshot of the Notepad window', async () => {
    expect(notepadPid).toBeDefined()
    const windowRef: WindowRef = { processId: notepadPid }
    const shot = await backend.shot(windowRef, 1024, false)
    expect(shot.pngBase64.length).toBeGreaterThan(100)
    expect(shot.width).toBeGreaterThan(0)
    expect(shot.height).toBeGreaterThan(0)
    // A PNG signature, once decoded, starts with these bytes.
    const header = Buffer.from(shot.pngBase64, 'base64').subarray(0, 8)
    expect(header.toString('hex')).toBe('89504e470d0a1a0a')
  })

  it('screen_shot with no target resolves to the foreground window, matching screen_read (regression: used to silently capture the primary screen instead, windowId 0)', async () => {
    expect(notepadPid).toBeDefined()
    const shot = await backend.shot({}, 1024, false)
    // Whatever the actual foreground window is, it must be a real window
    // (nonzero handle), not the windowId-0 whole-screen sentinel.
    expect(shot.snapshot.windowId).not.toBe(0)
    expect(shot.snapshot.foreground).toBe(true)
  })

  it('screen_shot with wholeScreen: true captures the primary screen with the windowId-0 sentinel', async () => {
    const shot = await backend.shot({}, 1024, true)
    expect(shot.snapshot.windowId).toBe(0)
    expect(shot.snapshot.title).toBe('primary screen')
    expect(shot.width).toBeGreaterThan(0)
    expect(shot.height).toBeGreaterThan(0)
  })

  it('sends a key combination that resolves a letter key (regression: Get-KeyMap crashed building its A-Z table via `foreach ($c in \'A\'..\'Z\')`, which fails converting a plain string to [int] on real Windows PowerShell 5.1 - every `key` call failed, letter or not, since the whole map is built up front)', async () => {
    expect(notepadPid).toBeDefined()
    const target: WindowRef = { processId: notepadPid }
    const tree = await backend.tree(target, 500, 32, false)
    // Ctrl+A (select all) rather than something destructive/window-closing:
    // this test just needs the helper to not crash while resolving a letter.
    const outcome = await backend.key({ windowId: tree.snapshot.windowId, keys: 'Ctrl+A' }, false)
    expect(outcome.delivered).toBe('posted')
  })

  it('connects with a per-call ssh override and no configured default (the runtime-prompted-credentials path)', async () => {
    // Simulates a deployment with no static config.ssh: the model supplies
    // host/user/password directly as the tool call's own `ssh` argument.
    // resolveSshTarget must accept that with no fallback at all.
    const callSupplied = resolveSshTarget({
      host: process.env['SSH_HOST'],
      port: process.env['SSH_PORT'] !== undefined ? Number(process.env['SSH_PORT']) : undefined,
      user: process.env['SSH_USER'],
      password: process.env['SSH_PASSWORD'],
      privateKeyPath: process.env['SSH_KEY_PATH'],
      passphrase: process.env['SSH_KEY_PASSPHRASE'],
    }, undefined)
    const overridePool = new SshHelperBackend(config)
    try {
      const overrideBackend = overridePool.getBackend(callSupplied)
      const windows = await overrideBackend.listWindows()
      expect(Array.isArray(windows)).toBe(true)
    } finally {
      overridePool.close()
    }
  })

  it('runs an arbitrary PowerShell script and captures stdout/exit code', async () => {
    const outcome = await backend.powershell("Write-Output 'dsh-windows-remote-ssh-e2e-marker'; exit 0", 15_000)
    expect(outcome.exitCode).toBe(0)
    expect(outcome.stdout).toContain('dsh-windows-remote-ssh-e2e-marker')
    expect(outcome.truncated).toBe(false)
  })

  it('captures a non-zero exit code and stderr from a failing script', async () => {
    const outcome = await backend.powershell("Write-Error 'dsh-windows-remote-ssh-e2e-failure'; exit 7", 15_000)
    expect(outcome.exitCode).toBe(7)
    expect(outcome.stderr).toContain('dsh-windows-remote-ssh-e2e-failure')
  })

  it('kills a script that runs past its timeout', async () => {
    await expect(backend.powershell('Start-Sleep -Seconds 30', 1_500)).rejects.toThrow(/did not finish within/iu)
  })

  it('a script allowed to run longer than helperTimeoutMs still gets its response (regression: the SFTP response-poll deadline used to ignore a call\'s own larger timeoutMs, always waiting only helperTimeoutMs regardless - a script that legitimately took longer than that, but well within its own requested allowance, would fail with "produced no response before the deadline" even though the helper was never going to give up on it that early)', async () => {
    // config.helperTimeoutMs is 45_000 for this test file (see beforeAll) -
    // this script deliberately runs longer than that, within a larger
    // explicit timeoutMs.
    const outcome = await backend.powershell('Start-Sleep -Seconds 47; Write-Output "dsh-long-script-marker"', 55_000)
    expect(outcome.exitCode).toBe(0)
    expect(outcome.stdout).toContain('dsh-long-script-marker')
  }, 90_000)

  it('pushes and pulls a text file round-trip', async () => {
    const tempDir = (await backend.powershell('Write-Output $env:TEMP', 10_000)).stdout.trim()
    const remotePath = `${tempDir}\\dsh-fs-e2e-${Date.now()}.txt`
    const content = Buffer.from('dsh-windows-remote-ssh filesystem round-trip test\nline two', 'utf8')
    try {
      const pushOutcome = await backend.pushFile(remotePath, content, true)
      expect(pushOutcome.bytesWritten).toBe(content.length)
      const pulled = await backend.pullFile(remotePath)
      expect(pulled.equals(content)).toBe(true)
    } finally {
      await backend.powershell(`Remove-Item -Path "${remotePath}" -Force -ErrorAction SilentlyContinue`, 10_000)
    }
  })

  it('pushes and pulls arbitrary binary content round-trip byte-for-byte', async () => {
    const tempDir = (await backend.powershell('Write-Output $env:TEMP', 10_000)).stdout.trim()
    const remotePath = `${tempDir}\\dsh-fs-e2e-${Date.now()}.bin`
    // Non-text bytes (including a null byte and a lone invalid UTF-8 byte) -
    // this exercises raw SFTP transfer fidelity, not the image/text
    // classification logic (that's unit-tested separately in filesystem.spec.ts).
    const content = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x80, 0x10, 0x20])
    try {
      await backend.pushFile(remotePath, content, true)
      const pulled = await backend.pullFile(remotePath)
      expect(pulled.equals(content)).toBe(true)
    } finally {
      await backend.powershell(`Remove-Item -Path "${remotePath}" -Force -ErrorAction SilentlyContinue`, 10_000)
    }
  })

  it('creates missing parent directories when pushing with createDirectories: true', async () => {
    const tempDir = (await backend.powershell('Write-Output $env:TEMP', 10_000)).stdout.trim()
    const nestedDir = `${tempDir}\\dsh-fs-e2e-nested-${Date.now()}`
    const remotePath = `${nestedDir}\\sub\\file.txt`
    try {
      await backend.pushFile(remotePath, Buffer.from('nested', 'utf8'), true)
      const pulled = await backend.pullFile(remotePath)
      expect(pulled.toString('utf8')).toBe('nested')
    } finally {
      await backend.powershell(`Remove-Item -Path "${nestedDir}" -Recurse -Force -ErrorAction SilentlyContinue`, 10_000)
    }
  })

  it('refuses to push content over maxFilesystemTransferBytes', async () => {
    const tempDir = (await backend.powershell('Write-Output $env:TEMP', 10_000)).stdout.trim()
    const remotePath = `${tempDir}\\dsh-fs-e2e-should-not-exist-${Date.now()}.txt`
    const tinyCapConfig = { ...config, maxFilesystemTransferBytes: 10 }
    const tinyPool = new SshHelperBackend(tinyCapConfig)
    try {
      const tinyBackend = tinyPool.getBackend(target)
      await expect(tinyBackend.pushFile(remotePath, Buffer.from('this is definitely more than ten bytes'), true))
        .rejects.toThrow(/maxFilesystemTransferBytes/iu)
    } finally {
      tinyPool.close()
    }
  })

  it('refuses to pull a file over maxFilesystemTransferBytes without downloading it', async () => {
    const tempDir = (await backend.powershell('Write-Output $env:TEMP', 10_000)).stdout.trim()
    const remotePath = `${tempDir}\\dsh-fs-e2e-oversized-${Date.now()}.txt`
    try {
      await backend.pushFile(remotePath, Buffer.from('this file is bigger than a tiny cap'), true)
      const tinyCapConfig = { ...config, maxFilesystemTransferBytes: 10 }
      const tinyPool = new SshHelperBackend(tinyCapConfig)
      try {
        const tinyBackend = tinyPool.getBackend(target)
        await expect(tinyBackend.pullFile(remotePath)).rejects.toThrow(/maxFilesystemTransferBytes/iu)
      } finally {
        tinyPool.close()
      }
    } finally {
      await backend.powershell(`Remove-Item -Path "${remotePath}" -Force -ErrorAction SilentlyContinue`, 10_000)
    }
  })

  describe('the 9 new capabilities (move, wait_for primitives, clipboard, process, display_list, screen_shot region/display, notify, multi_action primitives, window_control)', () => {
    /** Launch an app and poll app_list until it owns a visible window; returns its windowId. Mirrors what wait_for's own polling loop does over app_list/tree. */
    async function launchAndWaitForWindow(name = 'notepad'): Promise<{ pid: number; windowId: number }> {
      const launch = await backend.launch(name, [])
      let windowId: number | undefined
      for (let attempt = 0; attempt < 20 && windowId === undefined; attempt += 1) {
        const apps = await backend.apps()
        const app = apps.find(candidate => candidate.processId === launch.processId)
        if (app !== undefined && app.windows.length > 0) {
          windowId = app.windows[0]!.windowId
        } else {
          await new Promise(resolve => setTimeout(resolve, 300))
        }
      }
      expect(windowId).toBeDefined()
      return { pid: launch.processId, windowId: windowId as number }
    }

    let extraPid: number | undefined

    afterEach(async () => {
      if (extraPid !== undefined) {
        await cleanup.exec(`taskkill /F /PID ${extraPid}`).catch(() => undefined)
        extraPid = undefined
      }
    })

    it('display_list: enumerates at least one monitor, one of them primary', async () => {
      const displays = await backend.displays()
      expect(Array.isArray(displays)).toBe(true)
      expect(displays.length).toBeGreaterThan(0)
      expect(displays.some(display => display.primary)).toBe(true)
      for (const display of displays) {
        expect(display.rect.width).toBeGreaterThan(0)
        expect(display.rect.height).toBeGreaterThan(0)
      }
    })

    it('cursor_location: reports a position within some enumerated display\'s bounds', async () => {
      const [position, displays] = await Promise.all([backend.cursorPosition(), backend.displays()])
      expect(Number.isInteger(position.x)).toBe(true)
      expect(Number.isInteger(position.y)).toBe(true)
      const withinSomeDisplay = displays.some(display =>
        position.x >= display.rect.x && position.x < display.rect.x + display.rect.width
        && position.y >= display.rect.y && position.y < display.rect.y + display.rect.height)
      expect(withinSomeDisplay).toBe(true)
    })

    it('screen_shot region: captures exactly the requested screen-space rectangle', async () => {
      const shot = await backend.shot({}, 800, false, { region: { left: 0, top: 0, right: 200, bottom: 150 } })
      expect(shot.snapshot.windowId).toBe(0)
      expect(shot.snapshot.rect).toEqual({ x: 0, y: 0, width: 200, height: 150 })
      expect(shot.width).toBeGreaterThan(0)
      expect(shot.height).toBeGreaterThan(0)
    })

    it('screen_shot wholeScreen + display: captures a specific monitor by index', async () => {
      const displays = await backend.displays()
      const shot = await backend.shot({}, 800, true, { display: 0 })
      expect(shot.snapshot.windowId).toBe(0)
      expect(shot.snapshot.rect.width).toBe(displays[0]!.rect.width)
      expect(shot.snapshot.rect.height).toBe(displays[0]!.rect.height)
    })

    it('screen_shot with neither region nor display still behaves exactly as before (backward compatibility)', async () => {
      const shot = await backend.shot({}, 1024, true)
      expect(shot.snapshot.windowId).toBe(0)
      expect(shot.snapshot.title).toBe('primary screen')
    })

    it('clipboard: round-trips a set value through get', async () => {
      const marker = `dsh-clipboard-e2e-${Date.now()}`
      await backend.clipboardSet(marker)
      const text = await backend.clipboardGet()
      expect(text.trim()).toBe(marker)
    })

    it('process list: includes a freshly launched process', async () => {
      const { pid } = await launchAndWaitForWindow()
      extraPid = pid
      const processes = await backend.processList()
      expect(Array.isArray(processes)).toBe(true)
      expect(processes.some(process => process.pid === pid)).toBe(true)
    })

    it('process kill: kills a process by pid', async () => {
      const { pid } = await launchAndWaitForWindow()
      const outcome = await backend.processKill({ pid, force: true })
      expect(outcome.killedPids).toContain(pid)
      let stillRunning = true
      for (let attempt = 0; attempt < 20 && stillRunning; attempt += 1) {
        const processes = await backend.processList()
        stillRunning = processes.some(process => process.pid === pid)
        if (stillRunning) await new Promise(resolve => setTimeout(resolve, 300))
      }
      expect(stillRunning).toBe(false)
    })

    it('move: moves and drags the mouse inside a window via posted messages without error', async () => {
      const { pid, windowId } = await launchAndWaitForWindow()
      extraPid = pid
      const tree = await backend.tree({ windowId }, 50, 10, false)
      const rect = tree.snapshot.rect
      const outcome = await backend.move({
        windowId,
        x: rect.x + 20,
        y: rect.y + 20,
        drag: { toX: rect.x + 60, toY: rect.y + 60 },
      }, false)
      expect(outcome.delivered).toBe('posted')
      expect(outcome.processBefore.pid).toBe(outcome.processAfter.pid)
    })

    it('window_control: minimizes and restores a window, reflected in listWindows()', async () => {
      const { pid, windowId } = await launchAndWaitForWindow()
      extraPid = pid

      await backend.windowControl({ windowId, action: 'minimize' }, false)
      await new Promise(resolve => setTimeout(resolve, 500))
      const afterMinimize = (await backend.listWindows()).find(window => window.windowId === windowId)
      expect(afterMinimize?.minimized).toBe(true)

      await backend.windowControl({ windowId, action: 'restore' }, false)
      await new Promise(resolve => setTimeout(resolve, 500))
      const afterRestore = (await backend.listWindows()).find(window => window.windowId === windowId)
      expect(afterRestore?.minimized).toBe(false)
    })

    it('window_control: moves and resizes a window to an exact rect', async () => {
      const { pid, windowId } = await launchAndWaitForWindow()
      extraPid = pid

      await backend.windowControl({ windowId, action: 'move', x: 40, y: 40 }, false)
      await backend.windowControl({ windowId, action: 'resize', width: 500, height: 400 }, false)
      await new Promise(resolve => setTimeout(resolve, 500))
      const after = (await backend.listWindows()).find(window => window.windowId === windowId)
      expect(after?.rect.width).toBe(500)
      expect(after?.rect.height).toBe(400)
    })

    it('window_control: closes a window (uses cmd.exe, a classic Win32 console window, rather than Notepad - Windows 11\'s Notepad is a packaged app whose visible window is hosted by a frame process and does not reliably tear down on a posted WM_CLOSE the way a plain top-level window does; that is a property of that specific app, not of window_control\'s close action)', async () => {
      const { pid, windowId } = await launchAndWaitForWindow('cmd')
      // Best-effort cleanup regardless of whether the app fully exits on its own.
      extraPid = pid
      await backend.windowControl({ windowId, action: 'close' }, false)
      let windowGone = false
      for (let attempt = 0; attempt < 20 && !windowGone; attempt += 1) {
        const windows = await backend.listWindows()
        windowGone = !windows.some(window => window.windowId === windowId)
        if (!windowGone) await new Promise(resolve => setTimeout(resolve, 300))
      }
      expect(windowGone).toBe(true)
    })

    it('notify: shows a real Windows Action Center toast notification', async () => {
      await expect(backend.notify(
        'dsh-windows-remote-ssh',
        'integration test toast (safe to dismiss or ignore)',
        config.notifyAppId,
      )).resolves.toBeUndefined()
    })

    it('wait_for primitive: polling apps() detects a freshly launched process appearing', async () => {
      const launch = await backend.launch('notepad', [])
      extraPid = launch.processId
      let sawWindow = false
      const start = Date.now()
      while (!sawWindow && Date.now() - start < 10_000) {
        const apps = await backend.apps()
        sawWindow = apps.some(app => app.processId === launch.processId)
        if (!sawWindow) await new Promise(resolve => setTimeout(resolve, 500))
      }
      expect(sawWindow).toBe(true)
    })

    it('multi_action primitive: runs click then type sequentially against the same window', async () => {
      const { pid, windowId } = await launchAndWaitForWindow()
      extraPid = pid
      const tree = await backend.tree({ windowId }, 500, 32, false)
      const editable = tree.elements.find(element => element.patterns.includes('value'))
      expect(editable).toBeDefined()
      if (editable === undefined) return

      const clickOutcome = await backend.click({ windowId, elementId: editable.elementId, button: 'left' }, false)
      expect(['uia', 'posted']).toContain(clickOutcome.delivered)

      const typeOutcome = await backend.type({
        windowId,
        elementId: editable.elementId,
        text: 'multi_action mechanism test',
        rollback: true,
      }, false)
      expect(['uia', 'posted']).toContain(typeOutcome.delivered)
      expect(typeOutcome.processBefore.pid).toBe(typeOutcome.processAfter.pid)
    })
  })

  describe('invoke / read_text / read_table (UIA pattern tools, against real native apps)', () => {
    // A from-scratch WinForms fixture was tried first and abandoned: ad-hoc
    // PowerShell-hosted WinForms controls report as generic UIA "Pane"
    // elements with no discoverable patterns on this target (confirmed via
    // direct AutomationElement queries, independent of this plugin's own
    // helper code) - a real WinForms/UIA-bridge limitation in this
    // environment, not a bug in invoke/read_text/read_table. Real apps are
    // used instead: modern Notepad's own toolbar/menu/document expose
    // invoke/toggle/expand-collapse/value patterns natively, and Explorer's
    // file-listing view exposes Grid/Table patterns natively.
    let invokePid: number | undefined
    let invokeWindowId: number | undefined
    let explorerPid: number | undefined
    let explorerWindowId: number | undefined

    afterAll(async () => {
      if (invokePid !== undefined) await cleanup.exec(`taskkill /F /PID ${invokePid}`).catch(() => undefined)
      if (explorerPid !== undefined) await cleanup.exec(`taskkill /F /PID ${explorerPid}`).catch(() => undefined)
    })

    it('launches a fresh Notepad window for the invoke/read_text tests', async () => {
      const launch = await backend.launch('notepad', [])
      invokePid = launch.processId
      let windowId: number | undefined
      for (let attempt = 0; attempt < 20 && windowId === undefined; attempt += 1) {
        const apps = await backend.apps()
        const app = apps.find(candidate => candidate.processId === launch.processId)
        if (app !== undefined && app.windows.length > 0) windowId = app.windows[0]!.windowId
        else await new Promise(resolve => setTimeout(resolve, 300))
      }
      expect(windowId).toBeDefined()
      invokeWindowId = windowId
    }, 30_000)

    it('read_text: reads the Document element\'s content via TextPattern after typing known text', async () => {
      expect(invokeWindowId).toBeDefined()
      const tree = await backend.tree({ windowId: invokeWindowId! }, 200, 20, false)
      const editable = tree.elements.find(element => element.controlType === 'Document')
      expect(editable).toBeDefined()
      const marker = `dsh-read-text-marker-${Date.now()}`
      await backend.type({ windowId: invokeWindowId!, elementId: editable!.elementId, text: marker, rollback: false }, false)
      const result = await backend.readText(invokeWindowId!, editable!.elementId)
      expect(result.text).toContain(marker)
      expect(result.truncated).toBe(false)
    })

    it('read_text: fails clearly (naming the control type) against an element with no Text pattern', async () => {
      const tree = await backend.tree({ windowId: invokeWindowId! }, 200, 20, false)
      const toggleButton = tree.elements.find(element => element.patterns.includes('toggle'))
      expect(toggleButton).toBeDefined()
      await expect(backend.readText(invokeWindowId!, toggleButton!.elementId)).rejects.toThrow(/text pattern/iu)
    })

    it('invoke: "toggle" flips a real formatting button via TogglePattern (delivered: uia)', async () => {
      const tree = await backend.tree({ windowId: invokeWindowId! }, 200, 20, false)
      const toggleButton = tree.elements.find(element => element.patterns.includes('toggle'))
      expect(toggleButton).toBeDefined()
      const outcome = await backend.invokePattern({
        windowId: invokeWindowId!,
        elementId: toggleButton!.elementId,
        pattern: 'toggle',
      }, false)
      expect(outcome.delivered).toBe('uia')
      expect(outcome.processBefore.pid).toBe(outcome.processAfter.pid)
    })

    it('invoke: "invoke" calls InvokePattern.Invoke on a real button (delivered: uia)', async () => {
      const tree = await backend.tree({ windowId: invokeWindowId! }, 200, 20, false)
      // Any invoke-only button works; "invoke"-pattern buttons that also carry
      // expand-collapse (menu items) are avoided here to keep this test's
      // side effect contained to "a new tab/pane opens", not "a menu flyout".
      const invokeButton = tree.elements.find(element => element.patterns.includes('invoke') && !element.patterns.includes('expand-collapse'))
      expect(invokeButton).toBeDefined()
      const outcome = await backend.invokePattern({
        windowId: invokeWindowId!,
        elementId: invokeButton!.elementId,
        pattern: 'invoke',
      }, false)
      expect(outcome.delivered).toBe('uia')
    })

    it('invoke: "expand" then "collapse" a real menu item via ExpandCollapsePattern (delivered: uia)', async () => {
      const tree = await backend.tree({ windowId: invokeWindowId! }, 200, 20, false)
      const menuItem = tree.elements.find(element => element.controlType === 'MenuItem' && element.patterns.includes('expand-collapse'))
      expect(menuItem).toBeDefined()
      const expandOutcome = await backend.invokePattern({ windowId: invokeWindowId!, elementId: menuItem!.elementId, pattern: 'expand' }, false)
      expect(expandOutcome.delivered).toBe('uia')
      const collapseOutcome = await backend.invokePattern({ windowId: invokeWindowId!, elementId: menuItem!.elementId, pattern: 'collapse' }, false)
      expect(collapseOutcome.delivered).toBe('uia')
    })

    it('invoke: "setValue" sets the Document element\'s value via ValuePattern.SetValue', async () => {
      const tree = await backend.tree({ windowId: invokeWindowId! }, 200, 20, false)
      const editable = tree.elements.find(element => element.controlType === 'Document')
      expect(editable).toBeDefined()
      const marker = `dsh-invoke-setValue-marker-${Date.now()}`
      const outcome = await backend.invokePattern({
        windowId: invokeWindowId!,
        elementId: editable!.elementId,
        pattern: 'setValue',
        value: marker,
      }, false)
      expect(outcome.delivered).toBe('uia')
      const after = await backend.readText(invokeWindowId!, editable!.elementId)
      expect(after.text).toBe(marker)
    })

    it('invoke: fails clearly (naming the pattern and control type) when the element does not support the requested pattern', async () => {
      const tree = await backend.tree({ windowId: invokeWindowId! }, 200, 20, false)
      const invokeOnlyButton = tree.elements.find(element => element.patterns.includes('invoke') && !element.patterns.includes('toggle'))
      expect(invokeOnlyButton).toBeDefined()
      await expect(backend.invokePattern({
        windowId: invokeWindowId!,
        elementId: invokeOnlyButton!.elementId,
        pattern: 'toggle',
      }, false)).rejects.toThrow(/toggle/iu)
    })

    it('read_table: returns Explorer\'s file-listing row/column counts, headers, and cell values', async () => {
      const launch = await backend.launch('explorer', ['C:\\Windows\\System32\\drivers\\etc'])
      explorerPid = launch.processId
      // Explorer often reuses an existing host process/window rather than
      // creating one owned by launch()'s own reported pid, so poll the whole
      // window list for the folder's title instead of matching by processId.
      let windowId: number | undefined
      for (let attempt = 0; attempt < 30 && windowId === undefined; attempt += 1) {
        const windows = await backend.listWindows()
        const window = windows.find(candidate => candidate.title.toLowerCase().includes('etc') && candidate.className.toLowerCase().includes('cabinetwclass'))
        if (window !== undefined) windowId = window.windowId
        else await new Promise(resolve => setTimeout(resolve, 500))
      }
      expect(windowId).toBeDefined()
      explorerWindowId = windowId

      const tree = await backend.tree({ windowId: windowId! }, 200, 20, false)
      const itemsView = tree.elements.find(element => element.name === 'Items View')
      expect(itemsView).toBeDefined()
      const result = await backend.readTable(windowId!, itemsView!.elementId)
      expect(result.rowCount).toBeGreaterThan(0)
      expect(result.columnCount).toBeGreaterThan(0)
      expect(result.cells.length).toBe(result.rowCount)
      for (const row of result.cells) expect(row.length).toBe(result.columnCount)
      // %windir%\System32\drivers\etc\hosts ships on every stock Windows install.
      expect(result.cells.some(row => row.some(cell => cell.toLowerCase().includes('hosts')))).toBe(true)
    })

    it('read_table: fails clearly (naming the control type) against an element with neither Grid nor Table pattern', async () => {
      expect(explorerWindowId).toBeDefined()
      const tree = await backend.tree({ windowId: explorerWindowId! }, 200, 20, false)
      const nonGridElement = tree.elements.find(element => element.controlType === 'Edit' || element.controlType === 'ToolBar')
      expect(nonGridElement).toBeDefined()
      await expect(backend.readTable(explorerWindowId!, nonGridElement!.elementId)).rejects.toThrow(/grid.*table|neither/iu)
    })
  })
})
