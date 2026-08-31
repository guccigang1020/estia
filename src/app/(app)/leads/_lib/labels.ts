/**
 * Hebrew wording for where a sale came from, and for why inventory is held.
 *
 * ── This is the third copy, and it is the first total one ─────────────────
 *
 * `src/components/booking/create-booking-form.tsx` has a private
 * `Record<BookingSource, string>` listing only the sources a person may pick by
 * hand, and `src/app/(app)/bookings/[bookingId]/page.tsx` has a private
 * `Record<string, string>` — which is not total over the enum and therefore
 * renders `undefined` for a source nobody remembered. Neither is exported, and
 * neither file belongs to this work.
 *
 * The record below is `Record<BookingSource, string>` over `BOOKING_SOURCES`,
 * so a source added to the contract fails the build here rather than shipping
 * `vrbo` at a Hebrew screen. It is a finding rather than a solution: the three
 * should collapse into one, and it belongs in `src/lib/booking` beside
 * `BOOKING_STATUS_LABEL` where the domain already keeps its own wording.
 *
 * `HOLD_REASON_LABEL` has no copy anywhere; nothing has ever rendered a hold.
 */

import { type BookingSource, type HoldReason } from '@/lib/booking/types'

/** `public.booking_source`, 0009. Where the stay came from. */
export const BOOKING_SOURCE_LABEL: Record<BookingSource, string> = {
  direct_website: 'האתר של העסק',
  direct_manual: 'פנייה ישירה — טלפון או מייל',
  agent: 'סוכן',
  agency: 'סוכנות',
  airbnb: 'Airbnb',
  booking_com: 'Booking.com',
  vrbo: 'Vrbo',
  other_channel: 'ערוץ אחר',
}

/**
 * Which sources are the business's own.
 *
 * Used to label a lead, never to compute a share: `direct_booking_share` is a
 * metric with a definition in `src/lib/metrics` and a grant of its own, and a
 * second definition here would be a second answer to the same question.
 */
export const DIRECT_SOURCES: readonly BookingSource[] = [
  'direct_website',
  'direct_manual',
]

/**
 * `public.hold_reason`, 0009. Why inventory is off sale without a booking.
 *
 * `maintenance_block` is deliberately worded as a fact about the unit rather
 * than about a sale: it is the one reason on this list that is not somebody
 * closing a deal, and a screen about the pipeline has to say so or it reads as
 * a lead that never existed.
 */
export const HOLD_REASON_LABEL: Record<HoldReason, string> = {
  agent_quote: 'סוכן שמחזיק תאריך להצעה',
  guest_checkout: 'אורח באמצע תשלום באתר',
  staff_manual: 'החזקה ידנית של הצוות',
  maintenance_block: 'חסימה לתחזוקה — לא מכירה',
}
