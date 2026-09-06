import { describe, expect, it } from 'vitest'

import {
  DOWNSTREAM_FOR_FIELD,
  MODIFICATION_FIELDS,
  downstreamOf,
  planModification,
  type ModificationInput,
} from './modification'
import { DOWNSTREAM_SYSTEMS } from './types'
import { CONNECTOR_ID, aBooking, aReservation } from './testing'

const NOW = new Date('2026-02-05T10:00:00Z')

function input(patch: Partial<ModificationInput> = {}): ModificationInput {
  return {
    current: aBooking(),
    incoming: aReservation(),
    connectorId: CONNECTOR_ID,
    now: NOW,
    ...patch,
  }
}

describe('the delta', () => {
  it('is empty when nothing the business acts on moved', () => {
    expect(planModification(input()).kind).toBe('no_change')
  })

  it('names the dates that moved and everything they touch', () => {
    const plan = planModification(
      input({
        incoming: aReservation({
          stay: { checkIn: '2026-03-11', checkOut: '2026-03-15' },
        }),
      }),
    )

    expect(plan.kind).toBe('apply')
    if (plan.kind !== 'apply') return

    expect(plan.changes).toHaveLength(1)
    expect(plan.changes[0].field).toBe('dates')
    expect(plan.changes[0].description).toContain('2026-03-15')
    // A date change is not a date change. Laundry is the one nobody thinks of.
    expect(plan.downstream).toEqual([...DOWNSTREAM_SYSTEMS])
  })

  it('scales the operational systems with the guest count, not the calendar', () => {
    const plan = planModification(
      input({ incoming: aReservation({ guestCount: 6 }) }),
    )
    if (plan.kind !== 'apply') throw new Error('expected apply')

    expect(plan.downstream).not.toContain('availability')
    expect(plan.downstream).toContain('laundry')
    expect(plan.downstream).toContain('inventory')
  })

  it('reports several fields at once', () => {
    const plan = planModification(
      input({
        incoming: aReservation({
          guestCount: 5,
          guestName: 'דן כהן',
          grossAgorot: 350_000,
        }),
      }),
    )
    if (plan.kind !== 'apply') throw new Error('expected apply')

    expect(plan.changes.map((change) => change.field).sort()).toEqual([
      'guest_count',
      'guest_name',
      'price',
    ])
  })

  it('orders the downstream list by the frozen vocabulary', () => {
    const ordered = downstreamOf([
      {
        field: 'price',
        before: 1,
        after: 2,
        description: '',
        downstream: ['revenue'],
      },
      {
        field: 'guest_count',
        before: 1,
        after: 2,
        description: '',
        downstream: ['preparation', 'laundry'],
      },
    ])

    expect(ordered).toEqual(['preparation', 'laundry', 'revenue'])
  })
})

describe('conflict with a local change', () => {
  it('is REPORTED, never applied', () => {
    // The manager moved the dates after speaking to the guest. Four minutes
    // later the channel sends the old ones back.
    const plan = planModification(
      input({
        current: aBooking({
          stay: { checkIn: '2026-03-12', checkOut: '2026-03-15' },
          lastChannelSyncAt: new Date('2026-02-01T09:05:00Z'),
          localEdits: [
            {
              field: 'dates',
              at: new Date('2026-02-04T14:00:00Z'),
              byUserId: 'user-9',
            },
          ],
        }),
      }),
    )

    expect(plan.kind).toBe('conflict')
    if (plan.kind !== 'conflict') return

    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0].field).toBe('dates')
    expect(plan.conflicts[0].editedByUserId).toBe('user-9')
    expect(plan.exception.kind).toBe('modification_conflict')
    expect(plan.exception.severity).toBe('critical')
    // Nothing to run. A conflict plan carries no commands at all.
    expect('commands' in plan).toBe(false)
  })

  it('holds the whole modification, not only the conflicting field', () => {
    // Applying the non-conflicting half produces a booking that matches
    // neither side, which is worse than either.
    const plan = planModification(
      input({
        current: aBooking({
          guestCount: 2,
          localEdits: [
            {
              field: 'guest_count',
              at: new Date('2026-02-04T14:00:00Z'),
              byUserId: 'user-9',
            },
          ],
        }),
        incoming: aReservation({ guestCount: 6, grossAgorot: 400_000 }),
      }),
    )

    expect(plan.kind).toBe('conflict')
    if (plan.kind !== 'conflict') return
    expect(plan.changes.map((change) => change.field).sort()).toEqual([
      'guest_count',
      'price',
    ])
    expect(plan.conflicts).toHaveLength(1)
  })

  it('ignores a local edit made before the last sync', () => {
    // It has already been reconciled once. Treating it as standing would make
    // every future channel update conflict for ever.
    const plan = planModification(
      input({
        current: aBooking({
          guestCount: 2,
          lastChannelSyncAt: new Date('2026-02-03T00:00:00Z'),
          localEdits: [
            {
              field: 'guest_count',
              at: new Date('2026-02-01T00:00:00Z'),
              byUserId: 'user-9',
            },
          ],
        }),
        incoming: aReservation({ guestCount: 6 }),
      }),
    )

    expect(plan.kind).toBe('apply')
  })

  it('treats every local edit as recent on a booking that has never synced', () => {
    const plan = planModification(
      input({
        current: aBooking({
          guestCount: 2,
          lastChannelSyncAt: null,
          localEdits: [
            {
              field: 'guest_count',
              at: new Date('2020-01-01T00:00:00Z'),
              byUserId: 'user-9',
            },
          ],
        }),
        incoming: aReservation({ guestCount: 6 }),
      }),
    )

    expect(plan.kind).toBe('conflict')
  })

  it('does not conflict on a field nobody touched', () => {
    const plan = planModification(
      input({
        current: aBooking({
          localEdits: [
            {
              field: 'guest_name',
              at: new Date('2026-02-04T14:00:00Z'),
              byUserId: 'user-9',
            },
          ],
        }),
        incoming: aReservation({ grossAgorot: 400_000 }),
      }),
    )

    expect(plan.kind).toBe('apply')
  })
})

describe('the commands', () => {
  it('carries the version so a stale plan is refused at the write', () => {
    const plan = planModification(
      input({
        incoming: aReservation({
          stay: { checkIn: '2026-03-11', checkOut: '2026-03-14' },
        }),
      }),
    )
    if (plan.kind !== 'apply') throw new Error('expected apply')

    expect(plan.commands[0].expectedVersion).toBe(3)
  })

  it('says plainly which operations do not exist yet', () => {
    const plan = planModification(
      input({ incoming: aReservation({ grossAgorot: 400_000 }) }),
    )
    if (plan.kind !== 'apply') throw new Error('expected apply')

    const price = plan.commands.find(
      (command) => command.operation === 'booking.amend_price',
    )
    // The permission is in the catalogue; the operation is not built. Named
    // rather than hidden, so nothing reports success over a price that never
    // moved.
    expect(price?.available).toBe(false)
  })

  it('marks booking.amend_dates available, because it is', () => {
    const plan = planModification(
      input({
        incoming: aReservation({
          stay: { checkIn: '2026-03-11', checkOut: '2026-03-14' },
        }),
      }),
    )
    if (plan.kind !== 'apply') throw new Error('expected apply')

    expect(plan.commands[0].operation).toBe('booking.amend_dates')
    expect(plan.commands[0].available).toBe(true)
  })
})

describe('the vocabulary', () => {
  it('gives every field a downstream list', () => {
    for (const field of MODIFICATION_FIELDS) {
      expect(DOWNSTREAM_FOR_FIELD[field].length).toBeGreaterThan(0)
    }
  })

  it('never names a system outside the frozen list', () => {
    for (const systems of Object.values(DOWNSTREAM_FOR_FIELD)) {
      for (const system of systems) {
        expect(DOWNSTREAM_SYSTEMS).toContain(system)
      }
    }
  })
})
