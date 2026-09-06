import { describe, expect, it } from 'vitest'

import { evidenceFrom, fact, type Decided } from './facts'

describe('evidenceFrom', () => {
  const decided: Decided = {
    met: false,
    detail: 'טרם נרשמה מקדמה — חסרים ₪2,500 מתוך ₪2,500.',
    source: 'payments',
  }

  it('carries the owning engine as the source, not this module', () => {
    expect(
      evidenceFrom('payment_requirement', 'דרישת התשלום', decided).source,
    ).toBe('payments')
  })

  it('falls back to the yes-or-no when no richer value was given', () => {
    expect(evidenceFrom('k', 'l', decided).value).toBe(false)
  })

  it('prefers the stated value, including a falsy one', () => {
    const withZero: Decided = { ...decided, value: 0 }
    expect(evidenceFrom('k', 'l', withZero).value).toBe(0)
  })

  it('omits the optional fields rather than setting them to undefined', () => {
    const evidence = evidenceFrom('k', 'l', decided)
    // `"sourceId": null` in a stored record reads as "we looked and there was
    // nothing", which is a different claim from "we did not look".
    expect('sourceId' in evidence).toBe(false)
    expect('observedAt' in evidence).toBe(false)
  })

  it('keeps them when they are real', () => {
    const evidence = evidenceFrom('k', 'l', {
      ...decided,
      sourceId: 'pay-1',
      observedAt: '2026-09-12T09:00:00.000Z',
    })
    expect(evidence.sourceId).toBe('pay-1')
    expect(evidence.observedAt).toBe('2026-09-12T09:00:00.000Z')
  })
})

describe('fact', () => {
  it('builds a piece of evidence with its source attached', () => {
    expect(fact('stock.shortfall', 'חסר', 6, 'inventory')).toEqual({
      key: 'stock.shortfall',
      label: 'חסר',
      value: 6,
      source: 'inventory',
    })
  })

  it('omits observedAt when nothing observed it', () => {
    expect('observedAt' in fact('k', 'l', true, 's')).toBe(false)
  })
})
