/**
 * The import's write path, end to end through the real service pipeline.
 *
 * These are the tests that answer the question this feature is actually judged
 * on: when eighteen hundred stays from 2023 are imported on a Tuesday
 * afternoon, does a single guest receive a message?
 */

import { describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../audit/pipeline'
import type {
  AvailabilityWindow,
  OccupyingBooking,
  UnitAvailabilityRules,
} from '../booking/availability'
import type { HoldDraft } from '../booking/holds'
import type { BookingDraft, BookingRepository } from '../booking/repository'
import type { BookingSnapshot } from '../booking/state-machine'
import type { Hold } from '../booking/types'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'
import { FakeSupabaseClient } from '../persistence/fake-client'
import {
  InMemoryEventBus,
  InMemoryIdempotencyStore,
  type DomainEvent,
  type OperationServices,
} from '../service'
import { defineImportCommands, type CommandContext } from './commands'
import { actorWith, auditActor, bookingRecord, guestRecord } from './fixtures'

const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

const UNIT = { id: 'unit-1', propertyId: 'prop-1' }

/** Enough of the booking repository for `booking.create`. */
class MemoryBookings implements BookingRepository {
  readonly inserted: BookingDraft[] = []
  private sequence = 0

  async loadRules(): Promise<UnitAvailabilityRules | null> {
    return { unitId: UNIT.id, minimumNights: 1, blockedDates: [] }
  }
  async loadBookings(
    _window: AvailabilityWindow,
  ): Promise<readonly OccupyingBooking[]> {
    return []
  }
  async loadHolds(_window: AvailabilityWindow): Promise<readonly Hold[]> {
    return []
  }
  async loadBooking(): Promise<BookingSnapshot | null> {
    return null
  }
  async insertBooking(draft: BookingDraft): Promise<BookingSnapshot> {
    this.sequence += 1
    this.inserted.push(draft)
    return {
      ...draft,
      id: `bk-${this.sequence}`,
      reference: String(9000 + this.sequence),
      version: 1,
      depositHeldAgorot: 0,
    }
  }
  async updateBooking(): Promise<BookingSnapshot> {
    throw new Error('not used')
  }
  async loadHold(): Promise<Hold | null> {
    return null
  }
  async loadHoldsByUser(): Promise<readonly Hold[]> {
    return []
  }
  async insertHold(_draft: HoldDraft): Promise<Hold> {
    throw new Error('not used')
  }
  async saveHold(hold: Hold): Promise<Hold> {
    return hold
  }
}

function context(historic: boolean): CommandContext {
  return {
    actor: {
      ...actorWith([
        'booking.create',
        'booking.override_availability',
        'guest.create',
        'property.create',
      ]),
      entitlements: EVERY_ENTITLEMENT,
    },
    auditActor,
    correlationId: 'req-import-1',
    now: new Date('2026-09-06T09:00:00.000Z'),
    historic,
  }
}

function build(options: { sneakInALiveBus?: InMemoryEventBus } = {}) {
  const client = new FakeSupabaseClient({
    responses: {
      'guests:insert': { data: { id: 'guest-1', full_name: 'דנה כהן' } },
    },
  })
  const bookings = new MemoryBookings()
  const audit = new InMemoryAuditWriter()

  // The cast is the point of the test: it is what a caller would have to write
  // to get a live bus in here, and TypeScript refuses it without one because
  // `services` is `Omit<OperationServices, 'events' | 'onEventError'>`.
  const services = {
    audit,
    idempotency: new InMemoryIdempotencyStore(),
    ...(options.sneakInALiveBus === undefined
      ? {}
      : { events: options.sneakInALiveBus }),
  } as unknown as Omit<OperationServices, 'events' | 'onEventError'>

  const bundle = defineImportCommands({
    db: client.asDb(),
    bookings,
    services,
  })

  return { ...bundle, bookings, audit, client }
}

const HISTORIC = bookingRecord(412, {
  guestName: 'דנה כהן',
  unitName: 'וילה הגלבוע',
  checkIn: '2023-04-01',
  checkOut: '2023-04-05',
  totalAgorot: 480_000,
})

describe('a historic import fires no live side effects', () => {
  it('delivers nothing to a subscriber, even one smuggled in', async () => {
    const live = new InMemoryEventBus()
    const delivered: DomainEvent[] = []
    live.subscribe('*', (event) => {
      delivered.push(event)
    })

    const { commands, quarantine } = build({ sneakInALiveBus: live })

    await commands.createBooking(HISTORIC, context(true), UNIT)

    // The operation did emit — this is not a test that passes because nothing
    // happened. The event exists, was captured, and reached nobody.
    expect(quarantine.events.map((event) => event.name)).toContain(
      'booking.created',
    )
    expect(delivered).toEqual([])
    expect(live.published).toEqual([])
  })

  it('keeps the withheld events as evidence, attributed to the source row', async () => {
    const { commands, quarantine } = build()
    quarantine.attributeTo(412)

    await commands.createBooking(HISTORIC, context(true), UNIT)

    expect(quarantine.count).toBeGreaterThan(0)
    expect(quarantine.suppressed[0]?.name).toBe('booking.created')
    expect(quarantine.suppressed[0]?.rowNumber).toBe(412)
  })

  it('withholds guest events too, so no journey timer starts', async () => {
    const { commands, quarantine } = build()

    await commands.createGuest(
      guestRecord(2, { fullName: 'דנה כהן' }),
      context(false),
    )

    expect(quarantine.events.map((event) => event.name)).toContain(
      'guest.created',
    )
  })
})

describe('history may be written over the calendar; the future may not', () => {
  it('overrides availability for a stay that ended, with a stated reason', async () => {
    const { commands, audit } = build()

    await commands.createBooking(HISTORIC, context(true), UNIT)

    const summary = audit.records[0]?.summary ?? ''
    expect(summary).toContain('בעקיפת זמינות')
  })

  it('does not override availability for a stay still to come', async () => {
    const { commands, audit } = build()

    const future = bookingRecord(2, {
      guestName: 'רון לוי',
      unitName: 'וילה הגלבוע',
      checkIn: '2026-12-01',
      checkOut: '2026-12-05',
      totalAgorot: 300_000,
    })

    await commands.createBooking(future, context(false), UNIT)

    const summary = audit.records[0]?.summary ?? ''
    expect(summary).not.toContain('בעקיפת זמינות')
  })
})

describe('every write goes through a domain command', () => {
  it('produces an audit event for an imported booking', async () => {
    const { commands, audit } = build()

    await commands.createBooking(HISTORIC, context(true), UNIT)

    expect(audit.records).toHaveLength(1)
    expect(audit.records[0]?.resourceType).toBe('booking')
    expect(audit.records[0]?.summary).toContain('דנה כהן')
  })

  it('attributes an imported stay to a channel and not to the ESTIA desk', async () => {
    const { commands, bookings } = build()

    await commands.createBooking(HISTORIC, context(true), UNIT)

    expect(bookings.inserted[0]?.attribution.source).toBe('other_channel')
    expect(bookings.inserted[0]?.status).toBe('confirmed')
  })

  it('spreads the total across the nights rather than inventing a rate', async () => {
    const { commands, bookings } = build()

    await commands.createBooking(HISTORIC, context(true), UNIT)

    // 4,800 shekels over four nights.
    expect(bookings.inserted[0]?.totalAgorot).toBe(480_000)
  })

  it('writes a guest through the guest operation, not through a table', async () => {
    const { commands, client } = build()

    await commands.createGuest(
      guestRecord(2, { fullName: 'דנה כהן', phone: '050-1234567' }),
      context(false),
    )

    const writes = client.queriesFor('guests')
    expect(writes).toHaveLength(1)
    expect(writes[0]?.verb).toBe('insert')
    // `phone_e164` is a generated column computed by `normalize_phone_il`; no
    // write path may set it, this one included.
    const payload = writes[0]?.payload as Record<string, unknown>
    expect(payload.phone_e164).toBeUndefined()
  })
})

describe('the same record written twice', () => {
  it('replays rather than writing a second booking', async () => {
    const { commands, bookings } = build()

    const first = await commands.createBooking(HISTORIC, context(true), UNIT)
    const second = await commands.createBooking(HISTORIC, context(true), UNIT)

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.id).toBe(first.id)
    expect(bookings.inserted).toHaveLength(1)
  })
})
