/**
 * `payment.request`, through the real pipeline.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE TEST THIS FILE EXISTS FOR: the command never reports money as taken.
 *
 *  There is no payment provider in this codebase. Every path through this
 *  command — deposit, full payment, manual transfer, an organization that
 *  claims a live processor it cannot call — has to come out the other end
 *  saying `paymentTaken: false`, `paymentLinkCreated: false`, with no
 *  `payment.received` and no `payment.link_sent` behind it.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The rest is the refusals: nothing owed, nothing configured, and the
 * business's own turn.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../audit/pipeline'
import { AuthorizationError, type Actor } from '../authz/can'
import { PERMISSIONS, type Grant } from '../authz/permissions'
import { BusinessRuleError, NotFoundError } from '../errors'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'
import {
  InMemoryEventBus,
  InMemoryIdempotencyStore,
  RecordingTransactionRunner,
  type OperationContext,
} from '../service'
import { InMemoryPaymentPolicyRepository } from './repository'
import { definePaymentRequestCommands } from './requests'
import type { CollectionFacts } from './types'

const ORG = 'org-a'
const PROPERTY = 'property-1'
const BOOKING = 'booking-1'
const USER = 'user-dana'
const NOW = new Date('2026-05-01T09:00:00.000Z')

const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

/** ₪5,000 stay, nothing collected. */
function facts(overrides: Partial<CollectionFacts> = {}): CollectionFacts {
  return {
    bookingTotalAgorot: 500_000,
    settledAgorot: 0,
    settledLiveAgorot: 0,
    managerApproved: false,
    guestConfirmed: true,
    contractSigned: true,
    proofSubmitted: false,
    ...overrides,
  }
}

let repository: InMemoryPaymentPolicyRepository

beforeEach(() => {
  repository = new InMemoryPaymentPolicyRepository()
})

async function seedPolicy(
  policy: Parameters<InMemoryPaymentPolicyRepository['saveSettings']>[1],
): Promise<void> {
  await repository.saveSettings(ORG, policy)
}

async function seedBankTransfer(): Promise<void> {
  await repository.saveChannel(ORG, {
    channel: 'bank_transfer',
    enabled: true,
    displayName: null,
    instructions: 'בנק לאומי, סניף 800, חשבון 123456, ע״ש אירוח הכרמל בע״מ',
    sortOrder: 1,
  })
}

function commandsWith(
  collectionFacts: CollectionFacts | null = facts(),
  property: { propertyId: string } | null = { propertyId: PROPERTY },
) {
  return definePaymentRequestCommands({
    repository,
    bookingProperty: async () => property,
    collectionFacts: async () => collectionFacts,
  })
}

function actorWith(grants: readonly Grant[]): Actor {
  return {
    userId: USER,
    organizationId: ORG,
    membershipStatus: 'active',
    grants: new Set<Grant>(grants),
    scope: { kind: 'all_organization' },
    entitlements: EVERY_ENTITLEMENT,
  }
}

function contextFor(actor: Actor = actorWith(PERMISSIONS)): OperationContext {
  return {
    actor,
    auditActor: { type: 'user', userId: USER, label: 'דנה, הבעלים' },
    correlationId: 'req-payment-request',
    now: NOW,
  }
}

function wiring() {
  return {
    audit: new InMemoryAuditWriter(),
    events: new InMemoryEventBus(),
    idempotency: new InMemoryIdempotencyStore(),
    transactions: new RecordingTransactionRunner(),
  }
}

function rejection<E>(promise: Promise<unknown>): Promise<E> {
  return promise.then(
    () => {
      throw new Error('expected the command to be refused, but it succeeded')
    },
    (error: unknown) => error as E,
  )
}

const input = { bookingId: BOOKING, bookingClosed: null }

/* ══════════════════════════════════════════════════════════════════════════ */

describe('payment.request never reports money as taken', () => {
  it('asks for a 30% deposit and takes none of it', async () => {
    await seedPolicy({
      policy: 'deposit',
      requirements: [],
      depositPercentBps: 3000,
      depositFixedAgorot: null,
      balanceDueDaysBefore: 14,
      livePaymentsEnabled: false,
      liveProvider: null,
      guestInstructions: null,
    })
    await seedBankTransfer()

    const services = wiring()
    const outcome = await commandsWith().requestPayment.run({
      request: { input },
      context: contextFor(),
      services,
    })

    // ── The claim ──────────────────────────────────────────────────────
    expect(outcome.data.paymentTaken).toBe(false)
    expect(outcome.data.paymentLinkCreated).toBe(false)
    expect(outcome.data.delivered).toBe(false)
    expect(outcome.data.handoff).toBe('manual')

    // 30% of ₪5,000, from the one resolver.
    expect(outcome.data.amountDueAgorot).toBe(150_000)
    expect(outcome.data.action).toBe('manual_transfer')
    expect(outcome.data.channels).toHaveLength(1)
    expect(outcome.data.channels[0].instructions).toContain('בנק לאומי')

    // Nothing that could be read as money moving.
    const names = services.events.published.map((event) => event.name)
    expect(names).not.toContain('payment.received')
    expect(names).not.toContain('payment.link_sent')
    expect(names).not.toContain('payment.authorized')
    expect(names).not.toContain('payment.instructions_sent')
    expect(services.events.published).toEqual([])

    // And the audit sentence cannot be misread six months later.
    expect(services.audit.records).toHaveLength(1)
    expect(services.audit.records[0].summary).toContain('לא נגבה כסף')
    expect(services.audit.records[0].summary).toContain('לא נוצר קישור תשלום')
  })

  it('creates no link even when the organization claims a live provider', async () => {
    await seedPolicy({
      policy: 'full',
      requirements: [],
      depositPercentBps: null,
      depositFixedAgorot: null,
      balanceDueDaysBefore: null,
      // A named processor and no integration behind it anywhere in this
      // codebase. The command must not invent one.
      livePaymentsEnabled: true,
      liveProvider: 'tranzila',
      guestInstructions: null,
    })
    await seedBankTransfer()

    const outcome = await commandsWith().requestPayment.run({
      request: { input },
      context: contextFor(),
      services: wiring(),
    })

    expect(outcome.data.paymentLinkCreated).toBe(false)
    expect(outcome.data.paymentTaken).toBe(false)
    expect(outcome.data.amountDueAgorot).toBe(500_000)
  })

  it('asks for the shortfall, not the whole sum, once a deposit has landed', async () => {
    await seedPolicy({
      policy: 'deposit',
      requirements: [],
      depositPercentBps: null,
      depositFixedAgorot: 200_000,
      balanceDueDaysBefore: null,
      livePaymentsEnabled: false,
      liveProvider: null,
      guestInstructions: null,
    })
    await seedBankTransfer()

    const outcome = await commandsWith(
      facts({ settledAgorot: 50_000 }),
    ).requestPayment.run({
      request: { input },
      context: contextFor(),
      services: wiring(),
    })

    expect(outcome.data.amountDueAgorot).toBe(150_000)
    expect(outcome.data.paymentTaken).toBe(false)
  })
})

/* ══════════════════════════════════════════════════════════════════════════ */

describe('payment.request refuses rather than asking for nothing', () => {
  it('refuses when the policy asks for nothing at all', async () => {
    await seedPolicy({
      policy: 'none',
      requirements: [],
      depositPercentBps: null,
      depositFixedAgorot: null,
      balanceDueDaysBefore: null,
      livePaymentsEnabled: false,
      liveProvider: null,
      guestInstructions: null,
    })

    const services = wiring()
    const error = await rejection<BusinessRuleError>(
      commandsWith().requestPayment.run({
        request: { input },
        context: contextFor(),
        services,
      }),
    )

    expect(error.code).toBe('payments.nothing_to_request')
    expect(services.audit.records).toHaveLength(0)
  })

  it('refuses when the deposit has already been paid in full', async () => {
    await seedPolicy({
      policy: 'deposit',
      requirements: [],
      depositPercentBps: 3000,
      depositFixedAgorot: null,
      balanceDueDaysBefore: null,
      livePaymentsEnabled: false,
      liveProvider: null,
      guestInstructions: null,
    })
    await seedBankTransfer()

    const error = await rejection<BusinessRuleError>(
      commandsWith(facts({ settledAgorot: 150_000 })).requestPayment.run({
        request: { input },
        context: contextFor(),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('payments.nothing_to_request')
  })

  /**
   * The `not_configured` refusal. A business with no processor and no enabled
   * manual channel has nowhere for the money to go, and asking anyway leaves a
   * guest holding a bank transfer with no account number.
   */
  it('refuses when there is no route for the money at all', async () => {
    await seedPolicy({
      policy: 'deposit',
      requirements: [],
      depositPercentBps: 3000,
      depositFixedAgorot: null,
      balanceDueDaysBefore: null,
      livePaymentsEnabled: false,
      liveProvider: null,
      guestInstructions: null,
    })
    // No channels seeded.

    const error = await rejection<BusinessRuleError>(
      commandsWith().requestPayment.run({
        request: { input },
        context: contextFor(),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('payments.no_collection_route')
    expect(error.userMessage).toContain('הגדרות הגבייה')
  })

  /**
   * The other shape of "no route": the policy demands the money be taken on a
   * card and the organization has no processor. A different sentence, because
   * it is a different fix — change the policy, or connect a provider.
   */
  it('refuses a card-only policy at a business with no processor', async () => {
    await seedPolicy({
      policy: 'custom',
      requirements: ['deposit_paid_live'],
      depositPercentBps: 3000,
      depositFixedAgorot: null,
      balanceDueDaysBefore: null,
      livePaymentsEnabled: false,
      liveProvider: null,
      guestInstructions: null,
    })
    await seedBankTransfer()

    const error = await rejection<BusinessRuleError>(
      commandsWith().requestPayment.run({
        request: { input },
        context: contextFor(),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('payments.no_collection_route')
    expect(error.userMessage).toContain('סליקה')
  })

  it("refuses while the ball is in the business's court", async () => {
    await seedPolicy({
      policy: 'after_approval',
      requirements: [],
      depositPercentBps: null,
      depositFixedAgorot: null,
      balanceDueDaysBefore: null,
      livePaymentsEnabled: false,
      liveProvider: null,
      guestInstructions: null,
    })
    await seedBankTransfer()

    const error = await rejection<BusinessRuleError>(
      commandsWith().requestPayment.run({
        request: { input },
        context: contextFor(),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('payments.awaiting_staff')
  })

  it('refuses on a closed booking', async () => {
    await seedPolicy({
      policy: 'full',
      requirements: [],
      depositPercentBps: null,
      depositFixedAgorot: null,
      balanceDueDaysBefore: null,
      livePaymentsEnabled: false,
      liveProvider: null,
      guestInstructions: null,
    })
    await seedBankTransfer()

    const error = await rejection<BusinessRuleError>(
      commandsWith().requestPayment.run({
        request: { input: { bookingId: BOOKING, bookingClosed: true } },
        context: contextFor(),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('payments.nothing_to_request')
  })

  /**
   * Falling back to "nothing has been paid" here would ask a guest who has
   * already paid in full to pay again.
   */
  it('reports a booking whose collection facts cannot be read as not found', async () => {
    await expect(
      rejection<NotFoundError>(
        commandsWith(null).requestPayment.run({
          request: { input },
          context: contextFor(),
          services: wiring(),
        }),
      ),
    ).resolves.toBeInstanceOf(NotFoundError)
  })
})

/* ══════════════════════════════════════════════════════════════════════════ */

describe('payment.request and the grant', () => {
  it('refuses without payment.request_link, before anything is read', async () => {
    const error = await rejection<AuthorizationError>(
      commandsWith().requestPayment.run({
        request: { input },
        context: contextFor(actorWith(['payment.view', 'booking.view'])),
        services: wiring(),
      }),
    )

    expect(error).toBeInstanceOf(AuthorizationError)
  })
})
