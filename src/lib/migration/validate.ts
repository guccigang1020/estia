/**
 * Every row, judged on its own, in a sentence somebody can act on.
 *
 * ── The rule this file exists to enforce ──────────────────────────────────
 *
 * Never "שורה 412 אינה תקינה". That message ends migrations: the operator opens
 * their spreadsheet, looks at row 412, sees a booking that appears completely
 * ordinary, and concludes the product cannot read their data. Every issue here
 * therefore carries four things — the row, the column *as their file names it*,
 * the value *as they typed it*, and what to do — because the fifth thing, the
 * reason it is actually wrong, is usually invisible until you see the other
 * four side by side.
 *
 * ── Rows fail one at a time ───────────────────────────────────────────────
 *
 * A file is never rejected as a whole. `inventory/import.ts` argues this and it
 * is more true here, at three orders of magnitude more rows: an import that
 * stops on the first bad row makes a person fix one thing, re-upload, and
 * discover the next one. Eighteen hundred rows and forty problems is four
 * afternoons that way and one screen this way.
 *
 * ── The date ambiguity, which is the real hazard ──────────────────────────
 *
 * `03/04/2026` is the 3rd of April to an Israeli operator and the 4th of March
 * to an American product, and both readings are valid dates, so nothing in the
 * value itself reveals the mistake. Read it the wrong way and three years of
 * bookings land on plausible wrong days — the single most expensive silent
 * error this module can make.
 *
 * So the order is *decided once for the whole file*, from evidence, by
 * `inferDateOrder`: any value with a first component above twelve settles it
 * for every other row. Where the file offers no such evidence the assumption is
 * stated on the report as an `info` issue rather than made quietly, because an
 * operator who reads "התאריכים נקראו כיום/חודש/שנה" will correct it in two
 * seconds and one who is told nothing will not.
 *
 * ── Normalisation is not re-implementation ────────────────────────────────
 *
 * Telephone numbers go through `normalizePhone` from `src/lib/agents/phone.ts`,
 * which is the same function the agent network, the guest card and the database
 * generated column all agree on. A second normaliser here would be a second
 * definition of identity, and the day the two disagree is the day a returning
 * guest becomes two people.
 */

import { normalizePhone, PHONE_REJECTION_MESSAGE } from '../agents/phone'
import { fingerprint } from '../service/idempotency'
import { mappedValues } from './mapping'
import type {
  BlockedDateValues,
  BookingValues,
  FieldMapping,
  GuestValues,
  ImportEntity,
  ImportField,
  ImportRecord,
  ImportValues,
  NoteValues,
  OrganizationValues,
  PartyValues,
  PricingValues,
  PropertyValues,
  SourceRow,
  UnitValues,
  ValidationIssue,
} from './types'

/* ------------------------------------------------------------ the result -- */

export interface ValidationResult {
  records: readonly ImportRecord[]
  issues: readonly ValidationIssue[]
  /** How the dates in this file were read, and whether that was a guess. */
  dateOrder: DateOrder
  dateOrderInferred: boolean
}

export const DATE_ORDERS = ['dmy', 'mdy', 'ymd'] as const
export type DateOrder = (typeof DATE_ORDERS)[number]

export const DATE_ORDER_LABEL: Readonly<Record<DateOrder, string>> = {
  dmy: 'יום/חודש/שנה',
  mdy: 'חודש/יום/שנה',
  ymd: 'שנה-חודש-יום',
}

/* ------------------------------------------------------------------ dates -- */

const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})$/
const SLASHED = /^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})$/

/**
 * Which way round this file writes its dates.
 *
 * Decided by looking for a component that can only be a day. One value of
 * `13/04/2026` anywhere in eighteen hundred rows settles the whole file, and
 * that single piece of evidence is worth more than any locale setting, because
 * it came out of the operator's own data.
 *
 * With no evidence the answer is `dmy` — Israel, where this product is sold —
 * and the caller is told it was inferred so the screen can say so out loud.
 */
export function inferDateOrder(samples: readonly string[]): {
  order: DateOrder
  inferred: boolean
  /**
   * How many values could be read either way.
   *
   * Zero means the question never arose — a file written entirely in ISO has
   * no ambiguity, and warning about an assumption nobody made is noise on the
   * one screen that has to be read carefully.
   */
  ambiguous: number
} {
  let sawDayFirst = false
  let sawMonthFirst = false
  let ambiguous = 0

  for (const sample of samples) {
    const trimmed = sample.trim()
    if (ISO.test(trimmed)) continue

    const match = SLASHED.exec(trimmed)
    if (!match) continue

    const first = Number(match[1])
    const second = Number(match[2])
    if (match[1] !== undefined && match[1].length === 4) continue

    if (first > 12 && second <= 12) sawDayFirst = true
    else if (second > 12 && first <= 12) sawMonthFirst = true
    else ambiguous += 1
  }

  // Both seen means the file is internally inconsistent — two systems merged
  // into one sheet, usually. Israel's own order is chosen and the rows that
  // disagree will fail as impossible dates with their line numbers attached,
  // which is a far better outcome than half the file landing on wrong days.
  if (sawDayFirst) return { order: 'dmy', inferred: false, ambiguous }
  if (sawMonthFirst) return { order: 'mdy', inferred: false, ambiguous }
  return { order: 'dmy', inferred: true, ambiguous }
}

/** `2026-04-03`, or `null`. Never throws, never guesses past the order given. */
export function toIsoDate(raw: string, order: DateOrder): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  const iso = ISO.exec(trimmed)
  if (iso) return assemble(iso[1], iso[2], iso[3])

  const parts = SLASHED.exec(trimmed)
  if (!parts) return null

  const [, a, b, c] = parts
  if (a === undefined || b === undefined || c === undefined) return null

  if (a.length === 4 || order === 'ymd') return assemble(a, b, c)
  if (order === 'mdy') return assemble(c, a, b)
  return assemble(c, b, a)
}

/** Build the ISO string, refusing a day the calendar does not have. */
function assemble(
  year: string | undefined,
  month: string | undefined,
  day: string | undefined,
): string | null {
  if (year === undefined || month === undefined || day === undefined) {
    return null
  }

  const y = Number(year)
  const m = Number(month)
  const d = Number(day)
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return null
  }
  // A two-digit year is the one place a guess is unavoidable, and the window is
  // chosen for what this product imports: stay history and forward bookings.
  const fullYear = year.length === 2 ? 2000 + y : y
  if (fullYear < 1900 || fullYear > 2200) return null
  if (m < 1 || m > 12) return null

  const text =
    `${String(fullYear).padStart(4, '0')}-` +
    `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

  // The round trip catches 31 April, which every component-wise check admits.
  const parsed = new Date(`${text}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10) === text ? text : null
}

/* ------------------------------------------------------------------ money -- */

/**
 * Money as a person types it, in agorot.
 *
 * `₪1,250.50` and `1250.5` and `1,250` are all the same amount, and refusing
 * any of them refuses the file. The decimal point is the part worth being
 * careful about: `1250.5` is 125,050 agorot and not 1,250 agorot, and a parser
 * that dropped the fraction would import three years of revenue at a hundredth
 * of its value without a single error.
 */
export function toAgorot(raw: string): number | null {
  const cleaned = raw.replace(/[,\s₪$€]/g, '')
  if (cleaned.length === 0) return null
  const parsed = Number(cleaned)
  if (!Number.isFinite(parsed)) return null
  return Math.round(parsed * 100)
}

/** A plain count. Thousands separators tolerated; anything else refused. */
export function toCount(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]/g, '')
  if (cleaned.length === 0) return null
  const parsed = Number(cleaned)
  if (!Number.isFinite(parsed)) return null
  return Math.round(parsed)
}

/* ----------------------------------------------------------------- issues -- */

interface IssueContext {
  rowNumber: number
  entity: ImportEntity
  columnOf: (field: ImportField) => string | null
}

function issue(
  context: IssueContext,
  args: {
    severity: ValidationIssue['severity']
    code: ValidationIssue['code']
    field: ImportField | null
    value: string | null
    message: string
  },
): ValidationIssue {
  return {
    rowNumber: context.rowNumber,
    entity: context.entity,
    severity: args.severity,
    code: args.code,
    field: args.field,
    column: args.field === null ? null : context.columnOf(args.field),
    value: args.value,
    message: args.message,
  }
}

/* ------------------------------------------------------------ the reading -- */

export interface ValidateOptions {
  entity: ImportEntity
  mappings: readonly FieldMapping[]
  /** Left out to infer it from the file, which is what the screen does. */
  dateOrder?: DateOrder
  /** The organization's default language for a guest card. */
  defaultLanguage?: string
}

/**
 * Read every row, and say what is wrong with the ones that are.
 *
 * Pure: no clock, no client, no randomness. The same file and the same mapping
 * produce the same records and the same issues on every machine, which is what
 * lets the dry run be trusted as a preview of the apply.
 */
export function validateRows(
  rows: readonly SourceRow[],
  options: ValidateOptions,
): ValidationResult {
  const { entity, mappings } = options
  const columnOf = (field: ImportField): string | null =>
    mappings.find((mapping) => mapping.field === field)?.column ?? null

  const dateFields = mappings
    .filter((mapping) => isDateField(mapping.field))
    .map((mapping) => mapping.column)

  const samples: string[] = []
  for (const row of rows) {
    for (const column of dateFields) {
      const value = row.cells[column]
      if (value !== undefined && value.trim().length > 0) samples.push(value)
    }
  }

  const inference = inferDateOrder(samples)
  const dateOrder = options.dateOrder ?? inference.order
  const dateOrderInferred =
    options.dateOrder === undefined && inference.inferred

  const records: ImportRecord[] = []
  const issues: ValidationIssue[] = []

  // Only where the question actually arose. A file written entirely in ISO is
  // unambiguous, and an assumption nobody made is noise on the one screen that
  // has to be read carefully.
  if (dateOrderInferred && inference.ambiguous > 0) {
    issues.push({
      rowNumber: 0,
      entity,
      severity: 'info',
      code: 'date_order_assumed',
      field: null,
      column: null,
      value: null,
      message:
        'בקובץ אין תאריך שמכריע את סדר הרכיבים, ולכן הוא נקרא כ' +
        `${DATE_ORDER_LABEL[dateOrder]}. אם זה אינו הסדר הנכון — שנה אותו ` +
        'למעלה לפני ההרצה היבשה.',
    })
  }

  for (const row of rows) {
    const context: IssueContext = { rowNumber: row.rowNumber, entity, columnOf }
    const values = mappedValues(row.cells, mappings)
    const found: ValidationIssue[] = []

    const parsed = readEntity(entity, values, {
      context,
      dateOrder,
      defaultLanguage: options.defaultLanguage ?? 'he',
      report: (found_) => found.push(found_),
    })

    issues.push(...found)
    if (parsed === null) continue

    records.push({
      rowNumber: row.rowNumber,
      entity,
      sourceId: values.externalId ?? null,
      // The digest is over the *understood* record and not the raw row, so a
      // re-export with a renamed column or a reordered header is recognised as
      // the same record. Hashing the raw text would make every cosmetic change
      // in the source system look like eighteen hundred new bookings.
      contentHash: fingerprint(parsed),
      values: parsed,
    })
  }

  return { records, issues, dateOrder, dateOrderInferred }
}

function isDateField(field: ImportField | null): boolean {
  return (
    field === 'checkIn' ||
    field === 'checkOut' ||
    field === 'fromDate' ||
    field === 'toDate' ||
    field === 'createdAt'
  )
}

/* ------------------------------------------------------------ per entity -- */

interface ReadArgs {
  context: IssueContext
  dateOrder: DateOrder
  defaultLanguage: string
  report: (issue: ValidationIssue) => void
}

type Values = Readonly<Partial<Record<ImportField, string>>>

function readEntity(
  entity: ImportEntity,
  values: Values,
  args: ReadArgs,
): ImportValues | null {
  switch (entity) {
    case 'guests': {
      const guest = readGuest(values, args)
      return guest === null ? null : { entity: 'guests', guest }
    }
    case 'bookings': {
      const booking = readBooking(values, args)
      return booking === null ? null : { entity: 'bookings', booking }
    }
    case 'properties': {
      const property = readProperty(values, args)
      return property === null ? null : { entity: 'properties', property }
    }
    case 'units': {
      const unit = readUnit(values, args)
      return unit === null ? null : { entity: 'units', unit }
    }
    case 'blocked_dates': {
      const block = readBlock(values, args)
      return block === null ? null : { entity: 'blocked_dates', block }
    }
    case 'pricing': {
      const pricing = readPricing(values, args)
      return pricing === null ? null : { entity: 'pricing', pricing }
    }
    case 'owners': {
      const owner = readParty(values, args)
      return owner === null ? null : { entity: 'owners', owner }
    }
    case 'agents': {
      const agent = readParty(values, args)
      return agent === null ? null : { entity: 'agents', agent }
    }
    case 'notes': {
      const note = readNote(values, args)
      return note === null ? null : { entity: 'notes', note }
    }
    case 'organizations': {
      const organization = readOrganization(values, args)
      return organization === null
        ? null
        : { entity: 'organizations', organization }
    }
  }
}

/** A field that must be there, reported by name when it is not. */
function required(
  values: Values,
  field: ImportField,
  label: string,
  args: ReadArgs,
): string | null {
  const value = values[field]
  if (value !== undefined && value.length > 0) return value

  args.report(
    issue(args.context, {
      severity: 'error',
      code: 'missing_required',
      field,
      value: null,
      message:
        `חסר ${label}. זהו שדה חובה, והשורה לא תיובא בלעדיו. ` +
        'אם העמודה קיימת בקובץ — ודא שהיא ממופה בשלב המיפוי.',
    }),
  )
  return null
}

/**
 * A telephone number, or `null` with the reason said out loud.
 *
 * A bad number is a *warning* and not an error, and that choice is the whole
 * import policy in one line: a booking with an unreadable telephone number is
 * still a booking, and refusing the stay to protect the field would lose the
 * history this capability exists to move. The number is dropped, the row is
 * kept, and the report says which rows arrived without a contact.
 */
function readPhone(
  values: Values,
  field: ImportField,
  args: ReadArgs,
): string | null {
  const raw = values[field]
  if (raw === undefined) return null

  const normalized = normalizePhone(raw)
  if (normalized.ok) return normalized.e164

  args.report(
    issue(args.context, {
      severity: 'warning',
      code: 'phone_unreadable',
      field,
      value: raw,
      message:
        `מספר הטלפון ״${raw}״ לא נקרא: ` +
        `${PHONE_REJECTION_MESSAGE[normalized.reason]} ` +
        'השורה תיובא בלי מספר טלפון.',
    }),
  )
  return null
}

/** `guests_email_format` in 0009, copied rather than invented. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

function readEmail(
  values: Values,
  field: ImportField,
  args: ReadArgs,
): string | null {
  const raw = values[field]
  if (raw === undefined) return null
  if (EMAIL.test(raw)) return raw.toLowerCase()

  args.report(
    issue(args.context, {
      severity: 'warning',
      code: 'email_malformed',
      field,
      value: raw,
      message:
        `״${raw}״ אינה כתובת אימייל תקינה, והשורה תיובא בלעדיה. ` +
        'כתובת חייבת להכיל @ ונקודה אחריה.',
    }),
  )
  return null
}

function readDate(
  values: Values,
  field: ImportField,
  label: string,
  args: ReadArgs,
): string | null {
  const raw = values[field]
  if (raw === undefined) {
    args.report(
      issue(args.context, {
        severity: 'error',
        code: 'missing_required',
        field,
        value: null,
        message: `חסר ${label}. בלי שני התאריכים אי אפשר לקבוע שהות.`,
      }),
    )
    return null
  }

  const iso = toIsoDate(raw, args.dateOrder)
  if (iso !== null) return iso

  args.report(
    issue(args.context, {
      severity: 'error',
      code: 'not_a_date',
      field,
      value: raw,
      message:
        `״${raw}״ אינו תאריך שניתן לקרוא כ${DATE_ORDER_LABEL[args.dateOrder]}. ` +
        'פורמטים מקובלים: 2026-04-03, 03/04/2026, 3.4.2026.',
    }),
  )
  return null
}

function readNumber(
  values: Values,
  field: ImportField,
  label: string,
  args: ReadArgs,
  options: { money?: boolean } = {},
): number | null {
  const raw = values[field]
  if (raw === undefined) return null

  const parsed = options.money === true ? toAgorot(raw) : toCount(raw)
  if (parsed === null) {
    args.report(
      issue(args.context, {
        severity: 'warning',
        code: 'not_a_number',
        field,
        value: raw,
        message: `${label} ״${raw}״ אינו מספר, והשורה תיובא בלעדיו.`,
      }),
    )
    return null
  }

  if (parsed < 0) {
    args.report(
      issue(args.context, {
        severity: 'warning',
        code: 'negative_number',
        field,
        value: raw,
        message:
          `${label} שלילי (״${raw}״). סכום שלילי הוא זיכוי ולא הזמנה, ` +
          'והשדה יובא כריק.',
      }),
    )
    return null
  }

  return parsed
}

function readGuest(values: Values, args: ReadArgs): GuestValues | null {
  const fullName = required(values, 'fullName', 'שם מלא', args)
  if (fullName === null) return null

  const tags = values.tags
  const consent = values.marketingConsent

  return {
    externalId: values.externalId ?? null,
    fullName,
    phone: readPhone(values, 'phone', args),
    email: readEmail(values, 'email', args),
    language: values.language ?? args.defaultLanguage,
    nationality: readNationality(values, args),
    city: values.city ?? null,
    tags:
      tags === undefined
        ? []
        : [
            ...new Set(
              tags
                .split(/[,;|]/)
                .map((tag) => tag.trim())
                .filter((tag) => tag.length > 0),
            ),
          ],
    notes: values.notes ?? null,
    // Consent is the one field that defaults to *no* rather than to the file.
    // An import that turned marketing consent on because a column was blank
    // would be a legal problem with a delivery receipt.
    marketingConsent: consent !== undefined && isTruthy(consent),
  }
}

const ALPHA2 = /^[A-Z]{2}$/

function readNationality(values: Values, args: ReadArgs): string | null {
  const raw = values.nationality
  if (raw === undefined) return null

  const upper = raw.trim().toUpperCase()
  if (ALPHA2.test(upper)) return upper

  args.report(
    issue(args.context, {
      severity: 'warning',
      code: 'unknown_enum',
      field: 'nationality',
      value: raw,
      message:
        `אזרחות ״${raw}״ אינה קוד מדינה בן שתי אותיות לטיניות (כמו IL או FR), ` +
        'והשדה יובא כריק.',
    }),
  )
  return null
}

/** Hebrew and English affirmatives, because both appear in real exports. */
const TRUTHY: ReadonlySet<string> = new Set([
  'true', '1', 'yes', 'y', 'כן', 'אמת', 'v', 'x', '✓',
])

export function isTruthy(raw: string): boolean {
  return TRUTHY.has(raw.trim().toLowerCase())
}

function readBooking(values: Values, args: ReadArgs): BookingValues | null {
  const unitName = required(values, 'unitName', 'שם היחידה', args)
  const guestName = required(values, 'guestName', 'שם האורח', args)
  const checkIn = readDate(values, 'checkIn', 'תאריך הגעה', args)
  const checkOut = readDate(values, 'checkOut', 'תאריך עזיבה', args)

  if (
    unitName === null ||
    guestName === null ||
    checkIn === null ||
    checkOut === null
  ) {
    return null
  }

  if (checkOut <= checkIn) {
    args.report(
      issue(args.context, {
        severity: 'error',
        code: 'range_reversed',
        field: 'checkOut',
        value: `${checkIn} → ${checkOut}`,
        message:
          `תאריך העזיבה (${checkOut}) אינו מאוחר מתאריך ההגעה (${checkIn}). ` +
          'שהות של אפס לילות אינה שהות. אם התאריכים הפוכים בקובץ — החלף ' +
          'ביניהם במיפוי.',
      }),
    )
    return null
  }

  const guestCount = readNumber(values, 'guestCount', 'מספר האורחים', args)
  const adults = readNumber(values, 'adults', 'מספר המבוגרים', args)
  const children = readNumber(values, 'children', 'מספר הילדים', args)
  const infants = readNumber(values, 'infants', 'מספר התינוקות', args)

  const resolvedCount =
    guestCount !== null && guestCount > 0
      ? guestCount
      : (adults ?? 0) + (children ?? 0) + (infants ?? 0)

  if (resolvedCount <= 0) {
    args.report(
      issue(args.context, {
        severity: 'warning',
        code: 'missing_required',
        field: 'guestCount',
        value: null,
        message:
          'לא נמצא מספר אורחים ולא פירוט מבוגרים/ילדים, ולכן ההזמנה תיובא ' +
          'עם אורח אחד. אפשר לתקן אחרי הייבוא בכרטיס ההזמנה.',
      }),
    )
  }

  return {
    externalId: values.externalId ?? null,
    propertyName: values.propertyName ?? null,
    unitName,
    guestName,
    guestPhone: readPhone(values, 'guestPhone', args),
    guestEmail: readEmail(values, 'guestEmail', args),
    checkIn,
    checkOut,
    guestCount: resolvedCount > 0 ? resolvedCount : 1,
    adults,
    children,
    infants,
    status: values.status ?? null,
    source: values.source ?? null,
    totalAgorot: readNumber(values, 'totalAgorot', 'הסכום', args, {
      money: true,
    }),
    depositAgorot: readNumber(values, 'depositAgorot', 'הפיקדון', args, {
      money: true,
    }),
    notes: values.notes ?? null,
  }
}

const CLOCK = /^([01]?\d|2[0-3]):[0-5]\d$/

function readProperty(values: Values, args: ReadArgs): PropertyValues | null {
  const name = required(values, 'propertyName', 'שם הנכס', args)
  if (name === null) return null

  return {
    externalId: values.externalId ?? null,
    name,
    // Derived when absent, because a slug is an ESTIA concept and no other
    // product exports one. Latin-only, matching `properties_slug_format`; a
    // Hebrew name therefore yields an empty stem and the row is completed with
    // its row number rather than refused over a field nobody typed.
    slug: values.slug ?? slugFrom(name, args.context.rowNumber),
    propertyType: values.propertyType ?? 'villa',
    city: values.city ?? null,
    description: values.description ?? null,
    checkInTime: readClock(values, 'checkInTime', args) ?? '15:00',
    checkOutTime: readClock(values, 'checkOutTime', args) ?? '11:00',
    minNights: readNumber(values, 'minNights', 'מינימום הלילות', args) ?? 1,
    taxRatePercent:
      readNumber(values, 'taxRatePercent', 'שיעור המע״מ', args) ?? 0,
  }
}

function readClock(
  values: Values,
  field: ImportField,
  args: ReadArgs,
): string | null {
  const raw = values[field]
  if (raw === undefined) return null
  if (CLOCK.test(raw)) {
    const [hour, minute] = raw.split(':')
    if (hour === undefined || minute === undefined) return null
    return `${hour.padStart(2, '0')}:${minute}`
  }

  args.report(
    issue(args.context, {
      severity: 'warning',
      code: 'unknown_enum',
      field,
      value: raw,
      message: `״${raw}״ אינה שעה בפורמט HH:MM, ותשמש ברירת המחדל של הנכס.`,
    }),
  )
  return null
}

export function slugFrom(name: string, rowNumber: number): string {
  const stem = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return stem.length >= 2 ? stem.slice(0, 63) : `property-${rowNumber}`
}

function readUnit(values: Values, args: ReadArgs): UnitValues | null {
  const name = required(values, 'unitName', 'שם היחידה', args)
  if (name === null) return null

  return {
    externalId: values.externalId ?? null,
    propertyName: values.propertyName ?? null,
    name,
    code: values.unitCode ?? null,
    capacity: readNumber(values, 'capacity', 'התפוסה', args),
    bedrooms: readNumber(values, 'bedrooms', 'מספר חדרי השינה', args),
    nightlyAgorot: readNumber(values, 'nightlyAgorot', 'המחיר ללילה', args, {
      money: true,
    }),
    notes: values.notes ?? null,
  }
}

function readBlock(values: Values, args: ReadArgs): BlockedDateValues | null {
  const unitName = required(values, 'unitName', 'שם היחידה', args)
  const fromDate = readDate(values, 'fromDate', 'תאריך התחלה', args)
  const toDate = readDate(values, 'toDate', 'תאריך סיום', args)
  if (unitName === null || fromDate === null || toDate === null) return null

  if (toDate < fromDate) {
    args.report(
      issue(args.context, {
        severity: 'error',
        code: 'range_reversed',
        field: 'toDate',
        value: `${fromDate} → ${toDate}`,
        message: `תאריך הסיום (${toDate}) מוקדם מתאריך ההתחלה (${fromDate}).`,
      }),
    )
    return null
  }

  return {
    externalId: values.externalId ?? null,
    propertyName: values.propertyName ?? null,
    unitName,
    fromDate,
    toDate,
    reason: values.reason ?? null,
    notes: values.notes ?? null,
  }
}

function readPricing(values: Values, args: ReadArgs): PricingValues | null {
  const unitName = required(values, 'unitName', 'שם היחידה', args)
  const fromDate = readDate(values, 'fromDate', 'תאריך התחלה', args)
  const toDate = readDate(values, 'toDate', 'תאריך סיום', args)
  if (unitName === null || fromDate === null || toDate === null) return null

  const nightly = readNumber(values, 'nightlyAgorot', 'המחיר ללילה', args, {
    money: true,
  })
  if (nightly === null) {
    args.report(
      issue(args.context, {
        severity: 'error',
        code: 'missing_required',
        field: 'nightlyAgorot',
        value: values.nightlyAgorot ?? null,
        message: 'שורת תמחור בלי מחיר ללילה אינה תמחור.',
      }),
    )
    return null
  }

  return {
    externalId: values.externalId ?? null,
    propertyName: values.propertyName ?? null,
    unitName,
    fromDate,
    toDate,
    nightlyAgorot: nightly,
    minNights: readNumber(values, 'minNights', 'מינימום הלילות', args),
  }
}

function readParty(values: Values, args: ReadArgs): PartyValues | null {
  const fullName = required(values, 'fullName', 'שם מלא', args)
  if (fullName === null) return null

  return {
    externalId: values.externalId ?? null,
    fullName,
    phone: readPhone(values, 'phone', args),
    email: readEmail(values, 'email', args),
    propertyName: values.propertyName ?? null,
    agencyName: values.agencyName ?? null,
    percent:
      readNumber(values, 'sharePercent', 'אחוז הבעלות', args) ??
      readNumber(values, 'commissionPercent', 'אחוז העמלה', args),
    notes: values.notes ?? null,
  }
}

function readNote(values: Values, args: ReadArgs): NoteValues | null {
  const body = required(values, 'body', 'תוכן ההערה', args)
  if (body === null) return null

  const createdAt = values.createdAt
  return {
    externalId: values.externalId ?? null,
    subject: values.subject ?? null,
    body,
    author: values.author ?? null,
    createdAt:
      createdAt === undefined ? null : toIsoDate(createdAt, args.dateOrder),
    propertyName: values.propertyName ?? null,
    guestName: values.guestName ?? null,
  }
}

function readOrganization(
  values: Values,
  args: ReadArgs,
): OrganizationValues | null {
  const name = required(values, 'fullName', 'שם הארגון', args)
  if (name === null) return null

  return {
    externalId: values.externalId ?? null,
    name,
    legalName: values.legalName ?? null,
    taxId: values.taxId ?? null,
    phone: readPhone(values, 'phone', args),
    email: readEmail(values, 'email', args),
    city: values.city ?? null,
  }
}
