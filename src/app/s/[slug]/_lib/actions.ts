'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTION. The one write a stranger can perform.
 *
 * ── What it is not ───────────────────────────────────────────────────────
 *
 * Not a booking. It writes one row to `site_booking_requests` through
 * `site_public_booking_request`, which is SECURITY DEFINER and touches neither
 * `bookings` nor `holds`. A visitor with no account cannot hold a night; the
 * exclusion constraint that prevents a double booking is reached through
 * `defineBookingOperations` with an actor, and a person confirms this enquiry
 * through the ordinary booking screen.
 *
 * ── Why it is not a `defineOperation` ────────────────────────────────────
 *
 * Because the pipeline's first step is `assertCan(actor, ...)` and there is no
 * actor. A visitor holds no membership, no role and no `auth.uid()`. Forcing
 * this through the operation layer would mean inventing a synthetic actor,
 * which is how a public endpoint acquires permissions nobody granted it. The
 * same reasoning `src/lib/store/operations.ts` gives for keeping the guest's
 * own order submission out of its pipeline.
 *
 * What it does have instead: validation in the SQL function, a bounded set of
 * columns, an idempotency key derived from the enquiry, and a table whose
 * INSERT is reachable no other way — `site_booking_requests` has no INSERT
 * policy at all.
 *
 * ── Never a thrown error ─────────────────────────────────────────────────
 *
 * A throw inside a Server Action reaches the browser as a digest and a blank
 * screen. Every failure becomes a Hebrew sentence a visitor can act on.
 */

import {
  sendBookingRequest,
  submissionKeyFor,
  type PublicSite,
} from '@/lib/website'
import { createClient } from '@/lib/supabase/server'

export type EnquiryResult =
  { ok: true; deduplicated: boolean } | { ok: false; message: string }

export type EnquiryInput = {
  slug: string
  unitId: string
  checkIn: string
  checkOut: string
  adults: number
  children: number
  infants: number
  contactName: string
  contactPhone: string
  contactEmail: string
  message: string
  /** What the visitor was shown, in agorot. Stored as a snapshot. */
  quotedTotalAgorot: number | null
}

export async function submitEnquiry(
  input: EnquiryInput,
): Promise<EnquiryResult> {
  // Shaped before anything is sent. The SQL refuses these too and is the real
  // floor; this is so a person reads a sentence about their form.
  const name = input.contactName.trim()
  const phone = input.contactPhone.trim()

  if (name.length < 2) {
    return { ok: false, message: 'צריך שם כדי שנדע למי לחזור.' }
  }
  if (phone.replace(/\D/g, '').length < 6) {
    return { ok: false, message: 'צריך מספר טלפון תקין כדי לחזור אליכם.' }
  }
  if (!input.unitId) {
    return { ok: false, message: 'בחרו יחידה.' }
  }
  if (!input.checkIn || !input.checkOut || input.checkOut <= input.checkIn) {
    return { ok: false, message: 'תאריך העזיבה חייב להיות מאוחר מתאריך ההגעה.' }
  }

  try {
    const db = await createClient()

    const result = await sendBookingRequest({
      db,
      host: input.slug,
      unitId: input.unitId,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      adults: input.adults,
      children: input.children,
      infants: input.infants,
      contactName: name,
      contactPhone: phone,
      contactEmail: input.contactEmail.trim() || null,
      message: input.message.trim() || null,
      quotedTotalAgorot: input.quotedTotalAgorot,
      // Derived from the enquiry, not generated per render: a random key
      // changes on every re-render, which makes it useless for the case it
      // exists for. Two identical submissions are one request.
      submissionKey: submissionKeyFor({
        unitId: input.unitId,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        contactPhone: phone,
      }),
    })

    return { ok: true, deduplicated: result.deduplicated }
  } catch (cause) {
    const message =
      cause &&
      typeof cause === 'object' &&
      'userMessage' in cause &&
      typeof (cause as { userMessage: unknown }).userMessage === 'string'
        ? (cause as { userMessage: string }).userMessage
        : 'לא הצלחנו לשלוח את הבקשה. נסו שוב בעוד רגע.'

    // Logged server-side so a failing public form is visible to the operator.
    // The visitor's own details are NOT logged — a telephone number in a log
    // outlives the enquiry.
    console.error('[website] public enquiry failed', {
      slug: input.slug,
      unitId: input.unitId,
      cause,
    })

    return { ok: false, message }
  }
}

/** Re-exported for the page's type annotation without widening its imports. */
export type { PublicSite }
