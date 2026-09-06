/**
 * The null provider refuses, records why, and never invents a document.
 *
 * The three things asserted here are the three ways this file could quietly
 * become dishonest: by throwing instead of refusing (which a queue reads as a
 * retryable failure), by refusing without a reason (which leaves a person
 * looking at an empty row), and by returning a document number nobody issued.
 * The last one is checked structurally as well: the `issued` branch of the
 * result union is asserted never to be taken.
 */

import { describe, expect, it } from 'vitest'

import { CURRENCY } from '../finance/money'
import {
  NOT_CONFIGURED_REASON,
  NULL_FISCAL_PROVIDER,
  fixedFiscalProvider,
  nullFiscalProvider,
} from './null-provider'
import { guardCapability, guarded, type IssueDocumentRequest } from './provider'

function request(
  overrides: Partial<IssueDocumentRequest> = {},
): IssueDocumentRequest {
  return {
    organizationId: 'org-1',
    documentId: 'doc-1',
    type: 'tax_invoice_receipt',
    customer: {
      name: 'דנה כהן',
      taxId: null,
      email: 'dana@example.com',
      address: null,
    },
    amountAgorot: 120_000,
    taxAgorot: 18_305,
    taxRateBps: 1800,
    currency: CURRENCY,
    description: 'שהייה בסוויטת הגליל',
    externalReference: 'BK-2026-0184',
    idempotencyKey: 'key-1',
    ...overrides,
  }
}

describe('nullFiscalProvider', () => {
  it('declares no capabilities and names itself none', () => {
    expect(nullFiscalProvider.name).toBe(NULL_FISCAL_PROVIDER)
    expect(nullFiscalProvider.name).toBe('none')
    expect(nullFiscalProvider.capabilities.size).toBe(0)
  })

  it('refuses as a VALUE, with a recorded reason, and never throws', async () => {
    const result = await nullFiscalProvider.createInvoice(request())

    expect(result.outcome).toBe('refused')
    if (result.outcome !== 'refused') return
    expect(result.code).toBe('not_configured')
    expect(result.reason).toBe(NOT_CONFIGURED_REASON)
    expect(result.reason.length).toBeGreaterThan(0)
    expect(result.provider).toBe('none')
  })

  it('never returns an issued document from any issuing method', async () => {
    const results = await Promise.all([
      nullFiscalProvider.createInvoice(request()),
      nullFiscalProvider.createReceipt(request({ type: 'receipt' })),
      nullFiscalProvider.createInvoiceReceipt(request()),
      nullFiscalProvider.createCreditDocument({
        ...request({ type: 'credit_invoice' }),
        correctsProviderDocumentId: 'p-1',
        reason: 'ביטול הזמנה',
      }),
    ])

    for (const result of results) {
      expect(result.outcome).not.toBe('issued')
      // No branch of this module may produce a document number, so there is
      // nothing on any of these results that a screen could print as one.
      expect(JSON.stringify(result)).not.toContain('providerDocumentNumber')
    }
  })

  it('gives the refusal a real vendor would give, before the configuration one', async () => {
    const noName = await nullFiscalProvider.createInvoice(
      request({
        customer: { name: '  ', taxId: null, email: null, address: null },
      }),
    )
    expect(noName.outcome).toBe('refused')
    if (noName.outcome !== 'refused') return
    expect(noName.code).toBe('missing_customer')

    const zero = await nullFiscalProvider.createInvoice(
      request({ amountAgorot: 0 }),
    )
    expect(zero.outcome).toBe('refused')
    if (zero.outcome !== 'refused') return
    expect(zero.code).toBe('zero_amount')
  })

  it('refuses a credit document with no stated reason', async () => {
    const result = await nullFiscalProvider.createCreditDocument({
      ...request({ type: 'credit_invoice' }),
      correctsProviderDocumentId: 'p-1',
      reason: '   ',
    })
    expect(result.outcome).toBe('refused')
  })

  it('rejects an unsigned webhook rather than explaining the configuration', async () => {
    const result = await nullFiscalProvider.handleWebhook({
      deliveryId: 'd-1',
      body: '{"anything":true}',
      signature: null,
      receivedAt: new Date('2026-03-01T09:00:00.000Z'),
    })

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.reason).toContain('חתימה')
  })

  it('refuses lookup, cancel and reconcile too', async () => {
    const outcomes = await Promise.all([
      nullFiscalProvider.lookupCustomer({
        organizationId: 'org-1',
        taxId: null,
        email: null,
        name: 'דנה',
      }),
      nullFiscalProvider.lookupDocument({
        organizationId: 'org-1',
        providerDocumentId: 'p-1',
        externalReference: null,
      }),
      nullFiscalProvider.cancelOrCredit({
        organizationId: 'org-1',
        providerDocumentId: 'p-1',
        reason: 'טעות בסכום',
        idempotencyKey: 'k',
      }),
      nullFiscalProvider.reconcile({
        organizationId: 'org-1',
        from: '2026-02-01',
        to: '2026-02-28',
      }),
    ])

    for (const outcome of outcomes) expect(outcome.outcome).toBe('refused')
  })

  it('answers the unanswerable lookup before the configuration refusal', async () => {
    const result = await nullFiscalProvider.lookupDocument({
      organizationId: 'org-1',
      providerDocumentId: null,
      externalReference: null,
    })
    expect(result.outcome).toBe('refused')
    if (result.outcome !== 'refused') return
    expect(result.code).toBe('capability_unsupported')
  })
})

describe('guardCapability', () => {
  it('says not_configured when nothing is connected at all', () => {
    const refusal = guardCapability(nullFiscalProvider, 'create_invoice')
    expect(refusal?.code).toBe('not_configured')
  })

  it('says capability_unsupported when a provider is connected but limited', () => {
    const provider = fixedFiscalProvider({
      name: 'vendor',
      capabilities: ['create_invoice'],
    })

    expect(guardCapability(provider, 'create_invoice')).toBeNull()
    expect(guardCapability(provider, 'reconcile')?.code).toBe(
      'capability_unsupported',
    )
  })
})

describe('guarded', () => {
  it('refuses an undeclared capability without calling the provider', async () => {
    let called = false
    const provider = guarded({
      ...fixedFiscalProvider({
        name: 'vendor',
        capabilities: ['create_invoice'],
      }),
      async reconcile() {
        called = true
        return {
          outcome: 'listed',
          documents: [],
          provider: 'vendor',
        }
      },
    })

    const result = await provider.reconcile({
      organizationId: 'org-1',
      from: '2026-02-01',
      to: '2026-02-28',
    })

    expect(called).toBe(false)
    expect(result.outcome).toBe('refused')
  })

  it('passes a declared capability through', async () => {
    const provider = guarded(
      fixedFiscalProvider({
        name: 'vendor',
        capabilities: ['reconcile'],
        reconcile: { outcome: 'listed', documents: [], provider: 'vendor' },
      }),
    )

    const result = await provider.reconcile({
      organizationId: 'org-1',
      from: '2026-02-01',
      to: '2026-02-28',
    })

    expect(result.outcome).toBe('listed')
  })
})
