/**
 * What changed since the guest said yes.
 *
 * The failure this file guards against is specific and expensive: a guest
 * agreed to ₪7,500, somebody moved the price to ₪8,000, and every screen
 * downstream still shows a green tick. So the headline case is asserted with
 * the actual figures, in the actual wording, rather than as "a change was
 * detected".
 */

import { describe, expect, it } from 'vitest'

import { BASE_TERMS, QUIET_SETTINGS } from './fixtures'
import {
  compareTerms,
  describeParty,
  reconfirmationHeadline,
} from './reconfirmation'
import type { GuestConfirmation, GuestJourneySettings } from './types'

function confirmedAt(
  snapshot: Partial<GuestConfirmation['snapshot']> = {},
): GuestConfirmation {
  return {
    confirmedAt: '2026-08-20T09:00:00Z',
    bookingVersion: 4,
    snapshot: {
      checkIn: BASE_TERMS.checkIn,
      checkOut: BASE_TERMS.checkOut,
      adults: BASE_TERMS.adults,
      children: BASE_TERMS.children,
      infants: BASE_TERMS.infants,
      totalAgorot: BASE_TERMS.totalAgorot,
      currency: BASE_TERMS.currency,
      cancellationTerms: BASE_TERMS.cancellationTerms,
      ...snapshot,
    },
  }
}

const SETTINGS: GuestJourneySettings = QUIET_SETTINGS

describe('nothing to reconfirm', () => {
  it('reports no change for a booking that has not moved', () => {
    const verdict = compareTerms(confirmedAt(), BASE_TERMS, SETTINGS)

    expect(verdict.changed).toBe(false)
    expect(verdict.required).toBe(false)
    expect(verdict.changes).toEqual([])
  })

  it('reports no change when the guest has never confirmed', () => {
    // An unconfirmed booking has not changed — it has never been agreed. Saying
    // "ההזמנה עודכנה" to somebody opening their link for the first time is
    // both wrong and alarming.
    const verdict = compareTerms(null, BASE_TERMS, SETTINGS)

    expect(verdict.changed).toBe(false)
    expect(verdict.required).toBe(false)
  })

  it('ignores a version bump with no material change', () => {
    // `bookings.version` moves when anybody touches the row — an internal note,
    // a corrected surname. Re-asking on every bump teaches people to press the
    // button without reading.
    const verdict = compareTerms(
      confirmedAt(),
      { ...BASE_TERMS, bookingVersion: 11 },
      SETTINGS,
    )

    expect(verdict.changed).toBe(false)
  })

  it('ignores cancellation wording that was only re-wrapped', () => {
    const verdict = compareTerms(
      confirmedAt({
        cancellationTerms: 'ביטול עד 14 יום\n  לפני ההגעה ללא חיוב.',
      }),
      {
        ...BASE_TERMS,
        cancellationTerms: 'ביטול עד 14 יום לפני ההגעה ללא חיוב.',
      },
      SETTINGS,
    )

    expect(verdict.changed).toBe(false)
  })
})

describe('the price moved', () => {
  it('names the old figure and the new one', () => {
    const verdict = compareTerms(
      confirmedAt({ totalAgorot: 750_000 }),
      { ...BASE_TERMS, totalAgorot: 800_000 },
      SETTINGS,
    )

    expect(verdict.required).toBe(true)
    expect(verdict.changes).toHaveLength(1)
    expect(verdict.changes[0]).toMatchObject({
      trigger: 'price',
      label: 'מחיר',
      before: '₪7,500',
      after: '₪8,000',
    })
  })

  it('treats a currency change as a price change', () => {
    // ₪7,500 becoming $7,500 is not the same deal, and comparing only the
    // number would miss it entirely.
    const verdict = compareTerms(
      confirmedAt({ currency: 'ILS' }),
      { ...BASE_TERMS, currency: 'USD' },
      SETTINGS,
    )

    expect(verdict.changes.map((change) => change.trigger)).toEqual(['price'])
  })
})

describe('the other three triggers', () => {
  it('names moved dates', () => {
    const verdict = compareTerms(
      confirmedAt(),
      { ...BASE_TERMS, checkIn: '2026-09-04', checkOut: '2026-09-08' },
      SETTINGS,
    )

    expect(verdict.changes[0]).toMatchObject({
      trigger: 'dates',
      before: '3.9.2026 – 7.9.2026',
      after: '4.9.2026 – 8.9.2026',
    })
  })

  it('notices a party of the same size but a different shape', () => {
    // Two adults becoming one adult and one child is the same total and a
    // different stay, and a business charging per adult prices it differently.
    const verdict = compareTerms(
      confirmedAt({ adults: 2, children: 0 }),
      { ...BASE_TERMS, adults: 1, children: 1 },
      SETTINGS,
    )

    expect(verdict.changes[0]).toMatchObject({
      trigger: 'guests',
      before: '2 מבוגרים',
      after: 'מבוגר אחד · ילד אחד',
    })
  })

  it('notices rewritten cancellation terms', () => {
    const verdict = compareTerms(
      confirmedAt({
        cancellationTerms: 'ביטול עד 14 יום לפני ההגעה ללא חיוב.',
      }),
      {
        ...BASE_TERMS,
        cancellationTerms: 'ביטול עד 30 יום לפני ההגעה ללא חיוב.',
      },
      SETTINGS,
    )

    expect(verdict.changes.map((change) => change.trigger)).toEqual([
      'cancellation',
    ])
  })
})

describe('the business chooses what counts', () => {
  it('does not re-ask for a trigger the business excluded', () => {
    const verdict = compareTerms(
      confirmedAt({ cancellationTerms: 'ישן' }),
      { ...BASE_TERMS, cancellationTerms: 'חדש' },
      { ...SETTINGS, reconfirmationTriggers: ['dates', 'guests', 'price'] },
    )

    expect(verdict.changed).toBe(true)
    expect(verdict.required).toBe(false)
    // Still shown, quietly. A guest whose cancellation terms moved is entitled
    // to notice even where the business does not re-ask.
    expect(verdict.informational.map((change) => change.trigger)).toEqual([
      'cancellation',
    ])
  })

  it('still re-asks for a trigger the business kept', () => {
    const verdict = compareTerms(
      confirmedAt({ totalAgorot: 750_000 }),
      { ...BASE_TERMS, totalAgorot: 800_000 },
      { ...SETTINGS, reconfirmationTriggers: ['price'] },
    )

    expect(verdict.required).toBe(true)
  })
})

describe('the headline', () => {
  it('names the single thing that changed', () => {
    const verdict = compareTerms(
      confirmedAt({ totalAgorot: 750_000 }),
      { ...BASE_TERMS, totalAgorot: 800_000 },
      SETTINGS,
    )

    expect(reconfirmationHeadline(verdict)).toBe('ההזמנה עודכנה — מחיר')
  })

  it('joins several with a Hebrew conjunction', () => {
    const verdict = compareTerms(
      confirmedAt(),
      { ...BASE_TERMS, checkIn: '2026-09-04', totalAgorot: 800_000 },
      SETTINGS,
    )

    expect(reconfirmationHeadline(verdict)).toBe(
      'ההזמנה עודכנה — תאריכים ומחיר',
    )
  })

  it('stays neutral when nothing changed', () => {
    const verdict = compareTerms(confirmedAt(), BASE_TERMS, SETTINGS)
    expect(reconfirmationHeadline(verdict)).toBe('ההזמנה שלך')
  })
})

describe('describeParty', () => {
  it('skips whatever is zero', () => {
    expect(describeParty(2, 0, 0)).toBe('2 מבוגרים')
    expect(describeParty(1, 1, 1)).toBe('מבוגר אחד · ילד אחד · תינוק אחד')
    expect(describeParty(3, 2, 0)).toBe('3 מבוגרים · 2 ילדים')
  })

  it('says so rather than rendering an empty string', () => {
    expect(describeParty(0, 0, 0)).toBe('ללא אורחים')
  })
})
