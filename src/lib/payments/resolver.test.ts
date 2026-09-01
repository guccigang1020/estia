import { describe, expect, it } from 'vitest'

import { CONFIRMATION_REQUIREMENTS } from '../contracts/states'

import { resolveCollectionPolicy } from './resolver'
import {
  DEFAULT_COLLECTION_SETTINGS,
  NO_COLLECTION_FACTS,
  type CollectionFacts,
  type CollectionOverride,
  type CollectionSettings,
} from './types'

function settings(
  overrides: Partial<CollectionSettings> = {},
): CollectionSettings {
  return { ...DEFAULT_COLLECTION_SETTINGS, ...overrides }
}

function facts(overrides: Partial<CollectionFacts> = {}): CollectionFacts {
  return { ...NO_COLLECTION_FACTS, bookingTotalAgorot: 1_000_000, ...overrides }
}

function override(
  overrides: Partial<CollectionOverride> = {},
): CollectionOverride {
  return {
    id: 'override-1',
    bookingId: 'booking-1',
    policy: 'none',
    requirements: [],
    depositPercentBps: null,
    depositFixedAgorot: null,
    balanceDueDaysBefore: null,
    reason: 'לקוח חוזר, סוכם טלפונית',
    setByUserId: 'user-1',
    setAt: new Date('2026-01-01T00:00:00.000Z'),
    version: 1,
    ...overrides,
  }
}

// ── The default that is not an empty state ────────────────────────────────

describe('a business that takes no money before arrival', () => {
  it('has a complete answer with no settings row at all', () => {
    const decision = resolveCollectionPolicy({
      settings: null,
      override: null,
      facts: facts(),
    })

    expect(decision.policy).toBe('none')
    expect(decision.requirements).toEqual([])
    expect(decision.dueNowAgorot).toBe(0)
    expect(decision.confirmable).toBe(true)
    expect(decision.liveAvailable).toBe(false)
  })

  it('answers identically to a saved row that says the same thing', () => {
    const missing = resolveCollectionPolicy({
      settings: null,
      override: null,
      facts: facts(),
    })
    const saved = resolveCollectionPolicy({
      settings: settings(),
      override: null,
      facts: facts(),
    })

    expect(saved).toEqual(missing)
  })
})

// ── The deposit ───────────────────────────────────────────────────────────

describe('a percentage deposit', () => {
  it('is taken of the booking total, through the product one rounding rule', () => {
    const decision = resolveCollectionPolicy({
      settings: settings({ policy: 'deposit', depositPercentBps: 3000 }),
      override: null,
      facts: facts({ bookingTotalAgorot: 953_333 }),
    })

    // 30% of ₪9,533.33 is ₪2,860.00 (285,999.9 agorot, rounded half away
    // from zero). Asserted as a number rather than recomputed with the same
    // expression the code uses, which would prove nothing.
    expect(decision.dueNowAgorot).toBe(286_000)
    expect(decision.shortfallAgorot).toBe(286_000)
    expect(decision.confirmable).toBe(false)
  })

  it('is met once enough has been recorded, whatever the channel', () => {
    const decision = resolveCollectionPolicy({
      settings: settings({ policy: 'deposit', depositPercentBps: 3000 }),
      override: null,
      // A bank transfer somebody wrote down. No live payment at all.
      facts: facts({ settledAgorot: 300_000, settledLiveAgorot: 0 }),
    })

    expect(decision.outstanding).toEqual([])
    expect(decision.confirmable).toBe(true)
    expect(decision.shortfallAgorot).toBe(0)
  })

  it('never asks for more than the stay is worth', () => {
    const decision = resolveCollectionPolicy({
      settings: settings({ policy: 'deposit', depositFixedAgorot: 250_000 }),
      override: null,
      facts: facts({ bookingTotalAgorot: 180_000 }),
    })

    expect(decision.dueNowAgorot).toBe(180_000)
  })

  it('refuses to guess when the policy names no amount', () => {
    const decision = resolveCollectionPolicy({
      settings: settings({ policy: 'manual' }),
      override: null,
      facts: facts({ settledAgorot: 500_000 }),
    })

    // Money was collected and the requirement is still unmet, because the
    // amount was never configured. Reported as a sentence about the missing
    // configuration rather than silently satisfied.
    expect(decision.confirmable).toBe(false)
    expect(decision.checks[0].detail).toContain('לא הוגדר סכום')
  })
})

// ── The two deposits that are not the same deposit ────────────────────────

describe('deposit_paid_live is not satisfied by a bank transfer', () => {
  const input = {
    settings: settings({
      policy: 'custom' as const,
      requirements: ['deposit_paid_live' as const],
      depositPercentBps: 2000,
      livePaymentsEnabled: true,
      liveProvider: 'tranzila',
    }),
    override: null,
  }

  it('is unmet when the money arrived manually', () => {
    const decision = resolveCollectionPolicy({
      ...input,
      facts: facts({ settledAgorot: 1_000_000, settledLiveAgorot: 0 }),
    })

    expect(decision.confirmable).toBe(false)
    expect(decision.outstanding).toEqual(['deposit_paid_live'])
    expect(decision.checks[0].detail).toContain('העברה בנקאית אינה עונה')
  })

  it('is met when the money was taken on a card', () => {
    const decision = resolveCollectionPolicy({
      ...input,
      facts: facts({ settledAgorot: 200_000, settledLiveAgorot: 200_000 }),
    })

    expect(decision.confirmable).toBe(true)
  })
})

// ── The override ──────────────────────────────────────────────────────────

describe('a per-booking override', () => {
  const organizationDefault = settings({
    policy: 'deposit',
    depositPercentBps: 3000,
  })

  it('replaces the default whole, rather than merging field by field', () => {
    const decision = resolveCollectionPolicy({
      settings: organizationDefault,
      override: override({ policy: 'none' }),
      facts: facts(),
    })

    expect(decision.source).toBe('booking_override')
    expect(decision.policy).toBe('none')
    // The 30% must not survive into a policy that asks for nothing. A merge
    // would have left it in the untouched field.
    expect(decision.dueNowAgorot).toBe(0)
    expect(decision.confirmable).toBe(true)
    expect(decision.overrideReason).toBe('לקוח חוזר, סוכם טלפונית')
  })

  it('cannot conjure a payment provider the organization does not have', () => {
    const decision = resolveCollectionPolicy({
      settings: organizationDefault,
      override: override({
        policy: 'custom',
        requirements: ['deposit_paid_live'],
        depositFixedAgorot: 100_000,
      }),
      facts: facts(),
    })

    // The override asks for a live payment; whether one is possible is a fact
    // about the organization and stays false.
    expect(decision.liveAvailable).toBe(false)
    expect(decision.outstanding).toEqual(['deposit_paid_live'])
  })
})

// ── Explainability ────────────────────────────────────────────────────────

describe('every requirement can say why it is or is not met', () => {
  it('returns one check per requirement, each with a Hebrew sentence', () => {
    const decision = resolveCollectionPolicy({
      settings: settings({
        policy: 'custom',
        requirements: ['contract_signed', 'guest_confirmation', 'full_payment'],
      }),
      override: null,
      facts: facts({ guestConfirmed: true, settledAgorot: 400_000 }),
    })

    expect(decision.checks).toHaveLength(3)
    for (const check of decision.checks) {
      expect(check.detail.length).toBeGreaterThan(0)
    }

    const byRequirement = new Map(
      decision.checks.map((check) => [check.requirement, check]),
    )
    expect(byRequirement.get('guest_confirmation')?.met).toBe(true)
    expect(byRequirement.get('contract_signed')?.met).toBe(false)
    expect(byRequirement.get('full_payment')?.met).toBe(false)
    expect(byRequirement.get('full_payment')?.detail).toContain('חסרים')
  })

  it('orders requirements as the guest works them, not as they were declared', () => {
    const decision = resolveCollectionPolicy({
      settings: settings({
        policy: 'custom',
        requirements: [
          'manager_approval',
          'full_payment',
          'contract_signed',
          'guest_confirmation',
        ],
      }),
      override: null,
      facts: facts(),
    })

    expect(decision.requirements).toEqual([
      'guest_confirmation',
      'contract_signed',
      'full_payment',
      'manager_approval',
    ])
  })

  it('deduplicates a requirement the policy already implies', () => {
    const decision = resolveCollectionPolicy({
      settings: settings({
        policy: 'deposit',
        depositPercentBps: 1000,
        requirements: ['deposit_recorded'],
      }),
      override: null,
      facts: facts(),
    })

    expect(decision.requirements).toEqual(['deposit_recorded'])
  })
})

// ── The frozen contract ───────────────────────────────────────────────────

describe('the resolver understands the whole frozen vocabulary', () => {
  it('produces a check for every CONFIRMATION_REQUIREMENT', () => {
    const decision = resolveCollectionPolicy({
      settings: settings({
        policy: 'custom',
        requirements: [...CONFIRMATION_REQUIREMENTS],
        depositFixedAgorot: 50_000,
      }),
      override: null,
      facts: facts(),
    })

    expect(decision.checks).toHaveLength(CONFIRMATION_REQUIREMENTS.length)
    expect(new Set(decision.checks.map((c) => c.requirement))).toEqual(
      new Set(CONFIRMATION_REQUIREMENTS),
    )
  })
})

// ── The line between the two machines ─────────────────────────────────────

describe('payment state and booking state stay separate', () => {
  it('says nothing about a booking status, only about the requirements', () => {
    const decision = resolveCollectionPolicy({
      settings: settings(),
      override: null,
      facts: facts(),
    })

    // `confirmable` is "the policy is satisfied", never "the booking is
    // confirmed". Nothing in the answer names a booking status at all.
    expect(Object.keys(decision)).not.toContain('bookingStatus')
    expect(decision.confirmable).toBe(true)
  })
})
