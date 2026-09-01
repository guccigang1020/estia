/**
 * Taking a booking, driven over the demo dataset, and what the answer feeds.
 *
 * `operations.test.ts` proves the domain in isolation against an in-memory
 * repository. This file does the other half: it runs `booking.create` over
 * `createDemoClient(DEMO_DATASET)` through the *real* `SupabaseBookingRepository`
 * — the same columns, embeds and triggers the product uses — and then takes the
 * party it recorded and hands it to the preparation engine's own
 * `allocateSleeping`, to show that the two ends of the chain agree.
 *
 * ── The party the brief asked about ───────────────────────────────────────
 *
 * Four adults, two children, one infant, two couples. Seven heads and **six**
 * sleeping places, and the difference between those two numbers is the whole
 * reason the split exists: counting the baby into the sleeping party buys a
 * fourth double bed that nobody lies in, and leaving the baby off the booking
 * loses the cot. Both counterfactuals are asserted below rather than described.
 *
 * ── Two gaps this file names rather than papers over ──────────────────────
 *
 * **The adapter has not caught up.** `SupabaseBookingRepository.insertBooking`
 * writes `adults: draft.guestCount, children: 0, infants: 0` — the mapping it
 * has always had — and it lives in `src/lib/persistence`, which this work does
 * not own. So the *draft* carries 4/2/1 and the *row* carries 7/0/0. The
 * assertions below say exactly that: the total round-trips (it does today and
 * after the fix), and the draft is checked separately for the split the adapter
 * must learn to write. The one-line change is named in this work's report.
 *
 * **`allocateSleeping` cannot read the couples.** `SleepingAllocationInput` is
 * `{ guests, configuration, bedTypes }` and allocates largest-bed-first, so two
 * couples and four colleagues get an identical answer. That is proved here, on
 * purpose, because a gap nobody has demonstrated is a gap somebody argues
 * about. Widening that input belongs to whoever owns `src/lib/preparation`.
 *
 * This is not a test of row level security — `createDemoClient` says so in its
 * own header, and there is no policy engine behind these arrays.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import { InMemoryAuditWriter } from '@/lib/audit/pipeline'
import type { Actor } from '@/lib/authz/can'
import {
  defineBookingOperations,
  sleepingGuests,
  totalGuests,
  type BookingDraft,
  type BookingParty,
} from '@/lib/booking'
import { DemoDatabase, createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PLANS } from '@/lib/demo/dataset'
import { person } from '@/lib/demo/dataset-identity'
import { unit } from '@/lib/demo/dataset-inventory'
import { DemoActorSource } from '@/lib/demo/session'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'
import { SupabaseBookingRepository } from '@/lib/persistence/booking'
import { allocateSleeping } from '@/lib/preparation/sleeping'
import {
  BED_TYPES,
  PROPERTY,
} from '@/lib/preparation/testing/example-configuration'
import {
  InMemoryIdempotencyStore,
  noTransactionRunner,
  type OperationServices,
} from '@/lib/service'

const ORGANIZATION = DEMO_DATASET.organizationId

/** The twelve-guest villa. The only demo unit a party of seven fits into. */
const KAYITZ = unit('KAY-01')

/** Far enough out that no seeded booking or hold is in the way. */
const STAY = { checkIn: '2027-05-10', checkOut: '2027-05-13' } as const

/** The party the brief names. */
const PARTY: BookingParty = { adults: 4, children: 2, infants: 1 }

/** One private copy of the dataset per test, so writes cannot leak sideways. */
function database(): DemoDatabase {
  return new DemoDatabase(DEMO_DATASET)
}

function clientOn(db: DemoDatabase): Db {
  return createDemoClient(db) as unknown as Db
}

async function actorFor(key: string, db: DemoDatabase): Promise<Actor> {
  const plan = DEMO_PLANS.find((entry) => entry.code === 'pro')
  if (!plan) throw new Error("No demo plan 'pro'")

  const resolution = await resolveActor(
    new DemoActorSource(new SupabaseActorSource(clientOn(db)), plan),
    person(key).userId,
    ORGANIZATION,
  )
  if (!resolution.ok) {
    throw new Error(`${key} does not resolve to an actor: ${resolution.reason}`)
  }
  return resolution.actor
}

function servicesWith(audit: InMemoryAuditWriter): OperationServices {
  return {
    audit,
    idempotency: new InMemoryIdempotencyStore(),
    // Honest about what it is: neither `postgresUnitOfWork` nor its sequential
    // fallback is reproducible over an array of objects.
    transactions: noTransactionRunner,
  }
}

/**
 * The real adapter, with the draft it was handed kept for inspection.
 *
 * Not a stub — every call goes through to `SupabaseBookingRepository`, so the
 * columns, the guest row it creates and the price lines it writes are the
 * product's. The wrapper only remembers what the domain asked for, which is the
 * half of the chain this work owns and the half that can be proved today.
 */
class RecordingRepository extends SupabaseBookingRepository {
  drafts: BookingDraft[] = []

  override async insertBooking(
    ...args: Parameters<SupabaseBookingRepository['insertBooking']>
  ) {
    this.drafts.push(args[0])
    return super.insertBooking(...args)
  }
}

/**
 * Run `booking.create` and hand back whatever happened.
 *
 * The outcome *or* the failure, rather than a throw, because one of the two
 * assertions below is about a failure that is not this work's — see
 * `total_agorot` in the header. A helper that threw would make the interesting
 * case unreachable.
 */
async function attemptTheBooking(overrides: Record<string, unknown> = {}) {
  const db = database()
  const repository = new RecordingRepository(clientOn(db))
  const audit = new InMemoryAuditWriter()
  const actor = await actorFor('owner', db)

  const request = {
    request: {
      input: {
        unitId: KAYITZ.id,
        unitLabel: KAYITZ.name,
        propertyId: KAYITZ.propertyId,
        guestName: 'משפחת ברקוביץ',
        guestCount: totalGuests(PARTY),
        adults: PARTY.adults,
        children: PARTY.children,
        infants: PARTY.infants,
        couples: 2,
        extraBedsRequested: 0,
        cotsRequested: 1,
        eventType: 'shabbat',
        specialRequests: 'שתי מיטות תינוק',
        checkIn: STAY.checkIn,
        checkOut: STAY.checkOut,
        source: 'direct_manual',
        status: 'confirmed',
        pricing: {
          baseNightlyAgorot: KAYITZ.baseAgorot,
          cleaningFeeAgorot: KAYITZ.cleaningAgorot,
          depositAgorot: KAYITZ.depositAgorot,
          includedGuests: KAYITZ.standardGuests,
          extraGuestNightlyAgorot: KAYITZ.extraGuestAgorot,
        },
        ...overrides,
      },
    },
    context: {
      actor,
      auditActor: { type: 'user' as const, userId: actor.userId, label: 'דנה' },
      correlationId: 'correlation-intake',
    },
    services: servicesWith(audit),
  }

  const operations = defineBookingOperations(repository)

  try {
    return {
      db,
      repository,
      audit,
      outcome: await operations.createBooking.run(request),
      error: null as unknown,
    }
  } catch (cause) {
    return { db, repository, audit, outcome: null, error: cause }
  }
}

describe('a booking taken with the party split three ways', () => {
  it('hands the adapter the split, the cots and the event type', async () => {
    const { repository } = await attemptTheBooking()

    expect(repository.drafts).toHaveLength(1)
    const draft = repository.drafts[0]

    expect(draft.party).toEqual({ adults: 4, children: 2, infants: 1 })
    expect(draft.sleeping).toEqual({
      couples: 2,
      extraBedsRequested: 0,
      cotsRequested: 1,
    })
    expect(draft.eventType).toBe('shabbat')
    expect(draft.specialRequests).toBe('שתי מיטות תינוק')
    expect(draft.guestCount).toBe(7)
  })

  it('lands a real row carrying the party the desk actually typed', async () => {
    const before = database().rows('bookings').length
    const { db } = await attemptTheBooking()

    // The insert itself succeeds — this is the product's own adapter over the
    // product's own columns, and the row is there.
    expect(db.rows('bookings')).toHaveLength(before + 1)

    const written = db.rows('bookings')[db.rows('bookings').length - 1]

    // And here is the handoff, stated as numbers rather than as a paragraph.
    // This assertion used to read 7/0/0 and to explain why: the adapter wrote
    // `adults: draft.guestCount, children: 0, infants: 0`, so the desk typed
    // 4/2/1 and the row said seven adults and nobody else. The whole count
    // round-tripped, which is exactly why nothing looked broken while the
    // preparation engine was being handed a party with no children and no
    // babies. 0028 and `insertBooking` closed it, and this is the positive
    // statement that used to be a description of the gap.
    expect(Number(written.adults)).toBe(4)
    expect(Number(written.children)).toBe(2)
    expect(Number(written.infants)).toBe(1)
  })

  /**
   * A defect found on the way, in a file this work does not own.
   *
   * `bookings.total_agorot` is `not null default 0` in 0009 and the adapter
   * deliberately never sends it — `tg_bookings_freeze_total` owns it. The demo
   * client reproduces the *trigger* (`recalculateBookingTotals`) but not the
   * *default*: `GENERATED.bookings` fills `reference` and `guest_token` only,
   * so a freshly inserted row has no `total_agorot` key at all, the
   * recalculation skips it on `!('total_agorot' in booking)`, and the adapter's
   * re-read throws `RowShapeError`.
   *
   * The consequence is not confined to this test. `createClient()` returns the
   * demo client whenever demo mode is on, so **no booking can be created
   * through the running demo at all**, with or without this work. One line in
   * `src/lib/demo/client.ts` closes it — `total_agorot: () => 0` in
   * `GENERATED.bookings`.
   *
   * Asserted rather than skipped, because a gap nobody has demonstrated is a
   * gap somebody argues about. **The line has landed** — `total_agorot: () => 0`
   * is in `GENERATED.bookings` — so this is now the positive assertion it was
   * standing in for, kept in place rather than deleted so the regression has
   * somewhere to fail if the default is ever removed again.
   */
  it('creates the booking, and the total is the sum of its lines', async () => {
    const { db, error, outcome } = await attemptTheBooking()

    expect(error).toBeNull()
    expect(outcome).not.toBeNull()

    const rows = db.rows('bookings')
    const written = rows[rows.length - 1]

    // The trigger's job, reproduced: the total is whatever the price lines
    // add up to, and never a figure computed a second way.
    // `booking_price_lines.amount_agorot`, which is what
    // `tg_price_lines_recalc_total` sums in 0009 and what the demo's copy of
    // that trigger reads.
    const lines = db
      .rows('booking_price_lines')
      .filter((line) => line.booking_id === written.id)
    const expected = lines.reduce(
      (sum, line) => sum + Number(line.amount_agorot ?? 0),
      0,
    )

    expect(lines.length).toBeGreaterThan(0)

    expect(Number(written.total_agorot)).toBe(expected)
  })

  it('refuses a party past the domain’s own ceiling', async () => {
    // The *unit's* capacity is checked in `createBookingAction`, which reads
    // `units.max_guests` — the operation has no view of the unit and cannot.
    // That path is not exercised here because a Server Action resolves its
    // actor through `next/headers`; it is named in this work's report as the
    // one branch this suite does not cover. What is covered is that the domain
    // does not quietly accept sixty people either.
    const { error, repository } = await attemptTheBooking({
      guestCount: 60,
      adults: 60,
      children: 0,
      infants: 0,
      couples: 0,
    })

    expect(error).toBeInstanceOf(Error)
    // Refused before the adapter was reached, which is the point of refusing in
    // `rule` rather than in `execute`.
    expect(repository.drafts).toHaveLength(0)
  })
})

describe('the sleeping allocation this party produces', () => {
  /**
   * The fixture, asserted before it is relied on.
   *
   * `PROPERTY` and `BED_TYPES` belong to the preparation engine and the numbers
   * below are read off them. Checking the shape first means a change over there
   * fails with "the fixture moved" rather than with an arithmetic mismatch
   * somebody has to reverse-engineer.
   */
  it('is measured against five made-up double beds', () => {
    expect(PROPERTY.beds).toEqual([
      { bedTypeId: 'jewish_bed', permanent: 5, storage: 0, missing: 0 },
    ])
    expect(PROPERTY.maximumSleepingPlaces).toBeNull()
    expect(BED_TYPES.find((type) => type.id === 'jewish_bed')?.capacity).toBe(2)
  })

  it('lays six people over three beds, and leaves the infant to a cot', () => {
    expect(totalGuests(PARTY)).toBe(7)
    expect(sleepingGuests(PARTY)).toBe(6)

    const allocation = allocateSleeping({
      guests: sleepingGuests(PARTY),
      configuration: PROPERTY,
      bedTypes: BED_TYPES,
    })

    expect(allocation.permanentCapacity).toBe(10)
    expect(allocation.lines).toEqual([
      {
        bedTypeId: 'jewish_bed',
        label: BED_TYPES.find((type) => type.id === 'jewish_bed')?.label,
        source: 'permanent',
        count: 3,
        capacity: 6,
      },
    ])
    expect(allocation.sleepingPlaces).toBe(6)
    expect(allocation.extraBeds).toBe(0)
    expect(allocation.unplacedGuests).toBe(0)
  })

  it('would buy a fourth bed for nobody if the infant were counted', () => {
    // The cost of the field this work added, stated as a number. Seven heads
    // over double beds is four beds; the fourth is made up, dressed with two
    // single sheets and two pillows, and slept in by no one.
    const counted = allocateSleeping({
      guests: totalGuests(PARTY),
      configuration: PROPERTY,
      bedTypes: BED_TYPES,
    })

    expect(counted.lines[0].count).toBe(4)
    expect(counted.sleepingPlaces).toBe(8)
  })

  it('cannot yet tell two couples from four colleagues', () => {
    // `SleepingAllocationInput` takes no couples count, so the engine allocates
    // largest-bed-first regardless. The booking now records the fact; the
    // engine has nowhere to receive it. Named here so the gap is evidence
    // rather than an opinion.
    const asCouples = allocateSleeping({
      guests: 4,
      configuration: PROPERTY,
      bedTypes: BED_TYPES,
    })
    const asColleagues = allocateSleeping({
      guests: 4,
      configuration: PROPERTY,
      bedTypes: BED_TYPES,
    })

    expect(asCouples).toEqual(asColleagues)
    expect(asCouples.lines[0].bedTypeId).toBe('jewish_bed')
    expect(asCouples.lines[0].count).toBe(2)
  })
})
