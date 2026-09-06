/**
 * Fixtures for the fiscal module's own tests.
 *
 * Not exported from `index.ts`, for the reason `finance/testing.ts` is not
 * either: a builder in the public barrel is a builder that ends up constructing
 * a record in production code, and a `FiscalDocument` assembled from defaults
 * is exactly the kind of row `failure.ts` exists to refuse.
 *
 * The defaults describe the most common real row in a deployment with no
 * vendor connected: requested, refused because nothing is configured, and
 * carrying no document number. A test that wants an issued document has to say
 * so, including the number — which is the same demand the domain makes.
 */

import { CURRENCY } from '../finance/money'
import { NOT_CONFIGURED_REASON, NULL_FISCAL_PROVIDER } from './null-provider'
import type { FiscalDocument } from './types'

export function fiscalDocumentFixture(
  overrides: Partial<FiscalDocument> = {},
): FiscalDocument {
  const now = new Date('2026-03-01T09:00:00.000Z')

  return {
    id: 'doc-1',
    organizationId: 'org-1',
    propertyId: 'prop-1',
    bookingId: 'booking-1',
    invoiceId: null,
    provider: NULL_FISCAL_PROVIDER,
    providerDocumentId: null,
    providerDocumentNumber: null,
    type: 'tax_invoice_receipt',
    status: 'refused',
    customerName: 'דנה כהן',
    customerTaxId: null,
    amountAgorot: 120_000,
    taxAgorot: 18_305,
    taxRateBps: 1800,
    currency: CURRENCY,
    issueDate: null,
    source: { kind: 'payment', id: 'pay-1' },
    documentUrl: null,
    documentUrlExpiresAt: null,
    failure: {
      code: 'not_configured',
      reason: NOT_CONFIGURED_REASON,
      providerStatus: null,
    },
    attemptCount: 1,
    lastAttemptAt: now,
    nextRetryAt: null,
    reviewedAt: null,
    reviewedByUserId: null,
    correctsDocumentId: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...overrides,
  }
}
