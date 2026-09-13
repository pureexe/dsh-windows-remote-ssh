import { describe, expect, it } from 'vitest'
import { elementMatches, windowMatches } from '../../src/wait.ts'

describe('elementMatches', () => {
  const element = { name: 'Save As', automationId: 'SaveButton', controlType: 'Button' }

  it('matches by name substring, case-insensitively', () => {
    expect(elementMatches(element, { name: 'save' })).toBe(true)
  })

  it('matches by automationId substring', () => {
    expect(elementMatches(element, { automationId: 'savebutton' })).toBe(true)
  })

  it('matches by controlType substring', () => {
    expect(elementMatches(element, { controlType: 'button' })).toBe(true)
  })

  it('requires every given field to match (AND, not OR)', () => {
    expect(elementMatches(element, { name: 'save', controlType: 'Edit' })).toBe(false)
    expect(elementMatches(element, { name: 'save', controlType: 'Button' })).toBe(true)
  })

  it('never matches when no field is given at all', () => {
    expect(elementMatches(element, {})).toBe(false)
  })

  it('does not match an unrelated substring', () => {
    expect(elementMatches(element, { name: 'Cancel' })).toBe(false)
  })
})

describe('windowMatches', () => {
  it('matches by title substring, case-insensitively', () => {
    expect(windowMatches({ title: 'Untitled - Notepad' }, { title: 'notepad' })).toBe(true)
  })

  it('does not match an unrelated title', () => {
    expect(windowMatches({ title: 'Calculator' }, { title: 'notepad' })).toBe(false)
  })

  it('never matches when no title is given', () => {
    expect(windowMatches({ title: 'Calculator' }, {})).toBe(false)
  })
})
