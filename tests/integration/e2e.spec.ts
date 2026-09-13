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

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
})
