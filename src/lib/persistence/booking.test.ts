/**
 * What the booking adapter does to a row, and what it does to a failure.
 *
 * These are mapping tests. They cannot prove a column name is right — see
 * `fake-client.ts` — and they are not trying to. What they prove is the set of
 * decisions this adapter takes on top of the query: which absences become
 * `null`, that a zero-row update is a conflict rather than a shrug, that
 * `23P01` and only `23P01` becomes a domain conflict, and that every read is
 * scoped by organization in the query as well as by the policy.
 */

import { describe, expect, it } from 'vitest'

import { ConflictError } from '../errors'
import { SupabaseBookingRepository } from './booking'
import { FakeSupabaseClient, hasFilter } from './fake-client'
import { PG_ERROR } from './errors'
import { sequentialUnitOfWork } from './transaction'
import { PartialCommitError } from './errors'

const ORG = 'org-1'
const UNIT = 'unit-1'
const PROPERTY = 'prop-1'
const BOOKING = 'bk-1'

/** A `bookings` row as PostgREST actually renders one. */
function bookingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING,
    organization_id: ORG,
    property_id: PROPERTY,
    unit_id: UNIT,
    guest_id: 'guest-1',
    reference: 'B8892',
    status: 'confirmed',
    check_in: '2026-10-01',
    check_out: '2026-10-04',
    adults: 2,
    children: 1,
    infants: 0,
    source: 'direct_manual',
    source_channel: null,
    agent_user_id: null,
    agency_id: null,
    campaign_id: null,
    referral_id: null,
    total_agorot: 165000,
    created_by: 'user-1',
    version: 3,
    guests: { full_name: 'דנה לוי' },
    ...overrides,
  }
}

const PRICE_LINES = [
  {
    kind: 'accommodation',
    label: '3 לילות',
    amount_agorot: 150000,
    // `numeric` arrives as a string. If the mapping used it raw, the domain
    // would end up concatenating rather than adding.
    quantity: '3',
    line_date: '2026-10-01',
    sort_order: 0,
  },
  {
    kind: 'deposit',
    label: 'פיקדון',
    amount_agorot: 15000,
    quantity: '1',
    line_date: null,
    sort_order: 1,
  },
]

describe('loadBooking', () => {
  it('maps a row into a snapshot, deriving what has no column', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        bookings: { data: bookingRow() },
        booking_price_lines: { data: PRICE_LINES },
        deposits: { data: { held_agorot: 15000 } },
      },
    })

    const booking = await new SupabaseBookingRepository(
      client.asDb(),
    ).loadBooking(ORG, BOOKING)

    expect(booking).not.toBeNull()
    expect(booking?.reference).toBe('B8892')
    // The whole party, not the adults. Three columns, one domain number.
    expect(booking?.guestCount).toBe(3)
    // `numeric` became a number rather than a string.
    expect(booking?.lines[0].quantity).toBe(3)
    // No `deposit_required_agorot` column exists; it is the sum of the
    // `deposit` price lines, which is where `priceStay` put it.
    expect(booking?.depositRequiredAgorot).toBe(15000)
    expect(booking?.depositHeldAgorot).toBe(15000)
    expect(booking?.guestName).toBe('דנה לוי')
  })

  it('scopes the read by organization in the query, not only by policy', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        bookings: { data: bookingRow() },
        booking_price_lines: { data: [] },
        deposits: { data: null },
      },
    })

    await new SupabaseBookingRepository(client.asDb()).loadBooking(ORG, BOOKING)

    const [read] = client.queriesFor('bookings')
    expect(hasFilter(read, 'eq', 'organization_id', ORG)).toBe(true)
    expect(hasFilter(read, 'eq', 'id', BOOKING)).toBe(true)
    // Soft-deleted bookings are not bookings.
    expect(hasFilter(read, 'is', 'deleted_at', null)).toBe(true)
  })

  it('returns null for a booking that is not visible', async () => {
    const client = new FakeSupabaseClient({
      responses: { bookings: { data: null } },
    })

    const booking = await new SupabaseBookingRepository(
      client.asDb(),
    ).loadBooking(ORG, 'someone-elses-booking')

    // Under RLS a cross-tenant read returns no rows rather than a refusal, so
    // this is `null` where `MemoryRepository` returns the row and leaves the
    // refusal to the pipeline. Different, and better: it does not confirm the
    // booking exists.
    expect(booking).toBeNull()
  })

  it('leaves the guest name empty when the guest row is not readable', async () => {
    // `guests_select` requires `guest.view`, which a cleaner does not hold.
    // The embed is deliberately not `!inner`, so the booking still arrives.
    const client = new FakeSupabaseClient({
      responses: {
        bookings: { data: bookingRow({ guests: null }) },
        booking_price_lines: { data: [] },
        deposits: { data: null },
      },
    })

    const booking = await new SupabaseBookingRepository(
      client.asDb(),
    ).loadBooking(ORG, BOOKING)

    expect(booking?.guestName).toBe('')
    // The part that matters: the booking itself is still there.
    expect(booking?.id).toBe(BOOKING)
  })

  it('reports a zero deposit when no deposit was ever taken', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        bookings: { data: bookingRow() },
        booking_price_lines: { data: [] },
        deposits: { data: null },
      },
    })

    const booking = await new SupabaseBookingRepository(
      client.asDb(),
    ).loadBooking(ORG, BOOKING)

    expect(booking?.depositHeldAgorot).toBe(0)
    expect(booking?.depositRequiredAgorot).toBe(0)
  })
})

describe('insertBooking', () => {
  const draft = {
    organizationId: ORG,
    propertyId: null,
    unitId: UNIT,
    guestName: 'דנה לוי',
    guestCount: 3,
    checkIn: '2026-10-01',
    checkOut: '2026-10-04',
    status: 'confirmed' as const,
    attribution: {
      source: 'direct_manual' as const,
      sourceChannel: null,
      agentUserId: null,
      agencyId: null,
      campaignId: null,
      referralId: null,
    },
    lines: [
      {
        kind: 'accommodation' as const,
        label: '3 לילות',
        amount: 150000,
        quantity: 3,
        date: '2026-10-01',
      },
    ],
    totalAgorot: 150000,
    depositRequiredAgorot: 0,
    createdByUserId: 'user-1',
  }

  function seedSuccess() {
    return new FakeSupabaseClient({
      responses: {
        units: { data: { property_id: PROPERTY } },
        guests: { data: { id: 'guest-1' } },
        // The insert, then the re-read.
        bookings: [
          { data: bookingRow({ version: 1, total_agorot: 0 }) },
          { data: bookingRow({ version: 2, total_agorot: 150000 }) },
        ],
        booking_price_lines: [{ data: null }, { data: PRICE_LINES }],
        deposits: { data: null },
      },
    })
  }

  it('never sends total_agorot, because a trigger owns it', async () => {
    const client = seedSuccess()

    await new SupabaseBookingRepository(client.asDb()).insertBooking(
      draft,
      undefined,
    )

    const insert = client.queriesFor('bookings')[0]
    const payload = insert.payload as Record<string, unknown>
    // `tg_bookings_freeze_total` overwrites it with the sum of the price
    // lines, which do not exist yet at insert time. Sending 150000 would
    // store 0 — proved live — so it is not sent.
    expect(payload).not.toHaveProperty('total_agorot')
    // Nor the reference or the guest token: the column defaults generate both.
    expect(payload).not.toHaveProperty('reference')
    expect(payload.property_id).toBe(PROPERTY)
    expect(payload.adults).toBe(3)
  })

  it('re-reads the booking so the returned version is not already stale', async () => {
    const client = seedSuccess()

    const booking = await new SupabaseBookingRepository(
      client.asDb(),
    ).insertBooking(draft, undefined)

    // Two reads of `bookings`: the insert's RETURNING, then the re-read after
    // the price lines have bumped the version. The caller uses this number as
    // `expectedVersion` on its next write, so handing back the insert's own
    // version would produce a conflict on the very next edit.
    expect(client.queriesFor('bookings')).toHaveLength(2)
    expect(booking.version).toBe(2)
    expect(booking.totalAgorot).toBe(150000)
  })

  it('translates 23P01 from the occupancy constraint into a conflict', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        units: { data: { property_id: PROPERTY } },
        guests: { data: { id: 'guest-1' } },
        bookings: {
          error: {
            code: PG_ERROR.EXCLUSION_VIOLATION,
            message:
              'conflicting key value violates exclusion constraint ' +
              '"unit_occupancy_no_overlap"',
          },
        },
      },
    })

    await expect(
      new SupabaseBookingRepository(client.asDb()).insertBooking(
        draft,
        undefined,
      ),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('does not translate a network failure into a conflict', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        units: { data: { property_id: PROPERTY } },
        guests: { data: { id: 'guest-1' } },
        bookings: {
          error: { code: 'FetchError', message: 'fetch failed' },
        },
      },
    })

    const failure = await new SupabaseBookingRepository(client.asDb())
      .insertBooking(draft, undefined)
      .catch((error: unknown) => error)

    // The distinction this whole layer exists to preserve. Telling a guest
    // their dates are taken when the Wi-Fi dropped is a specific and
    // expensive lie.
    expect(failure).not.toBeInstanceOf(ConflictError)
    expect((failure as { code: string }).code).toBe('FetchError')
  })

  it('does not translate an exclusion violation on some other constraint', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        units: { data: { property_id: PROPERTY } },
        guests: { data: { id: 'guest-1' } },
        bookings: {
          error: {
            code: PG_ERROR.EXCLUSION_VIOLATION,
            message:
              'conflicting key value violates exclusion constraint ' +
              '"some_future_constraint"',
          },
        },
      },
    })

    const failure = await new SupabaseBookingRepository(client.asDb())
      .insertBooking(draft, undefined)
      .catch((error: unknown) => error)

    // `23P01` alone is not enough. Reporting an unrelated constraint as
    // "those dates are taken" would be a plausible, wrong sentence.
    expect(failure).not.toBeInstanceOf(ConflictError)
  })
})

describe('updateBooking', () => {
  it('conditions the update on the version the caller read', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        bookings: [
          {
            data: [
              {
                id: BOOKING,
                organization_id: ORG,
                property_id: PROPERTY,
                version: 4,
              },
            ],
          },
          { data: bookingRow({ version: 4 }) },
        ],
        booking_price_lines: { data: [] },
        deposits: { data: null },
      },
    })

    await new SupabaseBookingRepository(client.asDb()).updateBooking({
      bookingId: BOOKING,
      patch: { status: 'cancelled' },
      expectedVersion: 3,
      tx: undefined,
    })

    const update = client.queriesFor('bookings')[0]
    expect(hasFilter(update, 'eq', 'version', 3)).toBe(true)
    // The trigger owns `version`; sending one would be overwritten and would
    // only sometimes agree.
    expect(update.payload).not.toHaveProperty('version')
  })

  it('treats a zero-row update as a conflict, never as success', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        bookings: [
          // The conditional update matched nothing.
          { data: [] },
          // The follow-up read that reports the version actually held.
          { data: { version: 9 } },
        ],
      },
    })

    const failure = await new SupabaseBookingRepository(client.asDb())
      .updateBooking({
        bookingId: BOOKING,
        patch: { status: 'cancelled' },
        expectedVersion: 3,
        tx: undefined,
      })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ConflictError)
    expect((failure as ConflictError).expectedVersion).toBe(3)
    expect((failure as ConflictError).actualVersion).toBe(9)
  })

  it('refuses a total without the lines that produce it', async () => {
    const client = new FakeSupabaseClient({})

    await expect(
      new SupabaseBookingRepository(client.asDb()).updateBooking({
        bookingId: BOOKING,
        patch: { totalAgorot: 4700 },
        expectedVersion: 3,
        tx: undefined,
      }),
      // Loudly, rather than as a silent no-op: `total_agorot` is derived from
      // the price lines by trigger, and pretending to apply this would report
      // a price change that did not happen.
    ).rejects.toThrow(/derived from booking_price_lines/)
  })

  it('only sends the columns the patch names', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        bookings: [
          {
            data: [
              {
                id: BOOKING,
                organization_id: ORG,
                property_id: PROPERTY,
                version: 4,
              },
            ],
          },
          { data: bookingRow({ version: 4 }) },
        ],
        booking_price_lines: { data: [] },
        deposits: { data: null },
      },
    })

    await new SupabaseBookingRepository(client.asDb()).updateBooking({
      bookingId: BOOKING,
      patch: { status: 'cancelled' },
      expectedVersion: 3,
      tx: undefined,
    })

    // An absent key means "leave it alone". A `check_in: undefined` reaching
    // the update would blank the arrival date.
    const payload = client.queriesFor('bookings')[0].payload as Record<
      string,
      unknown
    >
    expect(Object.keys(payload)).toEqual(['status'])
  })
})

describe('availability reads', () => {
  it('does not filter bookings by status', async () => {
    const client = new FakeSupabaseClient({
      responses: { bookings: { data: [] } },
    })

    await new SupabaseBookingRepository(client.asDb()).loadBookings({
      organizationId: ORG,
      unitId: UNIT,
      range: { checkIn: '2026-10-01', checkOut: '2026-10-04' },
    })

    const [read] = client.queriesFor('bookings')
    // Occupancy is the domain's decision, over `OCCUPYING_STATUSES`. A
    // `WHERE status IN (...)` here that drifted from that list would make
    // taken dates look free — silently.
    expect(read.filters.some((filter) => filter.column === 'status')).toBe(
      false,
    )
    // Half-open overlap: a stay ending on the day another begins does not
    // collide, which is what makes a same-day turnaround possible.
    expect(hasFilter(read, 'lt', 'check_in', '2026-10-04')).toBe(true)
    expect(hasFilter(read, 'gt', 'check_out', '2026-10-01')).toBe(true)
  })

  it('keeps expired holds and drops released ones for a user count', async () => {
    const client = new FakeSupabaseClient({
      responses: { holds: { data: [] } },
    })

    await new SupabaseBookingRepository(client.asDb()).loadHoldsByUser(
      ORG,
      'user-1',
    )

    const [read] = client.queriesFor('holds')
    expect(hasFilter(read, 'is', 'released_at', null)).toBe(true)
    // Deliberately absent. Liveness is decided in the domain against the
    // clock, so that a missing sweeper cannot inflate an agent's count and
    // lock them out of their own work.
    expect(read.filters.some((filter) => filter.column === 'expires_at')).toBe(
      false,
    )
  })

  it('refuses to vouch for a unit that is not active', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        units: {
          data: {
            id: UNIT,
            min_nights: 2,
            status: 'maintenance',
            metadata: {},
          },
        },
      },
    })

    const rules = await new SupabaseBookingRepository(client.asDb()).loadRules(
      ORG,
      UNIT,
    )

    // `null` means "the engine cannot vouch for this unit", and
    // `checkAvailability` turns it into a refusal. Deny by default, in the one
    // place where the alternative is selling a unit nobody configured.
    expect(rules).toBeNull()
  })

  it('reads the date lists from unit metadata, and omits absent ones', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        units: {
          data: {
            id: UNIT,
            min_nights: 2,
            status: 'active',
            metadata: { blockedDates: ['2026-10-02'] },
          },
        },
      },
    })

    const rules = await new SupabaseBookingRepository(client.asDb()).loadRules(
      ORG,
      UNIT,
    )

    expect(rules?.minimumNights).toBe(2)
    expect(rules?.blockedDates).toEqual(['2026-10-02'])
    // An absent key means no restriction, which is the correct reading — not
    // an empty list that a future `.length` check might treat differently.
    expect(rules?.noArrivalDates).toBeUndefined()
  })
})

describe('the unit of work, which is not a transaction', () => {
  it('names what already committed when a later write fails', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        units: { data: { property_id: PROPERTY } },
        guests: { data: { id: 'guest-1' } },
        bookings: { data: bookingRow({ version: 1, total_agorot: 0 }) },
        booking_price_lines: {
          error: { code: '42501', message: 'permission denied' },
        },
      },
    })

    const repository = new SupabaseBookingRepository(client.asDb())
    const failure = await sequentialUnitOfWork(client.asDb())
      .run((tx) =>
        repository.insertBooking(
          {
            organizationId: ORG,
            propertyId: PROPERTY,
            unitId: UNIT,
            guestName: 'דנה לוי',
            guestCount: 2,
            checkIn: '2026-10-01',
            checkOut: '2026-10-04',
            status: 'confirmed',
            attribution: {
              source: 'direct_manual',
              sourceChannel: null,
              agentUserId: null,
              agencyId: null,
              campaignId: null,
              referralId: null,
            },
            lines: [
              {
                kind: 'accommodation',
                label: 'לילה',
                amount: 50000,
                quantity: 1,
                date: '2026-10-01',
              },
            ],
            totalAgorot: 50000,
            depositRequiredAgorot: 0,
            createdByUserId: 'user-1',
          },
          tx,
        ),
      )
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(PartialCommitError)
    // The booking row is durable and the price lines are not. An operator
    // needs to know that, because "the booking was not created" and "the
    // booking exists with no price lines" need different repairs.
    expect((failure as PartialCommitError).committed).toContain(
      `bookings(${BOOKING})`,
    )
    // And the taxonomy has to say `saved`, not `not_saved`.
    expect((failure as PartialCommitError).dataOutcome).toBe('saved')
  })

  it('lets a failure before any commit through unwrapped', async () => {
    const runner = sequentialUnitOfWork(new FakeSupabaseClient().asDb())
    const boom = new Error('nothing happened yet')

    await expect(
      runner.run(async () => {
        throw boom
      }),
    ).rejects.toBe(boom)
  })
})
