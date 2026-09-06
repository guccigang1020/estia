/**
 * Hebrew for the register's vocabularies.
 *
 * `Record<Field, string>` rather than a lookup with a fallback, for the reason
 * `fiscal/labels.ts` gives: adding a field without a Hebrew word for it should
 * fail the type check rather than render an identifier to a guesthouse owner.
 *
 * `FIELD_HELP` says what a field is *for*, in the operator's own terms, and
 * never why they might have to keep it. This module does not know that, and a
 * help string is exactly where an invented requirement would slip in dressed
 * as guidance.
 */

import type { GuestBookEntryStatus, GuestBookField } from './types'

export const GUEST_BOOK_FIELD_LABEL: Record<GuestBookField, string> = {
  booking_reference: 'אסמכתת הזמנה',
  property: 'נכס',
  primary_guest_name: 'שם האורח הראשי',
  guest_address: 'כתובת האורח',
  arrival: 'תאריך ושעת הגעה',
  departure: 'תאריך ושעת עזיבה',
  guest_count: 'מספר אורחים',
  financial_document: 'אסמכתה חשבונאית',
  notes: 'הערות',
}

export const GUEST_BOOK_FIELD_HELP: Record<GuestBookField, string> = {
  booking_reference: 'מקשר את הרישום להזמנה במערכת.',
  property: 'הנכס שבו התארחו.',
  primary_guest_name: 'האדם שעל שמו נרשמה השהייה.',
  guest_address: 'כתובת המגורים של האורח, כפי שמסר אותה.',
  arrival: 'שעת ההגעה נרשמת בפועל בעת הצ׳ק-אין, ולא לפי השעה המשוערת בהזמנה.',
  departure: 'מועד סיום השהייה.',
  guest_count: 'כמה אנשים שהו בפועל.',
  financial_document: 'מספר החשבונית או הקבלה שהופקה עבור השהייה.',
  notes: 'כל דבר נוסף שהעסק בוחר לתעד.',
}

export const GUEST_BOOK_STATUS_LABEL: Record<GuestBookEntryStatus, string> = {
  expected: 'צפוי',
  arrived: 'שוהה',
  departed: 'עזב',
  cancelled: 'בוטל',
}
