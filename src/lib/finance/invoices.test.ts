import { describe, expect, it } from 'vitest'

import { BusinessRuleError } from '../errors'
import {
  archiveInvoice,
  cancelInvoice,
  composeInvoice,
  creditedAgainst,
  exportDocuments,
  formatDocumentNumber,
  issueCreditNote,
  issueInvoice,
  remainingCreditable,
} from './invoices'
import { AT, BOOKING, snapshotFor } from './testing'
import type { CreditNote, Invoice } from './types'

const ISSUED_AT = AT('2026-03-14T12:00:00.000Z')

/** ₪3,250 of supply, 18% VAT, and a ₪1,000 refundable deposit. */
const snapshot = () =>
  snapshotFor({ taxRatePercent: 18, depositAgorot: 100_000 })

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    ...issueInvoice({
      id: 'inv-1',
      snapshot: snapshot(),
      kind: 'tax_invoice',
      number: 184,
      customerName: 'דנה כהן',
      issuedAt: ISSUED_AT,
    }),
    ...overrides,
  }
}

describe('composing a document', () => {
  it('adds subtotal and tax to the total, by construction', () => {
    const composed = composeInvoice(snapshot())

    expect(composed.subtotalAgorot).toBe(325_000)
    expect(composed.taxAgorot).toBe(58_500)
    expect(composed.totalAgorot).toBe(383_500)
    expect(composed.subtotalAgorot + composed.taxAgorot).toBe(
      composed.totalAgorot,
    )
  })

  it('leaves the refundable deposit off the tax invoice', () => {
    // The guest pays it, so it is on the payment request. It is not a supply
    // of anything, so it is not on a tax invoice and not in the VAT base.
    const composed = composeInvoice(snapshot())

    expect(composed.depositExcludedAgorot).toBe(100_000)
    expect(composed.lines.some((line) => line.kind === 'deposit')).toBe(false)
  })

  it('never puts the business’s own cost of sale on the guest’s bill', () => {
    const composed = composeInvoice(snapshot())
    expect(
      composed.lines.some((line) => line.kind === 'agent_commission'),
    ).toBe(false)
  })
})

describe('issuing', () => {
  it('carries a number and a moment, and nothing else may', () => {
    const document = invoice()

    expect(document.status).toBe('issued')
    expect(document.number).toBe(184)
    expect(document.displayNumber).toBe('2026-000184')
    expect(document.issuedAt).toEqual(ISSUED_AT)
    expect(document.totalAgorot).toBe(383_500)
  })

  it('snapshots the customer name', () => {
    // The guest may correct their name tomorrow; an issued invoice may not.
    expect(invoice().customerName).toBe('דנה כהן')
  })

  it('ties back to the capture the lines came from', () => {
    const source = snapshot()
    const document = issueInvoice({
      id: 'inv-2',
      snapshot: source,
      kind: 'tax_invoice',
      number: 1,
      customerName: 'דנה כהן',
      issuedAt: ISSUED_AT,
    })
    expect(document.snapshotCapturedAt).toBe(source.capturedAt)
  })

  it('records the VAT rate in basis points, not as a float', () => {
    expect(invoice().taxRateBps).toBe(1_800)
  })

  it('records no rate at all when nothing was taxed', () => {
    // "This supply carried no VAT" and "the rate was zero per cent" read the
    // same on screen and are different statements to an auditor.
    const untaxed = issueInvoice({
      id: 'inv-3',
      snapshot: snapshotFor(),
      kind: 'receipt',
      number: 2,
      customerName: 'דנה כהן',
      issuedAt: ISSUED_AT,
    })
    expect(untaxed.taxRateBps).toBeNull()
  })

  it('formats an unbroken series without a year', () => {
    expect(formatDocumentNumber(0, 184)).toBe('000184')
    expect(formatDocumentNumber(2026, 184)).toBe('2026-000184')
  })

  it('refuses a document with no customer', () => {
    expect(() =>
      issueInvoice({
        id: 'inv-4',
        snapshot: snapshot(),
        kind: 'tax_invoice',
        number: 1,
        customerName: '  ',
        issuedAt: ISSUED_AT,
      }),
    ).toThrow(BusinessRuleError)
  })

  it('refuses a document with no number', () => {
    expect(() =>
      issueInvoice({
        id: 'inv-5',
        snapshot: snapshot(),
        kind: 'tax_invoice',
        number: 0,
        customerName: 'דנה',
        issuedAt: ISSUED_AT,
      }),
    ).toThrow(BusinessRuleError)
  })

  it('refuses a document worth nothing', () => {
    expect(() =>
      issueInvoice({
        id: 'inv-6',
        snapshot: snapshotFor({
          baseNightlyAgorot: 0,
          cleaningFeeAgorot: 0,
        }),
        kind: 'tax_invoice',
        number: 1,
        customerName: 'דנה',
        issuedAt: ISSUED_AT,
      }),
    ).toThrow(BusinessRuleError)
  })
})

describe('archiving', () => {
  it('files the document away without changing what it is', () => {
    const archived = archiveInvoice(invoice(), ISSUED_AT)

    expect(archived.archivedAt).toEqual(ISSUED_AT)
    // An archived tax invoice is still an issued tax invoice as far as the
    // tax authority is concerned.
    expect(archived.status).toBe('issued')
  })

  it('is a no-op the second time', () => {
    const once = archiveInvoice(invoice(), ISSUED_AT)
    expect(archiveInvoice(once, AT('2026-04-01T00:00:00.000Z'))).toBe(once)
  })

  it('refuses to file away a draft', () => {
    expect(() =>
      archiveInvoice(invoice({ status: 'draft' }), ISSUED_AT),
    ).toThrow(BusinessRuleError)
  })
})

describe('cancelling', () => {
  it('refuses to cancel an issued tax invoice', () => {
    // The tax authority has a copy. The instrument is a credit note.
    expect(() => cancelInvoice(invoice(), 'טעות', ISSUED_AT)).toThrow(
      BusinessRuleError,
    )
  })

  it('allows a draft to be cancelled', () => {
    const cancelled = cancelInvoice(
      invoice({ status: 'draft' }),
      'ההזמנה בוטלה',
      ISSUED_AT,
    )
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cancelledAt).toEqual(ISSUED_AT)
  })

  it('allows a proforma to be cancelled — it carries no tax consequence', () => {
    const cancelled = cancelInvoice(
      invoice({ kind: 'proforma' }),
      'הצעה פגה',
      ISSUED_AT,
    )
    expect(cancelled.status).toBe('cancelled')
  })

  it('requires a reason', () => {
    expect(() =>
      cancelInvoice(invoice({ status: 'draft' }), '  ', ISSUED_AT),
    ).toThrow(BusinessRuleError)
  })
})

describe('credit notes', () => {
  const credit = (amountAgorot: number, existing: CreditNote[] = []) =>
    issueCreditNote({
      id: `cn-${amountAgorot}`,
      invoice: invoice(),
      existingNotes: existing,
      amountAgorot,
      reason: 'החזר חלקי לאורח',
      number: 1,
      issuedAt: ISSUED_AT,
    })

  it('credits part of an invoice', () => {
    const note = credit(100_000)

    expect(note.amountAgorot).toBe(100_000)
    expect(note.status).toBe('issued')
    expect(note.displayNumber).toBe('2026-000001')
    expect(note.series).toBe('credit')
  })

  it('refuses to credit more than the invoice', () => {
    try {
      credit(400_000)
      expect.unreachable('expected the credit note to be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessRuleError)
      expect((error as BusinessRuleError).publicDetails).toMatchObject({
        requested: 400_000,
        remaining: 383_500,
      })
    }
  })

  it('counts what has already been credited', () => {
    const first = credit(300_000)
    expect(creditedAgainst(invoice(), [first])).toBe(300_000)
    expect(remainingCreditable(invoice(), [first])).toBe(83_500)
    expect(() => credit(100_000, [first])).toThrow(BusinessRuleError)
  })

  it('frees the amount again when a note is cancelled', () => {
    const cancelled: CreditNote = { ...credit(300_000), status: 'cancelled' }
    expect(remainingCreditable(invoice(), [cancelled])).toBe(383_500)
  })

  it('requires a reason', () => {
    expect(() =>
      issueCreditNote({
        id: 'cn-x',
        invoice: invoice(),
        existingNotes: [],
        amountAgorot: 1_000,
        reason: '   ',
        number: 2,
        issuedAt: ISSUED_AT,
      }),
    ).toThrow(BusinessRuleError)
  })

  it('refuses a credit against a document that was never issued', () => {
    expect(() =>
      issueCreditNote({
        id: 'cn-y',
        invoice: invoice({ status: 'draft' }),
        existingNotes: [],
        amountAgorot: 1_000,
        reason: 'טעות',
        number: 2,
        issuedAt: ISSUED_AT,
      }),
    ).toThrow(BusinessRuleError)
  })

  it('takes its amount from its lines when it is itemised', () => {
    const itemised = issueCreditNote({
      id: 'cn-lines',
      invoice: invoice(),
      existingNotes: [],
      lines: [
        {
          kind: 'cleaning_fee',
          label: 'ביטול דמי ניקיון',
          amount: 25_000,
          quantity: 1,
          date: null,
        },
      ],
      reason: 'הניקיון לא בוצע',
      number: 3,
      issuedAt: ISSUED_AT,
    })

    expect(itemised.amountAgorot).toBe(25_000)
    expect(itemised.lines).toHaveLength(1)
  })
})

describe('export', () => {
  it('flattens documents into rows an accountant can read', () => {
    const rows = exportDocuments([invoice()], [])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      documentType: 'invoice',
      displayNumber: '2026-000184',
      subtotalAgorot: 325_000,
      taxAgorot: 58_500,
      totalAgorot: 383_500,
      currency: 'ILS',
    })
  })

  it('exports a credit note as a reduction', () => {
    const note = issueCreditNote({
      id: 'cn-1',
      invoice: invoice(),
      existingNotes: [],
      amountAgorot: 118_000,
      taxAgorot: 18_000,
      reason: 'החזר',
      number: 1,
      issuedAt: ISSUED_AT,
    })

    const rows = exportDocuments([], [note])
    expect(rows[0]).toMatchObject({
      documentType: 'credit_note',
      subtotalAgorot: -100_000,
      taxAgorot: -18_000,
      totalAgorot: -118_000,
    })
  })

  it('orders by the moment of issue', () => {
    const early = invoice({
      id: 'a',
      number: 1,
      displayNumber: '2026-000001',
      issuedAt: AT('2026-01-01T00:00:00.000Z'),
    })
    const late = invoice({
      id: 'b',
      number: 2,
      displayNumber: '2026-000002',
      issuedAt: AT('2026-05-01T00:00:00.000Z'),
    })

    expect(
      exportDocuments([late, early], []).map((row) => row.displayNumber),
    ).toEqual(['2026-000001', '2026-000002'])
  })

  it('carries the booking through, so rows can be tied back', () => {
    expect(exportDocuments([invoice()], [])[0].bookingId).toBe(BOOKING)
  })
})
