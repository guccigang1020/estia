/**
 * The service pipeline.
 *
 * This is the file the product owner's assurances rest on. "A cleaner cannot
 * change a price", "a stale form does not erase someone else's edit", "a
 * double-submitted payment charges once", "every change is in the log" — none
 * of those sentences mean anything until something proves them, and none of
 * them can be proved by a test that only walks the happy path.
 *
 * So most of what follows is negative. Where an operation must be refused, the
 * test also asserts *how far it got* — because "it refused" and "it refused
 * before reading anything" are different claims, and only the second one is
 * worth making.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from '../authz/can'
import { AuthorizationError } from '../authz/can'
import type { Grant } from '../authz/permissions'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'
import type { PlanLimits } from '../plans/entitlements'
import { formatAgorot } from '../plans/plan'
import {
  FailingAuditWriter,
  InMemoryAuditWriter,
  type AuditWriter,
} from '../audit/pipeline'
import {
  BusinessRuleError,
  ConflictError,
  IdempotencyConflictError,
  NotFoundError,
  QuotaExceededError,
  ValidationError,
  isAppError,
} from '../errors'
import { InMemoryEventBus } from './events'
import { InMemoryIdempotencyStore } from './idempotency'
import {
  defineOperation,
  type OperationContext,
  type OperationServices,
} from './operation'
import { s } from './schema'
import { RecordingTransactionRunner } from './transaction'

// ── The world ─────────────────────────────────────────────────────────────

const ORG = 'org-a'
const OTHER_ORG = 'org-b'
const USER = 'user-dana'
const CORRELATION = 'req-7f2a9c'
const NOW = new Date('2026-03-14T09:30:00.000Z')

const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

const LIMITS: PlanLimits = {
  properties: 5,
  units: 15,
  members: 10,
  storageGb: 50,
}

interface Booking {
  id: string
  organizationId: string
  propertyId: string
  status: 'confirmed' | 'cancelled'
  totalAgorot: number
  version: number
  createdByUserId: string
}

let bookings: Map<string, Booking>
/** Every step records that it ran, so a refusal can be located exactly. */
let ran: { load: number; rule: number; execute: number }

function seedBooking(overrides: Partial<Booking> = {}): Booking {
  const booking: Booking = {
    id: 'bk-1',
    organizationId: ORG,
    propertyId: 'prop-1',
    status: 'confirmed',
    totalAgorot: 520000,
    version: 3,
    createdByUserId: USER,
    ...overrides,
  }
  bookings.set(booking.id, booking)
  return booking
}

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

function contextFor(
  actor: Actor,
  overrides: Partial<OperationContext> = {},
): OperationContext {
  return {
    actor,
    auditActor: { type: 'user', userId: actor.userId, label: 'דנה כהן' },
    correlationId: CORRELATION,
    now: NOW,
    limits: LIMITS,
    ip: '81.218.4.9',
    userAgent: 'Mozilla/5.0',
    ...overrides,
  }
}

interface Wiring extends OperationServices {
  audit: InMemoryAuditWriter
  events: InMemoryEventBus
  idempotency: InMemoryIdempotencyStore
  transactions: RecordingTransactionRunner
  eventErrors: unknown[]
}

function wiring(overrides: { audit?: AuditWriter } = {}): Wiring {
  const eventErrors: unknown[] = []
  return {
    audit: (overrides.audit ??
      new InMemoryAuditWriter()) as InMemoryAuditWriter,
    events: new InMemoryEventBus(),
    idempotency: new InMemoryIdempotencyStore(),
    transactions: new RecordingTransactionRunner(),
    onEventError: (error) => eventErrors.push(error),
    eventErrors,
  }
}

/**
 * Await a rejection, and fail loudly if the operation succeeded instead.
 *
 * A refusal test that quietly passes because the operation returned normally
 * is worse than no test, so this insists on the throw before handing the error
 * back for inspection.
 */
function rejection<E>(promise: Promise<unknown>): Promise<E> {
  return promise.then(
    () => {
      throw new Error('expected the operation to be refused, but it succeeded')
    },
    (error: unknown) => error as E,
  )
}

// ── The operations under test ─────────────────────────────────────────────

/**
 * `booking.update` — the representative case: it loads a tenant-scoped record,
 * takes a version, applies a rule, writes, audits in Hebrew and announces
 * itself.
 */
const updateBooking = defineOperation({
  name: 'booking.update',
  permission: 'booking.update',
  resourceType: 'booking',
  requiresVersion: true,
  input: s.object({
    totalAgorot: s.agorot({ label: 'סכום ההזמנה' }),
    note: s.optional(s.string({ max: 200, label: 'הערה' })),
  }),

  async loadResource({ request }) {
    ran.load += 1
    const booking = bookings.get(request.resourceId ?? '')
    if (!booking) return null
    return {
      // Deliberately returned regardless of which organization owns it, the
      // way a service-role read would. The tenant check is what stops it.
      resource: {
        organizationId: booking.organizationId,
        propertyId: booking.propertyId,
        createdByUserId: booking.createdByUserId,
      },
      entity: booking,
      version: booking.version,
    }
  },

  rule({ entity }) {
    ran.rule += 1
    if (entity.status === 'cancelled') {
      throw new BusinessRuleError({
        code: 'booking.cancelled',
        userMessage: 'לא ניתן לשנות הזמנה שבוטלה.',
      })
    }
  },

  async execute({ input, entity }) {
    ran.execute += 1
    const updated: Booking = {
      ...entity,
      totalAgorot: input.totalAgorot,
      version: entity.version + 1,
    }
    bookings.set(updated.id, updated)
    return updated
  },

  audit({ entity, result, context }) {
    return {
      resourceId: result.id,
      before: { totalAgorot: entity.totalAgorot, status: entity.status },
      after: { totalAgorot: result.totalAgorot, status: result.status },
      summary:
        `${context.auditActor.label} שינתה את סכום ההזמנה ` +
        `מ-${formatAgorot(entity.totalAgorot)} ל-${formatAgorot(result.totalAgorot)}`,
    }
  },

  events({ result }) {
    return [{ name: 'booking.updated', payload: { bookingId: result.id } }]
  },
})

/** `payment.create` — no resource to load, and safe to retry. */
const createPayment = defineOperation({
  name: 'payment.create',
  permission: 'payment.create',
  resourceType: 'payment',
  input: s.object({ bookingId: s.string(), amountAgorot: s.agorot() }),

  async execute({ input, context }) {
    ran.execute += 1
    return {
      id: `pay-${ran.execute}`,
      bookingId: input.bookingId,
      amountAgorot: input.amountAgorot,
      organizationId: context.actor.organizationId,
      // A secret the operation carelessly returns. It must not survive into
      // the audit trail.
      card_token: 'tok_live_9912',
    }
  },

  audit({ result }) {
    return {
      resourceId: result.id,
      after: {
        amountAgorot: result.amountAgorot,
        bookingId: result.bookingId,
        card_token: result.card_token,
      },
      summary: `דנה קיבלה תשלום של ${formatAgorot(result.amountAgorot)}`,
    }
  },

  events({ result }) {
    return [{ name: 'payment.received', payload: { paymentId: result.id } }]
  },
})

/** `guest.export` — in `SENSITIVE_ACTIONS`, so it must demand a reason. */
const exportGuests = defineOperation({
  name: 'guest.export',
  permission: 'guest.export',
  resourceType: 'guest_export',
  input: s.nothing,
  async execute() {
    ran.execute += 1
    return { rows: 412 }
  },
  audit: ({ result }) => ({
    summary: `דנה ייצאה ${result.rows} רשומות אורחים`,
  }),
})

beforeEach(() => {
  bookings = new Map()
  ran = { load: 0, rule: 0, execute: 0 }
})

function updateRequest(overrides: Record<string, unknown> = {}) {
  return {
    resourceId: 'bk-1',
    expectedVersion: 3,
    input: { totalAgorot: 470000 },
    ...overrides,
  }
}

// ── Authorization ─────────────────────────────────────────────────────────

describe('authorization', () => {
  it('refuses before any data is loaded when the grant is missing', async () => {
    seedBooking()
    const services = wiring()

    const error = await rejection<AuthorizationError>(
      updateBooking.run({
        request: updateRequest(),
        context: contextFor(actorWith(['task.complete'])),
        services,
      }),
    )

    expect(error).toBeInstanceOf(AuthorizationError)
    // The point of the two-phase check: nothing was read, so the refusal
    // cannot be undermined by a load that throws or has a side effect.
    expect(ran.load).toBe(0)
    expect(ran.rule).toBe(0)
    expect(ran.execute).toBe(0)
    expect(services.audit.records).toHaveLength(0)
    expect(services.events.published).toHaveLength(0)
  })

  it('refuses a resource belonging to another organization', async () => {
    seedBooking({ organizationId: OTHER_ORG })
    const services = wiring()

    const error = await rejection<AuthorizationError>(
      updateBooking.run({
        request: updateRequest(),
        context: contextFor(actorWith(['booking.update'])),
        services,
      }),
    )

    expect(error).toBeInstanceOf(AuthorizationError)
    expect(error.decision.reason).toBe('cross_organization')
    // Loaded — it had to be, to know whose it was — and then stopped dead.
    expect(ran.load).toBe(1)
    expect(ran.rule).toBe(0)
    expect(ran.execute).toBe(0)
    expect(bookings.get('bk-1')?.totalAgorot).toBe(520000)
    expect(services.audit.records).toHaveLength(0)
  })

  it('refuses a resource outside the actor’s scope', async () => {
    seedBooking({ propertyId: 'prop-9' })

    const error = await rejection<AuthorizationError>(
      updateBooking.run({
        request: updateRequest(),
        context: contextFor(
          actorWith(['booking.update'], {
            scope: { kind: 'properties', propertyIds: ['prop-1'] },
          }),
        ),
        services: wiring(),
      }),
    )

    expect(error.decision.reason).toBe('out_of_scope')
    expect(ran.execute).toBe(0)
  })

  it('refuses a suspended member before reading anything', async () => {
    seedBooking()

    const error = await rejection<AuthorizationError>(
      updateBooking.run({
        request: updateRequest(),
        context: contextFor(
          actorWith(['booking.update'], { membershipStatus: 'suspended' }),
        ),
        services: wiring(),
      }),
    )

    expect(error).toBeInstanceOf(AuthorizationError)
    expect(ran.load).toBe(0)
  })

  it('refuses when the plan does not include the feature', async () => {
    const createTask = defineOperation({
      name: 'task.create',
      permission: 'task.create',
      resourceType: 'task',
      input: s.object({ title: s.string() }),
      async execute() {
        ran.execute += 1
        return { id: 't-1' }
      },
      audit: () => ({ resourceId: 't-1', summary: 'דנה יצרה משימה חדשה' }),
    })

    const error = await rejection<AuthorizationError>(
      createTask.run({
        request: { input: { title: 'ניקיון' } },
        context: contextFor(
          actorWith(['task.create'], {
            entitlements: new Set<Entitlement>(['core']),
          }),
        ),
        services: wiring(),
      }),
    )

    expect(error.decision.reason).toBe('plan_does_not_include')
    expect(ran.execute).toBe(0)
  })

  it('reports a missing record as not found', async () => {
    const error = await rejection<NotFoundError>(
      updateBooking.run({
        request: updateRequest({ resourceId: 'bk-missing' }),
        context: contextFor(actorWith(['booking.update'])),
        services: wiring(),
      }),
    )

    expect(error).toBeInstanceOf(NotFoundError)
    expect(ran.execute).toBe(0)
  })
})

// ── Validation ────────────────────────────────────────────────────────────

describe('validation', () => {
  it('lists every offending field, not just the first', async () => {
    seedBooking()
    const services = wiring()

    const error = await rejection<ValidationError>(
      updateBooking.run({
        request: updateRequest({
          input: { totalAgorot: -5, note: 'x'.repeat(300), colour: 'blue' },
        }),
        context: contextFor(actorWith(['booking.update'])),
        services,
      }),
    )

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.issues.map((i) => i.field).sort()).toEqual([
      'colour',
      'note',
      'totalAgorot',
    ])
    expect(error.issues.every((i) => i.message.length > 0)).toBe(true)
    expect(ran.load).toBe(0)
    expect(ran.execute).toBe(0)
    expect(services.audit.records).toHaveLength(0)
  })

  it('collects the missing version alongside the field problems', async () => {
    seedBooking()

    const error = await rejection<ValidationError>(
      updateBooking.run({
        request: { resourceId: 'bk-1', input: { totalAgorot: 'lots' } },
        context: contextFor(actorWith(['booking.update'])),
        services: wiring(),
      }),
    )

    expect(error.issues.map((i) => i.field).sort()).toEqual([
      'totalAgorot',
      'version',
    ])
  })

  it('demands a stated reason for a sensitive action, without being told to', async () => {
    // `guest.export` is in SENSITIVE_ACTIONS. The charter's rule — that such
    // actions need more than a permission — is enforced by the pipeline rather
    // than left to each operation to remember.
    const services = wiring()
    const context = contextFor(actorWith(['guest.export']))

    const error = await rejection<ValidationError>(
      exportGuests.run({ request: {}, context, services }),
    )

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.issues[0].field).toBe('reason')
    expect(ran.execute).toBe(0)
    expect(services.audit.records).toHaveLength(0)
  })

  it('proceeds and records the justification once one is given', async () => {
    const services = wiring()
    const context = contextFor(actorWith(['guest.export']), {
      reason: 'בקשת מחיקה לפי חוק הגנת הפרטיות',
    })

    const outcome = await exportGuests.run({ request: {}, context, services })

    expect(outcome.data.rows).toBe(412)
    expect(services.audit.records[0].reason).toBe(
      'בקשת מחיקה לפי חוק הגנת הפרטיות',
    )
  })
})

// ── Optimistic locking ────────────────────────────────────────────────────

describe('optimistic locking', () => {
  it('succeeds when the version still matches', async () => {
    seedBooking({ version: 3 })

    const outcome = await updateBooking.run({
      request: updateRequest({ expectedVersion: 3 }),
      context: contextFor(actorWith(['booking.update'])),
      services: wiring(),
    })

    expect(outcome.data.version).toBe(4)
    expect(bookings.get('bk-1')?.totalAgorot).toBe(470000)
  })

  it('refuses a stale version and never reaches execute', async () => {
    // Roni saved while Dana had the form open. Dana's save must not silently
    // erase Roni's change.
    seedBooking({ version: 5, totalAgorot: 480000 })
    const services = wiring()

    const error = await rejection<ConflictError>(
      updateBooking.run({
        request: updateRequest({ expectedVersion: 3 }),
        context: contextFor(actorWith(['booking.update'])),
        services,
      }),
    )

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.expectedVersion).toBe(3)
    expect(error.actualVersion).toBe(5)
    expect(ran.execute).toBe(0)
    expect(ran.rule).toBe(0)
    expect(bookings.get('bk-1')?.totalAgorot).toBe(480000)
    expect(services.audit.records).toHaveLength(0)
    expect(services.events.published).toHaveLength(0)
  })

  it('refuses an update that does not say which version it edited', async () => {
    seedBooking()

    const error = await rejection<ValidationError>(
      updateBooking.run({
        request: { resourceId: 'bk-1', input: { totalAgorot: 470000 } },
        context: contextFor(actorWith(['booking.update'])),
        services: wiring(),
      }),
    )

    expect(error.issues).toEqual([
      {
        field: 'version',
        code: 'required',
        message: 'לא ידוע איזו גרסה של הרשומה נערכה. רענן את הדף ונסה שוב.',
      },
    ])
  })
})

// ── Idempotency ───────────────────────────────────────────────────────────

describe('idempotency', () => {
  const request = {
    idempotencyKey: 'key-1',
    input: { bookingId: 'bk-1', amountAgorot: 470000 },
  }

  it('replays the first result instead of acting twice', async () => {
    const services = wiring()
    const context = contextFor(actorWith(['payment.create']))

    const first = await createPayment.run({ request, context, services })
    const second = await createPayment.run({ request, context, services })

    expect(ran.execute).toBe(1)
    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.data).toEqual(first.data)
  })

  it('does not audit or announce a replay', async () => {
    const services = wiring()
    const context = contextFor(actorWith(['payment.create']))

    await createPayment.run({ request, context, services })
    await createPayment.run({ request, context, services })

    // One real payment: one audit event, one announcement.
    expect(services.audit.records).toHaveLength(1)
    expect(services.events.published).toHaveLength(1)
  })

  it('is insensitive to the order the client serialised the input in', async () => {
    const services = wiring()
    const context = contextFor(actorWith(['payment.create']))

    await createPayment.run({ request, context, services })
    const replay = await createPayment.run({
      request: {
        idempotencyKey: 'key-1',
        input: { amountAgorot: 470000, bookingId: 'bk-1' },
      },
      context,
      services,
    })

    expect(replay.replayed).toBe(true)
    expect(ran.execute).toBe(1)
  })

  it('refuses the same key used for a different request', async () => {
    const services = wiring()
    const context = contextFor(actorWith(['payment.create']))

    await createPayment.run({ request, context, services })

    const error = await rejection<IdempotencyConflictError>(
      createPayment.run({
        request: {
          idempotencyKey: 'key-1',
          input: { bookingId: 'bk-1', amountAgorot: 99 },
        },
        context,
        services,
      }),
    )

    expect(error).toBeInstanceOf(IdempotencyConflictError)
    expect(error.kind).toBe('payload_mismatch')
    expect(ran.execute).toBe(1)
  })

  it('refuses a second attempt while the first is still running', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const slow = defineOperation({
      name: 'payment.create',
      permission: 'payment.create',
      resourceType: 'payment',
      input: s.object({ amountAgorot: s.agorot() }),
      async execute() {
        ran.execute += 1
        await gate
        return { id: 'pay-slow' }
      },
      audit: () => ({ resourceId: 'pay-slow', summary: 'דנה קיבלה תשלום' }),
    })

    const services = wiring()
    const context = contextFor(actorWith(['payment.create']))
    const slowRequest = {
      idempotencyKey: 'key-2',
      input: { amountAgorot: 100 },
    }

    // Both attempts are launched before either can finish — the shape of a
    // real double submit.
    const inFlight = slow.run({ request: slowRequest, context, services })
    const error = await rejection<IdempotencyConflictError>(
      slow.run({ request: slowRequest, context, services }),
    )

    expect(error).toBeInstanceOf(IdempotencyConflictError)
    expect(error.kind).toBe('in_flight')
    expect(error.retryable).toBe(true)

    release()
    await inFlight
    expect(ran.execute).toBe(1)
  })

  it('releases the key when the operation failed, so the retry can proceed', async () => {
    let failNext = true
    const flaky = defineOperation({
      name: 'payment.create',
      permission: 'payment.create',
      resourceType: 'payment',
      input: s.object({ amountAgorot: s.agorot() }),
      async execute() {
        ran.execute += 1
        if (failNext) {
          failNext = false
          throw new Error('network dropped')
        }
        return { id: 'pay-retry' }
      },
      audit: () => ({ resourceId: 'pay-retry', summary: 'דנה קיבלה תשלום' }),
    })

    const services = wiring()
    const context = contextFor(actorWith(['payment.create']))
    const flakyRequest = {
      idempotencyKey: 'key-3',
      input: { amountAgorot: 100 },
    }

    await expect(
      flaky.run({ request: flakyRequest, context, services }),
    ).rejects.toThrow('network dropped')

    // Without releasing, the retry the user is told to make would come back
    // "still in flight" forever.
    const retried = await flaky.run({
      request: flakyRequest,
      context,
      services,
    })
    expect(retried.data.id).toBe('pay-retry')
    expect(ran.execute).toBe(2)
  })

  it('keeps two organizations that chose the same key apart', async () => {
    const services = wiring()

    const a = await createPayment.run({
      request,
      context: contextFor(actorWith(['payment.create'])),
      services,
    })
    const b = await createPayment.run({
      request,
      context: contextFor(
        actorWith(['payment.create'], { organizationId: OTHER_ORG }),
      ),
      services,
    })

    expect(a.replayed).toBe(false)
    expect(b.replayed).toBe(false)
    expect(ran.execute).toBe(2)
  })

  it('refuses to honour a key by ignoring it when no store is wired', async () => {
    const services = wiring()

    const error = await rejection<unknown>(
      createPayment.run({
        request,
        context: contextFor(actorWith(['payment.create'])),
        services: { ...services, idempotency: undefined },
      }),
    )

    expect(isAppError(error) && error.code).toBe('operation_misconfigured')
    expect(ran.execute).toBe(0)
  })
})

// ── Audit ─────────────────────────────────────────────────────────────────

describe('audit', () => {
  it('records exactly one event per success', async () => {
    seedBooking()
    const services = wiring()

    await updateBooking.run({
      request: updateRequest(),
      context: contextFor(actorWith(['booking.update'])),
      services,
    })

    expect(services.audit.records).toHaveLength(1)
  })

  it('records zero events when the business rule refuses', async () => {
    seedBooking({ status: 'cancelled' })
    const services = wiring()

    const error = await rejection<BusinessRuleError>(
      updateBooking.run({
        request: updateRequest(),
        context: contextFor(actorWith(['booking.update'])),
        services,
      }),
    )

    expect(error).toBeInstanceOf(BusinessRuleError)
    expect(services.audit.records).toHaveLength(0)
    expect(ran.execute).toBe(0)
  })

  it('writes the sentence a manager can read, not "booking updated"', async () => {
    seedBooking({ totalAgorot: 520000 })
    const services = wiring()

    await updateBooking.run({
      request: updateRequest(),
      context: contextFor(actorWith(['booking.update'])),
      services,
    })

    expect(services.audit.records[0].summary).toBe(
      'דנה כהן שינתה את סכום ההזמנה מ-₪5,200 ל-₪4,700',
    )
  })

  it('stores the difference and the correlation id, not the whole record', async () => {
    seedBooking()
    const services = wiring()

    await updateBooking.run({
      request: updateRequest(),
      context: contextFor(actorWith(['booking.update'])),
      services,
    })

    const record = services.audit.records[0]
    expect(record.before).toEqual({ totalAgorot: 520000 })
    expect(record.after).toEqual({ totalAgorot: 470000 })
    expect(record.requestId).toBe(CORRELATION)
    expect(record.occurredAt).toEqual(NOW)
    expect(record.propertyId).toBe('prop-1')
    expect(record.action).toBe('booking.update')
    expect(record.actorLabel).toBe('דנה כהן')
  })

  it('never records a secret the operation carelessly returned', async () => {
    const services = wiring()

    await createPayment.run({
      request: { input: { bookingId: 'bk-1', amountAgorot: 470000 } },
      context: contextFor(actorWith(['payment.create'])),
      services,
    })

    const record = services.audit.records[0]
    expect(record.after).toMatchObject({ card_token: '[redacted]' })
    expect(JSON.stringify(record)).not.toContain('tok_live_9912')
  })

  it('fails the operation when the audit write fails', async () => {
    // A committed change with no audit row is an untraceable change. The trail
    // is part of the transaction, not a best effort beside it.
    seedBooking()
    const services = wiring({ audit: new FailingAuditWriter() })

    await expect(
      updateBooking.run({
        request: updateRequest(),
        context: contextFor(actorWith(['booking.update'])),
        services,
      }),
    ).rejects.toThrow('audit write failed')

    expect(services.transactions.rollbacks).toBe(1)
    expect(services.transactions.commits).toBe(0)
    expect(services.events.published).toHaveLength(0)
  })

  it('runs the change and the audit write inside one transaction', async () => {
    seedBooking()
    const services = wiring()

    await updateBooking.run({
      request: updateRequest(),
      context: contextFor(actorWith(['booking.update'])),
      services,
    })

    expect(services.transactions.commits).toBe(1)
    expect(services.transactions.rollbacks).toBe(0)
  })
})

// ── Domain events ─────────────────────────────────────────────────────────

describe('domain events', () => {
  it('publishes after success, stamped with the organization and correlation id', async () => {
    seedBooking()
    const services = wiring()

    const outcome = await updateBooking.run({
      request: updateRequest(),
      context: contextFor(actorWith(['booking.update'])),
      services,
    })

    expect(services.events.published).toEqual([
      {
        name: 'booking.updated',
        organizationId: ORG,
        propertyId: 'prop-1',
        correlationId: CORRELATION,
        occurredAt: NOW,
        payload: { bookingId: 'bk-1' },
      },
    ])
    expect(outcome.events).toHaveLength(1)
    expect(outcome.eventError).toBeNull()
  })

  it('does not fail the operation when a handler throws', async () => {
    // A confirmation email that fails must not un-create the booking it was
    // confirming. One flaky integration cannot roll back a guest's stay.
    seedBooking()
    const services = wiring()
    services.events.subscribe('booking.updated', () => {
      throw new Error('SMTP relay unavailable')
    })

    const outcome = await updateBooking.run({
      request: updateRequest(),
      context: contextFor(actorWith(['booking.update'])),
      services,
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.data.totalAgorot).toBe(470000)
    expect(bookings.get('bk-1')?.totalAgorot).toBe(470000)
    expect(services.transactions.commits).toBe(1)
    expect(services.transactions.rollbacks).toBe(0)
    expect(services.audit.records).toHaveLength(1)
  })

  it('reports the failure rather than swallowing it', async () => {
    // Silently dropped is a confirmation nobody knows was not sent.
    seedBooking()
    const services = wiring()
    services.events.subscribe('*', () => {
      throw new Error('SMTP relay unavailable')
    })

    const outcome = await updateBooking.run({
      request: updateRequest(),
      context: contextFor(actorWith(['booking.update'])),
      services,
    })

    expect(outcome.eventError).toBeTruthy()
    expect(services.eventErrors).toHaveLength(1)
  })

  it('publishes nothing when the operation failed', async () => {
    seedBooking({ status: 'cancelled' })
    const services = wiring()

    await expect(
      updateBooking.run({
        request: updateRequest(),
        context: contextFor(actorWith(['booking.update'])),
        services,
      }),
    ).rejects.toThrow()

    expect(services.events.published).toHaveLength(0)
  })

  it('lets a handler see the event it subscribed to', async () => {
    seedBooking()
    const services = wiring()
    const seen = vi.fn()
    services.events.subscribe('booking.updated', seen)

    await updateBooking.run({
      request: updateRequest(),
      context: contextFor(actorWith(['booking.update'])),
      services,
    })

    expect(seen).toHaveBeenCalledTimes(1)
  })
})

// ── Quota ─────────────────────────────────────────────────────────────────

describe('quota', () => {
  function quotaOperation(key: 'units' | 'members', current: number) {
    return defineOperation({
      name: `${key}.add`,
      permission: key === 'units' ? 'unit.manage' : 'user.invite',
      resourceType: key,
      input: s.object({ name: s.string() }),
      quota: () => ({ key, current }),
      async execute() {
        ran.execute += 1
        return { id: 'new-1' }
      },
      audit: () => ({ resourceId: 'new-1', summary: 'דנה הוסיפה רשומה חדשה' }),
    })
  }

  it('lets a unit overage through, because a check-in must never be blocked', async () => {
    // A business that cannot serve a guest today because it added a fifteenth
    // unit is a business that cancels this afternoon.
    const services = wiring()

    const outcome = await quotaOperation('units', 18).run({
      request: { input: { name: 'יחידה 18' } },
      context: contextFor(actorWith(['unit.manage'])),
      services,
    })

    expect(outcome.ok).toBe(true)
    expect(ran.execute).toBe(1)
    expect(outcome.quotaWarning).toMatchObject({
      key: 'units',
      current: 18,
      limit: 15,
      inOverage: true,
    })
    expect(services.audit.records).toHaveLength(1)
  })

  it('blocks a member overage, because inviting a colleague can wait', async () => {
    const services = wiring()

    const error = await rejection<QuotaExceededError>(
      quotaOperation('members', 11).run({
        request: { input: { name: 'רוני' } },
        context: contextFor(actorWith(['user.invite'])),
        services,
      }),
    )

    expect(error).toBeInstanceOf(QuotaExceededError)
    expect(error.quota.key).toBe('members')
    expect(error.status).toBe(402)
    expect(ran.execute).toBe(0)
    expect(services.audit.records).toHaveLength(0)
  })

  it('warns before the line is crossed', async () => {
    const outcome = await quotaOperation('units', 12).run({
      request: { input: { name: 'יחידה 12' } },
      context: contextFor(actorWith(['unit.manage'])),
      services: wiring(),
    })

    expect(outcome.quotaWarning).toMatchObject({
      approaching: true,
      inOverage: false,
    })
  })

  it('says nothing while comfortably inside the allowance', async () => {
    const outcome = await quotaOperation('units', 3).run({
      request: { input: { name: 'יחידה 3' } },
      context: contextFor(actorWith(['unit.manage'])),
      services: wiring(),
    })

    expect(outcome.quotaWarning).toBeNull()
  })

  it('refuses to run at all when a quota is declared but no limits are wired', async () => {
    const context = contextFor(actorWith(['user.invite']))

    const error = await rejection<unknown>(
      quotaOperation('members', 11).run({
        request: { input: { name: 'רוני' } },
        context: { ...context, limits: undefined },
        services: wiring(),
      }),
    )

    expect(isAppError(error) && error.code).toBe('operation_misconfigured')
    expect(ran.execute).toBe(0)
  })
})

// ── Correlation ───────────────────────────────────────────────────────────

describe('correlation', () => {
  it('stamps the id onto every failure leaving the pipeline', async () => {
    seedBooking({ status: 'cancelled' })

    const error = await rejection<BusinessRuleError>(
      updateBooking.run({
        request: updateRequest(),
        context: contextFor(actorWith(['booking.update'])),
        services: wiring(),
      }),
    )

    expect(error.correlationId).toBe(CORRELATION)
  })

  it('returns the id on success too, so a good request is traceable as well', async () => {
    seedBooking()

    const outcome = await updateBooking.run({
      request: updateRequest(),
      context: contextFor(actorWith(['booking.update'])),
      services: wiring(),
    })

    expect(outcome.correlationId).toBe(CORRELATION)
  })
})
