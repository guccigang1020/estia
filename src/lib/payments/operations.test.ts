import { beforeEach, describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../audit/pipeline'
import { AuthorizationError } from '../authz/can'
import { BusinessRuleError, NotFoundError, ValidationError } from '../errors'
import { actorFor, ORG, PROPERTY } from '../finance/testing'
import {
  InMemoryEventBus,
  InMemoryIdempotencyStore,
  type OperationContext,
  type OperationServices,
} from '../service'

import { definePaymentPolicyOperations } from './operations'
import { InMemoryPaymentPolicyRepository } from './repository'

const NOW = new Date('2026-03-11T10:00:00.000Z')
const BOOKING = '55555555-5555-4555-8555-555555555555'

let repository: InMemoryPaymentPolicyRepository
let audit: InMemoryAuditWriter
let idempotency: InMemoryIdempotencyStore
let events: InMemoryEventBus
let ops: ReturnType<typeof definePaymentPolicyOperations>

beforeEach(() => {
  repository = new InMemoryPaymentPolicyRepository()
  audit = new InMemoryAuditWriter()
  idempotency = new InMemoryIdempotencyStore()
  events = new InMemoryEventBus()
  ops = definePaymentPolicyOperations({
    repository,
    bookingProperty: (organizationId, bookingId) =>
      Promise.resolve(
        organizationId === ORG && bookingId === BOOKING
          ? { propertyId: PROPERTY }
          : null,
      ),
  })
})

function services(): OperationServices {
  return { audit, idempotency, events }
}

function context(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    // `payment.policy_manage` reaches organization_owner and administrator and
    // nobody else. Built from the real catalogue, not hand-picked.
    actor: actorFor('administrator'),
    auditActor: { type: 'user', userId: 'user-admin', label: 'דנה כהן' },
    correlationId: 'corr-1',
    now: NOW,
    reason: null,
    ...overrides,
  }
}

const manualPolicy = {
  policy: 'manual' as const,
  requirements: [],
  depositPercentBps: 3000,
  depositFixedAgorot: null,
  balanceDueDaysBefore: 7,
  livePaymentsEnabled: false,
  liveProvider: null,
  guestInstructions: 'נשמח לקבל את המקדמה עד שבוע לפני ההגעה.',
}

// ── The whole point: this works with live payments switched off ───────────

describe('a business that takes no cards at all', () => {
  it('can still say how it collects money', async () => {
    const outcome = await ops.setCollectionPolicy.run({
      request: { input: manualPolicy },
      context: context(),
      services: services(),
    })

    expect(outcome.data.policy).toBe('manual')
    expect(outcome.data.livePaymentsEnabled).toBe(false)
    expect(audit.records).toHaveLength(1)
    expect(audit.records[0].summary).toContain('מדיניות גבייה')
  })

  it('is refused if it claims live payments with no provider behind them', async () => {
    await expect(
      ops.setCollectionPolicy.run({
        request: {
          input: { ...manualPolicy, livePaymentsEnabled: true },
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)

    expect(audit.records).toHaveLength(0)
  })

  it('is refused two deposit shapes at once', async () => {
    await expect(
      ops.setCollectionPolicy.run({
        request: {
          input: {
            ...manualPolicy,
            policy: 'deposit',
            depositPercentBps: 3000,
            depositFixedAgorot: 250_000,
          },
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('is refused a deposit policy that names no amount', async () => {
    await expect(
      ops.setCollectionPolicy.run({
        request: {
          input: {
            ...manualPolicy,
            policy: 'deposit',
            depositPercentBps: null,
            depositFixedAgorot: null,
          },
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })
})

// ── Who may do it ─────────────────────────────────────────────────────────

describe('the grant, and only the grant', () => {
  it('refuses a finance manager, who holds every other payment grant', async () => {
    await expect(
      ops.setCollectionPolicy.run({
        request: { input: manualPolicy },
        context: context({ actor: actorFor('finance_manager') }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)

    expect(audit.records).toHaveLength(0)
  })

  it('refuses a cleaner', async () => {
    await expect(
      ops.setCollectionPolicy.run({
        request: { input: manualPolicy },
        context: context({ actor: actorFor('cleaner') }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  it('refuses an override on a booking in another tenant', async () => {
    await expect(
      ops.setBookingOverride.run({
        request: {
          input: {
            bookingId: 'booking-from-elsewhere',
            policy: 'none',
            requirements: [],
            depositPercentBps: null,
            depositFixedAgorot: null,
            balanceDueDaysBefore: null,
          },
        },
        context: context({ reason: 'סוכם טלפונית' }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

// ── The override, and its accountability ──────────────────────────────────

describe('a per-booking override', () => {
  const overrideInput = {
    bookingId: BOOKING,
    policy: 'none' as const,
    requirements: [],
    depositPercentBps: null,
    depositFixedAgorot: null,
    balanceDueDaysBefore: null,
  }

  it('cannot be made without a stated reason', async () => {
    await expect(
      ops.setBookingOverride.run({
        request: { input: overrideInput },
        context: context({ reason: null }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    expect(audit.records).toHaveLength(0)
  })

  it('records actor, time, old value, new value and reason', async () => {
    // Give the organization a default first, so "before" is a real previous
    // override rather than the absence of one.
    await ops.setBookingOverride.run({
      request: {
        input: { ...overrideInput, policy: 'deposit', depositPercentBps: 3000 },
      },
      context: context({ reason: 'קבוצה גדולה' }),
      services: services(),
    })

    const outcome = await ops.setBookingOverride.run({
      request: { input: overrideInput },
      context: context({ reason: 'לקוח חוזר, סוכם עם הבעלים' }),
      services: services(),
    })

    expect(outcome.data.policy).toBe('none')

    const record = audit.records[1]
    expect(record.actorLabel).toBe('דנה כהן')
    expect(record.actorUserId).toBe('user-admin')
    expect(record.occurredAt).toEqual(NOW)
    expect(record.reason).toBe('לקוח חוזר, סוכם עם הבעלים')
    expect(record.before).toMatchObject({ policy: 'deposit' })
    expect(record.after).toMatchObject({ policy: 'none' })
    expect(record.summary).toContain('מדיניות הגבייה')
  })

  it('names the organization default as the before value the first time', async () => {
    await ops.setBookingOverride.run({
      request: { input: overrideInput },
      context: context({ reason: 'סוכם טלפונית' }),
      services: services(),
    })

    expect(audit.records[0].before).toMatchObject({ policy: null })
  })

  it('replays rather than writing twice for one idempotency key', async () => {
    const request = { input: overrideInput, idempotencyKey: 'override-key-1' }

    const first = await ops.setBookingOverride.run({
      request,
      context: context({ reason: 'סוכם טלפונית' }),
      services: services(),
    })
    const second = await ops.setBookingOverride.run({
      request,
      context: context({ reason: 'סוכם טלפונית' }),
      services: services(),
    })

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(audit.records).toHaveLength(1)
  })

  it('is cleared back to the organization default, with a reason', async () => {
    await ops.setBookingOverride.run({
      request: { input: overrideInput },
      context: context({ reason: 'סוכם טלפונית' }),
      services: services(),
    })

    await ops.clearBookingOverride.run({
      request: { input: { bookingId: BOOKING } },
      context: context({ reason: 'ההסכמה בוטלה' }),
      services: services(),
    })

    expect(await repository.loadOverride(ORG, BOOKING)).toBeNull()
    expect(audit.records[1].after).toMatchObject({ policy: null })
  })

  it('refuses to clear an override that was never made', async () => {
    await expect(
      ops.clearBookingOverride.run({
        request: { input: { bookingId: BOOKING } },
        context: context({ reason: 'ההסכמה בוטלה' }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

// ── The channels ──────────────────────────────────────────────────────────

describe('a manual payment channel', () => {
  it('cannot be enabled without telling the guest where the money goes', async () => {
    await expect(
      ops.setManualChannel.run({
        request: {
          input: {
            channel: 'bank_transfer',
            enabled: true,
            displayName: null,
            instructions: null,
            sortOrder: 0,
          },
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('accepts cash with no instructions, because that is a complete answer', async () => {
    const outcome = await ops.setManualChannel.run({
      request: {
        input: {
          channel: 'cash',
          enabled: true,
          displayName: null,
          instructions: null,
          sortOrder: 0,
        },
      },
      context: context(),
      services: services(),
    })

    expect(outcome.data.enabled).toBe(true)
    expect(await repository.listChannels(ORG)).toHaveLength(1)
  })

  it('tells somebody when the way money is collected changes', async () => {
    await ops.setManualChannel.run({
      request: {
        input: {
          channel: 'bit',
          enabled: true,
          displayName: null,
          instructions: '050-1234567',
          sortOrder: 1,
        },
      },
      context: context(),
      services: services(),
    })

    expect(events.published.map((event) => event.name)).toEqual([
      'security.payment_config_changed',
    ])
  })
})

// ── The proof ─────────────────────────────────────────────────────────────

describe('a receipt recorded by staff', () => {
  const proofInput = {
    bookingId: BOOKING,
    storageKey: 'proofs/2026/03/abc123',
    fileName: 'העברה.pdf',
    contentType: 'application/pdf',
    byteSize: 84_211,
    checksumSha256: null,
    note: null,
  }

  it('is stored as staff-submitted, never as the guest', async () => {
    const outcome = await ops.recordPaymentProof.run({
      request: { input: proofInput },
      context: context(),
      services: services(),
    })

    expect(outcome.data.submittedByGuest).toBe(false)
    expect(outcome.data.submittedByUserId).toBe('user-administrator')
    expect(outcome.data.review).toBe('pending')
    expect(events.published.map((event) => event.name)).toEqual([
      'payment.proof_uploaded',
    ])
  })

  it('refuses a checksum that is not a sha-256', async () => {
    await expect(
      ops.recordPaymentProof.run({
        request: { input: { ...proofInput, checksumSha256: 'not-a-digest' } },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses a file larger than the column allows', async () => {
    await expect(
      ops.recordPaymentProof.run({
        request: { input: { ...proofInput, byteSize: 20_971_521 } },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})
