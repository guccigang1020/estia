/**
 * Hebrew for a booking source.
 *
 * A display label, not a definition. `BOOKING_SOURCES` is the vocabulary and
 * lives in `src/lib/booking/types.ts`; what a hotelier calls each one is a
 * property of this screen, and every screen that shows a source already keeps
 * its own wording — `integrations/_lib/labels.ts` says "אתר ישיר", the leads
 * screen says "האתר של העסק", and both are right for where they sit.
 *
 * The `Record` is exhaustive over `BookingSource`, so a source added to the
 * domain fails the build here rather than rendering as a raw enum value in the
 * middle of a Hebrew sentence.
 */

import type { BookingSource } from '@/lib/booking/types'

const SOURCE_LABEL: Readonly<Record<BookingSource, string>> = {
  direct_website: 'האתר של העסק',
  direct_manual: 'הזמנה ישירה שנרשמה בעסק',
  agent: 'סוכן',
  agency: 'סוכנות',
  airbnb: 'Airbnb',
  booking_com: 'Booking.com',
  vrbo: 'Vrbo',
  other_channel: 'ערוץ אחר',
}

export function sourceLabel(source: BookingSource): string {
  return SOURCE_LABEL[source] ?? source
}
