/**
 * Every finance enum has Hebrew wording, and `unknown` does not look like
 * `failed`.
 *
 * The first half is the same guard `properties/_lib/labels.test.ts` provides:
 * the records are asserted total over the contract's own tuples, so adding a
 * payment method in a migration and in `contracts/states.ts` without wording it
 * here fails the suite rather than printing `paybox` into a Hebrew screen.
 *
 * The second half is the product rule. A processor timeout is neither success
 * nor failure, and the whole reason `unknown` exists as a status is that the
 * business does not know whether the card was charged. A tone function that
 * gave it the same treatment as `failed` would tell a bookkeeper the money is
 * definitely not there.
 */

import { describe, expect, it } from 'vitest'

import {
  COMMISSION_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
} from '@/lib/contracts/states'
import {
  COLLECTION_CHANNELS,
  INVOICE_KINDS,
  INVOICE_STATUSES,
  PAYMENT_ATTENTIONS,
  PAYMENT_PURPOSES,
} from '@/lib/finance'

import {
  COLLECTION_CHANNEL_LABEL,
  INVOICE_KIND_LABEL,
  INVOICE_STATUS_LABEL,
  PAYMENT_ATTENTION_LABEL,
  PAYMENT_METHOD_LABEL,
  PAYMENT_PURPOSE_LABEL,
  commissionStatusTone,
  commissionStatusVoided,
  invoiceStatusTone,
  labelOr,
  paymentStatusTone,
  paymentStatusVoided,
} from './labels'

/** Hebrew, not a transliteration and not the enum value with spaces in it. */
const HEBREW = /[֐-׿]/

describe('every enum this module prints has Hebrew wording', () => {
  const cases: ReadonlyArray<
    readonly [string, readonly string[], Record<string, string>]
  > = [
    ['PAYMENT_METHODS', PAYMENT_METHODS, PAYMENT_METHOD_LABEL],
    ['PAYMENT_PURPOSES', PAYMENT_PURPOSES, PAYMENT_PURPOSE_LABEL],
    ['COLLECTION_CHANNELS', COLLECTION_CHANNELS, COLLECTION_CHANNEL_LABEL],
    ['PAYMENT_ATTENTIONS', PAYMENT_ATTENTIONS, PAYMENT_ATTENTION_LABEL],
    ['INVOICE_KINDS', INVOICE_KINDS, INVOICE_KIND_LABEL],
    ['INVOICE_STATUSES', INVOICE_STATUSES, INVOICE_STATUS_LABEL],
  ]

  it.each(cases)('%s is covered', (_name, members, labels) => {
    for (const member of members) {
      const label = labels[member]
      expect(label, `no Hebrew label for '${member}'`).toBeTruthy()
      expect(label).toMatch(HEBREW)
    }
    // And nothing worded that is not a member, which would be a label for a
    // value the database can no longer produce.
    expect(Object.keys(labels).sort()).toEqual([...members].sort())
  })
})

describe('a payment that nobody can vouch for is not a failed payment', () => {
  it('gives `unknown` a tone of its own, and gives it to nothing else', () => {
    expect(paymentStatusTone('unknown')).toBe('accent')

    for (const status of PAYMENT_STATUSES) {
      if (status === 'unknown') continue
      expect(paymentStatusTone(status)).not.toBe('accent')
    }
  })

  it('does not strike `unknown` through, the way it strikes a failure', () => {
    // Struck-through text reads as "this is over". An unknown payment is the
    // opposite: it is the one row still waiting for somebody.
    expect(paymentStatusVoided('unknown')).toBe(false)
    expect(paymentStatusVoided('failed')).toBe(true)
    expect(paymentStatusVoided('cancelled')).toBe(true)
    expect(paymentStatusVoided('paid')).toBe(false)
  })

  it('has a tone for every payment status, never undefined', () => {
    for (const status of PAYMENT_STATUSES) {
      expect(['neutral', 'brand', 'accent']).toContain(
        paymentStatusTone(status),
      )
    }
  })
})

describe('the commission ladder', () => {
  it('marks money that is committed and not yet paid', () => {
    expect(commissionStatusTone('eligible')).toBe('accent')
    expect(commissionStatusTone('approved')).toBe('accent')
    expect(commissionStatusTone('paid')).toBe('brand')
    expect(commissionStatusTone('estimated')).toBe('neutral')
  })

  it('has a tone for every commission status', () => {
    for (const status of COMMISSION_STATUSES) {
      expect(['neutral', 'brand', 'accent']).toContain(
        commissionStatusTone(status),
      )
    }
  })

  it('strikes only a cancelled commission through', () => {
    for (const status of COMMISSION_STATUSES) {
      expect(commissionStatusVoided(status)).toBe(status === 'cancelled')
    }
  })
})

describe('invoice status', () => {
  it('distinguishes the document that is in force', () => {
    expect(invoiceStatusTone('issued')).toBe('brand')
    expect(invoiceStatusTone('draft')).toBe('neutral')
    expect(invoiceStatusTone('cancelled')).toBe('neutral')
  })
})

describe('labelOr', () => {
  it('prints the raw value rather than inventing a Hebrew name for it', () => {
    expect(labelOr(PAYMENT_METHOD_LABEL, 'card')).toBe('כרטיס אשראי')
    expect(labelOr(PAYMENT_METHOD_LABEL, 'crypto')).toBe('crypto')
  })
})
