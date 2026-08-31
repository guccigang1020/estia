/**
 * The status filter, and the two decisions in it that no screenshot reveals.
 *
 * A status the enum does not contain must be dropped rather than queried — it
 * would reach PostgREST as a literal and come back as a database error the
 * reader cannot act on, and the honest behaviour for a hand-edited URL is to
 * ignore the part that means nothing.
 *
 * And "is anything filtered" decides between "you have never taken a payment"
 * and "your filter matched nothing", which is the distinction
 * `empty-presets.ts` exists to protect. The property switcher counts, because
 * it is a filter the reader did not set on this screen and is the one they are
 * most likely to have forgotten about.
 */

import { describe, expect, it } from 'vitest'

import { PAYMENT_STATUSES } from '@/lib/contracts/states'
import { PAYMENT_STATUS_LABEL } from '@/lib/finance'
import { INVOICE_STATUSES } from '@/lib/finance'

import {
  FINANCE_STATUS_KEY,
  describeStatusFilter,
  hasActiveStatusFilter,
  parseStatusFilter,
} from './filters'

describe('parseStatusFilter', () => {
  it('accepts every member of the vocabulary it is given', () => {
    for (const status of PAYMENT_STATUSES) {
      expect(
        parseStatusFilter({ [FINANCE_STATUS_KEY]: status }, PAYMENT_STATUSES),
      ).toEqual({ status })
    }
  })

  it('drops a status the contract does not contain', () => {
    // `reconciled` is a plausible-looking word and is not a payment status.
    // Passed through, it would produce a database error rather than a list.
    expect(
      parseStatusFilter(
        { [FINANCE_STATUS_KEY]: 'reconciled' },
        PAYMENT_STATUSES,
      ),
    ).toEqual({ status: null })
  })

  it('does not let one screen filter by another screen’s vocabulary', () => {
    // `issued` is an invoice status. On the payments screen it means nothing,
    // and matching it there would return rows nobody asked for.
    expect(
      parseStatusFilter({ [FINANCE_STATUS_KEY]: 'issued' }, PAYMENT_STATUSES),
    ).toEqual({ status: null })
    expect(
      parseStatusFilter({ [FINANCE_STATUS_KEY]: 'issued' }, INVOICE_STATUSES),
    ).toEqual({ status: 'issued' })
  })

  it('takes the first value when the key is repeated', () => {
    // `?status=paid&status=failed` is a real URL a browser can produce.
    expect(
      parseStatusFilter(
        { [FINANCE_STATUS_KEY]: ['paid', 'failed'] },
        PAYMENT_STATUSES,
      ),
    ).toEqual({ status: 'paid' })
  })

  it('treats an absent key as the unfiltered list', () => {
    expect(parseStatusFilter({}, PAYMENT_STATUSES)).toEqual({ status: null })
    expect(
      parseStatusFilter({ [FINANCE_STATUS_KEY]: '' }, PAYMENT_STATUSES),
    ).toEqual({ status: null })
  })
})

describe('hasActiveStatusFilter', () => {
  it('counts the property switcher as a filter', () => {
    // Getting this wrong shows "you have never taken a payment" to a business
    // whose payments are all in the other property.
    expect(hasActiveStatusFilter({ status: null }, 'property-1')).toBe(true)
    expect(hasActiveStatusFilter({ status: null }, null)).toBe(false)
    expect(hasActiveStatusFilter({ status: 'paid' }, null)).toBe(true)
  })
})

describe('describeStatusFilter', () => {
  it('says the filter back in the domain’s own Hebrew', () => {
    expect(
      describeStatusFilter(
        { status: 'unknown' },
        PAYMENT_STATUS_LABEL,
        'וילה הגליל',
      ),
    ).toBe('וילה הגליל · לא ידוע — דורש בירור')
  })

  it('omits what is not set rather than writing a separator around nothing', () => {
    expect(describeStatusFilter({ status: 'paid' }, PAYMENT_STATUS_LABEL)).toBe(
      'שולם',
    )
    expect(
      describeStatusFilter(
        { status: null },
        PAYMENT_STATUS_LABEL,
        'וילה הגליל',
      ),
    ).toBe('וילה הגליל')
    expect(describeStatusFilter({ status: null }, PAYMENT_STATUS_LABEL)).toBe(
      '',
    )
  })
})
