/**
 * After the stay — and the two things this screen is not allowed to do.
 *
 * It may not filter who reaches a public review link by what they said
 * privately, and it may not offer a date or a price it has not checked. Both
 * are asserted directly rather than left to the comments that explain them.
 */

import { describe, expect, it } from 'vitest'

import { NO_REBOOK_PORT } from './ports'
import { journeyFixture } from './fixtures'
import {
  buildPostStayView,
  guestRebookOffer,
  guestReceiptOffer,
  guestReviewOffer,
  guestStaySummary,
  safeExternalUrl,
} from './post-stay'
import { PAYMENT_UNKNOWN_NOTICE } from './stay'

const REVIEW_URL = 'https://www.google.com/maps/place/estia/reviews'

const DEPARTED = journeyFixture({
  current: {
    status: 'checked_out',
    checkIn: '2026-09-01',
    checkOut: '2026-09-05',
    adults: 2,
    children: 1,
    infants: 0,
    totalAgorot: 750_000,
  },
})

// ── The summary ───────────────────────────────────────────────────────────

describe('the booking summary', () => {
  it('counts the nights on the half-open convention', () => {
    const summary = guestStaySummary(DEPARTED)

    expect(summary.nights).toBe(4)
    expect(summary.nightsLabel).toBe('4 לילות')
    expect(summary.partyLabel).toBe('2 מבוגרים · ילד אחד')
    expect(summary.totalLabel).toBe('₪7,500')
  })

  it('uses the Hebrew singular and dual', () => {
    const one = guestStaySummary(
      journeyFixture({
        current: { checkIn: '2026-09-01', checkOut: '2026-09-02' },
      }),
    )
    const two = guestStaySummary(
      journeyFixture({
        current: { checkIn: '2026-09-01', checkOut: '2026-09-03' },
      }),
    )

    expect(one.nightsLabel).toBe('לילה אחד')
    expect(two.nightsLabel).toBe('שני לילות')
  })

  it('prints no total for a booking whose price was never entered', () => {
    // ₪0 on a thank-you screen is an invitation to an argument, not a fact.
    const free = guestStaySummary(
      journeyFixture({ current: { totalAgorot: 0 } }),
    )
    expect(free.totalLabel).toBeNull()
  })
})

// ── The review, and the gating that is not built ──────────────────────────

describe('the public review link is never filtered', () => {
  it('offers the link under every input the function accepts', () => {
    // The signature is the guarantee — there is no rating, no sentiment and no
    // feedback argument to pass. `canRecordFeedback` is the only other input
    // and it is a capability, not an opinion about the guest. So exhausting it
    // exhausts every way this function could have been made to filter.
    const settings = {
      ...DEPARTED.settings,
      reviewEnabled: true,
      reviewUrl: REVIEW_URL,
    }

    for (const canRecordFeedback of [true, false]) {
      expect(
        guestReviewOffer(settings, { canRecordFeedback })?.externalUrl,
      ).toBe(REVIEW_URL)
    }
    expect(guestReviewOffer(settings)?.externalUrl).toBe(REVIEW_URL)
  })

  it('shows the public link alongside the private prompt, not behind it', () => {
    const offer = guestReviewOffer(
      { ...DEPARTED.settings, reviewEnabled: true, reviewUrl: REVIEW_URL },
      { canRecordFeedback: true },
    )

    expect(offer?.mode).toBe('both')
    expect(offer?.internalPrompt).not.toBeNull()
    expect(offer?.externalUrl).toBe(REVIEW_URL)
  })

  it('offers the link alone when there is nowhere to store private feedback', () => {
    // Today's truth: 0034 has no table for it. A form that discards what
    // somebody wrote is worse than no form.
    const offer = guestReviewOffer({
      ...DEPARTED.settings,
      reviewEnabled: true,
      reviewUrl: REVIEW_URL,
    })

    expect(offer?.mode).toBe('external')
    expect(offer?.internalPrompt).toBeNull()
    expect(offer?.externalUrl).toBe(REVIEW_URL)
  })

  it('offers nothing when reviews are off', () => {
    expect(
      guestReviewOffer({ ...DEPARTED.settings, reviewEnabled: false }),
    ).toBeNull()
  })

  it('offers nothing rather than an empty section when neither half exists', () => {
    const offer = guestReviewOffer({
      ...DEPARTED.settings,
      reviewEnabled: true,
      reviewUrl: null,
    })
    expect(offer).toBeNull()
  })
})

describe('an operator-typed review URL is a URL somebody else opens', () => {
  it('refuses a javascript: URL', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull()
  })

  it('refuses a relative URL, which would carry the token back into the portal', () => {
    expect(safeExternalUrl('/g/abc/review')).toBeNull()
  })

  it('refuses blank and whitespace', () => {
    expect(safeExternalUrl('')).toBeNull()
    expect(safeExternalUrl('   ')).toBeNull()
    expect(safeExternalUrl(null)).toBeNull()
  })

  it('keeps a real link', () => {
    expect(safeExternalUrl(REVIEW_URL)).toBe(REVIEW_URL)
  })

  it('does not surface a refused URL through the offer', () => {
    const offer = guestReviewOffer({
      ...DEPARTED.settings,
      reviewEnabled: true,
      reviewUrl: 'javascript:alert(1)',
    })
    expect(offer).toBeNull()
  })
})

// ── The receipt ───────────────────────────────────────────────────────────

describe('a receipt asserts that money moved', () => {
  it('is offered once the payment settled', () => {
    const receipt = guestReceiptOffer(DEPARTED, { paymentStatus: 'paid' })

    expect(receipt?.totalLabel).toBe('₪7,500')
    expect(receipt?.notice?.tone).toBe('success')
  })

  it('is not offered while the provider is being asked', () => {
    const receipt = guestReceiptOffer(DEPARTED, { paymentStatus: 'unknown' })

    expect(receipt?.href).toBeNull()
    expect(receipt?.notice?.message).toBe(PAYMENT_UNKNOWN_NOTICE)
    expect(receipt?.notice?.message).not.toContain('נכשל')
  })

  it('is not offered for a booking with no total', () => {
    const free = journeyFixture({ current: { totalAgorot: 0 } })
    expect(guestReceiptOffer(free, { paymentStatus: 'paid' })).toBeNull()
  })

  it('says nothing when nothing is known about the money', () => {
    expect(guestReceiptOffer(DEPARTED)).toBeNull()
  })

  it('refuses a receipt URL that is not a real link', () => {
    const receipt = guestReceiptOffer(DEPARTED, {
      paymentStatus: 'paid',
      receiptUrl: 'javascript:alert(1)',
    })
    expect(receipt?.href).toBeNull()
  })
})

// ── Rebooking ─────────────────────────────────────────────────────────────

describe('rebooking never invents an opening', () => {
  const rebookable = journeyFixture({
    settings: { rebookEnabled: true },
    current: { status: 'checked_out', adults: 2, children: 1, infants: 0 },
    details: {
      submittedAt: '2026-08-20T09:00:00Z',
      fields: {
        full_name: 'דנה לוי',
        phone: '050-1234567',
        email: 'dana@example.com',
      },
    },
  })

  it('asks rather than shows when the availability port knows nothing', async () => {
    // The shipped wiring. `NO_REBOOK_PORT` returns an empty list by design and
    // this is the screen that produces.
    const openRanges = await NO_REBOOK_PORT.openRanges({
      organizationId: 'o-1',
      propertyId: 'p-1',
      bookingId: 'b-1',
      from: '2026-10-01',
      to: '2026-12-31',
    })

    const offer = guestRebookOffer(rebookable, { openRanges })

    expect(offer.kind).toBe('ask')
    if (offer.kind !== 'ask') throw new Error('unreachable')
    expect(offer.body).toContain('לא יכולים להראות כאן תאריכים פנויים')
  })

  it('carries no price under any shape', () => {
    const asked = guestRebookOffer(rebookable)
    const shown = guestRebookOffer(rebookable, {
      openRanges: [{ start: '2026-11-05', end: '2026-11-09' }],
    })

    for (const offer of [asked, shown]) {
      const serialised = JSON.stringify(offer)
      expect(serialised).not.toContain('Agorot')
      expect(serialised).not.toContain('₪')
    }
  })

  it('prefills the guest and the party and nothing more', () => {
    const offer = guestRebookOffer(rebookable)
    if (offer.kind !== 'ask') throw new Error('unreachable')

    expect(offer.prefill).toEqual({
      guestName: 'דנה לוי',
      phone: '050-1234567',
      email: 'dana@example.com',
      adults: 2,
      children: 1,
      infants: 0,
    })
  })

  it('shows only the ranges it was handed, unchanged', () => {
    const ranges = [
      { start: '2026-11-05', end: '2026-11-09' },
      { start: '2026-12-01', end: '2026-12-04' },
    ]
    const offer = guestRebookOffer(rebookable, { openRanges: ranges })

    expect(offer.kind).toBe('dates')
    if (offer.kind !== 'dates') throw new Error('unreachable')
    expect(offer.ranges).toEqual(ranges)
  })

  it('drops a malformed range rather than rendering it', () => {
    const offer = guestRebookOffer(rebookable, {
      openRanges: [{ start: '2026-11-09', end: '2026-11-05' }],
    })
    // Reversed: not a free window, and certainly not one to offer.
    expect(offer.kind).toBe('ask')
  })

  it('shows no card at all when the business does not offer rebooking', () => {
    expect(guestRebookOffer(DEPARTED).kind).toBe('off')
  })
})

// ── The whole screen ──────────────────────────────────────────────────────

describe('the post-stay screen asks one thing', () => {
  it('leads with the review where one is offered', () => {
    const view = buildPostStayView(
      journeyFixture({
        settings: {
          reviewEnabled: true,
          reviewUrl: REVIEW_URL,
          rebookEnabled: true,
        },
        current: { status: 'checked_out' },
      }),
    )

    expect(view.action.id).toBe('review')
    expect(view.review?.externalUrl).toBe(REVIEW_URL)
  })

  it('falls back to rebooking, then to nothing at all', () => {
    const rebookOnly = buildPostStayView(
      journeyFixture({ settings: { rebookEnabled: true } }),
    )
    expect(rebookOnly.action.id).toBe('rebook')

    const quiet = buildPostStayView(journeyFixture())
    expect(quiet.action.id).toBe('none')
    expect(quiet.action.label).toBeNull()
    expect(quiet.review).toBeNull()
    expect(quiet.rebook.kind).toBe('off')
  })

  it('thanks the guest and shows the stay it is thanking them for', () => {
    const view = buildPostStayView(DEPARTED)

    expect(view.headline).toBe('תודה שהתארחתם אצלנו')
    expect(view.summary.nights).toBe(4)
  })

  it('never claims a payment failed while the provider is being asked', () => {
    const view = buildPostStayView(DEPARTED, { paymentStatus: 'unknown' })

    expect(view.receipt?.notice?.message).toBe(PAYMENT_UNKNOWN_NOTICE)
    expect(JSON.stringify(view)).not.toContain('נכשל')
  })
})
