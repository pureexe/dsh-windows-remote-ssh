import { describe, expect, it } from 'vitest'
import { redactSensitive, sanitizePath, sanitizeText, sanitizeVisible } from '../../src/sanitize.ts'

describe('sanitizeText', () => {
  it('strips control characters and truncates with a marker', () => {
    expect(sanitizeText('hello\u0007world', 20)).toBe('helloworld')
    expect(sanitizeText('a'.repeat(10), 5)).toBe('aaaa…')
  })

  it('collapses tabs to a single space', () => {
    expect(sanitizeText('a\t\t\tb', 20)).toBe('a b')
  })
})

describe('sanitizePath', () => {
  it('preserves the tail (filename side) when truncating', () => {
    const long = 'C:\\Users\\alice\\AppData\\Local\\Temp\\very-important-file.txt'
    const result = sanitizePath(long, 20)
    expect(result.length).toBe(20)
    expect(result.endsWith('file.txt')).toBe(true)
    expect(result.startsWith('…')).toBe(true)
  })
})

describe('redactSensitive', () => {
  it('redacts key=value credential assignments', () => {
    expect(redactSensitive('password=hunter2 ok')).toBe('password=[redacted] ok')
    expect(redactSensitive('api_key: sk-abc123')).toBe('api_key:[redacted]')
  })

  it('redacts JWTs and bearer tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    expect(redactSensitive(`token in body: ${jwt}`)).toContain('[redacted]')
    expect(redactSensitive('Authorization: Bearer abcdef1234567890')).toContain('Bearer [redacted]')
  })
})

describe('sanitizeVisible', () => {
  it('redacts then truncates', () => {
    const result = sanitizeVisible('password=hunter2secretvalue', 15)
    expect(result.endsWith('…')).toBe(true)
    expect(result).not.toContain('hunter2secretvalue')
  })
})
