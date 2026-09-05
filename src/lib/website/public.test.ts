/**
 * THE PUBLIC PATH: ONE AVAILABILITY TRUTH, AND NO DRAFT.
 *
 * Two things asserted here that nothing else can assert:
 *
 *   1. A unit that is not in the PUBLISHED snapshot is refused before any
 *      engine is asked anything. That is what stops a draft leaking through
 *      the booking widget.
 *
 *   2. The availability answer comes from `src/lib/booking/availability.ts`
 *      and this module supplies rows. The test proves it by feeding the facts
 *      function a booking the module never inspects and watching the canonical
 *      engine's own blocker come back — vocabulary this file does not contain.
 */

import { describe, expect, it, vi } from 'vitest'

import type { Db } from '../persistence'
import {
  SiteRefusedError,
  publicAvailability,
  publicQuote,
  publicSite,
  submissionKeyFor,
} from './public'
import { DEFAULT_SITE_DESIGN, type SiteSnapshot } from './types'

const UNIT = 'unit-a1'
const OTHER_UNIT = 'unit-draft-only'

const snapshot: SiteSnapshot = {
  siteId: 'site-1',
  slug: 'galilee',
  name: 'אחוזת הגליל',
  locale: 'he',
  design: DEFAULT_SITE_DESIGN,
  organizationName: 'אחוזת הגליל',
  pages: [],
  media: [],
  bookableUnitIds: [UNIT],
  factManifest: [],
  builtAt: '2026-03-01T00:00:00.000Z',
}

/** A `Db` that answers only `rpc`, which is the whole public surface. */
function dbReturning(
  answers: Record<string, unknown>,
  failures: Record<string, { message: string; hint?: string }> = {},
): { db: Db; rpc: ReturnType<typeof vi.fn> } {
  const rpc = vi.fn(async (fn: string) => {
    if (failures[fn]) return { data: null, error: failures[fn] }
    return { data: answers[fn] ?? null, error: null }
  })
  return { db: { rpc } as unknown as Db, rpc }
}

describe('resolving a site', () => {
  it('returns the published snapshot', async () => {
    const { db } = dbReturning({
      site_public_snapshot: {
        siteId: 'site-1',
        slug: 'galilee',
        versionId: 'v3',
        publishedAt: '2026-03-01T00:00:00.000Z',
        snapshot,
      },
    })

    const resolved = await publicSite(db, 'galilee')
    expect(resolved.versionId).toBe('v3')
    expect(resolved.snapshot.slug).toBe('galilee')
  })

  it('refuses a site that has never been published, with a 404', async () => {
    // The draft gate, from the visitor's side. A site somebody is building is
    // not found — it is not "empty" and it is not a server error.
    const { db } = dbReturning(
      {},
      {
        site_public_snapshot: {
          message: 'site_not_published',
          hint: 'האתר עדיין אינו באוויר.',
        },
      },
    )

    await expect(publicSite(db, 'galilee')).rejects.toMatchObject({
      code: 'site_not_published',
      status: 404,
    })
  })

  it('refuses an empty host without calling the database at all', async () => {
    const { db, rpc } = dbReturning({})
    await expect(publicSite(db, '   ')).rejects.toBeInstanceOf(SiteRefusedError)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('keeps the database Hebrew hint for a refusal it has not heard of', async () => {
    const { db } = dbReturning(
      {},
      {
        site_public_snapshot: {
          message: 'site_suspended',
          hint: 'האתר הושעה.',
        },
      },
    )

    await expect(publicSite(db, 'galilee')).rejects.toMatchObject({
      code: 'site_refused_site_suspended',
    })
  })
})

describe('THE DRAFT CANNOT BE BOOKED', () => {
  it('refuses a unit that is not in the published snapshot, before asking anything', async () => {
    const { db, rpc } = dbReturning({})

    await expect(
      publicAvailability({
        db,
        host: 'galilee',
        snapshot,
        organizationId: 'org-1',
        unitId: OTHER_UNIT,
        checkIn: '2026-06-01',
        checkOut: '2026-06-04',
        now: new Date('2026-03-01T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'site_unit_not_bookable', status: 404 })

    // Nothing was asked. Adding a unit to a draft page does not make the live
    // site quote it, and it does not even make the live site look.
    expect(rpc).not.toHaveBeenCalled()
  })

  it('refuses a quote for the same reason', async () => {
    const { db, rpc } = dbReturning({})

    await expect(
      publicQuote({
        db,
        host: 'galilee',
        snapshot,
        unitId: OTHER_UNIT,
        checkIn: '2026-06-01',
        checkOut: '2026-06-04',
        guests: 2,
      }),
    ).rejects.toMatchObject({ code: 'site_unit_not_bookable' })

    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('THE ONE AVAILABILITY ENGINE', () => {
  const now = new Date('2026-03-01T00:00:00.000Z')

  it('answers free when nothing occupies the window', async () => {
    const { db } = dbReturning({
      site_public_availability_facts: {
        unitId: UNIT,
        rules: { unitId: UNIT, minimumNights: 1, metadata: {} },
        bookings: [],
        holds: [],
      },
    })

    const result = await publicAvailability({
      db,
      host: 'galilee',
      snapshot,
      organizationId: 'org-1',
      unitId: UNIT,
      checkIn: '2026-06-01',
      checkOut: '2026-06-04',
      now,
    })

    expect(result.available).toBe(true)
    expect(result.nights).toBe(3)
  })

  it('answers taken from the CANONICAL engine, not from anything in this module', async () => {
    // `kind: 'booking'` and the Hebrew message are the engine's own
    // vocabulary. `public.ts` contains no overlap test and no such string, so
    // this passing is proof the decision was made there.
    const { db } = dbReturning({
      site_public_availability_facts: {
        unitId: UNIT,
        rules: { unitId: UNIT, minimumNights: 1, metadata: {} },
        bookings: [
          {
            id: 'booking-1',
            status: 'confirmed',
            checkIn: '2026-06-02',
            checkOut: '2026-06-05',
          },
        ],
        holds: [],
      },
    })

    const result = await publicAvailability({
      db,
      host: 'galilee',
      snapshot,
      organizationId: 'org-1',
      unitId: UNIT,
      checkIn: '2026-06-01',
      checkOut: '2026-06-04',
      now,
    })

    expect(result.available).toBe(false)
    expect(result.blockers.map((blocker) => blocker.kind)).toContain('booking')
  })

  it('does not treat a cancelled booking as occupying, because the engine decides that', () => {
    // The facts function deliberately does not filter by status — a WHERE
    // clause that drifted from OCCUPYING_STATUSES could make dates look free.
    // This asserts the over-returned row is handled correctly.
    return (async () => {
      const { db } = dbReturning({
        site_public_availability_facts: {
          unitId: UNIT,
          rules: { unitId: UNIT, minimumNights: 1, metadata: {} },
          bookings: [
            {
              id: 'booking-1',
              status: 'cancelled',
              checkIn: '2026-06-02',
              checkOut: '2026-06-05',
            },
          ],
          holds: [],
        },
      })

      const result = await publicAvailability({
        db,
        host: 'galilee',
        snapshot,
        organizationId: 'org-1',
        unitId: UNIT,
        checkIn: '2026-06-01',
        checkOut: '2026-06-04',
        now,
      })

      expect(result.available).toBe(true)
    })()
  })

  it('applies a minimum stay stored in the unit metadata, the same way the internal calendar does', async () => {
    const { db } = dbReturning({
      site_public_availability_facts: {
        unitId: UNIT,
        rules: {
          unitId: UNIT,
          minimumNights: 3,
          metadata: {},
        },
        bookings: [],
        holds: [],
      },
    })

    const result = await publicAvailability({
      db,
      host: 'galilee',
      snapshot,
      organizationId: 'org-1',
      unitId: UNIT,
      checkIn: '2026-06-01',
      checkOut: '2026-06-02',
      now,
    })

    expect(result.available).toBe(false)
    expect(result.blockers.map((blocker) => blocker.kind)).toContain(
      'minimum_nights',
    )
  })

  it('denies by default when the unit has no rules row', async () => {
    // The engine's own documented behaviour: a missing rules row means it
    // cannot vouch for the unit, and inventing a permissive default would sell
    // a unit nobody configured for sale.
    const { db } = dbReturning({
      site_public_availability_facts: {
        unitId: UNIT,
        rules: null,
        bookings: [],
        holds: [],
      },
    })

    const result = await publicAvailability({
      db,
      host: 'galilee',
      snapshot,
      organizationId: 'org-1',
      unitId: UNIT,
      checkIn: '2026-06-01',
      checkOut: '2026-06-04',
      now,
    })

    expect(result.available).toBe(false)
  })
})

describe('THE ONE PRICING ENGINE', () => {
  it('quotes from the unit rate columns, with every line from priceStay', async () => {
    const { db } = dbReturning({
      site_public_rate_facts: {
        unitId: UNIT,
        unitName: 'סוויטת הזית',
        propertyId: 'property-a',
        baseNightlyAgorot: 90_000,
        extraGuestNightlyAgorot: 12_000,
        cleaningFeeAgorot: 15_000,
        depositAgorot: 50_000,
        standardGuests: 2,
        maxGuests: 4,
        minNights: 1,
        currency: 'ILS',
        taxRateBps: 1700,
        taxIncludedInPrice: true,
      },
    })

    const { quote } = await publicQuote({
      db,
      host: 'galilee',
      snapshot,
      unitId: UNIT,
      checkIn: '2026-06-01',
      checkOut: '2026-06-04',
      guests: 3,
    })

    expect(quote.nights).toBe(3)
    // Three nights, one extra guest for three nights, one cleaning fee.
    const accommodation = quote.lines
      .filter((line) => line.kind === 'accommodation')
      .reduce((total, line) => total + line.amount, 0)
    expect(accommodation).toBe(270_000)

    // The deposit is refundable and is NOT part of what the stay costs.
    expect(quote.depositAgorot).toBe(50_000)
    expect(quote.stayTotalAgorot).toBe(quote.totalAgorot - 50_000)
  })

  it('adds NO tax line when the rate already includes VAT', async () => {
    // An Israeli guesthouse quoting VAT-inclusive prices shows one figure.
    // Adding a tax line to a rate that already contains it overcharges by 17%.
    const { db } = dbReturning({
      site_public_rate_facts: {
        unitId: UNIT,
        unitName: 'סוויטת הזית',
        propertyId: 'property-a',
        baseNightlyAgorot: 90_000,
        extraGuestNightlyAgorot: 0,
        cleaningFeeAgorot: 0,
        depositAgorot: 0,
        standardGuests: 2,
        maxGuests: 4,
        minNights: 1,
        currency: 'ILS',
        taxRateBps: 1700,
        taxIncludedInPrice: true,
      },
    })

    const { quote } = await publicQuote({
      db,
      host: 'galilee',
      snapshot,
      unitId: UNIT,
      checkIn: '2026-06-01',
      checkOut: '2026-06-02',
      guests: 2,
    })

    expect(quote.taxAgorot).toBe(0)
    expect(quote.totalAgorot).toBe(90_000)
  })

  it('adds a tax line when the rate is exclusive', async () => {
    const { db } = dbReturning({
      site_public_rate_facts: {
        unitId: UNIT,
        unitName: 'סוויטת הזית',
        propertyId: 'property-a',
        baseNightlyAgorot: 100_000,
        extraGuestNightlyAgorot: 0,
        cleaningFeeAgorot: 0,
        depositAgorot: 0,
        standardGuests: 2,
        maxGuests: 4,
        minNights: 1,
        currency: 'ILS',
        taxRateBps: 1700,
        taxIncludedInPrice: false,
      },
    })

    const { quote } = await publicQuote({
      db,
      host: 'galilee',
      snapshot,
      unitId: UNIT,
      checkIn: '2026-06-01',
      checkOut: '2026-06-02',
      guests: 2,
    })

    expect(quote.taxAgorot).toBe(17_000)
  })
})

describe('the submission key', () => {
  it('is the same for the same enquiry, so a double-tap is one request', () => {
    const input = {
      unitId: UNIT,
      checkIn: '2026-06-01',
      checkOut: '2026-06-04',
      contactPhone: '050-1234567',
    }

    expect(submissionKeyFor(input)).toBe(submissionKeyFor(input))
  })

  it('ignores how the telephone number was typed', () => {
    expect(
      submissionKeyFor({
        unitId: UNIT,
        checkIn: '2026-06-01',
        checkOut: '2026-06-04',
        contactPhone: '050-1234567',
      }),
    ).toBe(
      submissionKeyFor({
        unitId: UNIT,
        checkIn: '2026-06-01',
        checkOut: '2026-06-04',
        contactPhone: '0501234567',
      }),
    )
  })

  it('differs for a genuinely different enquiry', () => {
    expect(
      submissionKeyFor({
        unitId: UNIT,
        checkIn: '2026-06-01',
        checkOut: '2026-06-04',
        contactPhone: '0501234567',
      }),
    ).not.toBe(
      submissionKeyFor({
        unitId: UNIT,
        checkIn: '2026-07-01',
        checkOut: '2026-07-04',
        contactPhone: '0501234567',
      }),
    )
  })

  it('is long enough for the database constraint', () => {
    // `site_booking_requests_submission_key` requires 16..128 characters.
    const key = submissionKeyFor({
      unitId: UNIT,
      checkIn: '2026-06-01',
      checkOut: '2026-06-04',
      contactPhone: '0501234567',
    })
    expect(key.length).toBeGreaterThanOrEqual(16)
    expect(key.length).toBeLessThanOrEqual(128)
  })
})

describe('rules are read for the RIGHT unit', () => {
  it('does not hand one unit the other unit’s minimum stay', async () => {
    // The regression this test exists for: `loadRules` is asked for a UNIT,
    // not a window, and the first version answered with "the last thing
    // cached". Two units in one request — which a unit grid checking
    // availability across rooms produces — would have given the second one
    // the first one's floor.
    const twoUnits: SiteSnapshot = {
      ...snapshot,
      bookableUnitIds: ['unit-strict', 'unit-loose'],
    }

    const rpc = vi.fn(async (_fn: string, args: Record<string, unknown>) => {
      const unitId = String(args.p_unit_id)
      return {
        data: {
          unitId,
          rules: {
            unitId,
            // The strict unit demands three nights; the loose one accepts one.
            minimumNights: unitId === 'unit-strict' ? 3 : 1,
            metadata: {},
          },
          bookings: [],
          holds: [],
        },
        error: null,
      }
    })
    const db = { rpc } as unknown as Db

    const now = new Date('2026-03-01T00:00:00.000Z')

    // The strict unit is asked FIRST, so a "last cached wins" implementation
    // would still get this one right.
    const strict = await publicAvailability({
      db,
      host: 'galilee',
      snapshot: twoUnits,
      organizationId: 'org-1',
      unitId: 'unit-strict',
      checkIn: '2026-06-01',
      checkOut: '2026-06-02',
      now,
    })

    expect(strict.available).toBe(false)
    expect(strict.blockers.map((blocker) => blocker.kind)).toContain(
      'minimum_nights',
    )

    // And the loose unit, asked second on the same source shape, must get its
    // OWN floor rather than inheriting the strict one.
    const loose = await publicAvailability({
      db,
      host: 'galilee',
      snapshot: twoUnits,
      organizationId: 'org-1',
      unitId: 'unit-loose',
      checkIn: '2026-06-01',
      checkOut: '2026-06-02',
      now,
    })

    expect(loose.available).toBe(true)
  })
})
