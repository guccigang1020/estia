/**
 * EXECUTION CONTEXT — SHARED. Imported by the browser and by the Server Action.
 *
 * The rules a workspace has to satisfy before anything is written, expressed
 * once. The wizard uses them to disable a button and to put a Hebrew sentence
 * under a control; `actions.ts` uses the same functions again on the server,
 * against the same input, before it opens a connection.
 *
 * That second run is not belt-and-braces, it is the only one that counts. A
 * Server Action is a POST, and a POST does not have to come from the form —
 * every constraint here is therefore re-decided server-side, and the client
 * half exists so a person is told about a problem before they submit rather
 * than after.
 *
 * The functions return `FieldIssue[]` — the same shape `ValidationError`
 * carries and `ActionError` already renders — so a refusal reaches the screen
 * attached to the control that caused it instead of as one sentence at the top
 * that names none of them.
 *
 * Nothing here invents a value. Where a field has no safe default the rule is
 * "required", not "fill it in for them": a check-out time nobody chose is a
 * time a guest will eventually be held to.
 */

import type { FieldIssue } from '@/lib/errors'

/* ------------------------------------------------------------ vocabulary -- */

/** `organization_business_type`, verified against the live enum. */
export const BUSINESS_TYPES = [
  'zimmer',
  'villa',
  'apartment',
  'boutique_hotel',
  'hostel',
  'complex',
  'management_company',
  'other',
] as const

export type BusinessType = (typeof BUSINESS_TYPES)[number]

export const BUSINESS_TYPE_LABEL: Record<BusinessType, string> = {
  zimmer: 'צימר',
  villa: 'וילה',
  apartment: 'דירה',
  boutique_hotel: 'מלון בוטיק',
  hostel: 'הוסטל',
  complex: 'מתחם',
  management_company: 'חברת ניהול',
  other: 'אחר',
}

/**
 * `property_type`. A near-twin of the business type and deliberately not the
 * same enum — a management company runs villas, so the business and the place
 * are two different answers.
 */
export const PROPERTY_TYPES = [
  'zimmer',
  'villa',
  'apartment',
  'boutique_hotel',
  'hostel',
  'complex',
  'camping',
  'other',
] as const

export type PropertyType = (typeof PROPERTY_TYPES)[number]

export const PROPERTY_TYPE_LABEL: Record<PropertyType, string> = {
  zimmer: 'צימר',
  villa: 'וילה',
  apartment: 'דירה',
  boutique_hotel: 'מלון בוטיק',
  hostel: 'הוסטל',
  complex: 'מתחם',
  camping: 'קמפינג',
  other: 'אחר',
}

/** `unit_type`. */
export const UNIT_TYPES = [
  'room',
  'suite',
  'studio',
  'apartment',
  'cabin',
  'villa',
  'dorm_bed',
  'tent',
  'pitch',
  'other',
] as const

export type UnitType = (typeof UNIT_TYPES)[number]

export const UNIT_TYPE_LABEL: Record<UnitType, string> = {
  room: 'חדר',
  suite: 'סוויטה',
  studio: 'סטודיו',
  apartment: 'דירה',
  cabin: 'בקתה',
  villa: 'וילה',
  dorm_bed: 'מיטה בחדר משותף',
  tent: 'אוהל',
  pitch: 'מגרש',
  other: 'אחר',
}

/**
 * The time zones an Israeli accommodation business plausibly operates in.
 *
 * A full IANA list is 600 entries and makes the common answer harder to find.
 * These are offered; the column takes any string, so widening the list later
 * costs nothing and no data written now becomes wrong.
 */
export const TIMEZONES = [
  'Asia/Jerusalem',
  'Europe/Nicosia',
  'Europe/Athens',
  'Europe/London',
  'America/New_York',
  'UTC',
] as const

export const DEFAULT_TIMEZONE = 'Asia/Jerusalem'

/**
 * Currency and locale are fixed for now, and honestly so. Every price in the
 * schema is agorot and every screen in the product is Hebrew; offering a
 * chooser that writes `EUR` into `organizations.currency` would offer a
 * setting nothing downstream honours.
 */
export const FIXED_CURRENCY = 'ILS'
export const FIXED_LOCALE = 'he-IL'
export const FIXED_COUNTRY = 'IL'

/* ------------------------------------------------------------------ slug -- */

/** `organizations_slug_format`, copied from 0001 rather than approximated. */
export const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
export const SLUG_MIN = 2
export const SLUG_MAX = 63

/**
 * A slug suggestion from a name.
 *
 * Latin letters and digits survive, everything else becomes a separator. A
 * Hebrew name therefore produces an EMPTY string, and that is the correct
 * answer rather than a failure: there is no defensible transliteration of
 * "וילה הגליל" into a URL, and inventing one would put a word on the person's
 * public address that they never chose. The field is required, the suggestion
 * is blank, and they type what they want.
 */
export function slugify(value: string): string {
  return (
    value
      .normalize('NFKD')
      // Strip combining marks so "Café" suggests "cafe" instead of "caf".
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SLUG_MAX)
      .replace(/-+$/g, '')
  )
}

/* ------------------------------------------------------------- utilities -- */

const issue = (
  field: string,
  code: string,
  message: string,
  label: string,
): FieldIssue => ({ field, code, message, label })

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** `HH:MM`, which is what `<input type="time">` produces and `time` accepts. */
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

/**
 * Shekels as typed, into agorot as stored.
 *
 * Returns `null` for anything that is not a plain non-negative amount with at
 * most two decimals — including `1e3`, `-5`, `12.345` and the empty string.
 * Rounding is done on a string, not on a float: `Math.round(139.9 * 100)` is
 * the classic way to store 13989 agorot and then argue with an accountant.
 */
export function shekelsToAgorot(value: string): number | null {
  const text = value.trim().replace(/,/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null

  const [whole, fraction = ''] = text.split('.')
  const agorot = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))

  return Number.isSafeInteger(agorot) ? agorot : null
}

/** The inverse, for putting a stored price back into a form. */
export function agorotToShekels(agorot: number): string {
  return (agorot / 100).toFixed(2)
}

/* --------------------------------------------------------- organization -- */

export type OrganizationDraft = {
  name: string
  slug: string
  businessType: string
  timezone: string
}

export const ORGANIZATION_FIELD_LABEL = {
  name: 'שם העסק',
  slug: 'כתובת המרחב',
  businessType: 'סוג העסק',
  timezone: 'אזור זמן',
} as const

export function validateOrganization(
  draft: OrganizationDraft,
): readonly FieldIssue[] {
  const issues: FieldIssue[] = []
  const label = ORGANIZATION_FIELD_LABEL

  const name = trimmed(draft.name)
  if (name.length === 0) {
    issues.push(issue('name', 'required', 'יש להזין שם עסק.', label.name))
  } else if (name.length > 120) {
    issues.push(
      issue('name', 'too_long', 'שם העסק ארוך מ־120 תווים.', label.name),
    )
  }

  const slug = trimmed(draft.slug)
  if (slug.length === 0) {
    issues.push(
      issue(
        'slug',
        'required',
        'יש להזין כתובת באותיות לטיניות. זו הכתובת שתופיע בקישורים, ולכן היא לא נגזרת אוטומטית משם בעברית.',
        label.slug,
      ),
    )
  } else if (slug.length < SLUG_MIN || slug.length > SLUG_MAX) {
    issues.push(
      issue(
        'slug',
        'length',
        `אורך הכתובת חייב להיות בין ${SLUG_MIN} ל־${SLUG_MAX} תווים.`,
        label.slug,
      ),
    )
  } else if (!SLUG_PATTERN.test(slug)) {
    issues.push(
      issue(
        'slug',
        'format',
        'הכתובת יכולה להכיל אותיות לטיניות קטנות, ספרות ומקפים בלבד, ולהתחיל ולהסתיים באות או בספרה.',
        label.slug,
      ),
    )
  }

  if (!isBusinessType(draft.businessType)) {
    issues.push(
      issue(
        'businessType',
        'invalid',
        'יש לבחור סוג עסק מהרשימה.',
        label.businessType,
      ),
    )
  }

  if (trimmed(draft.timezone).length === 0) {
    issues.push(
      issue('timezone', 'required', 'יש לבחור אזור זמן.', label.timezone),
    )
  }

  return issues
}

export function isBusinessType(value: unknown): value is BusinessType {
  return (
    typeof value === 'string' &&
    (BUSINESS_TYPES as readonly string[]).includes(value)
  )
}

export function isPropertyType(value: unknown): value is PropertyType {
  return (
    typeof value === 'string' &&
    (PROPERTY_TYPES as readonly string[]).includes(value)
  )
}

export function isUnitType(value: unknown): value is UnitType {
  return (
    typeof value === 'string' &&
    (UNIT_TYPES as readonly string[]).includes(value)
  )
}

/* -------------------------------------------------------------- property -- */

export type PropertyDraft = {
  name: string
  propertyType: string
  addressLine1: string
  city: string
  checkInTime: string
  checkOutTime: string
  cancellationPolicyText: string
}

export const PROPERTY_FIELD_LABEL = {
  name: 'שם הנכס',
  propertyType: 'סוג הנכס',
  addressLine1: 'כתובת',
  city: 'עיר או יישוב',
  checkInTime: 'שעת כניסה',
  checkOutTime: 'שעת יציאה',
  cancellationPolicyText: 'מדיניות ביטול',
} as const

export function validateProperty(draft: PropertyDraft): readonly FieldIssue[] {
  const issues: FieldIssue[] = []
  const label = PROPERTY_FIELD_LABEL

  const name = trimmed(draft.name)
  if (name.length === 0) {
    issues.push(issue('name', 'required', 'יש להזין שם לנכס.', label.name))
  } else if (name.length > 120) {
    issues.push(
      issue('name', 'too_long', 'שם הנכס ארוך מ־120 תווים.', label.name),
    )
  }

  if (!isPropertyType(draft.propertyType)) {
    issues.push(
      issue(
        'propertyType',
        'invalid',
        'יש לבחור סוג נכס מהרשימה.',
        label.propertyType,
      ),
    )
  }

  if (trimmed(draft.addressLine1).length === 0) {
    issues.push(
      issue(
        'addressLine1',
        'required',
        'יש להזין כתובת. היא מופיעה על חשבונית ובאישור ההזמנה.',
        label.addressLine1,
      ),
    )
  }

  if (trimmed(draft.city).length === 0) {
    issues.push(issue('city', 'required', 'יש להזין עיר או יישוב.', label.city))
  }

  if (!TIME_PATTERN.test(trimmed(draft.checkInTime))) {
    issues.push(
      issue(
        'checkInTime',
        'invalid',
        'שעת כניסה חייבת להיות בפורמט שעה תקין.',
        label.checkInTime,
      ),
    )
  }

  if (!TIME_PATTERN.test(trimmed(draft.checkOutTime))) {
    issues.push(
      issue(
        'checkOutTime',
        'invalid',
        'שעת יציאה חייבת להיות בפורמט שעה תקין.',
        label.checkOutTime,
      ),
    )
  }

  // Deliberately NOT "check-out must precede check-in". They are times of day
  // on two different days: 15:00 in and 11:00 out is the normal case, and a
  // late-checkout suite at 18:00 is a real one. There is no ordering rule to
  // enforce here, and inventing one would refuse a correct entry.

  const policy = trimmed(draft.cancellationPolicyText)
  if (policy.length === 0) {
    issues.push(
      issue(
        'cancellationPolicyText',
        'required',
        'יש לנסח מדיניות ביטול. זה הטקסט שהאורח מאשר, ולכן אי אפשר למלא אותו במקומך.',
        label.cancellationPolicyText,
      ),
    )
  } else if (policy.length > 2000) {
    issues.push(
      issue(
        'cancellationPolicyText',
        'too_long',
        'מדיניות הביטול ארוכה מ־2000 תווים.',
        label.cancellationPolicyText,
      ),
    )
  }

  return issues
}

/* ------------------------------------------------------------------ unit -- */

export type UnitDraft = {
  name: string
  unitType: string
  /** `units.max_guests`. */
  capacity: string
  bedrooms: string
  bathrooms: string
  /** Shekels as typed. Converted to agorot before it reaches the database. */
  basePrice: string
  deposit: string
}

export const UNIT_FIELD_LABEL = {
  name: 'שם היחידה',
  unitType: 'סוג היחידה',
  capacity: 'תפוסה מרבית',
  bedrooms: 'חדרי שינה',
  bathrooms: 'חדרי רחצה',
  basePrice: 'מחיר לילה',
  deposit: 'פיקדון',
} as const

/** Mirrors `units_max_guests_positive` and the sanity ceiling above it. */
const MAX_GUESTS_CEILING = 64
const BEDROOMS_CEILING = 50
const BATHROOMS_CEILING = 50
/** 1,000,000 shekels a night. A ceiling that catches a misplaced decimal. */
const PRICE_CEILING_AGOROT = 100_000_000

function wholeNumber(value: string): number | null {
  const text = value.trim()
  if (!/^\d+$/.test(text)) return null
  const parsed = Number(text)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/** `units.bathrooms` is `numeric(3,1)`: one decimal place, and 99.9 at most. */
function halfNumber(value: string): number | null {
  const text = value.trim()
  if (!/^\d{1,2}(\.\d)?$/.test(text)) return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

export function validateUnit(draft: UnitDraft): readonly FieldIssue[] {
  const issues: FieldIssue[] = []
  const label = UNIT_FIELD_LABEL

  const name = trimmed(draft.name)
  if (name.length === 0) {
    issues.push(issue('name', 'required', 'יש להזין שם ליחידה.', label.name))
  } else if (name.length > 120) {
    issues.push(
      issue('name', 'too_long', 'שם היחידה ארוך מ־120 תווים.', label.name),
    )
  }

  if (!isUnitType(draft.unitType)) {
    issues.push(
      issue(
        'unitType',
        'invalid',
        'יש לבחור סוג יחידה מהרשימה.',
        label.unitType,
      ),
    )
  }

  const capacity = wholeNumber(draft.capacity)
  if (capacity === null || capacity < 1) {
    issues.push(
      issue(
        'capacity',
        'invalid',
        'תפוסה מרבית חייבת להיות מספר שלם, אחד לפחות.',
        label.capacity,
      ),
    )
  } else if (capacity > MAX_GUESTS_CEILING) {
    issues.push(
      issue(
        'capacity',
        'too_large',
        `תפוסה מרבית גדולה מ־${MAX_GUESTS_CEILING} אינה סבירה ליחידה אחת.`,
        label.capacity,
      ),
    )
  }

  const bedrooms = wholeNumber(draft.bedrooms)
  if (bedrooms === null) {
    issues.push(
      issue(
        'bedrooms',
        'invalid',
        'חדרי שינה חייבים להיות מספר שלם. סטודיו הוא 0.',
        label.bedrooms,
      ),
    )
  } else if (bedrooms > BEDROOMS_CEILING) {
    issues.push(
      issue(
        'bedrooms',
        'too_large',
        `מספר חדרי השינה גדול מ־${BEDROOMS_CEILING}.`,
        label.bedrooms,
      ),
    )
  }

  const bathrooms = halfNumber(draft.bathrooms)
  if (bathrooms === null) {
    issues.push(
      issue(
        'bathrooms',
        'invalid',
        'חדרי רחצה חייבים להיות מספר עם עד ספרה אחת אחרי הנקודה, למשל 1.5.',
        label.bathrooms,
      ),
    )
  } else if (bathrooms > BATHROOMS_CEILING) {
    issues.push(
      issue(
        'bathrooms',
        'too_large',
        `מספר חדרי הרחצה גדול מ־${BATHROOMS_CEILING}.`,
        label.bathrooms,
      ),
    )
  }

  const basePrice = shekelsToAgorot(draft.basePrice)
  if (basePrice === null) {
    issues.push(
      issue(
        'basePrice',
        'invalid',
        'מחיר לילה חייב להיות סכום בשקלים, עם עד שתי ספרות אחרי הנקודה.',
        label.basePrice,
      ),
    )
  } else if (basePrice > PRICE_CEILING_AGOROT) {
    issues.push(
      issue(
        'basePrice',
        'too_large',
        'מחיר הלילה חורג מהתחום הסביר. בדוק את מיקום הנקודה העשרונית.',
        label.basePrice,
      ),
    )
  }

  const deposit = shekelsToAgorot(draft.deposit)
  if (deposit === null) {
    issues.push(
      issue(
        'deposit',
        'invalid',
        'פיקדון חייב להיות סכום בשקלים. אם אינך גובה פיקדון, הזן 0.',
        label.deposit,
      ),
    )
  } else if (deposit > PRICE_CEILING_AGOROT) {
    issues.push(
      issue(
        'deposit',
        'too_large',
        'הפיקדון חורג מהתחום הסביר. בדוק את מיקום הנקודה העשרונית.',
        label.deposit,
      ),
    )
  }

  return issues
}

/**
 * The numbers a validated unit draft carries, parsed once.
 *
 * Returns `null` when the draft does not validate, so a caller cannot get
 * halfway through a write on input the rules above would have refused.
 */
export function parseUnitDraft(draft: UnitDraft): {
  maxGuests: number
  bedrooms: number
  bathrooms: number
  basePriceAgorot: number
  depositAgorot: number
} | null {
  if (validateUnit(draft).length > 0) return null

  const maxGuests = wholeNumber(draft.capacity)
  const bedrooms = wholeNumber(draft.bedrooms)
  const bathrooms = halfNumber(draft.bathrooms)
  const basePriceAgorot = shekelsToAgorot(draft.basePrice)
  const depositAgorot = shekelsToAgorot(draft.deposit)

  if (
    maxGuests === null ||
    bedrooms === null ||
    bathrooms === null ||
    basePriceAgorot === null ||
    depositAgorot === null
  ) {
    return null
  }

  return { maxGuests, bedrooms, bathrooms, basePriceAgorot, depositAgorot }
}

/* ------------------------------------------------------------------ next -- */

/**
 * Where to send someone after onboarding, when they arrived from a deep link.
 *
 * Only a path inside this application is honoured. `//evil.example` is a
 * protocol-relative URL that browsers resolve to another origin, and a
 * `?next=` that accepts one turns this screen into an open redirect that
 * borrows the product's credibility to land somebody on a phishing page. A
 * backslash is refused for the same reason: some browsers normalise `/\` to
 * `//`.
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  if (!value.startsWith('/')) return null
  if (value.startsWith('//') || value.startsWith('/\\')) return null
  return value
}
