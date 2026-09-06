/**
 * What the barrel may and may not hand out.
 *
 * The second test is the one that matters. `scripts/client-bundle.mjs` records
 * a Client Component importing a module barrel, reaching a repository through
 * it and taking every route in the product down with `Can't resolve 'fs'` —
 * three times in one day, from a file nobody had touched. Naming the adapter
 * here would be the first step of that again, so it is asserted absent rather
 * than remembered.
 */

import { describe, expect, it } from 'vitest'

import * as tasks from './index'

describe('the public surface', () => {
  it('offers the four operations a caller builds', () => {
    expect(typeof tasks.defineTaskCreation).toBe('function')
    expect(typeof tasks.defineTaskAssignment).toBe('function')
    expect(typeof tasks.defineTaskPriorityChange).toBe('function')
    expect(typeof tasks.defineTaskCancellation).toBe('function')
  })

  it('does not hand out the database adapter', () => {
    expect(Object.keys(tasks)).not.toContain('SupabaseTaskRepository')
    expect(Object.keys(tasks)).not.toContain('taskFromRow')
    expect(Object.keys(tasks)).not.toContain('assignmentFromRow')
  })

  it('exports the vocabulary readings a screen legitimately wants', () => {
    expect(tasks.INITIAL_TASK_STATUSES).toContain('new')
    expect(tasks.SETTLED_TASK_STATUSES).toContain('cancelled')
    expect(tasks.TASK_PRIORITY_LABELS.critical).toBe('קריטית')
    expect(tasks.isSettled('completed')).toBe(true)
  })
})
