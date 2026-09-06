/**
 * The two readings of a status, and the one label map.
 *
 * These look like tautologies and are not. Each one is a list written by hand
 * beside a frozen vocabulary, and the failure they guard against is a status
 * or a priority added to `contracts/states.ts` that nothing here ever hears
 * about: a new terminal status would silently become one a cancelled task can
 * be cancelled from again, and a new priority would render as `undefined` in a
 * stored audit sentence.
 */

import { describe, expect, it } from 'vitest'

import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskStatus,
} from '../contracts/states'

import {
  INITIAL_TASK_STATUSES,
  SETTLED_TASK_STATUSES,
  TASK_PRIORITY_LABELS,
  isSettled,
} from './types'

describe('the statuses a task may be born in', () => {
  it('are all real statuses', () => {
    for (const status of INITIAL_TASK_STATUSES) {
      expect(TASK_STATUSES).toContain(status)
    }
  })

  it('are only the two nobody has acted on yet', () => {
    // Anything else is a transition somebody performs, and the trigger in 0011
    // stamps `started_at`, `completed_at` and `verified_at` from those. A
    // creation form offering one would ask the database to invent a moment.
    expect([...INITIAL_TASK_STATUSES]).toEqual(['new', 'assigned'])
  })

  it('never overlap the statuses that mean the job is over', () => {
    for (const status of INITIAL_TASK_STATUSES) {
      expect(isSettled(status)).toBe(false)
    }
  })
})

describe('the statuses that mean the job is over', () => {
  it('are all real statuses', () => {
    for (const status of SETTLED_TASK_STATUSES) {
      expect(TASK_STATUSES).toContain(status)
    }
  })

  it('agree with the reading of them', () => {
    for (const status of TASK_STATUSES) {
      expect(isSettled(status)).toBe(SETTLED_TASK_STATUSES.includes(status))
    }
  })

  it('leave the states somebody is still working in open', () => {
    const open: readonly TaskStatus[] = [
      'new',
      'assigned',
      'accepted',
      'in_progress',
      'blocked',
      'awaiting_approval',
    ]
    for (const status of open) expect(isSettled(status)).toBe(false)
  })
})

describe('the priority labels', () => {
  it('name every priority, in Hebrew', () => {
    for (const priority of TASK_PRIORITIES) {
      const label = TASK_PRIORITY_LABELS[priority]
      expect(label).toBeTruthy()
      // Hebrew, because the label goes into a stored audit sentence a manager
      // reads, and never into a log line.
      expect(label).toMatch(/[֐-׿]/)
    }
  })

  it('names nothing that is not a priority', () => {
    expect(Object.keys(TASK_PRIORITY_LABELS).sort()).toEqual(
      [...TASK_PRIORITIES].sort(),
    )
  })
})
