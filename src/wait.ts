/**
 * Pure matching helpers for `wait_for` conditions: whether one accessibility
 * element or one window listing entry matches the condition the model asked
 * to wait for. Kept separate from `tools.ts` (which owns the actual polling
 * loop and backend calls) so this matching logic is directly unit-testable,
 * the same way `filesystem.ts` keeps `filesystem_pull`'s classification pure.
 *
 * @module dsh-windows-remote-ssh/wait
 */

/** Substring match fields for an "element appears" `wait_for` condition. At least one must be given. */
export interface ElementMatch {
  name?: string
  automationId?: string
  controlType?: string
}

/** Substring match fields for a "window appears" `wait_for` condition. */
export interface WindowMatch {
  title?: string
}

/** Case-insensitive substring containment. */
function includesFold(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

/**
 * Whether one accessibility element satisfies an "element appears" match.
 * Every given field must match (case-insensitive substring); at least one
 * field must be given at all, or nothing can ever match.
 *
 * @param element - the candidate element's name/automationId/controlType.
 * @param match - the condition's match fields.
 * @returns whether the element matches.
 */
export function elementMatches(element: { name: string; automationId: string; controlType: string }, match: ElementMatch): boolean {
  if (match.name === undefined && match.automationId === undefined && match.controlType === undefined) return false
  if (match.name !== undefined && !includesFold(element.name, match.name)) return false
  if (match.automationId !== undefined && !includesFold(element.automationId, match.automationId)) return false
  if (match.controlType !== undefined && !includesFold(element.controlType, match.controlType)) return false
  return true
}

/**
 * Whether one window listing entry satisfies a "window appears" match.
 *
 * @param window - the candidate window's title.
 * @param match - the condition's match fields.
 * @returns whether the window matches.
 */
export function windowMatches(window: { title: string }, match: WindowMatch): boolean {
  if (match.title === undefined) return false
  return includesFold(window.title, match.title)
}
