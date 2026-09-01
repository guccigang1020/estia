/**
 * The order's life, its money and its amendments.
 *
 * Two claims are worth more than the rest of this file and are tested first:
 *
 *   · a total is the sum of its lines, and is never re-derived from a rate;
 *   · a change that costs the guest more cannot be applied without consent,
 *     and the flag that says so is DERIVED rather than passed in, so a screen
 *     cannot forget to ask.
 */

import { describe, expect, it } from 'vitest'

import {
  assertAmendable,
  assertTransition,
  canTransition,
  initialStatusFor,
  isCommitted,
  isOverdue,
  isTerminal,
  orderAttention,
  orderTotalAgorot,
  proposeAmendment,
} from './orders'
import type { StoreOrder } from './types'

const SETTINGS = { approvalRequiredDefault: false }

/**
 * Assert the sentence a PERSON reads, not the one a developer does.
 *
 * `toThrowError(/…/)` matches `Error.message`, which every `AppError` in this
 * codebase deliberately keeps in English for the log. The Hebrew lives in
 * `userMessage`, and that is the half worth testing: it is what appears on
 * screen, and a refusal with no usable sentence is a support ticket.
 */
function refusal(run: () => unknown): { code: string; userMessage: string } {
  try {
    run()
  } catch (cause) {
    const error = cause as { code?: string; userMessage?: string }
    return { code: error.code ?? '', userMessage: error.userMessage ?? '' }
  }
  throw new Error('expected the call to be refused, and it was not')
}

describe('a total is the sum of its lines', () => {
  it('adds the lines and nothing else', () => {
    const totals = orderTotalAgorot({
      lines: [
        { lineTotalAgorot: 150_000 },
        { lineTotalAgorot: 24_000 },
        { lineTotalAgorot: 9_500 },
      ],
    })

    expect(totals.subtotalAgorot).toBe(183_500)
    expect(totals.totalAgorot).toBe(183_500)
  })

  it('clamps a discount to the subtotal, so a total is never negative', () => {
    const totals = orderTotalAgorot({
      lines: [{ lineTotalAgorot: 15_000 }],
      discountAgorot: 20_000,
    })

    expect(totals.discountAgorot).toBe(15_000)
    expect(totals.totalAgorot).toBe(0)
  })

  it('an empty order is zero, not an error', () => {
    expect(orderTotalAgorot({ lines: [] }).totalAgorot).toBe(0)
  })
})

describe('the state graph', () => {
  it('lets a bottle of wine go pending → confirmed → completed', () => {
    expect(canTransition('pending', 'confirmed')).toBe(true)
    expect(canTransition('confirmed', 'fulfilled')).toBe(true)
    expect(canTransition('fulfilled', 'completed')).toBe(true)
  })

  it('lets a DJ go through approval and a fulfilment window', () => {
    expect(canTransition('pending', 'awaiting_approval')).toBe(true)
    expect(canTransition('awaiting_approval', 'confirmed')).toBe(true)
    expect(canTransition('confirmed', 'in_preparation')).toBe(true)
    expect(canTransition('in_preparation', 'ready')).toBe(true)
    expect(canTransition('ready', 'fulfilled')).toBe(true)
  })

  it('never goes back to draft', () => {
    for (const from of ['pending', 'confirmed', 'fulfilled'] as const) {
      expect(canTransition(from, 'draft')).toBe(false)
    }
  })

  it('lets nothing out of a terminal status except a refund after completion', () => {
    expect(canTransition('completed', 'refunded')).toBe(true)
    expect(canTransition('refunded', 'confirmed')).toBe(false)
    expect(canTransition('cancelled', 'confirmed')).toBe(false)
  })

  it('refuses an impossible move with a sentence a person can act on', () => {
    expect(
      refusal(() => assertTransition('refunded', 'confirmed')).userMessage,
    ).toContain('כבר סגורה')

    expect(
      refusal(() => assertTransition('draft', 'fulfilled')).userMessage,
    ).toContain('רענן את הדף')
  })

  it('knows which statuses are committed', () => {
    expect(isCommitted('confirmed')).toBe(true)
    expect(isCommitted('pending')).toBe(false)
    expect(isTerminal('completed')).toBe(true)
    expect(isTerminal('ready')).toBe(false)
  })
})

describe('where a new order starts', () => {
  it('waits for a person when the organization asks for approval', () => {
    expect(
      initialStatusFor({
        requiresApproval: null,
        settings: { approvalRequiredDefault: true },
        paymentMode: 'with_booking',
      }),
    ).toBe('awaiting_approval')
  })

  it('lets a product override the organization in either direction', () => {
    expect(
      initialStatusFor({
        requiresApproval: false,
        settings: { approvalRequiredDefault: true },
        paymentMode: 'with_booking',
      }),
    ).toBe('pending')

    expect(
      initialStatusFor({
        requiresApproval: true,
        settings: SETTINGS,
        paymentMode: 'with_booking',
      }),
    ).toBe('awaiting_approval')
  })

  it('honours approval_first regardless of the product', () => {
    expect(
      initialStatusFor({
        requiresApproval: false,
        settings: SETTINGS,
        paymentMode: 'approval_first',
      }),
    ).toBe('awaiting_approval')
  })

  it('waits for money only when the mode actually takes money now', () => {
    expect(
      initialStatusFor({
        requiresApproval: false,
        settings: SETTINGS,
        paymentMode: 'pay_now',
      }),
    ).toBe('awaiting_payment')

    // The default mode asks nothing of the guest, so nothing waits.
    expect(
      initialStatusFor({
        requiresApproval: false,
        settings: SETTINGS,
        paymentMode: 'with_booking',
      }),
    ).toBe('pending')
  })
})

/* ══════════════════════════════════════════════════════════════════════════ */

describe('AMENDING A COMMITTED ORDER — never a silent edit', () => {
  const order = { id: 'order-1', status: 'confirmed' } as Pick<
    StoreOrder,
    'id' | 'status'
  >

  it('derives consent from the sign of the delta, so a screen cannot forget to ask', () => {
    const costlier = proposeAmendment(order, {
      kind: 'quantity',
      beforeState: { quantity: 2 },
      afterState: { quantity: 3 },
      deltaAgorot: 12_000,
      reason: 'האורח ביקש מנה נוספת',
    })

    expect(costlier.consentRequired).toBe(true)
    expect(costlier.status).toBe('awaiting_consent')
  })

  it('does not demand consent for a change that costs nothing more', () => {
    const cheaper = proposeAmendment(order, {
      kind: 'quantity',
      beforeState: { quantity: 3 },
      afterState: { quantity: 2 },
      deltaAgorot: -12_000,
      reason: 'ילד אחד פחות',
    })

    expect(cheaper.consentRequired).toBe(false)
    expect(cheaper.status).toBe('proposed')
  })

  it('refuses to apply a costlier amendment before the guest agreed', () => {
    const refused = refusal(() =>
      assertAmendable({
        consentRequired: true,
        consentGivenAt: null,
        status: 'awaiting_consent',
      }),
    )

    expect(refused.code).toBe('store_amendment_awaiting_consent')
    expect(refused.userMessage).toContain('ממתין לאישור האורח')
  })

  it('allows it once they have', () => {
    expect(() =>
      assertAmendable({
        consentRequired: true,
        consentGivenAt: '2026-03-02T10:00:00.000Z',
        status: 'awaiting_consent',
      }),
    ).not.toThrow()
  })

  it('refuses to apply the same amendment twice', () => {
    expect(
      refusal(() =>
        assertAmendable({
          consentRequired: false,
          consentGivenAt: null,
          status: 'applied',
        }),
      ).userMessage,
    ).toContain('כבר בוצע')
  })

  it('demands a reason', () => {
    expect(
      refusal(() =>
        proposeAmendment(order, {
          kind: 'price',
          beforeState: {},
          afterState: {},
          deltaAgorot: 0,
          reason: '   ',
        }),
      ).userMessage,
    ).toContain('נימוק')
  })

  it('refuses to amend a closed order at all', () => {
    expect(
      refusal(() =>
        proposeAmendment(
          { id: 'order-1', status: 'refunded' },
          {
            kind: 'price',
            beforeState: {},
            afterState: {},
            deltaAgorot: 0,
            reason: 'תיקון',
          },
        ),
      ).userMessage,
    ).toContain('סגורה')
  })
})

/* ══════════════════════════════════════════════════════════════════════════ */

describe('what needs a person', () => {
  const NOW = new Date('2026-03-15T09:00:00.000Z')

  it('an order past its requested date is overdue', () => {
    expect(
      isOverdue({
        status: 'confirmed',
        requestedForDate: '2026-03-10',
        now: NOW,
      }),
    ).toBe(true)
  })

  it('a cancelled order is never overdue — it is finished', () => {
    expect(
      isOverdue({
        status: 'cancelled',
        requestedForDate: '2026-03-10',
        now: NOW,
      }),
    ).toBe(false)
  })

  it('an order with no requested date cannot be late', () => {
    expect(
      isOverdue({ status: 'confirmed', requestedForDate: null, now: NOW }),
    ).toBe(false)
  })

  it('ranks approval above everything, because nothing moves until somebody says yes', () => {
    expect(
      orderAttention({
        status: 'awaiting_approval',
        requestedForDate: '2026-03-01',
        hasUnconfirmedProvider: true,
        now: NOW,
      }),
    ).toBe('awaiting_approval')
  })

  it('surfaces a provider who has not answered', () => {
    expect(
      orderAttention({
        status: 'confirmed',
        requestedForDate: '2026-03-20',
        hasUnconfirmedProvider: true,
        now: NOW,
      }),
    ).toBe('awaiting_provider')
  })

  it('says nothing about an order that is simply progressing', () => {
    expect(
      orderAttention({
        status: 'confirmed',
        requestedForDate: '2026-03-20',
        hasUnconfirmedProvider: false,
        now: NOW,
      }),
    ).toBe('none')
  })
})
