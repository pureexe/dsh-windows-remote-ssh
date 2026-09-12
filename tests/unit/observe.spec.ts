import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config.ts'
import { ObservationStore } from '../../src/observe.ts'
import type { WindowSnapshot } from '../../src/platform/types.ts'

function snapshot(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    windowId: 1,
    processId: 100,
    executablePath: 'C:\\Windows\\notepad.exe',
    title: 'Untitled - Notepad',
    className: 'Notepad',
    rect: { x: 0, y: 0, width: 800, height: 600 },
    foreground: true,
    treeHash: 'abc',
    shotHash: 'def',
    elementCount: 3,
    ...overrides,
  }
}

const baseConfig = resolveConfig({ ssh: { host: 'h', user: 'u', password: 'p' } })
// resolveConfig always resolves `ssh` when host/user/password are given.
const target = baseConfig.ssh!

describe('ObservationStore', () => {
  it('records an observation and verifies it as fresh against an identical snapshot', () => {
    const store = new ObservationStore(baseConfig)
    const record = store.record(snapshot(), target)
    const verdict = store.verify(record, snapshot())
    expect(verdict.ok).toBe(true)
  })

  it('remembers which SSH target an observation came from', () => {
    const store = new ObservationStore(baseConfig)
    const record = store.record(snapshot(), target)
    expect(record.target).toBe(target)
  })

  it('refuses when the accessibility tree changed', () => {
    const store = new ObservationStore(baseConfig)
    const record = store.record(snapshot(), target)
    const verdict = store.verify(record, snapshot({ treeHash: 'different' }))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('STALE_TREE')
  })

  it('refuses when the pixels changed and staleCheckPixels is on', () => {
    const store = new ObservationStore(baseConfig)
    const record = store.record(snapshot(), target)
    const verdict = store.verify(record, snapshot({ shotHash: 'different' }))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('STALE_PIXELS')
  })

  it('ignores pixel drift when staleCheckPixels is off', () => {
    const config = resolveConfig({ ssh: { host: 'h', user: 'u', password: 'p' }, staleCheckPixels: false })
    const store = new ObservationStore(config)
    const record = store.record(snapshot(), target)
    const verdict = store.verify(record, snapshot({ shotHash: 'different' }))
    expect(verdict.ok).toBe(true)
  })

  it('refuses when the window identity changed', () => {
    const store = new ObservationStore(baseConfig)
    const record = store.record(snapshot(), target)
    const verdict = store.verify(record, snapshot({ processId: 999 }))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('STALE_IDENTITY')
  })

  it('refuses an expired observation', () => {
    const store = new ObservationStore(baseConfig)
    const record = store.record(snapshot(), target)
    const verdict = store.verify(record, snapshot(), record.observedAt + baseConfig.maxObservationAgeMs + 1)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('EXPIRED')
  })

  it('evicts the oldest observation once the cache cap is exceeded', () => {
    const config = resolveConfig({ ssh: { host: 'h', user: 'u', password: 'p' }, maxCachedObservations: 2 })
    const store = new ObservationStore(config)
    const first = store.record(snapshot({ windowId: 1 }), target)
    store.record(snapshot({ windowId: 2 }), target)
    store.record(snapshot({ windowId: 3 }), target)
    expect(store.get(first.id)).toBeUndefined()
  })
})
