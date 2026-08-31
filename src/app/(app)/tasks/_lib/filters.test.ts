/**
 * The filter, as a pure function of the URL.
 *
 * The assertion that matters is the last one in the first block: a value that
 * is not in the frozen tuple is *dropped*, not passed through. A hand-edited
 * `?status=done` reaching PostgREST comes back as a database error about an
 * enum, which is a sentence no user can act on and a stack trace in a log
 * nobody reads.
 */

import { describe, expect, it } from 'vitest'

import {
  TASK_PRIORITY_LABEL,
  TASK_STATUS_LABEL,
  TASK_TYPE_LABEL,
} from '@/components/preparation/task-status'

import {
  NO_TASK_FILTER,
  describeTaskFilter,
  hasActiveTaskFilter,
  parseTaskFilter,
} from './filters'

const LABELS = {
  status: TASK_STATUS_LABEL,
  type: TASK_TYPE_LABEL,
  priority: TASK_PRIORITY_LABEL,
}

describe('reading the filter out of the URL', () => {
  it('reads all three axes', () => {
    expect(
      parseTaskFilter({
        status: 'blocked',
        type: 'maintenance',
        priority: 'critical',
      }),
    ).toEqual({
      status: 'blocked',
      type: 'maintenance',
      priority: 'critical',
    })
  })

  it('treats an absent key as no filter', () => {
    expect(parseTaskFilter({})).toEqual(NO_TASK_FILTER)
  })

  it('takes the first of a repeated key rather than crashing on the array', () => {
    expect(parseTaskFilter({ status: ['blocked', 'new'] }).status).toBe(
      'blocked',
    )
  })

  it('drops a value the contract does not contain', () => {
    expect(
      parseTaskFilter({ status: 'done', type: 'plumbing', priority: 'urgent' }),
    ).toEqual(NO_TASK_FILTER)
  })
})

describe('whether anything is hiding rows', () => {
  it('counts the property switcher as a filter', () => {
    // The one the reader is most likely to have forgotten about. Getting this
    // wrong tells a business with forty open jobs that it has never had one.
    expect(hasActiveTaskFilter(NO_TASK_FILTER, 'property-1')).toBe(true)
  })

  it('is false when nothing is set at all', () => {
    expect(hasActiveTaskFilter(NO_TASK_FILTER, null)).toBe(false)
  })

  it('is true for any one axis', () => {
    expect(
      hasActiveTaskFilter({ ...NO_TASK_FILTER, priority: 'high' }, null),
    ).toBe(true)
  })
})

describe('saying the filter back to the person it is hiding data from', () => {
  it('names the property, the type, the status and the priority', () => {
    expect(
      describeTaskFilter(
        { status: 'blocked', type: 'maintenance', priority: 'critical' },
        LABELS,
        'אחוזת רימונים',
      ),
    ).toBe('אחוזת רימונים · תחזוקה · תקועה · עדיפות קריטית')
  })

  it('says nothing when nothing is set', () => {
    expect(describeTaskFilter(NO_TASK_FILTER, LABELS, null)).toBe('')
  })
})
