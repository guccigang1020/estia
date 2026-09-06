/**
 * Which column is which.
 *
 * ── The step that decides whether a migration happens ─────────────────────
 *
 * Everything else in this module is arithmetic. This is the part where a
 * person sits in front of twenty-four columns out of a product they are
 * leaving and tells ESTIA what each one means. Get it wrong and three years of
 * bookings arrive with the departure date in the arrival column, which is not
 * a bug anybody notices until a guest turns up.
 *
 * Two things follow from that, and they are the whole design of this file.
 *
 * **A suggestion is a suggestion.** `suggestMappings` proposes, and a person
 * confirms. It never silently commits — a header called "Date" is genuinely
 * ambiguous and the machine has no business deciding whether it is the arrival
 * or the booking date. Where it is unsure it proposes nothing, which puts an
 * empty select in front of somebody rather than a wrong answer they will not
 * re-read.
 *
 * **A mapping is saved against the shape of the file, not the file.** A monthly
 * top-up export out of the same PMS has the same header row, so the same
 * signature, so the same mapping is offered without a single click. An import
 * that demands the same twenty-four decisions every month is an import that is
 * run once.
 *
 * ── The signature ─────────────────────────────────────────────────────────
 *
 * A digest of the normalised header, order included. Order is part of it on
 * purpose: two exports with the same column names in a different order are
 * different shapes, and a mapping applied positionally across them would be
 * silently wrong. The names are matched by name here, so the order-sensitivity
 * costs a re-map in a rare case and prevents a catastrophic one in a rarer one.
 */

import { fingerprint } from '../service/idempotency'
import {
  ENTITY_FIELDS,
  IMPORT_FIELDS,
  type FieldMapping,
  type ImportEntity,
  type ImportField,
  type SavedMapping,
  type SourceFormat,
} from './types'

/* ---------------------------------------------------------------- labels -- */

export const IMPORT_FIELD_LABEL: Readonly<Record<ImportField, string>> = {
  externalId: 'מזהה במערכת הקודמת',
  fullName: 'שם מלא',
  phone: 'טלפון',
  email: 'אימייל',
  city: 'עיר',
  notes: 'הערות',
  legalName: 'שם משפטי',
  taxId: 'ח.פ. / עוסק',
  propertyName: 'שם הנכס',
  slug: 'מזהה באתר',
  propertyType: 'סוג הנכס',
  checkInTime: 'שעת כניסה',
  checkOutTime: 'שעת יציאה',
  minNights: 'מינימום לילות',
  taxRatePercent: 'מע״מ באחוזים',
  description: 'תיאור',
  unitName: 'שם היחידה',
  unitCode: 'קוד היחידה',
  capacity: 'תפוסה מרבית',
  bedrooms: 'חדרי שינה',
  language: 'שפה',
  nationality: 'אזרחות',
  tags: 'תוויות',
  marketingConsent: 'הסכמה לדיוור',
  guestName: 'שם האורח',
  guestPhone: 'טלפון האורח',
  guestEmail: 'אימייל האורח',
  checkIn: 'תאריך הגעה',
  checkOut: 'תאריך עזיבה',
  guestCount: 'מספר אורחים',
  adults: 'מבוגרים',
  children: 'ילדים',
  infants: 'תינוקות',
  status: 'סטטוס',
  source: 'מקור ההזמנה',
  totalAgorot: 'סכום ההזמנה',
  depositAgorot: 'פיקדון',
  fromDate: 'מתאריך',
  toDate: 'עד תאריך',
  reason: 'סיבה',
  nightlyAgorot: 'מחיר ללילה',
  sharePercent: 'אחוז בעלות',
  agencyName: 'שם הסוכנות',
  commissionPercent: 'אחוז עמלה',
  subject: 'נושא',
  body: 'תוכן',
  author: 'נכתב על ידי',
  createdAt: 'נוצר בתאריך',
}

/* --------------------------------------------------------------- aliases -- */

/**
 * The header names real exports actually use.
 *
 * Hebrew first, because the file will have come out of a Hebrew system, and
 * English after it because half of them are English regardless. The list is
 * long and boring by design: every name missing from it is a column an operator
 * has to map by hand, and the point of this file is that they do not.
 *
 * Matched after normalisation — case, punctuation, the Hebrew geresh and the
 * various dashes are all stripped by `normalizeHeader` — so `Check-in`,
 * `check in` and `CHECK_IN` are one entry rather than three.
 */
const FIELD_ALIASES: Readonly<Record<ImportField, readonly string[]>> = {
  externalId: ['מזהה', 'מספר הזמנה', 'אסמכתא', 'id', 'external id',
    'reference', 'confirmation code', 'booking id', 'reservation id', 'uid'],
  fullName: ['שם', 'שם מלא', 'name', 'full name', 'contact name'],
  phone: ['טלפון', 'נייד', 'phone', 'mobile', 'telephone', 'phone number'],
  email: ['אימייל', 'מייל', 'דואל', 'email', 'e mail', 'email address'],
  city: ['עיר', 'ישוב', 'city', 'town'],
  notes: ['הערות', 'הערה', 'notes', 'note', 'comments', 'remarks'],
  legalName: ['שם משפטי', 'שם החברה', 'legal name', 'company name'],
  taxId: ['חפ', 'עוסק מורשה', 'מספר עוסק', 'tax id', 'vat number'],
  propertyName: ['נכס', 'שם הנכס', 'property', 'property name', 'listing',
    'listing name'],
  slug: ['מזהה באתר', 'כתובת באתר', 'slug', 'url', 'handle'],
  propertyType: ['סוג הנכס', 'סוג', 'property type', 'type'],
  checkInTime: ['שעת כניסה', 'check in time', 'checkin time'],
  checkOutTime: ['שעת יציאה', 'check out time', 'checkout time'],
  minNights: ['מינימום לילות', 'לילות מינימום', 'min nights',
    'minimum nights', 'minimum stay'],
  taxRatePercent: ['מעמ', 'אחוז מעמ', 'vat', 'tax rate', 'tax percent'],
  description: ['תיאור', 'description', 'about'],
  unitName: ['יחידה', 'שם היחידה', 'חדר', 'unit', 'unit name', 'room',
    'room name', 'apartment', 'accommodation'],
  unitCode: ['קוד יחידה', 'מקט יחידה', 'unit code', 'room code'],
  capacity: ['תפוסה', 'תפוסה מרבית', 'capacity', 'max guests', 'sleeps'],
  bedrooms: ['חדרי שינה', 'חדרים', 'bedrooms', 'rooms'],
  language: ['שפה', 'language', 'locale'],
  nationality: ['אזרחות', 'לאום', 'מדינה', 'nationality', 'country'],
  tags: ['תוויות', 'תגיות', 'tags', 'labels'],
  marketingConsent: ['הסכמה לדיוור', 'דיוור', 'marketing consent',
    'newsletter', 'opt in'],
  guestName: ['שם האורח', 'אורח', 'guest', 'guest name', 'booked by',
    'customer', 'customer name'],
  guestPhone: ['טלפון האורח', 'guest phone', 'customer phone'],
  guestEmail: ['אימייל האורח', 'guest email', 'customer email'],
  checkIn: ['תאריך הגעה', 'הגעה', 'כניסה', 'מתאריך', 'check in', 'checkin',
    'arrival', 'start date', 'from', 'dtstart'],
  checkOut: ['תאריך עזיבה', 'עזיבה', 'יציאה', 'עד תאריך', 'check out',
    'checkout', 'departure', 'end date', 'to', 'dtend'],
  guestCount: ['מספר אורחים', 'אורחים', 'guests', 'number of guests', 'pax',
    'guest count'],
  adults: ['מבוגרים', 'adults'],
  children: ['ילדים', 'children', 'kids'],
  infants: ['תינוקות', 'infants', 'babies'],
  status: ['סטטוס', 'מצב', 'status', 'state', 'booking status'],
  source: ['מקור', 'ערוץ', 'source', 'channel', 'platform'],
  totalAgorot: ['סכום', 'סהכ', 'מחיר', 'total', 'amount', 'total price',
    'price'],
  depositAgorot: ['פיקדון', 'מקדמה', 'deposit', 'prepayment'],
  fromDate: ['מתאריך', 'התחלה', 'from', 'from date', 'start', 'start date'],
  toDate: ['עד תאריך', 'סיום', 'to', 'to date', 'end', 'end date'],
  reason: ['סיבה', 'reason', 'block reason'],
  nightlyAgorot: ['מחיר ללילה', 'תעריף', 'nightly', 'nightly rate', 'rate',
    'price per night'],
  sharePercent: ['אחוז בעלות', 'אחוז', 'share', 'ownership percent'],
  agencyName: ['סוכנות', 'שם הסוכנות', 'agency', 'agency name'],
  commissionPercent: ['עמלה', 'אחוז עמלה', 'commission', 'commission percent'],
  subject: ['נושא', 'כותרת', 'subject', 'title'],
  body: ['תוכן', 'גוף', 'body', 'content', 'text'],
  author: ['נכתב על ידי', 'מחבר', 'author', 'created by', 'user'],
  createdAt: ['נוצר בתאריך', 'תאריך', 'created at', 'created', 'date'],
}

/**
 * A header cell, reduced to the thing worth comparing.
 *
 * The Hebrew geresh and gershayim are stripped alongside the Latin quotes,
 * because `מק״ט` and `מקט` are one word typed two ways and a lookup table that
 * held both would need to hold every other pair too. Bidirectional control
 * marks go as well: a right-to-left interface round-trips a header through an
 * RTL run and the invisible mark that comes back matches nothing — the same
 * failure `agents/phone.ts` documents for telephone numbers, arriving here.
 */
export function normalizeHeader(header: string): string {
  let kept = ''
  for (const character of header) {
    const point = character.codePointAt(0) ?? -1
    if (BIDI_CONTROL_POINTS.has(point)) continue
    kept += character
  }

  return kept
    .replace(/["'׳״`]/g, '')
    .replace(/[_\-./\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * The invisible marks a right-to-left interface puts inside a header.
 *
 * Written as code points rather than inside a character class, following
 * `agents/phone.ts`: an invisible character in a regular expression literal is
 * a line no reviewer can check, and this is the same failure arriving at a
 * different field. A header carrying a stray RTL mark matches no alias and
 * lands the operator on an empty select with no explanation.
 */
const BIDI_CONTROL_POINTS: ReadonlySet<number> = new Set([
  0x200e, // left-to-right mark
  0x200f, // right-to-left mark
  0x202a, // left-to-right embedding
  0x202b, // right-to-left embedding
  0x202c, // pop directional formatting
  0x202d, // left-to-right override
  0x202e, // right-to-left override
  0x2066, // left-to-right isolate
  0x2067, // right-to-left isolate
  0x2068, // first strong isolate
  0x2069, // pop directional isolate
  0xfeff, // zero width no-break space, i.e. a BOM mid-string
])

/**
 * The field this header names, or `null`.
 *
 * Exact match after normalisation, and nothing else. Fuzzy matching was
 * considered and rejected: the cost of a near-miss here is the departure date
 * in the arrival column, and a person confirming an empty select is cheap while
 * a person confirming a plausible wrong answer is not.
 */
export function fieldForHeader(
  header: string,
  entity: ImportEntity,
): ImportField | null {
  const normalized = normalizeHeader(header)
  if (normalized.length === 0) return null

  const allowed = ENTITY_FIELDS[entity]

  for (const field of allowed) {
    const aliases = FIELD_ALIASES[field]
    if (aliases.some((alias) => normalizeHeader(alias) === normalized)) {
      return field
    }
  }

  return null
}

/**
 * A proposed mapping for every column in the file.
 *
 * Every column appears, including the ones nothing matched — a column mapped to
 * `null` is visible and ignorable, while a column omitted from the list is a
 * column the operator never finds out was dropped.
 *
 * A field claimed by an earlier column is not offered to a later one. Two
 * columns feeding one field is not a mapping, it is a coin toss, and the first
 * match wins because the first match is the one the operator saw first.
 */
export function suggestMappings(
  columns: readonly string[],
  entity: ImportEntity,
): readonly FieldMapping[] {
  const taken = new Set<ImportField>()

  return columns.map((column) => {
    const field = fieldForHeader(column, entity)
    if (field === null || taken.has(field)) return { column, field: null }
    taken.add(field)
    return { column, field }
  })
}

/* ------------------------------------------------------------- signature -- */

/**
 * The shape of this file's header, as one string.
 *
 * Normalised so that a re-export with different capitalisation is the same
 * shape, and ordered so that the same names in a different order are not. See
 * the file header for why that asymmetry is the safe one.
 */
export function headerSignature(
  columns: readonly string[],
  entity: ImportEntity,
): string {
  return fingerprint({
    entity,
    columns: columns.map(normalizeHeader),
  })
}

/**
 * The saved mapping that fits this file, or `null`.
 *
 * Matched on the signature and on the entity together. A guest sheet and a
 * booking sheet out of the same product can share a header row — both have
 * `Name`, `Phone`, `Email` — and applying the guest mapping to the bookings
 * would silently import eight hundred stays with no dates.
 */
export function findSavedMapping(
  saved: readonly SavedMapping[],
  columns: readonly string[],
  entity: ImportEntity,
): SavedMapping | null {
  const signature = headerSignature(columns, entity)
  return (
    saved.find(
      (candidate) =>
        candidate.signature === signature && candidate.entity === entity,
    ) ?? null
  )
}

/**
 * A saved mapping, laid over the columns this file actually has.
 *
 * Not applied blindly. A saved mapping names columns; if the export gained a
 * column since it was saved, that column appears here unmapped rather than
 * being dropped, and if it lost one, the missing entry simply does not appear.
 * Both are visible on the mapping screen, which is where a person notices that
 * their PMS changed its export.
 */
export function applySavedMapping(
  saved: SavedMapping,
  columns: readonly string[],
): readonly FieldMapping[] {
  const byColumn = new Map<string, ImportField | null>()
  for (const mapping of saved.mappings) {
    byColumn.set(normalizeHeader(mapping.column), mapping.field)
  }

  return columns.map((column) => ({
    column,
    field: byColumn.get(normalizeHeader(column)) ?? null,
  }))
}

/**
 * A mapping ready to be saved.
 *
 * The signature is computed here rather than taken from the caller, so a saved
 * row cannot claim to describe a header it does not describe.
 */
export function toSavedMapping(args: {
  id: string
  organizationId: string
  name: string
  entity: ImportEntity
  sourceFormat: SourceFormat
  columns: readonly string[]
  mappings: readonly FieldMapping[]
}): SavedMapping {
  return {
    id: args.id,
    organizationId: args.organizationId,
    name: args.name,
    entity: args.entity,
    sourceFormat: args.sourceFormat,
    signature: headerSignature(args.columns, args.entity),
    mappings: args.mappings,
  }
}

/* ---------------------------------------------------------------- lookup -- */

/**
 * The mapped values of one row, keyed by ESTIA field.
 *
 * Unmapped columns are dropped here and not before, which is what makes the
 * mapping step reversible: the parsed rows still hold every original cell, so
 * changing one select and re-running costs nothing and re-reads the file from
 * memory.
 */
export function mappedValues(
  cells: Readonly<Record<string, string>>,
  mappings: readonly FieldMapping[],
): Readonly<Partial<Record<ImportField, string>>> {
  const values: Partial<Record<ImportField, string>> = {}

  for (const mapping of mappings) {
    if (mapping.field === null) continue
    const value = cells[mapping.column]
    if (value === undefined) continue
    const trimmed = value.trim()
    if (trimmed.length === 0) continue
    values[mapping.field] = trimmed
  }

  return values
}

/** Which fields a given entity may legitimately be mapped to. For the screen. */
export function fieldsFor(entity: ImportEntity): readonly ImportField[] {
  return ENTITY_FIELDS[entity]
}

/** Every field, for a screen that lists them all. Order matches the catalogue. */
export const ALL_IMPORT_FIELDS: readonly ImportField[] = IMPORT_FIELDS
