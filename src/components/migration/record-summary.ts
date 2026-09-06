/**
 * One record, in the words the operator would use for it.
 *
 * ── Why this exists at all ────────────────────────────────────────────────
 *
 * The dry run says 1,847 rows will be written. That number is worth exactly
 * nothing to somebody who cannot open it and see their own villa names and
 * their own guests' dates. So every count on these screens has a table under
 * it, and this file is what turns an `ImportValues` — a closed union of ten
 * shapes — into a heading and a handful of facts.
 *
 * ── Formatting only ──────────────────────────────────────────────────────
 *
 * Nothing here decides anything. It does not judge a record, does not compare
 * one to another, does not work out whether two guests are the same person and
 * does not know what a conflict is. It reads fields that `validate.ts` already
 * produced and joins them with separators. If a function in this file ever
 * needs to know a rule, the rule is in `src/lib/migration` and this file should
 * be calling it.
 *
 * ── Money is shown as the operator typed it, in shekels ───────────────────
 *
 * The domain holds integer agorot and never divides. A screen has to show a
 * price eventually, and this is the boundary where that happens: one place,
 * with the divisor visible, rather than `/ 100` scattered through six
 * components.
 */

import {
  IMPORT_ENTITY_LABEL,
  type ImportRecord,
  type ImportValues,
} from '@/lib/migration/types'

export type RecordFact = { label: string; value: string }

/** Agorot to a shekel string. The only division in the migration screens. */
export function shekels(agorot: number): string {
  return `${(agorot / 100).toLocaleString('he-IL', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ₪`
}

function orDash(value: string | null | undefined): string {
  return value === null || value === undefined || value.length === 0
    ? '—'
    : value
}

/**
 * The one line that identifies this record in a list.
 *
 * A guest is their name. A booking is the unit and the dates, because that is
 * how an operator finds a stay — not by the guest, of whom they have four
 * called Cohen.
 */
export function recordLabel(record: ImportRecord): string {
  const values = record.values

  switch (values.entity) {
    case 'organizations':
      return values.organization.name
    case 'properties':
      return values.property.name
    case 'units':
      return values.unit.name
    case 'guests':
      return values.guest.fullName
    case 'bookings':
      return `${values.booking.unitName} · ${values.booking.checkIn} → ${values.booking.checkOut}`
    case 'blocked_dates':
      return `${values.block.unitName} · ${values.block.fromDate} → ${values.block.toDate}`
    case 'pricing':
      return `${values.pricing.unitName} · ${values.pricing.fromDate} → ${values.pricing.toDate}`
    case 'owners':
      return values.owner.fullName
    case 'agents':
      return values.agent.fullName
    case 'notes':
      return orDash(values.note.subject)
  }
}

/**
 * The handful of facts worth showing beside the label.
 *
 * Deliberately short. A drill-down that reproduces the whole row is the
 * spreadsheet they already have open; what earns its place here is what ESTIA
 * *understood*, which is a different thing — a telephone number normalised to
 * E.164 is the field most worth checking, because it is the one that quietly
 * changed.
 */
export function recordFacts(values: ImportValues): readonly RecordFact[] {
  switch (values.entity) {
    case 'organizations':
      return [
        { label: 'שם משפטי', value: orDash(values.organization.legalName) },
        { label: 'ח.פ. / ע.מ.', value: orDash(values.organization.taxId) },
        { label: 'טלפון', value: orDash(values.organization.phone) },
      ]

    case 'properties':
      return [
        { label: 'כתובת באתר', value: values.property.slug },
        { label: 'סוג', value: values.property.propertyType },
        { label: 'עיר', value: orDash(values.property.city) },
        {
          label: 'צ׳ק אין / צ׳ק אאוט',
          value: `${values.property.checkInTime} / ${values.property.checkOutTime}`,
        },
      ]

    case 'units':
      return [
        { label: 'נכס', value: orDash(values.unit.propertyName) },
        { label: 'קוד', value: orDash(values.unit.code) },
        {
          label: 'תפוסה',
          value:
            values.unit.capacity === null ? '—' : String(values.unit.capacity),
        },
      ]

    case 'guests':
      return [
        { label: 'טלפון (מנורמל)', value: orDash(values.guest.phone) },
        { label: 'אימייל', value: orDash(values.guest.email) },
        { label: 'שפה', value: values.guest.language },
        {
          label: 'דיוור',
          value: values.guest.marketingConsent ? 'הסכים' : 'לא הסכים',
        },
      ]

    case 'bookings':
      return [
        { label: 'אורח', value: values.booking.guestName },
        { label: 'טלפון (מנורמל)', value: orDash(values.booking.guestPhone) },
        { label: 'אורחים', value: String(values.booking.guestCount) },
        { label: 'סטטוס במקור', value: orDash(values.booking.status) },
        {
          label: 'סכום',
          value:
            values.booking.totalAgorot === null
              ? '—'
              : shekels(values.booking.totalAgorot),
        },
      ]

    case 'blocked_dates':
      return [
        { label: 'נכס', value: orDash(values.block.propertyName) },
        { label: 'סיבה', value: orDash(values.block.reason) },
      ]

    case 'pricing':
      return [
        { label: 'מחיר ללילה', value: shekels(values.pricing.nightlyAgorot) },
        {
          label: 'מינימום לילות',
          value:
            values.pricing.minNights === null
              ? '—'
              : String(values.pricing.minNights),
        },
      ]

    case 'owners':
      return [
        { label: 'נכס', value: orDash(values.owner.propertyName) },
        {
          label: 'אחוז בעלות',
          value:
            values.owner.percent === null ? '—' : `${values.owner.percent}%`,
        },
        { label: 'טלפון', value: orDash(values.owner.phone) },
      ]

    case 'agents':
      return [
        { label: 'סוכנות', value: orDash(values.agent.agencyName) },
        {
          label: 'עמלה',
          value:
            values.agent.percent === null ? '—' : `${values.agent.percent}%`,
        },
        { label: 'טלפון', value: orDash(values.agent.phone) },
      ]

    case 'notes':
      return [
        { label: 'נכתב על ידי', value: orDash(values.note.author) },
        { label: 'נכס', value: orDash(values.note.propertyName) },
        { label: 'אורח', value: orDash(values.note.guestName) },
      ]
  }
}

/** The entity in Hebrew, for a table that mixes several. */
export function entityLabel(record: ImportRecord): string {
  return IMPORT_ENTITY_LABEL[record.entity]
}
