/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Direct booking, from the public site.
 *
 * ── There is exactly one availability truth and this screen uses it ───────
 *
 * Every "free" or "taken" on this page comes from `checkAvailability` in
 * `src/lib/booking/availability.ts`, reached through `publicAvailability`.
 * Every figure comes from `priceStay` in `src/lib/booking/pricing.ts`, reached
 * through `publicQuote`. This file contains no overlap test, no minimum-nights
 * arithmetic and no multiplication.
 *
 * ── And it cannot quote a draft ──────────────────────────────────────────
 *
 * The unit list is `snapshot.bookableUnitIds` — the PUBLISHED snapshot's own
 * list, fixed at publish time. A unit added to a draft page is not in it, both
 * `publicAvailability` and the SQL function behind it refuse it, and the
 * refusal is checked before the engine is asked anything.
 *
 * ── An enquiry, not a booking ────────────────────────────────────────────
 *
 * The form sends a request. It does not create a booking and does not place a
 * hold: a visitor with no account cannot hold a night, and the exclusion
 * constraint that actually prevents a double booking lives behind the
 * operation layer with an actor. The page says so, in Hebrew, rather than
 * implying a confirmation nobody made.
 */

import { notFound } from 'next/navigation'

import { BookingEnquiry } from '@/components/website/booking-enquiry'
import {
  publicAvailability,
  publicQuote,
  type PublicRateFacts,
} from '@/lib/website'
import type { AvailabilityResult, StayQuote } from '@/lib/booking'
import { createClient } from '@/lib/supabase/server'

import { loadPublicSite } from '../_lib/load'
import { submitEnquiry } from '../_lib/actions'

export const metadata = {
  title: 'בדיקת זמינות',
  // A booking form is not a page for a search index, and its query string
  // carries somebody's chosen dates.
  robots: { index: false, follow: true },
}

export default async function PublicBookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams])

  let site: Awaited<ReturnType<typeof loadPublicSite>>
  try {
    site = await loadPublicSite(slug)
  } catch {
    notFound()
  }

  const snapshot = site.snapshot
  const unitId = first(query.unit) ?? snapshot.bookableUnitIds[0] ?? null
  const checkIn = first(query.from)
  const checkOut = first(query.to)
  const guests = Number(first(query.guests) ?? '2')

  // Names for the unit picker, read out of the snapshot's own claims rather
  // than from the units table. The published document is self-contained and
  // this page does not reach past it.
  const unitNames = unitNamesFrom(snapshot)

  let availability: AvailabilityResult | null = null
  let quote: StayQuote | null = null
  let facts: PublicRateFacts | null = null
  let failure: string | null = null

  if (unitId && checkIn && checkOut) {
    const db = await createClient()
    try {
      availability = await publicAvailability({
        db,
        host: snapshot.slug,
        snapshot,
        organizationId: '',
        unitId,
        checkIn,
        checkOut,
        now: new Date(),
      })

      // Priced only when the dates are actually available. Showing a total for
      // nights somebody cannot have is the shape of a quote that gets argued
      // about later.
      if (availability.available) {
        const priced = await publicQuote({
          db,
          host: snapshot.slug,
          snapshot,
          unitId,
          checkIn,
          checkOut,
          guests: Number.isFinite(guests) ? guests : 2,
        })
        quote = priced.quote
        facts = priced.facts
      }
    } catch (cause) {
      // A refusal from the public path carries its own Hebrew sentence. An
      // unexpected failure gets a neutral one — a visitor cannot act on a
      // correlation id.
      failure =
        cause &&
        typeof cause === 'object' &&
        'userMessage' in cause &&
        typeof (cause as { userMessage: unknown }).userMessage === 'string'
          ? (cause as { userMessage: string }).userMessage
          : 'לא הצלחנו לבדוק זמינות כרגע. נסו שוב בעוד רגע.'
    }
  }

  return (
    <BookingEnquiry
      slug={snapshot.slug}
      units={snapshot.bookableUnitIds.map((id) => ({
        id,
        name: unitNames.get(id) ?? 'יחידה',
      }))}
      selectedUnitId={unitId}
      checkIn={checkIn ?? null}
      checkOut={checkOut ?? null}
      guests={Number.isFinite(guests) ? guests : 2}
      availability={availability}
      quote={quote}
      maxGuests={facts?.maxGuests ?? null}
      failure={failure}
      action={submitEnquiry}
    />
  )
}

function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

/**
 * Unit names, from the snapshot's claims.
 *
 * `factsForSection` writes unit claims as `unit.name.<unitId>`, so the name of
 * a bookable unit is already in the published document if any section shows
 * it. A unit that is bookable but named nowhere falls back to "יחידה" rather
 * than sending this page to the units table — reaching past the snapshot is
 * the one thing the public path must not do.
 */
function unitNamesFrom(
  snapshot: Awaited<ReturnType<typeof loadPublicSite>>['snapshot'],
): ReadonlyMap<string, string> {
  const names = new Map<string, string>()

  for (const claim of snapshot.factManifest) {
    if (claim.source !== 'unit') continue
    if (!claim.key.startsWith('unit.name.')) continue
    names.set(claim.key.slice('unit.name.'.length), claim.text)
  }

  return names
}
