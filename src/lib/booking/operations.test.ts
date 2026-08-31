/**
 * The booking operations, end to end through the service pipeline.
 *
 * These are the tests that answer the questions a product owner asks: can a
 * receptionist without the right permission move a booking (no, and nothing is
 * read before they are told so), does cancelling put the dates back on sale
 * (yes), does a stale form erase somebody else's edit (no), does an agent's
 * hold survive its own expiry (no), and what happens when two people book the
 * same villa at the same instant.
 *
 * That last one has an honest answer rather than a comfortable one, and the
 * test that covers it says so in its name. The application-level availability
 * check loses races by construction; the database's exclusion constraint is the
 * guarantee. Both are exercised below.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { AuthorizationError, type Actor } from '../authz/can'
import { PERMISSIONS, type Grant } from '../authz/permissions'
import { InMemoryAuditWriter, type AuditWriter } from '../audit/pipeline'
import { BusinessRuleError, ConflictError, ValidationError } from '../errors'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'
import {
  InMemoryEventBus,
  InMemoryIdempotencyStore,
  RecordingTransactionRunner,
  type OperationContext,
  type OperationServices,
} from '../service'
import {
  checkAvailability,
  type AvailabilityWindow,
  type OccupyingBooking,
  type UnitAvailabilityRules,
} from './availability'
import { isHoldLive } from './holds'
import { defineBookingOperations } from './operations'
import type {
  BookingDraft,
  BookingPatch,
  BookingRepository,
} from './repository'
import type { BookingSnapshot } from './state-machine'
import { rangesOverlap, type Hold } from './types'
import type { HoldDraft } from './holds'

// ── The world ─────────────────────────────────────────────────────────────

const ORG = 'org-a'
const OTHER_ORG = 'org-b'
const PROP = 'prop-1'
const UNIT = 'unit-1'
const USER = 'user-dana'
const CORRELATION = 'req-7f2a9c'
/** Midday in Israel, a fortnight before the stay. */
const NOW = new Date('2026-08-20T09:00:00.000Z')

const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

/**
 * The repository, in memory.
 *
 * `enforceExclusion` models the `GiST` exclusion constraint the real schema
 * carries. Off by default, so the tests can show what the application layer
 * does on its own; switched on for the test that shows what actually stops a
 * double booking.
 */
class MemoryRepository implements BookingRepository {
  readonly bookings = new Map<string, BookingSnapshot>()
  readonly holds = new Map<string, Hold>()
  rules: UnitAvailabilityRules | null = {
    unitId: UNIT,
    minimumNights: 1,
    blockedDates: [],
  }
  enforceExclusion = false
  /** Every read, so a refusal can be located exactly. */
  reads = 0
  private bookingSeq = 0
  private holdSeq = 0

  async loadRules(): Promise<UnitAvailabilityRules | null> {
    this.reads += 1
    return this.rules
  }

  async loadBookings(
    window: AvailabilityWindow,
  ): Promise<readonly OccupyingBooking[]> {
    this.reads += 1
    return [...this.bookings.values()]
      .filter(
        (booking) =>
          booking.organizationId === window.organizationId &&
          booking.unitId === window.unitId,
      )
      .map((booking) => ({
        id: booking.id,
        reference: booking.reference,
        status: booking.status,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      }))
  }

  async loadHolds(window: AvailabilityWindow): Promise<readonly Hold[]> {
    this.reads += 1
    return [...this.holds.values()].filter(
      (hold) =>
        hold.organizationId === window.organizationId &&
        hold.unitId === window.unitId,
    )
  }

  async loadBooking(
    organizationId: string,
    bookingId: string,
  ): Promise<BookingSnapshot | null> {
    this.reads += 1
    const booking = this.bookings.get(bookingId)
    // Returned regardless of tenant, the way a service-role read would. The
    // pipeline's second authorization check is what stops it.
    return booking ?? null
  }

  /**
   * The drafts as the domain handed them over, by booking id.
   *
   * Kept beside the snapshots because a `BookingSnapshot` deliberately does not
   * carry the party split, the sleeping request or the event type: `hydrate` in
   * `src/lib/persistence/booking.ts` builds snapshots from columns, and three
   * of those four have no column yet. Asserting the intake against the *draft*
   * is asserting the thing this layer is actually responsible for producing.
   */
  drafts = new Map<string, BookingDraft>()

  async insertBooking(draft: BookingDraft): Promise<BookingSnapshot> {
    if (this.enforceExclusion) this.assertNoOverlap(draft)

    this.bookingSeq += 1
    const booking: BookingSnapshot = {
      ...draft,
      id: `bk-${this.bookingSeq}`,
      reference: String(8891 + this.bookingSeq),
      version: 1,
      depositHeldAgorot: 0,
    }
    this.bookings.set(booking.id, booking)
    this.drafts.set(booking.id, draft)
    return booking
  }

  async updateBooking(args: {
    bookingId: string
    patch: BookingPatch
    expectedVersion: number
  }): Promise<BookingSnapshot> {
    const current = this.bookings.get(args.bookingId)
    if (!current) throw new Error(`no booking ${args.bookingId}`)
    if (current.version !== args.expectedVersion) {
      // What the `WHERE version = $n` in the real update does.
      throw new ConflictError({
        resourceType: 'booking',
        resourceId: args.bookingId,
        expectedVersion: args.expectedVersion,
        actualVersion: current.version,
      })
    }
    const updated: BookingSnapshot = {
      ...current,
      ...args.patch,
      version: current.version + 1,
    }
    this.bookings.set(updated.id, updated)
    return updated
  }

  async loadHold(organizationId: string, holdId: string): Promise<Hold | null> {
    this.reads += 1
    const hold = this.holds.get(holdId)
    return hold && hold.organizationId === organizationId ? hold : null
  }

  async loadHoldsByUser(
    organizationId: string,
    userId: string,
  ): Promise<readonly Hold[]> {
    this.reads += 1
    // Expired holds included on purpose: the domain decides liveness.
    return [...this.holds.values()].filter(
      (hold) =>
        hold.organizationId === organizationId &&
        hold.heldByUserId === userId &&
        hold.releasedAt === null,
    )
  }

  async insertHold(draft: HoldDraft): Promise<Hold> {
    this.holdSeq += 1
    const hold: Hold = { ...draft, id: `hold-${this.holdSeq}` }
    this.holds.set(hold.id, hold)
    return hold
  }

  async saveHold(hold: Hold): Promise<Hold> {
    this.holds.set(hold.id, hold)
    return hold
  }

  seedHold(overrides: Partial<Hold> = {}): Hold {
    this.holdSeq += 1
    const hold: Hold = {
      id: `hold-${this.holdSeq}`,
      organizationId: ORG,
      unitId: UNIT,
      checkIn: '2026-10-01',
      checkOut: '2026-10-03',
      reason: 'agent_quote',
      heldByUserId: USER,
      expiresAt: '2026-08-20T09:30:00.000Z',
      releasedAt: null,
      convertedToBookingId: null,
      ...overrides,
    }
    this.holds.set(hold.id, hold)
    return hold
  }

  private assertNoOverlap(draft: BookingDraft): void {
    const clash = [...this.bookings.values()].some(
      (existing) =>
        existing.unitId === draft.unitId &&
        existing.status !== 'cancelled' &&
        rangesOverlap(existing, draft),
    )
    if (clash) {
      throw new Error('exclusion constraint violated: bookings_no_overlap')
    }
  }
}

let repo: MemoryRepository
let operations: ReturnType<typeof defineBookingOperations>

beforeEach(() => {
  repo = new MemoryRepository()
  operations = defineBookingOperations(repo)
})

function actorWith(
  grants: readonly Grant[],
  overrides: Partial<Actor> = {},
): Actor {
  return {
    userId: USER,
    organizationId: ORG,
    membershipStatus: 'active',
    grants: new Set<Grant>(grants),
    scope: { kind: 'all_organization' },
    entitlements: EVERY_ENTITLEMENT,
    ...overrides,
  }
}

const owner = () => actorWith(PERMISSIONS)

function contextFor(
  actor: Actor,
  overrides: Partial<OperationContext> = {},
): OperationContext {
  return {
    actor,
    auditActor: { type: 'user', userId: actor.userId, label: 'דנה כהן' },
    correlationId: CORRELATION,
    now: NOW,
    ...overrides,
  }
}

interface Wiring extends OperationServices {
  audit: InMemoryAuditWriter
  events: InMemoryEventBus
}

function wiring(overrides: { audit?: AuditWriter } = {}): Wiring {
  return {
    audit: (overrides.audit ??
      new InMemoryAuditWriter()) as InMemoryAuditWriter,
    events: new InMemoryEventBus(),
    idempotency: new InMemoryIdempotencyStore(),
    transactions: new RecordingTransactionRunner(),
  }
}

function rejection<E>(promise: Promise<unknown>): Promise<E> {
  return promise.then(
    () => {
      throw new Error('expected the operation to be refused, but it succeeded')
    },
    (error: unknown) => error as E,
  )
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    unitId: UNIT,
    unitLabel: 'וילה הכרמל',
    propertyId: PROP,
    guestName: 'משה לוי',
    guestCount: 2,
    checkIn: '2026-09-03',
    checkOut: '2026-09-06',
    source: 'direct_website',
    status: 'confirmed',
    pricing: { baseNightlyAgorot: 120000 },
    ...overrides,
  }
}

async function seedConfirmedBooking(
  overrides: Record<string, unknown> = {},
): Promise<BookingSnapshot> {
  const outcome = await operations.createBooking.run({
    request: { input: createInput(overrides) },
    context: contextFor(owner()),
    services: wiring(),
  })
  return outcome.data.booking
}

async function isFree(checkIn: string, checkOut: string): Promise<boolean> {
  const result = await checkAvailability(
    repo,
    { organizationId: ORG, unitId: UNIT, range: { checkIn, checkOut } },
    { now: NOW },
  )
  return result.available
}

// ── Creating ──────────────────────────────────────────────────────────────

describe('booking.create', () => {
  it('writes the booking, prices it and says so in Hebrew', async () => {
    const services = wiring()

    const outcome = await operations.createBooking.run({
      request: { input: createInput() },
      context: contextFor(owner()),
      services,
    })

    expect(outcome.data.booking.reference).toBe('8892')
    expect(outcome.data.booking.totalAgorot).toBe(360000)
    expect(outcome.data.quote.nights).toBe(3)
    expect(services.audit.records[0].summary).toBe(
      'דנה כהן יצרה את הזמנה 8892 עבור משה לוי ביחידה וילה הכרמל ' +
        'לתאריכים 3.9–6.9 (3 לילות) עבור 2 מבוגרים (לינה) בסך ₪3,600',
    )
    expect(services.events.published[0].name).toBe('booking.created')
    expect(services.transactions?.constructor.name).toBe(
      'RecordingTransactionRunner',
    )
  })

  it('takes the dates off sale once it occupies them', async () => {
    await seedConfirmedBooking()
    expect(await isFree('2026-09-04', '2026-09-07')).toBe(false)
    // Same-day turnaround, still sellable.
    expect(await isFree('2026-09-06', '2026-09-08')).toBe(true)
  })

  it('refuses before reading anything when the grant is missing', async () => {
    const services = wiring()

    const error = await rejection<AuthorizationError>(
      operations.createBooking.run({
        request: { input: createInput() },
        context: contextFor(actorWith(['booking.view'])),
        services,
      }),
    )

    expect(error).toBeInstanceOf(AuthorizationError)
    expect(repo.reads).toBe(0)
    expect(repo.bookings.size).toBe(0)
    expect(services.audit.records).toHaveLength(0)
  })

  it('refuses a unit outside the actor’s scope, before reading anything', async () => {
    // The pipeline cannot check scope on a create — there is no resource yet.
    // The operation checks it against its own input instead.
    const error = await rejection<AuthorizationError>(
      operations.createBooking.run({
        request: { input: createInput() },
        context: contextFor(
          actorWith(['booking.create'], {
            scope: { kind: 'properties', propertyIds: ['prop-9'] },
          }),
        ),
        services: wiring(),
      }),
    )

    expect(error.decision.reason).toBe('out_of_scope')
    expect(repo.reads).toBe(0)
  })

  it('refuses dates another booking already holds, as a conflict', async () => {
    await seedConfirmedBooking()

    const error = await rejection<ConflictError>(
      operations.createBooking.run({
        request: {
          input: createInput({ checkIn: '2026-09-05', checkOut: '2026-09-08' }),
        },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.userMessage).toContain('אינם פנויים')
    expect(repo.bookings.size).toBe(1)
  })

  it('refuses a stay under the minimum as a rule, not a conflict', async () => {
    // Different failures need different offers: "try again" for a race,
    // "choose other dates" for a request that will never work.
    repo.rules = { unitId: UNIT, minimumNights: 5, blockedDates: [] }

    const error = await rejection<BusinessRuleError>(
      operations.createBooking.run({
        request: { input: createInput() },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error).toBeInstanceOf(BusinessRuleError)
    expect(error.code).toBe('booking.dates_unavailable')
  })

  it('records an enquiry for dates that are already sold', async () => {
    // An enquiry does not occupy the calendar, and this is exactly when a
    // business wants the lead: so it can offer something else.
    await seedConfirmedBooking()

    const outcome = await operations.createBooking.run({
      request: { input: createInput({ status: 'inquiry' }) },
      context: contextFor(owner()),
      services: wiring(),
    })

    expect(outcome.data.booking.status).toBe('inquiry')
  })

  it('lets an override write over taken dates, with the permission and a reason', async () => {
    await seedConfirmedBooking()
    const services = wiring()

    const outcome = await operations.createBooking.run({
      request: { input: createInput({ overrideAvailability: true }) },
      context: contextFor(owner(), { reason: 'אישור מנהל — הועברה יחידה' }),
      services,
    })

    expect(outcome.data.booking.id).toBe('bk-2')
    expect(services.audit.records[0].summary).toContain('בעקיפת זמינות')
    expect(services.audit.records[0].reason).toBe('אישור מנהל — הועברה יחידה')
  })

  it('refuses an override without the permission for it', async () => {
    await seedConfirmedBooking()

    const error = await rejection<AuthorizationError>(
      operations.createBooking.run({
        request: { input: createInput({ overrideAvailability: true }) },
        context: contextFor(
          actorWith(['booking.create', 'availability.view']),
          { reason: 'כי בא לי' },
        ),
        services: wiring(),
      }),
    )

    expect(error).toBeInstanceOf(AuthorizationError)
    expect(error.grant).toBe('booking.override_availability')
  })

  it('refuses an override with no stated reason', async () => {
    await seedConfirmedBooking()

    const error = await rejection<ValidationError>(
      operations.createBooking.run({
        request: { input: createInput({ overrideAvailability: true }) },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.issues[0].field).toBe('reason')
  })

  it('refuses a manual discount without the price override permission', async () => {
    const error = await rejection<AuthorizationError>(
      operations.createBooking.run({
        request: { input: createInput({ manualDiscountAgorot: 50000 }) },
        context: contextFor(actorWith(['booking.create']), {
          reason: 'לקוח חוזר',
        }),
        services: wiring(),
      }),
    )

    expect(error.grant).toBe('booking.override_price')
  })

  it('itemises an approved manual discount instead of editing the total', async () => {
    const outcome = await operations.createBooking.run({
      request: { input: createInput({ manualDiscountAgorot: 50000 }) },
      context: contextFor(owner(), { reason: 'לקוח חוזר' }),
      services: wiring(),
    })

    expect(outcome.data.booking.totalAgorot).toBe(310000)
    expect(
      outcome.data.quote.lines.some((line) => line.amount === -50000),
    ).toBe(true)
  })

  it('applies a percentage discount as its own line', async () => {
    const outcome = await operations.createBooking.run({
      request: {
        input: createInput({
          pricing: {
            baseNightlyAgorot: 120000,
            discountPercent: 10,
            discountLabel: 'מבצע ספטמבר',
          },
        }),
      },
      context: contextFor(owner()),
      services: wiring(),
    })

    expect(outcome.data.booking.totalAgorot).toBe(324000)
    expect(
      outcome.data.quote.lines.some((line) => line.label === 'מבצע ספטמבר'),
    ).toBe(true)
  })

  it('refuses a hold that does not exist', async () => {
    const error = await rejection<BusinessRuleError>(
      operations.createBooking.run({
        request: { input: createInput({ fromHoldId: 'hold-nowhere' }) },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('hold.not_found')
  })

  it('refuses a payload carrying a field it never asked for', async () => {
    const error = await rejection<ValidationError>(
      operations.createBooking.run({
        request: { input: createInput({ totalAgorot: 1 }) },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error.issues[0].code).toBe('unknown_field')
  })

  it('refuses a date that is not a day', async () => {
    const error = await rejection<ValidationError>(
      operations.createBooking.run({
        request: { input: createInput({ checkIn: '2026-02-30' }) },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error.issues.map((issue) => issue.field)).toContain('checkIn')
  })

  it('creates once when the same request is submitted twice', async () => {
    const services = wiring()
    const request = { idempotencyKey: 'key-1', input: createInput() }
    const context = contextFor(owner())

    const first = await operations.createBooking.run({
      request,
      context,
      services,
    })
    const second = await operations.createBooking.run({
      request,
      context,
      services,
    })

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(repo.bookings.size).toBe(1)
    expect(services.audit.records).toHaveLength(1)
  })
})

// ── Status ────────────────────────────────────────────────────────────────

describe('booking.change_status', () => {
  it('moves the booking and writes the sentence a manager can read', async () => {
    const booking = await seedConfirmedBooking()
    const services = wiring()

    const outcome = await operations.changeBookingStatus.run({
      request: {
        resourceId: booking.id,
        expectedVersion: 1,
        input: { to: 'pre_arrival' },
      },
      context: contextFor(owner()),
      services,
    })

    expect(outcome.data.booking.status).toBe('pre_arrival')
    expect(outcome.data.booking.version).toBe(2)
    expect(services.audit.records[0].summary).toBe(
      'דנה כהן שינתה את סטטוס הזמנה 8892 מ"מאושרת" ל"לקראת הגעה"',
    )
    expect(services.audit.records[0].action).toBe('booking.pre_arrival')
    expect(services.events.published[0].name).toBe('booking.pre_arrival')
  })

  it('refuses an illegal move and leaves the booking alone', async () => {
    const booking = await seedConfirmedBooking()
    const services = wiring()

    const error = await rejection<BusinessRuleError>(
      operations.changeBookingStatus.run({
        request: {
          resourceId: booking.id,
          expectedVersion: 1,
          input: { to: 'checked_in' },
        },
        context: contextFor(owner()),
        services,
      }),
    )

    expect(error.code).toBe('booking.illegal_transition')
    expect(repo.bookings.get(booking.id)?.status).toBe('confirmed')
    expect(services.audit.records).toHaveLength(0)
    expect(services.events.published).toHaveLength(0)
  })

  it('refuses a stale version before running the rule or the write', async () => {
    // Roni advanced the booking while Dana had the screen open. Dana's move
    // must not be applied to a booking that has moved on.
    const booking = await seedConfirmedBooking()
    await operations.changeBookingStatus.run({
      request: {
        resourceId: booking.id,
        expectedVersion: 1,
        input: { to: 'pre_arrival' },
      },
      context: contextFor(owner()),
      services: wiring(),
    })

    const services = wiring()
    const error = await rejection<ConflictError>(
      operations.changeBookingStatus.run({
        request: {
          resourceId: booking.id,
          expectedVersion: 1,
          input: { to: 'ready_for_check_in' },
        },
        context: contextFor(owner()),
        services,
      }),
    )

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.expectedVersion).toBe(1)
    expect(error.actualVersion).toBe(2)
    expect(repo.bookings.get(booking.id)?.status).toBe('pre_arrival')
    expect(services.audit.records).toHaveLength(0)
  })

  it('refuses an update that never says which version it edited', async () => {
    const booking = await seedConfirmedBooking()

    const error = await rejection<ValidationError>(
      operations.changeBookingStatus.run({
        request: { resourceId: booking.id, input: { to: 'pre_arrival' } },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error.issues[0].field).toBe('version')
  })

  it('refuses the move before any data is read when the grant is missing', async () => {
    const booking = await seedConfirmedBooking()
    repo.reads = 0

    const error = await rejection<AuthorizationError>(
      operations.changeBookingStatus.run({
        request: {
          resourceId: booking.id,
          expectedVersion: 1,
          input: { to: 'pre_arrival' },
        },
        context: contextFor(actorWith(['booking.view'])),
        services: wiring(),
      }),
    )

    expect(error).toBeInstanceOf(AuthorizationError)
    expect(repo.reads).toBe(0)
    expect(repo.bookings.get(booking.id)?.status).toBe('confirmed')
  })

  it('refuses a deposit release to someone who may only change status', async () => {
    // Holding `booking.change_status` must not be a way to hand a guest's
    // money back. The state machine's own permission is enforced here.
    const booking = await seedConfirmedBooking()
    repo.bookings.set(booking.id, {
      ...booking,
      status: 'inspection',
      depositHeldAgorot: 100000,
    })

    const error = await rejection<AuthorizationError>(
      operations.changeBookingStatus.run({
        request: {
          resourceId: booking.id,
          expectedVersion: 1,
          input: { to: 'deposit_release' },
        },
        context: contextFor(actorWith(['booking.change_status']), {
          reason: 'הפיקדון מוחזר',
        }),
        services: wiring(),
      }),
    )

    expect(error.grant).toBe('deposit.release')
    expect(repo.bookings.get(booking.id)?.status).toBe('inspection')
  })

  it('demands a reason for a move that carries one', async () => {
    const booking = await seedConfirmedBooking()

    const error = await rejection<ValidationError>(
      operations.changeBookingStatus.run({
        request: {
          resourceId: booking.id,
          expectedVersion: 1,
          input: { to: 'no_show' },
        },
        context: contextFor(owner(), {
          now: new Date('2026-09-04T09:00:00.000Z'),
        }),
        services: wiring(),
      }),
    )

    expect(error.issues[0].field).toBe('reason')
  })

  it('sends a cancellation to the operation that demands a reason', async () => {
    const booking = await seedConfirmedBooking()

    const error = await rejection<BusinessRuleError>(
      operations.changeBookingStatus.run({
        request: {
          resourceId: booking.id,
          expectedVersion: 1,
          input: { to: 'cancelled' },
        },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('booking.use_cancel_operation')
  })

  it('refuses a booking belonging to another organization', async () => {
    const booking = await seedConfirmedBooking()
    repo.bookings.set(booking.id, { ...booking, organizationId: OTHER_ORG })

    const error = await rejection<AuthorizationError>(
      operations.changeBookingStatus.run({
        request: {
          resourceId: booking.id,
          expectedVersion: 1,
          input: { to: 'pre_arrival' },
        },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error.decision.reason).toBe('cross_organization')
  })
})

// ── Amending ──────────────────────────────────────────────────────────────

describe('booking.amend_dates', () => {
  it('moves the dates and names the change in the audit trail', async () => {
    const booking = await seedConfirmedBooking()
    const services = wiring()

    await operations.amendBookingDates.run({
      request: {
        resourceId: booking.id,
        expectedVersion: 1,
        input: { checkIn: '2026-09-05', checkOut: '2026-09-06' },
      },
      context: contextFor(owner()),
      services,
    })

    expect(services.audit.records[0].summary).toContain(
      'שינתה את תאריכי הזמנה 8892 מ-3.9 ל-5.9',
    )
    expect(repo.bookings.get(booking.id)?.checkIn).toBe('2026-09-05')
  })

  it('does not collide with the booking being amended', async () => {
    const booking = await seedConfirmedBooking()

    const outcome = await operations.amendBookingDates.run({
      request: {
        resourceId: booking.id,
        expectedVersion: 1,
        input: { checkIn: '2026-09-04', checkOut: '2026-09-07' },
      },
      context: contextFor(owner()),
      services: wiring(),
    })

    expect(outcome.data.booking.checkOut).toBe('2026-09-07')
  })

  it('refuses an amendment that would collide, with a conflict', async () => {
    const first = await seedConfirmedBooking()
    await seedConfirmedBooking({
      checkIn: '2026-09-10',
      checkOut: '2026-09-14',
    })

    const error = await rejection<ConflictError>(
      operations.amendBookingDates.run({
        request: {
          resourceId: first.id,
          expectedVersion: 1,
          input: { checkIn: '2026-09-08', checkOut: '2026-09-12' },
        },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error).toBeInstanceOf(ConflictError)
    expect(repo.bookings.get(first.id)?.checkIn).toBe('2026-09-03')
  })

  it('refuses a range that ends before it begins', async () => {
    const booking = await seedConfirmedBooking()

    const error = await rejection<ValidationError>(
      operations.amendBookingDates.run({
        request: {
          resourceId: booking.id,
          expectedVersion: 1,
          input: { checkIn: '2026-09-08', checkOut: '2026-09-04' },
        },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error.issues[0].field).toBe('checkOut')
  })

  it('lets an override move a booking onto taken dates, with a reason', async () => {
    const first = await seedConfirmedBooking()
    await seedConfirmedBooking({
      checkIn: '2026-09-10',
      checkOut: '2026-09-14',
    })

    const outcome = await operations.amendBookingDates.run({
      request: {
        resourceId: first.id,
        expectedVersion: 1,
        input: {
          checkIn: '2026-09-10',
          checkOut: '2026-09-12',
          overrideAvailability: true,
        },
      },
      context: contextFor(owner(), { reason: 'אישור מנהל — פיצול יחידות' }),
      services: wiring(),
    })

    expect(outcome.data.booking.checkIn).toBe('2026-09-10')
  })

  it('refuses a stale version', async () => {
    const booking = await seedConfirmedBooking()

    const error = await rejection<ConflictError>(
      operations.amendBookingDates.run({
        request: {
          resourceId: booking.id,
          expectedVersion: 9,
          input: { checkIn: '2026-09-04', checkOut: '2026-09-07' },
        },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error.actualVersion).toBe(1)
  })

  it('refuses to rewrite the dates of a stay that already happened', async () => {
    const booking = await seedConfirmedBooking()
    repo.bookings.set(booking.id, { ...booking, status: 'checked_out' })

    const error = await rejection<BusinessRuleError>(
      operations.amendBookingDates.run({
        request: {
          resourceId: booking.id,
          expectedVersion: 1,
          input: { checkIn: '2026-09-04', checkOut: '2026-09-07' },
        },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('booking.dates_locked')
  })

  it('lets an in-house guest extend, but not move their arrival', async () => {
    const booking = await seedConfirmedBooking()
    repo.bookings.set(booking.id, { ...booking, status: 'in_house' })

    const moved = await rejection<BusinessRuleError>(
      operations.amendBookingDates.run({
        request: {
          resourceId: booking.id,
          expectedVersion: 1,
          input: { checkIn: '2026-09-04', checkOut: '2026-09-08' },
        },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )
    expect(moved.code).toBe('booking.arrival_locked')

    const extended = await operations.amendBookingDates.run({
      request: {
        resourceId: booking.id,
        expectedVersion: 1,
        input: { checkIn: '2026-09-03', checkOut: '2026-09-08' },
      },
      context: contextFor(owner()),
      services: wiring(),
    })
    expect(extended.data.booking.checkOut).toBe('2026-09-08')
  })

  it('refuses to shorten a stay in progress', async () => {
    const booking = await seedConfirmedBooking()
    repo.bookings.set(booking.id, { ...booking, status: 'in_house' })

    const error = await rejection<BusinessRuleError>(
      operations.amendBookingDates.run({
        request: {
          resourceId: booking.id,
          expectedVersion: 1,
          input: { checkIn: '2026-09-03', checkOut: '2026-09-05' },
        },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('booking.shortening_in_stay')
  })

  it('reprices only when asked, and says which happened', async () => {
    const booking = await seedConfirmedBooking()
    const services = wiring()

    await operations.amendBookingDates.run({
      request: {
        resourceId: booking.id,
        expectedVersion: 1,
        input: {
          checkIn: '2026-09-03',
          checkOut: '2026-09-08',
          pricing: { baseNightlyAgorot: 100000 },
        },
      },
      context: contextFor(owner()),
      services,
    })

    expect(repo.bookings.get(booking.id)?.totalAgorot).toBe(500000)
    expect(services.audit.records[0].summary).toContain('חושב מחדש')
  })

  it('refuses repricing to someone who may not override a price', async () => {
    const booking = await seedConfirmedBooking()

    const error = await rejection<AuthorizationError>(
      operations.amendBookingDates.run({
        request: {
          resourceId: booking.id,
          expectedVersion: 1,
          input: {
            checkIn: '2026-09-03',
            checkOut: '2026-09-08',
            pricing: { baseNightlyAgorot: 1 },
          },
        },
        context: contextFor(actorWith(['booking.update'])),
        services: wiring(),
      }),
    )

    expect(error.grant).toBe('booking.override_price')
  })
})

// ── Cancelling ────────────────────────────────────────────────────────────

describe('booking.cancel', () => {
  it('cancels and puts the dates back on sale', async () => {
    const booking = await seedConfirmedBooking()
    expect(await isFree('2026-09-03', '2026-09-06')).toBe(false)

    const services = wiring()
    await operations.cancelBooking.run({
      request: { resourceId: booking.id, expectedVersion: 1, input: {} },
      context: contextFor(owner(), { reason: 'האורח ביטל' }),
      services,
    })

    expect(repo.bookings.get(booking.id)?.status).toBe('cancelled')
    expect(await isFree('2026-09-03', '2026-09-06')).toBe(true)
    expect(services.audit.records[0].summary).toBe(
      'דנה כהן ביטלה את הזמנה 8892 של משה לוי לתאריכים 3.9–6.9',
    )
    expect(services.audit.records[0].reason).toBe('האורח ביטל')
  })

  it('lets the freed dates be sold to somebody else', async () => {
    const booking = await seedConfirmedBooking()
    await operations.cancelBooking.run({
      request: { resourceId: booking.id, expectedVersion: 1, input: {} },
      context: contextFor(owner(), { reason: 'האורח ביטל' }),
      services: wiring(),
    })

    const replacement = await operations.createBooking.run({
      request: { input: createInput({ guestName: 'רותי כהן' }) },
      context: contextFor(owner()),
      services: wiring(),
    })

    expect(replacement.data.booking.guestName).toBe('רותי כהן')
  })

  it('refuses a cancellation with no stated reason', async () => {
    const booking = await seedConfirmedBooking()

    const error = await rejection<ValidationError>(
      operations.cancelBooking.run({
        request: { resourceId: booking.id, expectedVersion: 1, input: {} },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error.issues[0].field).toBe('reason')
    expect(repo.bookings.get(booking.id)?.status).toBe('confirmed')
  })

  it('refuses to cancel a stay that has already ended', async () => {
    const booking = await seedConfirmedBooking()
    repo.bookings.set(booking.id, { ...booking, status: 'checked_out' })

    const error = await rejection<BusinessRuleError>(
      operations.cancelBooking.run({
        request: { resourceId: booking.id, expectedVersion: 1, input: {} },
        context: contextFor(owner(), { reason: 'האורח התלונן' }),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('booking.illegal_transition')
  })

  it('cancels a guest who is already in the unit, as an early termination', async () => {
    const booking = await seedConfirmedBooking()
    repo.bookings.set(booking.id, { ...booking, status: 'in_house' })

    const outcome = await operations.cancelBooking.run({
      request: { resourceId: booking.id, expectedVersion: 1, input: {} },
      context: contextFor(owner(), { reason: 'הפסקת שהות בהסכמה' }),
      services: wiring(),
    })

    expect(outcome.data.booking.status).toBe('cancelled')
  })

  it('gates waiving the cancellation fee behind the price permission', async () => {
    const booking = await seedConfirmedBooking()

    const error = await rejection<AuthorizationError>(
      operations.cancelBooking.run({
        request: {
          resourceId: booking.id,
          expectedVersion: 1,
          input: { waiveCancellationFee: true },
        },
        context: contextFor(actorWith(['booking.cancel']), {
          reason: 'מחווה ללקוח',
        }),
        services: wiring(),
      }),
    )

    expect(error.grant).toBe('booking.override_price')
  })
})

// ── Holds ─────────────────────────────────────────────────────────────────

describe('hold.create and hold.release', () => {
  function holdInput(overrides: Record<string, unknown> = {}) {
    return {
      unitId: UNIT,
      unitLabel: 'וילה הכרמל',
      propertyId: PROP,
      checkIn: '2026-09-03',
      checkOut: '2026-09-06',
      reason: 'agent_quote',
      ...overrides,
    }
  }

  it('holds the dates and says for how long', async () => {
    const services = wiring()

    const outcome = await operations.placeHold.run({
      request: { input: holdInput() },
      context: contextFor(owner()),
      services,
    })

    expect(isHoldLive(outcome.data.hold, NOW)).toBe(true)
    expect(await isFree('2026-09-04', '2026-09-05')).toBe(false)
    expect(services.audit.records[0].summary).toBe(
      'דנה כהן תפסה את היחידה וילה הכרמל לתאריכים 3.9–6.9 למשך 30 דקות ' +
        '(הצעת סוכן)',
    )
  })

  it('refuses an agent who is already at their limit', async () => {
    for (let index = 0; index < 5; index += 1) {
      repo.seedHold({
        checkIn: `2026-10-0${index + 1}`,
        checkOut: `2026-10-0${index + 2}`,
      })
    }

    const error = await rejection<BusinessRuleError>(
      operations.placeHold.run({
        request: { input: holdInput() },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('hold.limit_reached')
    expect(repo.holds.size).toBe(5)
  })

  it('does not count expired holds towards the limit', async () => {
    // The row is still there and nothing has swept it. Expiry is honoured on
    // read, so the agent is not locked out by last week's work.
    for (let index = 0; index < 5; index += 1) {
      repo.seedHold({ expiresAt: '2026-08-20T08:00:00.000Z' })
    }

    const outcome = await operations.placeHold.run({
      request: { input: holdInput() },
      context: contextFor(owner()),
      services: wiring(),
    })

    expect(outcome.data.hold.id).toBe('hold-6')
  })

  it('refuses to hold dates a booking already occupies', async () => {
    await seedConfirmedBooking()

    const error = await rejection<ConflictError>(
      operations.placeHold.run({
        request: {
          input: holdInput({ checkIn: '2026-09-05', checkOut: '2026-09-07' }),
        },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error).toBeInstanceOf(ConflictError)
  })

  it('lets a maintenance block ignore the minimum stay', async () => {
    repo.rules = { unitId: UNIT, minimumNights: 7, blockedDates: [] }

    const outcome = await operations.placeHold.run({
      request: {
        input: holdInput({
          checkIn: '2026-09-03',
          checkOut: '2026-09-04',
          reason: 'maintenance_block',
        }),
      },
      context: contextFor(owner()),
      services: wiring(),
    })

    expect(outcome.data.hold.reason).toBe('maintenance_block')
  })

  it('refuses a hold longer than the policy for its reason', async () => {
    const error = await rejection<BusinessRuleError>(
      operations.placeHold.run({
        request: {
          input: holdInput({ reason: 'guest_checkout', minutes: 600 }),
        },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('hold.duration_too_long')
  })

  it('releases a hold and frees the dates', async () => {
    const placed = await operations.placeHold.run({
      request: { input: holdInput() },
      context: contextFor(owner()),
      services: wiring(),
    })

    const services = wiring()
    await operations.releaseHold.run({
      request: { resourceId: placed.data.hold.id },
      context: contextFor(owner()),
      services,
    })

    expect(await isFree('2026-09-03', '2026-09-06')).toBe(true)
    expect(services.audit.records[0].summary).toContain('שחררה את ההחזקה')
  })

  it('refuses a second release of the same hold', async () => {
    const hold = repo.seedHold({ releasedAt: '2026-08-20T08:50:00.000Z' })

    const error = await rejection<BusinessRuleError>(
      operations.releaseHold.run({
        request: { resourceId: hold.id },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('hold.already_released')
  })

  it('refuses to release a hold in another organization', async () => {
    const hold = repo.seedHold({ organizationId: OTHER_ORG })

    await expect(
      operations.releaseHold.run({
        request: { resourceId: hold.id },
        context: contextFor(owner()),
        services: wiring(),
      }),
    ).rejects.toThrow()
  })
})

// ── Converting a hold ─────────────────────────────────────────────────────

describe('converting a hold into a booking', () => {
  async function placeHoldFor(range: { checkIn: string; checkOut: string }) {
    const outcome = await operations.placeHold.run({
      request: {
        input: {
          unitId: UNIT,
          unitLabel: 'וילה הכרמל',
          propertyId: PROP,
          reason: 'agent_quote',
          ...range,
        },
      },
      context: contextFor(owner()),
      services: wiring(),
    })
    return outcome.data.hold
  }

  it('does not let the hold block its own booking', async () => {
    // Without ignoring it, the agent's own hold refuses the booking it was
    // placed to protect.
    const hold = await placeHoldFor({
      checkIn: '2026-09-03',
      checkOut: '2026-09-06',
    })

    const outcome = await operations.createBooking.run({
      request: { input: createInput({ fromHoldId: hold.id }) },
      context: contextFor(owner()),
      services: wiring(),
    })

    expect(outcome.data.booking.id).toBe('bk-1')
    expect(outcome.data.hold?.convertedToBookingId).toBe('bk-1')
    expect(isHoldLive(repo.holds.get(hold.id)!, NOW)).toBe(false)
  })

  it('leaves the dates held by the booking, not by the hold', async () => {
    const hold = await placeHoldFor({
      checkIn: '2026-09-03',
      checkOut: '2026-09-06',
    })
    await operations.createBooking.run({
      request: { input: createInput({ fromHoldId: hold.id }) },
      context: contextFor(owner()),
      services: wiring(),
    })

    const result = await checkAvailability(
      repo,
      {
        organizationId: ORG,
        unitId: UNIT,
        range: { checkIn: '2026-09-04', checkOut: '2026-09-05' },
      },
      { now: NOW },
    )

    expect(result.blockers.map((blocker) => blocker.kind)).toEqual(['booking'])
  })

  it('refuses a hold that has already expired', async () => {
    const hold = repo.seedHold({
      checkIn: '2026-09-03',
      checkOut: '2026-09-06',
      expiresAt: '2026-08-20T08:00:00.000Z',
    })

    const error = await rejection<BusinessRuleError>(
      operations.createBooking.run({
        request: { input: createInput({ fromHoldId: hold.id }) },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('hold.not_live')
    expect(repo.bookings.size).toBe(0)
  })

  it('refuses a hold that does not cover the whole stay', async () => {
    const hold = await placeHoldFor({
      checkIn: '2026-09-04',
      checkOut: '2026-09-05',
    })

    const error = await rejection<BusinessRuleError>(
      operations.createBooking.run({
        request: { input: createInput({ fromHoldId: hold.id }) },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('hold.does_not_cover_dates')
  })

  it('refuses a hold on a different unit', async () => {
    const hold = repo.seedHold({
      unitId: 'unit-2',
      checkIn: '2026-09-03',
      checkOut: '2026-09-06',
    })

    const error = await rejection<BusinessRuleError>(
      operations.createBooking.run({
        request: { input: createInput({ fromHoldId: hold.id }) },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('hold.wrong_unit')
  })
})

// ── The race ──────────────────────────────────────────────────────────────

describe('two bookings for the same dates at the same instant', () => {
  it('lets both through when only the application check is in play — the database exclusion constraint is the real guarantee', async () => {
    // Not a bug being documented as a feature: it is the reason the constraint
    // exists. Both requests read a free calendar before either has written, and
    // no amount of care in the availability engine closes that window.
    const [first, second] = await Promise.all([
      operations.createBooking.run({
        request: { input: createInput({ guestName: 'משה לוי' }) },
        context: contextFor(owner()),
        services: wiring(),
      }),
      operations.createBooking.run({
        request: { input: createInput({ guestName: 'רותי כהן' }) },
        context: contextFor(owner()),
        services: wiring(),
      }),
    ])

    expect(first.data.booking.id).not.toBe(second.data.booking.id)
    expect(repo.bookings.size).toBe(2)
  })

  it('is stopped by the exclusion constraint, and the failure reaches the caller', async () => {
    repo.enforceExclusion = true

    const results = await Promise.allSettled([
      operations.createBooking.run({
        request: { input: createInput({ guestName: 'משה לוי' }) },
        context: contextFor(owner()),
        services: wiring(),
      }),
      operations.createBooking.run({
        request: { input: createInput({ guestName: 'רותי כהן' }) },
        context: contextFor(owner()),
        services: wiring(),
      }),
    ])

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1)
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1)
    expect(repo.bookings.size).toBe(1)
  })

  it('rolls the transaction back when the constraint rejects the write', async () => {
    await seedConfirmedBooking()
    repo.enforceExclusion = true
    const services = wiring()

    await expect(
      operations.createBooking.run({
        request: { input: createInput({ overrideAvailability: true }) },
        context: contextFor(owner(), { reason: 'אישור מנהל' }),
        services,
      }),
    ).rejects.toThrow('exclusion constraint')

    expect(services.audit.records).toHaveLength(0)
    expect(services.events.published).toHaveLength(0)
  })
})

// ── The intake ────────────────────────────────────────────────────────────

/**
 * What the booking screen now collects, and where each piece lands.
 *
 * `public.bookings` has held `adults`, `children` and `infants` as separate
 * columns since 0009 and the form sent one number, so the schema was ahead of
 * the screen and the preparation engine was ahead of both. These tests exercise
 * the middle: the operation takes the split, refuses the ways it can be wrong,
 * and hands a draft that names every fact a work plan is built from.
 */
describe('booking.create · the party and the preparation intake', () => {
  it('carries the split, the sleeping shape and the event type onto the draft', async () => {
    const outcome = await operations.createBooking.run({
      request: {
        input: createInput({
          guestCount: 7,
          adults: 4,
          children: 2,
          infants: 1,
          couples: 2,
          extraBedsRequested: 1,
          cotsRequested: 2,
          eventType: 'shabbat',
          specialRequests: '  שתי מיטות תינוק  ',
        }),
      },
      context: contextFor(owner()),
      services: wiring(),
    })

    const written = repo.drafts.get(outcome.data.booking.id)
    expect(written).toBeDefined()
    expect(written?.party).toEqual({ adults: 4, children: 2, infants: 1 })
    expect(written?.sleeping).toEqual({
      couples: 2,
      extraBedsRequested: 1,
      cotsRequested: 2,
    })
    expect(written?.eventType).toBe('shabbat')
    // Trimmed, because "  " is not a special request and a stored blank is a
    // note a cleaner has to read to discover it says nothing.
    expect(written?.specialRequests).toBe('שתי מיטות תינוק')
    // The head count still totals the party, so nothing that prices or
    // capacity-checks a stay has changed meaning underneath it.
    expect(written?.guestCount).toBe(7)
  })

  it('defaults to the plain stay and the whole party as adults', async () => {
    // A caller that predates the split — a channel importer, the old form —
    // gets exactly what `SupabaseBookingRepository` has always written, named
    // rather than accidental.
    const outcome = await operations.createBooking.run({
      request: { input: createInput({ guestCount: 5 }) },
      context: contextFor(owner()),
      services: wiring(),
    })

    const written = repo.drafts.get(outcome.data.booking.id)
    expect(written?.party).toEqual({ adults: 5, children: 0, infants: 0 })
    expect(written?.eventType).toBe('accommodation')
    expect(written?.specialRequests).toBeNull()
  })

  it('refuses a split that does not add up to the head count', async () => {
    const error = await rejection<ValidationError>(
      operations.createBooking.run({
        request: {
          input: createInput({ guestCount: 7, adults: 4, children: 2 }),
        },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.issues[0].field).toBe('guestCount')
  })

  it('refuses more couples than there are adults to make them', async () => {
    const error = await rejection<ValidationError>(
      operations.createBooking.run({
        request: {
          input: createInput({ guestCount: 4, adults: 4, couples: 3 }),
        },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error.issues[0].field).toBe('couples')
    expect(error.issues[0].message).toContain('3 זוגות')
  })

  it('refuses an event type outside the frozen list', async () => {
    const error = await rejection<ValidationError>(
      operations.createBooking.run({
        request: { input: createInput({ eventType: 'bar_mitzvah' }) },
        context: contextFor(owner()),
        services: wiring(),
      }),
    )

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.issues[0].field).toBe('eventType')
  })

  it('names the party and the event in the audit sentence and the payload', async () => {
    const services = wiring()

    await operations.createBooking.run({
      request: {
        input: createInput({
          guestCount: 7,
          adults: 4,
          children: 2,
          infants: 1,
          couples: 2,
          cotsRequested: 2,
          eventType: 'shabbat',
        }),
      },
      context: contextFor(owner()),
      services,
    })

    expect(services.audit.records[0].summary).toContain(
      'עבור 4 מבוגרים, 2 ילדים, תינוק אחד (שבת)',
    )
    // Until the columns exist, this payload is the only machine-readable record
    // of the event type and the cots. Asserted here so that is a decision
    // somebody made rather than something discovered later.
    expect(services.audit.records[0].after).toMatchObject({
      adults: 4,
      children: 2,
      infants: 1,
      couples: 2,
      cotsRequested: 2,
      eventType: 'shabbat',
    })
    expect(services.events.published[0].payload).toMatchObject({
      adults: 4,
      children: 2,
      infants: 1,
      eventType: 'shabbat',
    })
  })
})

// ── The agreed price ──────────────────────────────────────────────────────

/**
 * The price of a stay is whatever the seller decides, deal by deal.
 *
 * A villa owner is not running a hotel with a rate card: two identical stays
 * can sell for different amounts and neither is a mistake. The unit's stored
 * rate is a default, not a floor. What must stay true is that the price is
 * *authorized* rather than merely accepted, and that the stored total is the
 * sum of the lines the quote produced.
 */
describe('booking.create · the price the seller agreed', () => {
  it('prices the stay at the agreed rate rather than the unit rate', async () => {
    const outcome = await operations.createBooking.run({
      request: { input: createInput({ agreedNightlyAgorot: 90000 }) },
      context: contextFor(owner()),
      services: wiring(),
    })

    // Three nights at ₪900 rather than three at ₪1,200. Below the unit's rate,
    // and that is an ordinary sale rather than something to warn about.
    expect(outcome.data.booking.totalAgorot).toBe(270000)
    expect(
      outcome.data.quote.lines
        .filter((line) => line.kind === 'accommodation')
        .every((line) => line.amount === 90000),
    ).toBe(true)
  })

  it('accepts a price above the unit rate just as readily', async () => {
    const outcome = await operations.createBooking.run({
      request: { input: createInput({ agreedNightlyAgorot: 200000 }) },
      context: contextFor(owner()),
      services: wiring(),
    })

    expect(outcome.data.booking.totalAgorot).toBe(600000)
  })

  it('refuses an agreed price without the permission that governs prices', async () => {
    const error = await rejection<AuthorizationError>(
      operations.createBooking.run({
        request: { input: createInput({ agreedNightlyAgorot: 90000 }) },
        context: contextFor(actorWith(['booking.create'])),
        services: wiring(),
      }),
    )

    expect(error).toBeInstanceOf(AuthorizationError)
    expect(error.grant).toBe('booking.override_price')
  })

  it('asks for no justification, because an agreed price is not an exception', async () => {
    // A manual discount demands a reason and is tested above. This does not:
    // making the normal case explain itself teaches a desk to type a full stop
    // into the box.
    const services = wiring()

    const outcome = await operations.createBooking.run({
      request: { input: createInput({ agreedNightlyAgorot: 90000 }) },
      context: contextFor(owner()),
      services,
    })

    expect(outcome.ok).toBe(true)
    expect(services.audit.records[0].summary).toContain(
      'במחיר מוסכם של ₪900 ללילה',
    )
    expect(services.audit.records[0].after).toMatchObject({
      agreedNightlyAgorot: 90000,
    })
  })

  it('drops the extra-guest supplement, because an agreed rate covers the party', async () => {
    const withoutAgreement = await operations.createBooking.run({
      request: {
        input: createInput({
          guestCount: 6,
          pricing: {
            baseNightlyAgorot: 120000,
            includedGuests: 2,
            extraGuestNightlyAgorot: 10000,
          },
        }),
      },
      context: contextFor(owner()),
      services: wiring(),
    })

    // Four guests over the included two, at ₪100 each per night, for 3 nights.
    expect(
      withoutAgreement.data.quote.lines.some(
        (line) => line.kind === 'extra_guest',
      ),
    ).toBe(true)
    expect(withoutAgreement.data.booking.totalAgorot).toBe(480000)

    const withAgreement = await operations.createBooking.run({
      request: {
        input: createInput({
          guestCount: 6,
          checkIn: '2026-10-03',
          checkOut: '2026-10-06',
          agreedNightlyAgorot: 120000,
          pricing: {
            baseNightlyAgorot: 120000,
            includedGuests: 2,
            extraGuestNightlyAgorot: 10000,
          },
        }),
      },
      context: contextFor(owner()),
      services: wiring(),
    })

    expect(
      withAgreement.data.quote.lines.some(
        (line) => line.kind === 'extra_guest',
      ),
    ).toBe(false)
    expect(withAgreement.data.booking.totalAgorot).toBe(360000)
  })

  it('keeps the total a sum of its lines', async () => {
    const outcome = await operations.createBooking.run({
      request: {
        input: createInput({
          agreedNightlyAgorot: 87543,
          pricing: { baseNightlyAgorot: 120000, cleaningFeeAgorot: 25000 },
        }),
      },
      context: contextFor(owner()),
      services: wiring(),
    })

    const summed = outcome.data.quote.lines.reduce(
      (total, line) => total + line.amount,
      0,
    )
    expect(outcome.data.booking.totalAgorot).toBe(summed)
    expect(summed).toBe(87543 * 3 + 25000)
  })
})
