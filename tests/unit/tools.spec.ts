import { describe, expect, it } from 'vitest'
import { assertHardwareAllowed, resolveScreenshotMaxSide, shotScaleNote, type ObservedWindowValue } from '../../src/tools.ts'
import { MAX_SCREENSHOT_SIDE, MIN_SCREENSHOT_SIDE, resolveConfig } from '../../src/config.ts'

function observedWindow(overrides: Partial<ObservedWindowValue['rect']> = {}): ObservedWindowValue {
  return {
    windowId: 1,
    processId: 100,
    title: 'VRoid Studio 2.14.0',
    className: 'Qt5QWindowIcon',
    executablePath: 'C:\\Users\\me\\AppData\\Local\\Programs\\VRoidStudio\\VRoidStudio.exe',
    rect: { x: 100, y: 50, width: 3440, height: 1440, ...overrides },
    foreground: true,
  }
}

describe('resolveScreenshotMaxSide', () => {
  it('falls back to the configured default when maxSide is omitted', () => {
    expect(resolveScreenshotMaxSide(undefined, 1600)).toBe(1600)
  })

  it('honors an explicit maxSide above the configured default (regression: used to be silently clamped down to it)', () => {
    expect(resolveScreenshotMaxSide(3440, 1600)).toBe(3440)
  })

  it('honors an explicit maxSide below the configured default too', () => {
    expect(resolveScreenshotMaxSide(800, 1600)).toBe(800)
  })

  it('accepts the absolute min/max bounds', () => {
    expect(resolveScreenshotMaxSide(MIN_SCREENSHOT_SIDE, 1600)).toBe(MIN_SCREENSHOT_SIDE)
    expect(resolveScreenshotMaxSide(MAX_SCREENSHOT_SIDE, 1600)).toBe(MAX_SCREENSHOT_SIDE)
  })

  it('rejects a maxSide outside the absolute bounds', () => {
    expect(() => resolveScreenshotMaxSide(MAX_SCREENSHOT_SIDE + 1, 1600)).toThrow(/maxSide/iu)
    expect(() => resolveScreenshotMaxSide(MIN_SCREENSHOT_SIDE - 1, 1600)).toThrow(/maxSide/iu)
  })

  it('rejects a non-integer maxSide', () => {
    expect(() => resolveScreenshotMaxSide(1600.5, 1600)).toThrow(/maxSide/iu)
  })
})

describe('shotScaleNote', () => {
  it('returns undefined when the image matches the real captured size (no downscaling)', () => {
    expect(shotScaleNote(observedWindow(), 3440, 1440)).toBeUndefined()
  })

  it('warns with the real size/origin and the exact conversion when the image was downscaled', () => {
    const note = shotScaleNote(observedWindow(), 1600, 670)
    expect(note).toBeDefined()
    expect(note).toContain('1600x670')
    expect(note).toContain('3440x1440')
    expect(note).toContain('(100, 50)')
    // scaleX = 3440/1600 = 2.15, scaleY = 1440/670 ≈ 2.1493
    expect(note).toContain('2.1500')
    expect(note).toContain('2.1493')
  })

  it('returns undefined for a zero-sized image (nothing sensible to convert)', () => {
    expect(shotScaleNote(observedWindow(), 0, 0)).toBeUndefined()
  })

  it('warns even when only one dimension differs (e.g. a portrait capture whose height alone was capped)', () => {
    const note = shotScaleNote(observedWindow({ width: 652, height: 1600 }), 652, 1600)
    expect(note).toBeUndefined()
    const downscaledHeightOnly = shotScaleNote(observedWindow({ width: 652, height: 1600 }), 652, 800)
    expect(downscaledHeightOnly).toBeDefined()
    expect(downscaledHeightOnly).toContain('652x1600')
  })
})

describe('assertHardwareAllowed', () => {
  it('is a no-op (returns false) when hardware is not requested, regardless of config', () => {
    expect(assertHardwareAllowed(resolveConfig({ allowHardwareInput: false }), undefined)).toBe(false)
    expect(assertHardwareAllowed(resolveConfig({ allowHardwareInput: true }), undefined)).toBe(false)
    expect(assertHardwareAllowed(resolveConfig({ allowHardwareInput: false }), false)).toBe(false)
  })

  it('refuses hardware: true with a clear, actionable error when allowHardwareInput is off (the default)', () => {
    const config = resolveConfig(undefined)
    expect(config.allowHardwareInput).toBe(false)
    expect(() => assertHardwareAllowed(config, true)).toThrow(/allowHardwareInput/u)
  })

  it('allows hardware: true through once allowHardwareInput is on', () => {
    const config = resolveConfig({ allowHardwareInput: true })
    expect(assertHardwareAllowed(config, true)).toBe(true)
  })
})
