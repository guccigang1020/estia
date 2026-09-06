import { describe, expect, it } from 'vitest'

import {
  cancellationSummary,
  hasArrivedOrFinished,
  planCancellation,
  type CancellationInput,
} from './cancellation'
import { CONNECTOR_ID, aBooking, aReservation } from './testing'

const NOW = new Date('2026-03-01T10:00:00Z')

function input(patch: Partial<CancellationInput> = {}): CancellationInput {
  return {
    current: aBooking(),
    incoming: aReservation({ status: 'cancelled' }),
    connectorId: CONNECTOR_ID,
    now: NOW,
    propertyToday: '2026-03-01',
    ...patch,
  }
}

describe('cancelling twice', () => {
  it('is not an error and raises nothing', () => {
    // A redelivered cancellation, or one a person already made here. An
    // exception nobody needs to act on is what stops the queue being read.
    const plan = planCancellation(
      input({ current: aBooking({ status: 'cancelled' }) }),
    )

    expect(plan.kind).toBe('no_change')
    if (plan.kind !== 'no_change') return
    expect(plan.reason).toBe('already_cancelled')
  })
})

describe('a stay that has started', () => {
  it('is refused, because releasing it would empty an occupied unit', () => {
    const plan = planCancellation(
      input({ current: aBooking({ status: 'in_house' }) }),
    )

    expect(plan.kind).toBe('conflict')
    if (plan.kind !== 'conflict') return
    expect(plan.reason).toBe('stay_in_progress')
    expect(plan.exception.kind).toBe('cancellation_conflict')
    expect(plan.exception.severity).toBe('critical')
  })

  it('distinguishes a finished stay from one in progress', () => {
    const plan = planCancellation(
      input({ current: aBooking({ status: 'checked_out' }) }),
    )

    expect(plan.kind).toBe('conflict')
    if (plan.kind !== 'conflict') return
    expect(plan.reason).toBe('stay_completed')
  })

  it('knows which statuses mean the guest arrived', () => {
    expect(hasArrivedOrFinished('checked_in')).toBe(true)
    expect(hasArrivedOrFinished('completed')).toBe(true)
    expect(hasArrivedOrFinished('confirmed')).toBe(false)
    expect(hasArrivedOrFinished('option')).toBe(false)
  })
})

describe('a cancellation that applies', () => {
  it('names the operation, the version and the grant', () => {
    const plan = planCancellation(input())
    expect(plan.kind).toBe('apply')
    if (plan.kind !== 'apply') return

    expect(plan.command.operation).toBe('booking.cancel')
    expect(plan.command.requires).toBe('booking.cancel')
    expect(plan.command.expectedVersion).toBe(3)
  })

  it('lists everything that has to be released, not only the dates', () => {
    const plan = planCancellation(input())
    if (plan.kind !== 'apply') throw new Error('expected apply')

    expect(plan.downstream).toEqual([
      'availability',
      'preparation',
      'tasks',
      'laundry',
      'inventory',
      'access',
      'revenue',
    ])

    // Only the calendar looks after itself. Everything else is somebody's job.
    const automatic = plan.releases.filter((release) => release.automatic)
    expect(automatic).toHaveLength(1)
    expect(automatic[0].system).toBe('availability')
  })

  it('says less for a booking that never got as far as preparation', () => {
    const plan = planCancellation(
      input({ current: aBooking({ status: 'option' }) }),
    )
    if (plan.kind !== 'apply') throw new Error('expected apply')

    expect(plan.downstream).toEqual(['availability', 'revenue'])
  })

  it('is urgent when the arrival is close', () => {
    const plan = planCancellation(
      input({
        current: aBooking({
          stay: { checkIn: '2026-03-02', checkOut: '2026-03-05' },
        }),
      }),
    )
    if (plan.kind !== 'apply') throw new Error('expected apply')

    expect(plan.urgent).toBe(true)
  })

  it('is not urgent when the arrival is months away', () => {
    const plan = planCancellation(
      input({
        current: aBooking({
          stay: { checkIn: '2026-09-01', checkOut: '2026-09-05' },
        }),
      }),
    )
    if (plan.kind !== 'apply') throw new Error('expected apply')

    expect(plan.urgent).toBe(false)
  })

  it('treats an arrival already in the past as urgent', () => {
    // Somebody is probably preparing that unit right now.
    const plan = planCancellation(
      input({
        current: aBooking({
          stay: { checkIn: '2026-02-20', checkOut: '2026-02-23' },
        }),
      }),
    )
    if (plan.kind !== 'apply') throw new Error('expected apply')

    expect(plan.urgent).toBe(true)
  })

  it('summarises the affected systems in Hebrew', () => {
    const plan = planCancellation(input())
    expect(cancellationSummary(plan)).toContain('כביסה')
  })

  it('summarises nothing for a plan that does not apply', () => {
    const plan = planCancellation(
      input({ current: aBooking({ status: 'cancelled' }) }),
    )
    expect(cancellationSummary(plan)).toBe('')
  })
})
