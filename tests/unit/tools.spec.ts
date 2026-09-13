import { describe, expect, it } from 'vitest'
import { resolveScreenshotMaxSide } from '../../src/tools.ts'
import { MAX_SCREENSHOT_SIDE, MIN_SCREENSHOT_SIDE } from '../../src/config.ts'

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
