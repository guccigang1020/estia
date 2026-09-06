/**
 * The comparison reports differences and changes nothing.
 *
 * The two assertions that carry the file: a document the vendor issued and
 * ESTIA has no reference to is always reported, and nothing the reconciler
 * touches is mutated. The rest fences off the cases that would make a run
 * uselessly red — rows from the null provider, and requests never attempted.
 */

import { describe, expect, it } from 'vitest'

import { NULL_FISCAL_PROVIDER } from './null-provider'
import {
  describeFiscalReconciliation,
  reconcileFiscalDocuments,
} from './reconciliation'
import { fiscalDocumentFixture } from './testing'
import type { ProviderDocumentSummary } from './types'

const WINDOW = { from: '2026-02-01', to: '2026-02-28', provider: 'vendor' }

function summary(
  overrides: Partial<ProviderDocumentSummary> = {},
): ProviderDocumentSummary {
  return {
    providerDocumentId: 'p-1',
    providerDocumentNumber: '2026-000184',
    type: 'tax_invoice_receipt',
    status: 'issued',
    issueDate: '2026-02-14',
    amountAgorot: 120_000,
    taxAgorot: 18_305,
    externalReference: 'BK-2026-0184',
    ...overrides,
  }
}

const MATCHED = fiscalDocumentFixture({
  provider: 'vendor',
  status: 'issued',
  providerDocumentId: 'p-1',
  providerDocumentNumber: '2026-000184',
  issueDate: '2026-02-14',
  failure: null,
})

describe('reconcileFiscalDocuments', () => {
  it('balances when both ledgers agree', () => {
    const report = reconcileFiscalDocuments({
      ...WINDOW,
      documents: [MATCHED],
      providerDocuments: [summary()],
    })

    expect(report.balanced).toBe(true)
    expect(report.matchedCount).toBe(1)
    expect(report.matchedAgorot).toBe(120_000)
    expect(report.differences).toHaveLength(0)
    expect(describeFiscalReconciliation(report)).toContain('ללא הפרשים')
  })

  it('reports a document the vendor issued and we have no reference to', () => {
    const report = reconcileFiscalDocuments({
      ...WINDOW,
      documents: [],
      providerDocuments: [summary()],
    })

    expect(report.differences).toHaveLength(1)
    expect(report.differences[0].kind).toBe('missing_locally')
    expect(report.differences[0].providerAgorot).toBe(120_000)
    expect(report.differenceAgorot).toBe(120_000)
  })

  it('reports a zero-amount document the vendor issued', () => {
    // Reported even at zero: a numbered legal document nobody knows about is
    // a fact regardless of its size.
    const report = reconcileFiscalDocuments({
      ...WINDOW,
      documents: [],
      providerDocuments: [summary({ amountAgorot: 0, taxAgorot: 0 })],
    })
    expect(report.differences.map((d) => d.kind)).toEqual(['missing_locally'])
  })

  it('leads with a document our own record calls unknown', () => {
    const report = reconcileFiscalDocuments({
      ...WINDOW,
      documents: [
        fiscalDocumentFixture({
          provider: 'vendor',
          status: 'unknown',
          providerDocumentId: 'p-1',
          attemptCount: 1,
        }),
      ],
      providerDocuments: [summary()],
    })

    expect(report.differences[0].kind).toBe('unknown_locally')
    expect(report.differences[0].message).toContain('2026-000184')
    // Matched against the vendor's row, so it is not also reported missing.
    expect(report.differences).toHaveLength(1)
  })

  it('reports an amount difference in both directions', () => {
    const report = reconcileFiscalDocuments({
      ...WINDOW,
      documents: [MATCHED],
      providerDocuments: [summary({ amountAgorot: 100_000 })],
    })

    expect(report.differences[0].kind).toBe('amount_mismatch')
    expect(report.differences[0].deltaAgorot).toBe(20_000)
  })

  it('reports a cancellation only one side knows about', () => {
    const report = reconcileFiscalDocuments({
      ...WINDOW,
      documents: [{ ...MATCHED, status: 'cancelled' }],
      providerDocuments: [summary()],
    })

    expect(report.differences[0].kind).toBe('status_mismatch')
  })

  it('does not call a credited document a status difference', () => {
    // A credit document is a second document; the original stays in force.
    const report = reconcileFiscalDocuments({
      ...WINDOW,
      documents: [{ ...MATCHED, status: 'credited' }],
      providerDocuments: [summary()],
    })

    expect(report.balanced).toBe(true)
  })

  it('reports an issued document with no provider id as unmatchable', () => {
    const report = reconcileFiscalDocuments({
      ...WINDOW,
      documents: [{ ...MATCHED, providerDocumentId: null }],
      providerDocuments: [],
    })

    expect(report.differences[0].kind).toBe('unmatchable')
  })

  it('excludes null-provider rows rather than reporting every one of them', () => {
    const report = reconcileFiscalDocuments({
      ...WINDOW,
      documents: [
        fiscalDocumentFixture({ provider: NULL_FISCAL_PROVIDER }),
        fiscalDocumentFixture({ id: 'doc-2', provider: NULL_FISCAL_PROVIDER }),
      ],
      providerDocuments: [],
    })

    expect(report.balanced).toBe(true)
    expect(report.notComparedCount).toBe(2)
  })

  it('excludes a request that was never attempted', () => {
    const report = reconcileFiscalDocuments({
      ...WINDOW,
      documents: [
        fiscalDocumentFixture({
          provider: 'vendor',
          status: 'pending',
          attemptCount: 0,
          failure: null,
        }),
      ],
      providerDocuments: [],
    })

    expect(report.balanced).toBe(true)
    expect(report.notComparedCount).toBe(1)
  })

  it('ignores a failed attempt — that is the §148 queue, not this report', () => {
    const report = reconcileFiscalDocuments({
      ...WINDOW,
      documents: [
        fiscalDocumentFixture({
          provider: 'vendor',
          status: 'failed',
          attemptCount: 3,
        }),
      ],
      providerDocuments: [],
    })

    expect(report.balanced).toBe(true)
    expect(report.notComparedCount).toBe(0)
  })

  it('mutates nothing it was given', () => {
    const document = { ...MATCHED }
    const before = JSON.stringify(document)

    reconcileFiscalDocuments({
      ...WINDOW,
      documents: [document],
      providerDocuments: [summary({ amountAgorot: 1 })],
    })

    expect(JSON.stringify(document)).toBe(before)
  })
})
