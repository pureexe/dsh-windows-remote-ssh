import { describe, expect, it } from 'vitest'
import { detectImageMediaType, looksLikeText } from '../../src/filesystem.ts'

describe('detectImageMediaType', () => {
  it('identifies a PNG by its magic bytes', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
    expect(detectImageMediaType(png)).toBe('image/png')
  })

  it('identifies a JPEG by its magic bytes', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    expect(detectImageMediaType(jpeg)).toBe('image/jpeg')
  })

  it('identifies a GIF by its magic bytes', () => {
    const gif = Buffer.from('GIF89a', 'ascii')
    expect(detectImageMediaType(gif)).toBe('image/gif')
  })

  it('identifies a WEBP by its RIFF/WEBP framing', () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]), // size field, irrelevant to detection
      Buffer.from('WEBP', 'ascii'),
    ])
    expect(detectImageMediaType(webp)).toBe('image/webp')
  })

  it('returns undefined for plain text', () => {
    expect(detectImageMediaType(Buffer.from('hello world', 'utf8'))).toBeUndefined()
  })

  it('returns undefined for a too-short buffer', () => {
    expect(detectImageMediaType(Buffer.from([0x89, 0x50]))).toBeUndefined()
  })

  it('does not misidentify a RIFF file that is not WEBP (e.g. a WAV)', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'ascii'),
    ])
    expect(detectImageMediaType(wav)).toBeUndefined()
  })
})

describe('looksLikeText', () => {
  it('accepts plain ASCII text', () => {
    expect(looksLikeText(Buffer.from('hello world\n', 'utf8'))).toBe(true)
  })

  it('accepts valid multi-byte UTF-8', () => {
    expect(looksLikeText(Buffer.from('héllo 世界', 'utf8'))).toBe(true)
  })

  it('rejects a PNG (binary, invalid as UTF-8)', () => {
    // A real PNG signature followed by typically-invalid-UTF-8 IDAT-ish bytes.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01])
    expect(looksLikeText(png)).toBe(false)
  })

  it('rejects a lone invalid UTF-8 continuation byte', () => {
    expect(looksLikeText(Buffer.from([0x80, 0x80, 0x80]))).toBe(false)
  })

  it('rejects a truncated multi-byte sequence', () => {
    // 0xE2 0x82 alone is an incomplete 3-byte UTF-8 sequence (missing the third byte of e.g. €).
    expect(looksLikeText(Buffer.from([0xe2, 0x82]))).toBe(false)
  })

  it('accepts an empty buffer', () => {
    expect(looksLikeText(Buffer.alloc(0))).toBe(true)
  })
})
