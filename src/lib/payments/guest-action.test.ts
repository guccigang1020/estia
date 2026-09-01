import { describe, expect, it } from 'vitest'

import { nextGuestAction } from './guest-action'
import { resolveCollectionPolicy } from './resolver'
import {
  DEFAULT_COLLECTION_SETTINGS,
  NO_COLLECTION_FACTS,
  type CollectionFacts,
  type CollectionSettings,
  type ManualChannel,
} from './types'

function settings(
  overrides: Partial<CollectionSettings> = {},
): CollectionSettings {
  return { ...DEFAULT_COLLECTION_SETTINGS, ...overrides }
}

function facts(overrides: Partial<CollectionFacts> = {}): CollectionFacts {
  return { ...NO_COLLECTION_FACTS, bookingTotalAgorot: 1_000_000, ...overrides }
}

const BANK: ManualChannel = {
  id: 'channel-1',
  channel: 'bank_transfer',
  enabled: true,
  displayName: null,
  instructions: 'בנק הפועלים, סניף 613, חשבון 123456',
  sortOrder: 0,
}

const DISABLED_BIT: ManualChannel = {
  id: 'channel-2',
  channel: 'bit',
  enabled: false,
  displayName: null,
  instructions: '050-0000000',
  sortOrder: 1,
}

function actionFor(args: {
  settings?: Partial<CollectionSettings>
  facts?: Partial<CollectionFacts>
  channels?: readonly ManualChannel[]
  bookingClosed?: boolean
  awaitingProofReview?: boolean
}) {
  const decision = resolveCollectionPolicy({
    settings: settings(args.settings),
    override: null,
    facts: facts(args.facts),
  })
  return nextGuestAction({
    decision,
    channels: args.channels ?? [],
    ...(args.bookingClosed === undefined
      ? {}
      : { bookingClosed: args.bookingClosed }),
    ...(args.awaitingProofReview === undefined
      ? {}
      : { awaitingProofReview: args.awaitingProofReview }),
  })
}

// ── The three shapes the brief names ──────────────────────────────────────

describe('a business with no payment provider', () => {
  it('never renders a live-payment call to action', () => {
    const action = actionFor({
      settings: { policy: 'deposit', depositPercentBps: 2500 },
      channels: [BANK],
    })

    expect(action.kind).toBe('manual_transfer')
    expect(action.cta).toBeNull()
    expect(action.channels.map((c) => c.channel)).toEqual(['bank_transfer'])
    expect(action.offerProofUpload).toBe(true)
    expect(action.amountAgorot).toBe(250_000)
  })

  it('says so plainly when money is required and there is nowhere to send it', () => {
    const action = actionFor({
      settings: { policy: 'deposit', depositFixedAgorot: 250_000 },
      channels: [DISABLED_BIT],
    })

    expect(action.kind).toBe('blocked')
    expect(action.channels).toEqual([])
    expect(action.offerProofUpload).toBe(false)
    expect(action.cta).toBeNull()
  })
})

describe('a business with manual channels only', () => {
  it('shows the enabled channels and nothing else', () => {
    const action = actionFor({
      settings: { policy: 'manual', depositFixedAgorot: 100_000 },
      channels: [BANK, DISABLED_BIT],
    })

    expect(action.kind).toBe('manual_transfer')
    expect(action.channels).toHaveLength(1)
    expect(action.channels[0].instructions).toContain('בנק הפועלים')
  })

  it('stops asking once a receipt is in and nobody has looked at it', () => {
    const action = actionFor({
      settings: { policy: 'manual', depositFixedAgorot: 100_000 },
      channels: [BANK],
      awaitingProofReview: true,
    })

    expect(action.kind).toBe('awaiting_staff')
    expect(action.offerProofUpload).toBe(false)
  })
})

describe('a business with live payments', () => {
  it('offers the hosted page, and no bank instructions beside it', () => {
    const action = actionFor({
      settings: {
        policy: 'deposit',
        depositPercentBps: 3000,
        livePaymentsEnabled: true,
        liveProvider: 'tranzila',
      },
      channels: [BANK],
    })

    expect(action.kind).toBe('pay_live')
    expect(action.cta).toContain('₪3,000')
    expect(action.amountAgorot).toBe(300_000)
    // One action. The bank details are not rendered alongside a pay button.
    expect(action.channels).toEqual([])
  })

  it('refuses to offer a card page when the policy demands one and there is none', () => {
    const action = actionFor({
      settings: {
        policy: 'custom',
        requirements: ['deposit_paid_live'],
        depositFixedAgorot: 100_000,
      },
      channels: [BANK],
    })

    expect(action.kind).toBe('blocked')
    // Not offered a bank transfer either: the policy said the money must be
    // taken on a card, and a transfer would not satisfy it.
    expect(action.channels).toEqual([])
  })
})

// ── One action, never a menu ──────────────────────────────────────────────

describe('exactly one action is ever rendered', () => {
  it('asks the guest to confirm before it asks them to pay', () => {
    const action = actionFor({
      settings: {
        policy: 'custom',
        requirements: ['guest_confirmation', 'full_payment'],
      },
      channels: [BANK],
    })

    expect(action.kind).toBe('confirm_booking')
    expect(action.cta).toBe('אשר הזמנה')
    expect(action.amountAgorot).toBeNull()
    expect(action.channels).toEqual([])
  })

  it('asks for a signature before it asks for money', () => {
    const action = actionFor({
      settings: {
        policy: 'custom',
        requirements: ['contract_signed', 'full_payment'],
      },
      facts: { guestConfirmed: true },
      channels: [BANK],
    })

    expect(action.kind).toBe('sign_contract')
    expect(action.cta).toBe('חתום על החוזה')
  })

  it('renders nothing at all when the policy requires nothing', () => {
    const action = actionFor({ channels: [BANK] })

    expect(action.kind).toBe('nothing_required')
    expect(action.cta).toBeNull()
    expect(action.channels).toEqual([])
    expect(action.offerProofUpload).toBe(false)
  })

  it('tells the guest to wait when the outstanding item is the office own', () => {
    const action = actionFor({
      settings: { policy: 'after_approval' },
      channels: [BANK],
    })

    expect(action.kind).toBe('awaiting_staff')
    expect(action.title).toContain('ממתינה לאישור')
    expect(action.cta).toBeNull()
  })

  it('asks nothing of a guest whose booking is closed', () => {
    const action = actionFor({
      settings: { policy: 'full' },
      bookingClosed: true,
      channels: [BANK],
    })

    expect(action.kind).toBe('nothing_required')
    expect(action.cta).toBeNull()
  })
})

// ── Every action carries an explanation ───────────────────────────────────

describe('no bare button', () => {
  it('gives every action a title and a sentence', () => {
    const cases = [
      actionFor({}),
      actionFor({ settings: { policy: 'after_approval' } }),
      actionFor({
        settings: { policy: 'deposit', depositFixedAgorot: 100_000 },
        channels: [BANK],
      }),
      actionFor({
        settings: {
          policy: 'full',
          livePaymentsEnabled: true,
          liveProvider: 'tranzila',
        },
      }),
      actionFor({
        settings: { policy: 'custom', requirements: ['contract_signed'] },
      }),
    ]

    for (const action of cases) {
      expect(action.title.length).toBeGreaterThan(0)
      expect(action.body.length).toBeGreaterThan(0)
    }
  })
})
