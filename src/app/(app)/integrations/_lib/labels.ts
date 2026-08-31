/**
 * Hebrew wording for the services this business leaves traces of.
 *
 * ── Nothing here is a catalogue of integrations ───────────────────────────
 *
 * These are labels for *values that appeared in rows*, not a list of services
 * the product supports. `SERVICE_LABEL` is looked up through `labelOr`, so a
 * provider nobody has named here renders as its own stored string rather than
 * disappearing — which is the correct behaviour when the set is open. A
 * business that switches to a processor this file has never heard of gets a
 * screen that says its name.
 *
 * The booking channels are the exception and are total over `BOOKING_SOURCES`,
 * because that one *is* a closed enum in the contract. The wording matches
 * `SOURCE_LABEL` on the booking detail screen deliberately: two Hebrew names
 * for `booking_com` in one product is how a person starts wondering whether
 * they are two different things.
 */

import type { BookingSource } from '@/lib/booking'

import type { IntegrationKind } from './queries'

/** The heading each section carries. */
export const KIND_LABEL: Record<IntegrationKind, string> = {
  payment_provider: 'סליקה ותשלומים',
  invoice_provider: 'הפקת מסמכים',
  booking_channel: 'ערוצי מכירה',
}

/** What the section is actually reading, said out loud. */
export const KIND_EVIDENCE: Record<IntegrationKind, string> = {
  payment_provider:
    'נגזר מעמודות provider ו-provider_payment_id בטבלת התשלומים — מי חייב את הכרטיס ואיך הוא קרא לעסקה.',
  invoice_provider:
    'נגזר מעמודות provider ו-provider_invoice_id בטבלת החשבוניות — מי הפיק את המסמך שרשות המסים תראה.',
  booking_channel:
    'נגזר מעמודת source בכל הזמנה. היא נרשמת מהמיגרציה הראשונה, כי מחלוקת על עמלה מול טבלה שאינה יודעת מי מכר אינה ניתנת ליישוב.',
}

/**
 * Names for providers this deployment has actually used.
 *
 * Latin names stay Latin: Cardcom and Green Invoice are how the businesses
 * themselves are written on an Israeli invoice, and transliterating them into
 * Hebrew would make them harder to match against a bank statement.
 */
export const SERVICE_LABEL: Readonly<Record<string, string>> = {
  cardcom: 'Cardcom',
  greeninvoice: 'Green Invoice',
  tranzila: 'Tranzila',
  pelecard: 'PeleCard',
  icount: 'iCount',
  in_memory: 'ספק בדיקה מקומי',
}

/** Total over `BookingSource`, matching the booking detail screen word for word. */
export const CHANNEL_LABEL: Record<BookingSource, string> = {
  direct_website: 'אתר ישיר',
  direct_manual: 'ידני — טלפון, וואטסאפ או מקום',
  agent: 'סוכן',
  agency: 'סוכנות',
  airbnb: 'Airbnb',
  booking_com: 'Booking.com',
  vrbo: 'Vrbo',
  other_channel: 'ערוץ אחר',
}

/**
 * The channels that are not third parties at all.
 *
 * `direct_manual` is a person at a desk and `agent` is a member of this
 * organization with a narrow role. Both are legitimate sources and neither is
 * an integration, so they are marked rather than counted as connected
 * services — otherwise the screen reports that a business taking every booking
 * by telephone has one integration running.
 */
export const NOT_A_THIRD_PARTY: ReadonlySet<string> = new Set([
  'direct_manual',
  'agent',
])

/** A label for a value the database returned that this file does not know. */
export function labelOr<T extends string>(
  labels: Record<T, string>,
  value: string,
): string {
  return value in labels ? labels[value as T] : value
}
