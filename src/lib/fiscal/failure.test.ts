/**
 * §148 — a payment whose fiscal document failed reads as paid-and-pending, and
 * cannot read as complete.
 *
 * The central assertion of the module. Everything else in this file exists to
 * fence it in: the money side is unaffected by anything on the fiscal side,
 * the two are never merged into one value, and a row *claiming* to be issued
 * without a vendor's document number is refused rather than believed.
 */

import { describe, expect, it } from 'vitest'

import {
  describeSettlement,
  isFiscallyComplete,
  isPaidAndFiscallyPending,
  moneySideOf,
  type PaymentFiscalFacts,
} from './failure'
import { fiscalDocumentFixture } from './testing'

const NOW = new Date('2026-03-02T10:00:00.000Z')

const PAID: PaymentFiscalFacts = {
  paymentId: 'pay-1',
  status: 'paid',
  capturedAgorot: 120_000,
  refundedAgorot: 0,
}

describe('the money side is decided by the payment alone', () => {
  it('reports received money regardless of the document', () => {
    for (const status of ['refused', 'failed', 'unknown', 'pending'] as const) {
      const view = describeSettlement({
        payment: PAID,
        document: fiscalDocumentFixture({ status }),
        expected: true,
        now: NOW,
      })
      expect(view.money).toEqual({ state: 'received', netAgorot: 120_000 })
    }
  })

  it('never counts an unknown payment as received or as missing', () => {
    expect(moneySideOf({ ...PAID, status: 'unknown' })).toEqual({
      state: 'unknown',
    })
  })
})

describe('a failed fiscal document on a paid payment', () => {
  const view = describeSettlement({
    payment: PAID,
    document: fiscalDocumentFixture({
      status: 'failed',
      nextRetryAt: null,
      failure: {
        code: 'vendor_500',
        reason: 'ספק המסמכים החזיר שגיאה.',
        providerStatus: '500',
      },
    }),
    expected: true,
    now: NOW,
  })

  it('renders as paid and pending, in one line carrying both facts', () => {
    expect(view.money.state).toBe('received')
    expect(view.fiscal.state).toBe('needs_review')
    expect(view.headline).toBe('תשלום נרשם · מסמך חשבונאי נכשל — נדרשת בדיקה')
  })

  it('CANNOT render as fiscally complete', () => {
    expect(isFiscallyComplete(view)).toBe(false)
    expect(isPaidAndFiscallyPending(view)).toBe(true)
    expect(view.needsPerson).toBe(true)
  })

  it('prints the §148 sentence when the document is merely pending', () => {
    const pending = describeSettlement({
      payment: PAID,
      document: fiscalDocumentFixture({ status: 'pending', failure: null }),
      expected: true,
      now: NOW,
    })
    expect(pending.headline).toBe('תשלום נרשם · מסמך חשבונאי ממתין')
    expect(isFiscallyComplete(pending)).toBe(false)
  })

  it('says the same thing when no document row exists at all', () => {
    const none = describeSettlement({
      payment: PAID,
      document: null,
      expected: true,
      now: NOW,
    })
    expect(none.headline).toBe('תשלום נרשם · מסמך חשבונאי ממתין')
    expect(isFiscallyComplete(none)).toBe(false)
  })
})

describe('an issued document', () => {
  const issued = fiscalDocumentFixture({
    provider: 'vendor',
    status: 'issued',
    providerDocumentId: 'p-1',
    providerDocumentNumber: '2026-000184',
    issueDate: '2026-03-01',
    documentUrl: 'https://vendor.example/doc/p-1',
    failure: null,
  })

  it('is the only state that reads as complete', () => {
    const view = describeSettlement({
      payment: PAID,
      document: issued,
      expected: true,
      now: NOW,
    })

    expect(view.fiscal).toEqual({
      state: 'issued',
      documentNumber: '2026-000184',
      issueDate: '2026-03-01',
      documentUrl: 'https://vendor.example/doc/p-1',
    })
    expect(isFiscallyComplete(view)).toBe(true)
    expect(isPaidAndFiscallyPending(view)).toBe(false)
    expect(view.headline).toBe('תשלום נרשם · מסמך חשבונאי הופק')
  })

  it('is REFUSED when the provider supplied no document number', () => {
    // The row claims `issued`. It has no number. Believing the status would
    // print "הופק" over a document that may not exist.
    const view = describeSettlement({
      payment: PAID,
      document: { ...issued, providerDocumentNumber: null },
      expected: true,
      now: NOW,
    })

    expect(view.fiscal.state).toBe('needs_review')
    if (view.fiscal.state !== 'needs_review') return
    expect(view.fiscal.code).toBe('issued_without_number')
    expect(isFiscallyComplete(view)).toBe(false)
  })

  it('is refused for a blank document number too', () => {
    const view = describeSettlement({
      payment: PAID,
      document: { ...issued, providerDocumentNumber: '   ' },
      expected: true,
      now: NOW,
    })
    expect(isFiscallyComplete(view)).toBe(false)
  })
})

describe('the two truths never merge', () => {
  it('exposes no combined status field', () => {
    const view = describeSettlement({
      payment: PAID,
      document: fiscalDocumentFixture(),
      expected: true,
      now: NOW,
    })

    // A single status would have to name "paid but undocumented", and every
    // list that grouped on it would file those rows with the paid ones or the
    // unpaid ones. Both are wrong, so the field does not exist.
    expect(Object.keys(view).sort()).toEqual([
      'fiscal',
      'headline',
      'money',
      'needsPerson',
      'paymentId',
    ])
  })
})

describe('what does not need a person', () => {
  it('an unconfigured organization that expects no documents', () => {
    const view = describeSettlement({
      payment: PAID,
      document: null,
      expected: false,
      now: NOW,
    })
    expect(view.fiscal.state).toBe('not_required')
    expect(view.needsPerson).toBe(false)
    expect(isPaidAndFiscallyPending(view)).toBe(false)
  })

  it('a failure with a retry actually scheduled', () => {
    const view = describeSettlement({
      payment: PAID,
      document: fiscalDocumentFixture({
        status: 'failed',
        attemptCount: 2,
        nextRetryAt: new Date('2026-03-02T11:00:00.000Z'),
        failure: {
          code: 'timeout',
          reason: 'הספק לא השיב בזמן.',
          providerStatus: null,
        },
      }),
      expected: true,
      now: NOW,
    })

    expect(view.fiscal.state).toBe('retrying')
    expect(view.needsPerson).toBe(false)
    expect(isPaidAndFiscallyPending(view)).toBe(true)
  })

  it('a rate-limited refusal, which is the one refusal a queue may retry', () => {
    const view = describeSettlement({
      payment: PAID,
      document: fiscalDocumentFixture({
        status: 'refused',
        failure: {
          code: 'rate_limited',
          reason: 'הספק הגביל את קצב הפניות.',
          providerStatus: '429',
        },
      }),
      expected: true,
      now: NOW,
    })
    expect(view.fiscal.state).toBe('retrying')
  })
})

describe('an unknown fiscal document', () => {
  it('needs a person and is never treated as complete', () => {
    const view = describeSettlement({
      payment: PAID,
      document: fiscalDocumentFixture({
        provider: 'vendor',
        status: 'unknown',
        failure: {
          code: 'timeout',
          reason: 'הספק לא השיב, ולכן לא ידוע אם הופק מסמך.',
          providerStatus: null,
        },
      }),
      expected: true,
      now: NOW,
    })

    expect(view.fiscal.state).toBe('unknown')
    expect(view.needsPerson).toBe(true)
    expect(isFiscallyComplete(view)).toBe(false)
  })
})
