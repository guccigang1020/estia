import { describe, expect, it } from 'vitest'

import { PROPERTY_TIME_ZONE } from '../../../booking/dates'
import type { DetectorContext } from '../facts'
import { ALL_MODULES, NO_MODULES, type EnabledModules } from '../modules'

import { detectCleaning, type CleaningFacts } from './cleaning'

const NOW = new Date('2026-09-12T10:42:00.000Z')

function context(modules: EnabledModules = ALL_MODULES): DetectorContext {
  return { modules, now: NOW, timeZone: PROPERTY_TIME_ZONE }
}

function job(overrides: Partial<CleaningFacts> = {}): CleaningFacts {
  return {
    taskId: 'task-1',
    bookingId: 'booking-1',
    propertyId: 'villa-1',
    label: 'וילה ים',
    status: 'in_progress',
    assigneeId: 'user-1',
    acceptedAt: '2026-09-12T08:00:00.000Z',
    startedAt: '2026-09-12T09:00:00.000Z',
    completedAt: null,
    verifiedAt: null,
    inspectionRequired: false,
    dueAt: '2026-09-12T12:00:00.000Z',
    blockedReason: null,
    ...overrides,
  }
}

describe('detectCleaning', () => {
  it('says nothing for a business with no cleaning module', () => {
    expect(
      detectCleaning([job({ assigneeId: null })], context(NO_MODULES)),
    ).toHaveLength(0)
  })

  it('says nothing about a job that is going fine', () => {
    expect(detectCleaning([job()], context())).toHaveLength(0)
  })

  it('ignores a cancelled job', () => {
    expect(
      detectCleaning(
        [job({ status: 'cancelled', assigneeId: null })],
        context(),
      ),
    ).toHaveLength(0)
  })
})

describe('the two conversations', () => {
  it('sends an unassigned job to whoever does the rota', () => {
    const signal = detectCleaning(
      [job({ assigneeId: null, acceptedAt: null, startedAt: null })],
      context(),
    )[0]
    expect(signal?.code).toBe('cleaning.unassigned')
    expect(signal?.domain).toBe('staff')
  })

  it('does not also complain that an unassigned job was not accepted', () => {
    const signals = detectCleaning(
      [job({ assigneeId: null, acceptedAt: null, startedAt: null })],
      context(),
    )
    expect(signals).toHaveLength(1)
  })

  it('sends an unaccepted job to staff and a stalled one to preparation', () => {
    const unaccepted = detectCleaning(
      [job({ acceptedAt: null, startedAt: null, status: 'assigned' })],
      context(),
    )[0]
    const notStarted = detectCleaning(
      [job({ startedAt: null, status: 'accepted' })],
      context(),
    )[0]

    expect(unaccepted?.domain).toBe('staff')
    expect(notStarted?.domain).toBe('preparation')
  })
})

describe('blocked', () => {
  it('is critical and carries the reason the cleaner gave', () => {
    const signal = detectCleaning(
      [job({ status: 'blocked', blockedReason: 'המצעים לא הגיעו' })],
      context(),
    )[0]
    expect(signal?.risk).toBe('critical')
    expect(signal?.detail).toBe('המצעים לא הגיעו')
  })

  it('says so plainly when nobody recorded a reason', () => {
    const signal = detectCleaning([job({ status: 'blocked' })], context())[0]
    expect(signal?.detail).toContain('ללא סיבה שנרשמה')
  })

  it('is not also reported as not started', () => {
    const signals = detectCleaning(
      [job({ status: 'blocked', startedAt: null })],
      context(),
    )
    expect(signals.map((signal) => signal.code)).toEqual(['cleaning.blocked'])
  })
})

describe('the inspection', () => {
  const finished = job({
    status: 'completed',
    completedAt: '2026-09-12T10:00:00.000Z',
    inspectionRequired: true,
  })

  it('is asked for where the business requires one', () => {
    expect(detectCleaning([finished], context())[0]?.code).toBe(
      'cleaning.inspection_missing',
    )
  })

  it('is never asked of a business that inspects nothing', () => {
    expect(
      detectCleaning(
        [finished],
        context({ ...ALL_MODULES, inspection: false }),
      ),
    ).toHaveLength(0)
    expect(
      detectCleaning([{ ...finished, inspectionRequired: false }], context()),
    ).toHaveLength(0)
  })

  it('is satisfied once it has been verified', () => {
    expect(
      detectCleaning(
        [
          {
            ...finished,
            status: 'verified',
            verifiedAt: '2026-09-12T10:30:00.000Z',
          },
        ],
        context(),
      ),
    ).toHaveLength(0)
  })
})

describe('keys', () => {
  it('are keyed on the task, so two jobs on one stay do not collide', () => {
    const signals = detectCleaning(
      [
        job({ taskId: 'task-1', assigneeId: null }),
        job({ taskId: 'task-2', assigneeId: null }),
      ],
      context(),
    )
    expect(new Set(signals.map((signal) => signal.dedupeKey)).size).toBe(2)
  })

  it('are stable across passes', () => {
    const facts = job({ startedAt: null, status: 'accepted' })
    const first = detectCleaning([facts], context())[0]
    const second = detectCleaning([facts], {
      ...context(),
      now: new Date(NOW.getTime() + 300_000),
    })[0]
    expect(first?.dedupeKey).toBe(second?.dedupeKey)
    expect(first?.dedupeKey).toBe('cleaning.not_started:task:task-1')
  })
})
