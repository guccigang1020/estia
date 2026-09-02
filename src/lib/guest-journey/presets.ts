/**
 * The three starting points, as data.
 *
 * ── A preset is a starting point, never a mode ────────────────────────────
 *
 * Nothing in this file locks anything. Applying a preset writes ordinary
 * values into `guest_journey_settings` and every one of them is editable the
 * second afterwards, with no memory anywhere that a preset was ever chosen.
 * That is deliberate and it is the difference between a product a business
 * grows into and one it has to escape: a "professional mode" that greys out
 * the contract switch is a decision somebody made for a customer they have
 * never met.
 *
 * ── Why the presets are data and not prose ────────────────────────────────
 *
 * A preset described in a paragraph is a preset that drifts from what the
 * button does. Here the paragraph IS the settings object, `resolvePreset`
 * turns it into exactly the row that will be written, and the screen renders
 * the difference from that same function. There is one answer to "what will
 * this change", and the operation and the confirmation dialogue both read it.
 *
 * ── EXECUTION CONTEXT — pure ──────────────────────────────────────────────
 *
 * No database, no clock, no Node builtins. A Client Component may import this
 * module directly, and must — importing `@/lib/guest-journey` instead drags
 * the Postgres driver into the browser bundle and every route 500s.
 *
 * ── What a preset deliberately does NOT touch ─────────────────────────────
 *
 * **Payment collection.** `src/lib/payments` owns what a guest must pay and
 * `resolveCollectionPolicy` is the one resolver for it. Each preset therefore
 * carries a *sentence* about the money — the one the business should go and
 * set next door — and applying a preset writes nothing into
 * `payment_collection_settings`. A preset that quietly switched on a deposit
 * would be a second answer to "what must a guest pay", arriving from a screen
 * that is not the payments screen.
 *
 * **The words a guest reads.** Directions, a door code, the wifi password:
 * those are facts about a house, they live in `guest_journey_content`, and no
 * preset can invent them.
 */

import type { PaymentCollectionPolicy } from '../contracts/states'

import {
  GUEST_ARRIVAL_RELEASE_LABEL,
  GUEST_DETAIL_FIELD_LABEL,
  GUEST_REQUEST_CATEGORIES,
  GUEST_REQUEST_CATEGORY_LABEL,
  type GuestArrivalRelease,
  type GuestContractMode,
  type GuestDetailField,
  type GuestJourneySettings,
  type GuestRequestCategory,
  type ReconfirmationTrigger,
} from './types'

/* ------------------------------------------------------- the vocabulary -- */

/** `guest_journey_settings_hours_sane`, so a form and a column agree. */
export const ARRIVAL_RELEASE_HOURS_MIN = 0
export const ARRIVAL_RELEASE_HOURS_MAX = 720

/**
 * The labels `types.ts` does not carry.
 *
 * That file is another worker's and holds the vocabularies the *portal* needs.
 * These four are needed by the settings screen and by the change list below,
 * and they are here rather than there because adding them there would be an
 * edit outside this worker's claim for the sake of tidiness.
 */
export const CONTRACT_MODE_LABEL: Record<GuestContractMode, string> = {
  disabled: 'אין חוזה',
  optional: 'חוזה זמין, לא חובה',
  mandatory: 'חוזה חובה לפני ההגעה',
}

export const CONTRACT_MODE_DESCRIPTION: Record<GuestContractMode, string> = {
  disabled:
    'לא יופיע שלב חוזה בעמוד האורח כלל. זו הגדרה שלמה — רוב בתי האירוח הקטנים אינם מחתימים איש.',
  optional: 'החוזה יוצג לאורח ויהיה אפשר לחתום עליו, אך אי-חתימה לא תעצור דבר.',
  mandatory: 'האורח לא יתקדם בלי לחתום, והחתימה נשמרת כעותק קפוא.',
}

/** `guest_journey_settings.during_stay_topics`, as the portal reads them. */
export const DURING_STAY_TOPICS = [
  'wifi',
  'guide',
  'access',
  'checkout',
] as const

export type DuringStayTopic = (typeof DURING_STAY_TOPICS)[number]

export const DURING_STAY_TOPIC_LABEL: Record<DuringStayTopic, string> = {
  wifi: 'רשת אלחוטית וסיסמה',
  guide: 'מדריך הנכס',
  access: 'הוראות כניסה',
  checkout: 'הוראות יציאה',
}

export const DURING_STAY_TOPIC_DESCRIPTION: Record<DuringStayTopic, string> = {
  wifi: 'מוצג רק אחרי שהשהות התחילה. הסיסמה נשמרת בתוכן הנכס.',
  guide: 'מה יש בבית, איך מפעילים מה, ומה מבקשים לא לעשות.',
  access: 'איך נכנסים בפועל. הקוד עצמו נחשף לפי מדיניות שחרור פרטי ההגעה.',
  checkout: 'מה עושים לפני שעוזבים. מוצג לקראת סוף השהות.',
}

/**
 * The names the settings screen uses for the same four topics.
 *
 * An alias rather than a second list: two lists would let a topic be added to
 * one and not the other, and the symptom is a checkbox that saves a value the
 * portal never reads.
 */
export const GUEST_STAY_TOPICS = DURING_STAY_TOPICS
export const GUEST_STAY_TOPIC_LABEL = DURING_STAY_TOPIC_LABEL
export const GUEST_STAY_TOPIC_DESCRIPTION = DURING_STAY_TOPIC_DESCRIPTION

export const GUEST_CONTRACT_MODE_LABEL = CONTRACT_MODE_LABEL
export const GUEST_CONTRACT_MODE_DESCRIPTION = CONTRACT_MODE_DESCRIPTION

/**
 * What each release mode actually means for a person standing at a door.
 *
 * Written as consequences rather than as definitions, because this is the one
 * setting on the screen that is a security control: every sentence below says
 * who ends up able to see a door code, which is the decision being made.
 */
export const GUEST_ARRIVAL_RELEASE_DESCRIPTION: Record<
  GuestArrivalRelease,
  string
> = {
  immediate:
    'הכתובת והקוד גלויים ברגע שהקישור נפתח. מתאים לכתובת מפורסמת ולמפתח בתיבה.',
  after_confirmation:
    'נחשפים אחרי שהאורח אישר את ההזמנה. זו ברירת המחדל של המערכת.',
  after_contract: 'נחשפים אחרי חתימה על החוזה. דורש שהחוזה יהיה פעיל.',
  after_deposit: 'נחשפים אחרי שנרשמה מקדמה. המקדמה מוגדרת במסך גבייה ותשלומים.',
  after_full_payment: 'נחשפים אחרי שההזמנה שולמה במלואה.',
  hours_before: 'נחשפים זמן קצוב לפני שעת הכניסה, בלי קשר לתשלום או לחתימה.',
  manual: 'לא נחשפים עד ששחררתם ידנית בהזמנה עצמה. שום דבר לא קורה מאליו.',
}

export const RECONFIRMATION_TRIGGER_LABEL: Record<
  ReconfirmationTrigger,
  string
> = {
  dates: 'שינוי תאריכים',
  guests: 'שינוי מספר האורחים',
  price: 'שינוי מחיר',
  cancellation: 'שינוי תנאי הביטול',
}

export const RECONFIRMATION_TRIGGER_DESCRIPTION: Record<
  ReconfirmationTrigger,
  string
> = {
  dates: 'אורח שאישר שבוע אחד לא אישר שבוע אחר.',
  guests: 'אורח שאישר לשניים לא אישר לחמישה.',
  price: 'אורח שאישר ₪7,500 לא אישר ₪8,000.',
  cancellation: 'שינוי תנאי הביטול אחרי האישור הוא שינוי של העסקה עצמה.',
}

/**
 * The stay topics as the portal will read them, with anything it does not know
 * left where it was.
 *
 * A screen renders four checkboxes; the column is a `text[]` and a future
 * migration may add a fifth topic this build has never heard of. Dropping it
 * because a form did not draw a box for it would silently switch off a section
 * of somebody's guest page, so unknown members survive the round trip.
 */
export function mergeStayTopics(
  chosen: readonly string[],
  previous: readonly string[],
): string[] {
  const known = new Set<string>(DURING_STAY_TOPICS)
  const unknown = previous.filter((topic) => !known.has(topic))
  const ordered = DURING_STAY_TOPICS.filter((topic) => chosen.includes(topic))
  return [...ordered, ...unknown]
}

/* --------------------------------------------------- the shipped answer -- */

/**
 * What a business that has never opened this screen already has.
 *
 * A transcription of the fallback branch of `guest_journey_effective_settings`
 * in `0034_guest_journey.sql`, value for value. It is copied rather than read
 * because the screen has to render "never configured" without a round trip,
 * and it is a transcription rather than an invention because a fourth opinion
 * about the defaults — SQL, the demo, this file — is a screen that shows a
 * business something other than what its guests are getting.
 *
 * It is deliberately the quietest journey the product can produce: confirm,
 * and nothing else.
 */
export const SHIPPED_JOURNEY_SETTINGS: GuestJourneySettings = {
  contractMode: 'disabled',
  requireGuestConfirmation: true,
  requiredDetailFields: [],
  optionalDetailFields: [],
  arrivalRelease: 'after_confirmation',
  arrivalReleaseHours: 24,
  duringStayTopics: ['wifi', 'guide', 'access', 'checkout'],
  requestsEnabled: true,
  requestCategories: [...GUEST_REQUEST_CATEGORIES],
  checkoutDeclarationEnabled: true,
  reviewEnabled: false,
  reviewUrl: null,
  rebookEnabled: false,
  reconfirmationTriggers: ['dates', 'guests', 'price', 'cancellation'],
}

/* ------------------------------------------------------------ the three -- */

export const JOURNEY_PRESET_IDS = [
  'simple_villa',
  'professional',
  'full_commerce',
] as const

export type JourneyPresetId = (typeof JOURNEY_PRESET_IDS)[number]

export type JourneyPreset = {
  id: JourneyPresetId
  label: string
  /** Who this fits, in one line, in their words rather than in features. */
  audience: string
  /** What the guest actually meets, as sentences rather than as field names. */
  highlights: readonly string[]
  settings: GuestJourneySettings
  /**
   * What this preset expects of the payment policy — stated, never written.
   *
   * `src/lib/payments` owns "what must a guest pay" and
   * `resolveCollectionPolicy` is its one implementation. Applying a preset
   * writes nothing into `payment_collection_settings`; this is the sentence
   * the screen shows beside a link to the screen that does.
   */
  paymentGuidance: {
    policy: PaymentCollectionPolicy
    sentence: string
  }
}

/** The name the settings screen imports. One list, two names, no second copy. */
export type GuestJourneyPreset = JourneyPreset

export const JOURNEY_PRESETS: readonly JourneyPreset[] = [
  {
    id: 'simple_villa',
    label: 'וילה פשוטה',
    audience:
      'בית אירוח אחד, סגירה בטלפון או בוואטסאפ, תשלום בהעברה בנקאית או במזומן.',
    highlights: [
      'האורח מאשר את ההזמנה, וזהו — אין חוזה ואין טופס פרטים ארוך.',
      'הכתובת והוראות הכניסה נחשפות מיד עם האישור.',
      'אין בקשות שירות, אין הצהרת יציאה ואין בקשת ביקורת.',
    ],
    settings: {
      contractMode: 'disabled',
      requireGuestConfirmation: true,
      // Two fields, and both of them are things the business already asked for
      // on the telephone. A details form is a wall, and a wall before a
      // confirmation is how a booking goes unconfirmed.
      requiredDetailFields: ['full_name', 'phone'],
      optionalDetailFields: ['arrival_estimate'],
      arrivalRelease: 'after_confirmation',
      arrivalReleaseHours: 24,
      duringStayTopics: ['access', 'checkout'],
      requestsEnabled: false,
      requestCategories: [],
      checkoutDeclarationEnabled: false,
      reviewEnabled: false,
      reviewUrl: null,
      rebookEnabled: false,
      reconfirmationTriggers: ['dates', 'guests', 'price', 'cancellation'],
    },
    paymentGuidance: {
      policy: 'manual',
      sentence: 'האורח מקבל את פרטי ההעברה ומשלם מחוץ למערכת.',
    },
  },
  {
    id: 'professional',
    label: 'ניהול מקצועי',
    audience:
      'כמה נכסים, חוזה חתום מול כל אורח, מקדמה לפני ההגעה, ובקשה לביקורת בסוף.',
    highlights: [
      'האורח מאשר, חותם על חוזה, וממלא פרטים מלאים לפני ההגעה.',
      'הכתובת והקוד נחשפים רק אחרי החתימה.',
      'במהלך השהות אפשר לבקש מגבות, ניקיון ותחזוקה.',
      'בסוף השהות מוצגת הצהרת יציאה, ואם הוגדר קישור — גם בקשת ביקורת.',
    ],
    settings: {
      contractMode: 'mandatory',
      requireGuestConfirmation: true,
      requiredDetailFields: [
        'full_name',
        'id_number',
        'phone',
        'email',
        'arrival_estimate',
      ],
      optionalDetailFields: ['vehicle', 'guest_names', 'notes'],
      // The address follows the signature. The whole point of a mandatory
      // contract is that it precedes the key.
      arrivalRelease: 'after_contract',
      arrivalReleaseHours: 24,
      duringStayTopics: ['wifi', 'guide', 'access', 'checkout'],
      requestsEnabled: true,
      requestCategories: [...GUEST_REQUEST_CATEGORIES],
      checkoutDeclarationEnabled: true,
      reviewEnabled: true,
      // Null on purpose: nobody can guess a business's review link, and the
      // database refuses `review_enabled` without one. `resolvePreset` turns
      // this into "off, and here is why" rather than into a failed save.
      reviewUrl: null,
      rebookEnabled: false,
      reconfirmationTriggers: ['dates', 'guests', 'price', 'cancellation'],
    },
    paymentGuidance: {
      policy: 'deposit',
      sentence: 'מקדמה לפני האישור, והיתרה לפני ההגעה.',
    },
  },
  {
    id: 'full_commerce',
    label: 'מסחר מלא',
    audience:
      'הזמנה שנסגרת מעצמה, סליקה מקוונת, חוזה, מכירות נוספות ומנעול חכם.',
    highlights: [
      'האורח מאשר, חותם ומשלם — והכול לפני שהוא מקבל קוד כניסה.',
      'הכתובת והקוד נחשפים רק אחרי תשלום מלא.',
      'עמוד השהות מלא: רשת, מדריך, בקשות והוראות יציאה.',
      'בסוף מוצעת הזמנה חוזרת, ואם הוגדר קישור — גם בקשת ביקורת.',
    ],
    settings: {
      contractMode: 'mandatory',
      requireGuestConfirmation: true,
      requiredDetailFields: [
        'full_name',
        'id_number',
        'phone',
        'email',
        'arrival_estimate',
        'guest_names',
      ],
      optionalDetailFields: ['vehicle', 'dietary', 'notes'],
      // A door code that opens a lock is released once the stay is paid for.
      // `guest_arrival_released` still overrides this the moment the business
      // checks the guest in, so nobody is left outside holding a telephone.
      arrivalRelease: 'after_full_payment',
      arrivalReleaseHours: 24,
      duringStayTopics: ['wifi', 'guide', 'access', 'checkout'],
      requestsEnabled: true,
      requestCategories: [...GUEST_REQUEST_CATEGORIES],
      checkoutDeclarationEnabled: true,
      reviewEnabled: true,
      reviewUrl: null,
      rebookEnabled: true,
      reconfirmationTriggers: ['dates', 'guests', 'price', 'cancellation'],
    },
    paymentGuidance: {
      policy: 'full',
      sentence:
        'תשלום מלא מקוון לפני ההגעה. בלי סליקה פעילה, שחרור הכתובת לפי תשלום מלא לא יקרה מאליו ויידרש שחרור ידני.',
    },
  },
]

/** The name the settings screen imports. Same array, not a copy. */
export const GUEST_JOURNEY_PRESETS = JOURNEY_PRESETS

export function presetById(id: string): JourneyPreset | null {
  return JOURNEY_PRESETS.find((preset) => preset.id === id) ?? null
}

/* ------------------------------------------------------- what it changes -- */

export type JourneyChange = {
  field: keyof GuestJourneySettings
  /** The section this belongs to on the settings screen. */
  section: JourneySectionId
  label: string
  from: string
  to: string
}

export const JOURNEY_SECTION_IDS = [
  'confirmation',
  'payment',
  'contract',
  'details',
  'arrival',
  'stay',
  'checkout',
  'review',
] as const

export type JourneySectionId = (typeof JOURNEY_SECTION_IDS)[number]

export const JOURNEY_SECTION_LABEL: Record<JourneySectionId, string> = {
  confirmation: 'אישור ההזמנה',
  payment: 'גביית תשלום',
  contract: 'חוזה',
  details: 'פרטי האורח',
  arrival: 'הגעה',
  stay: 'במהלך השהות',
  checkout: 'יציאה',
  review: 'ביקורת',
}

const FIELD_SECTION: Record<keyof GuestJourneySettings, JourneySectionId> = {
  requireGuestConfirmation: 'confirmation',
  reconfirmationTriggers: 'confirmation',
  contractMode: 'contract',
  requiredDetailFields: 'details',
  optionalDetailFields: 'details',
  arrivalRelease: 'arrival',
  arrivalReleaseHours: 'arrival',
  duringStayTopics: 'stay',
  requestsEnabled: 'stay',
  requestCategories: 'stay',
  checkoutDeclarationEnabled: 'checkout',
  reviewEnabled: 'review',
  reviewUrl: 'review',
  rebookEnabled: 'review',
}

const FIELD_LABEL: Record<keyof GuestJourneySettings, string> = {
  requireGuestConfirmation: 'נדרש אישור האורח',
  reconfirmationTriggers: 'שינויים המבטלים אישור קיים',
  contractMode: 'חוזה',
  requiredDetailFields: 'פרטים נדרשים',
  optionalDetailFields: 'פרטים לא חובה',
  arrivalRelease: 'מתי נחשפים פרטי ההגעה',
  arrivalReleaseHours: 'כמה שעות לפני ההגעה',
  duringStayTopics: 'מה מוצג במהלך השהות',
  requestsEnabled: 'בקשות מהאורח',
  requestCategories: 'סוגי בקשות',
  checkoutDeclarationEnabled: 'הצהרת יציאה',
  reviewEnabled: 'בקשת ביקורת',
  reviewUrl: 'קישור לביקורת',
  rebookEnabled: 'הזמנה חוזרת',
}

const YES = 'פעיל'
const NO = 'כבוי'
const NONE = 'ללא'

function joinOr(values: readonly string[]): string {
  return values.length > 0 ? values.join(' · ') : NONE
}

function detailList(fields: readonly GuestDetailField[]): string {
  return joinOr(fields.map((field) => GUEST_DETAIL_FIELD_LABEL[field]))
}

function categoryList(values: readonly GuestRequestCategory[]): string {
  return joinOr(values.map((value) => GUEST_REQUEST_CATEGORY_LABEL[value]))
}

function topicList(values: readonly string[]): string {
  return joinOr(
    values.map(
      (value) =>
        DURING_STAY_TOPIC_LABEL[value as DuringStayTopic] ?? String(value),
    ),
  )
}

function arrivalLabel(release: GuestArrivalRelease, hours: number): string {
  if (release !== 'hours_before') return GUEST_ARRIVAL_RELEASE_LABEL[release]
  return `${GUEST_ARRIVAL_RELEASE_LABEL[release]} — ${hours} שעות`
}

/** One field, as a person would read it out loud. */
export function describeSetting(
  field: keyof GuestJourneySettings,
  settings: GuestJourneySettings,
): string {
  switch (field) {
    case 'requireGuestConfirmation':
      return settings.requireGuestConfirmation ? YES : NO
    case 'contractMode':
      return CONTRACT_MODE_LABEL[settings.contractMode]
    case 'requiredDetailFields':
      return detailList(settings.requiredDetailFields)
    case 'optionalDetailFields':
      return detailList(settings.optionalDetailFields)
    case 'arrivalRelease':
      return arrivalLabel(settings.arrivalRelease, settings.arrivalReleaseHours)
    case 'arrivalReleaseHours':
      return `${settings.arrivalReleaseHours} שעות`
    case 'duringStayTopics':
      return topicList(settings.duringStayTopics)
    case 'requestsEnabled':
      return settings.requestsEnabled ? YES : NO
    case 'requestCategories':
      return categoryList(settings.requestCategories)
    case 'checkoutDeclarationEnabled':
      return settings.checkoutDeclarationEnabled ? YES : NO
    case 'reviewEnabled':
      return settings.reviewEnabled ? YES : NO
    case 'reviewUrl':
      return settings.reviewUrl ?? NONE
    case 'rebookEnabled':
      return settings.rebookEnabled ? YES : NO
    case 'reconfirmationTriggers':
      return joinOr(
        settings.reconfirmationTriggers.map(
          (trigger) => RECONFIRMATION_TRIGGER_LABEL[trigger],
        ),
      )
  }
}

const COMPARED_FIELDS = Object.keys(
  FIELD_LABEL,
) as (keyof GuestJourneySettings)[]

/**
 * What would change, field by field, in the order the screen reads.
 *
 * Rendered rather than diffed structurally: two arrays holding the same
 * members in a different order are not a change a person cares about, and
 * comparing the sentences is what makes "מגבות · מצעים" equal to itself
 * however the checkboxes were clicked.
 */
export function describeChanges(
  current: GuestJourneySettings,
  next: GuestJourneySettings,
): JourneyChange[] {
  const changes: JourneyChange[] = []

  for (const field of COMPARED_FIELDS) {
    // `arrivalReleaseHours` is folded into the arrival sentence, so reporting
    // it separately would announce a change to a number nobody is reading
    // whenever the release mode is not the timed one.
    if (
      field === 'arrivalReleaseHours' &&
      next.arrivalRelease !== 'hours_before'
    )
      continue

    const from = describeSetting(field, current)
    const to = describeSetting(field, next)
    if (from === to) continue

    changes.push({
      field,
      section: FIELD_SECTION[field],
      label: FIELD_LABEL[field],
      from,
      to,
    })
  }

  return changes
}

/* ---------------------------------------------------------- applying one -- */

export type PresetResolution = {
  /** Exactly the row that will be written. */
  settings: GuestJourneySettings
  changes: JourneyChange[]
  /** Where the preset could not have its way, and why. Shown before applying. */
  notes: string[]
}

function union<T>(left: readonly T[], right: readonly T[]): T[] {
  return [...new Set([...left, ...right])]
}

/**
 * The preset, reconciled with what this business already has.
 *
 * Two reconciliations, and both exist because a preset must never take
 * something away that a person cannot see it taking:
 *
 *   · **The review link survives.** A preset carries none, and wiping a link
 *     somebody pasted in would be a silent loss on a screen about something
 *     else. Where the preset wants reviews and there is no link at all,
 *     reviews stay OFF and the note says so — the alternative is a database
 *     constraint violation dressed up as "the preset failed".
 *
 *   · **Consent protection only ever widens.** `reconfirmation_triggers` is
 *     the union of the preset's and the business's own, never the preset's
 *     alone. A guest who agreed to ₪7,500 has not agreed to ₪8,000, and no
 *     starting point gets to quietly reduce which changes void that.
 *
 * Idempotent by construction: applying the same preset twice produces the same
 * settings and the second call reports no changes.
 */
export function resolvePreset(
  current: GuestJourneySettings,
  preset: JourneyPreset,
): PresetResolution {
  const notes: string[] = []

  const reviewUrl = current.reviewUrl
  const reviewEnabled = preset.settings.reviewEnabled && reviewUrl !== null

  if (preset.settings.reviewEnabled && !reviewEnabled) {
    notes.push(
      'בקשת הביקורת תישאר כבויה כי לא הוגדר קישור לביקורת. אפשר להזין קישור בסעיף "ביקורת" ולהפעיל אותה.',
    )
  }

  const reconfirmationTriggers = union(
    preset.settings.reconfirmationTriggers,
    current.reconfirmationTriggers,
  )

  if (
    reconfirmationTriggers.length >
    preset.settings.reconfirmationTriggers.length
  ) {
    notes.push(
      'השינויים המבטלים אישור קיים נשמרים כפי שהם ואינם מצטמצמים על ידי תבנית.',
    )
  }

  notes.push(
    'תבנית אינה משנה את מדיניות הגבייה. את זה קובעים במסך גבייה ותשלומים.',
  )
  notes.push(
    'תבנית אינה כותבת מילים — כתובת, קוד כניסה או סיסמת רשת נשארים כפי שהם.',
  )

  const settings: GuestJourneySettings = {
    ...preset.settings,
    requiredDetailFields: [...preset.settings.requiredDetailFields],
    optionalDetailFields: [...preset.settings.optionalDetailFields],
    duringStayTopics: [...preset.settings.duringStayTopics],
    requestCategories: [...preset.settings.requestCategories],
    reviewEnabled,
    reviewUrl,
    reconfirmationTriggers,
  }

  return { settings, changes: describeChanges(current, settings), notes }
}

/* ------------------------------------- what applying it costs, in advance -- */

/**
 * A change, and whether it runs over something somebody chose on purpose.
 *
 * "Eleven settings will change" and "three of those are decisions you made"
 * are different sentences, and only the second should give anybody pause. A
 * value that still matches the shipped default was never chosen by anyone, so
 * a preset replacing it is filling in a blank rather than overruling a person.
 */
export type PresetChange = JourneyChange & {
  overwritesOwnChoice: boolean
}

export type PresetApplication = {
  settings: GuestJourneySettings
  changes: PresetChange[]
  /** The subset that overrules a deliberate choice. Never a separate list. */
  overwrites: PresetChange[]
  notes: string[]
}

/**
 * Exactly what pressing the button would do, computed before it is pressed.
 *
 * The screen renders this and the operation applies the same resolution, so
 * there is one answer to "what will this change" rather than a preview and a
 * behaviour that can drift apart.
 */
export function applyPreset(
  current: GuestJourneySettings,
  preset: JourneyPreset,
): PresetApplication {
  const resolution = resolvePreset(current, preset)

  const changes: PresetChange[] = resolution.changes.map((change) => ({
    ...change,
    overwritesOwnChoice:
      describeSetting(change.field, current) !==
      describeSetting(change.field, SHIPPED_JOURNEY_SETTINGS),
  }))

  return {
    settings: resolution.settings,
    changes,
    overwrites: changes.filter((change) => change.overwritesOwnChoice),
    notes: resolution.notes,
  }
}

/**
 * Which preset these settings already are, if any.
 *
 * Answered by applying each one and asking whether anything would move — the
 * same function the button uses. Nothing is stored to say a preset was chosen,
 * because a preset is a starting point and not a mode: a business that edits
 * one field afterwards has simply stopped matching, which is the honest thing
 * for the badge to say.
 */
export function matchingPreset(
  current: GuestJourneySettings,
): JourneyPreset | null {
  return (
    JOURNEY_PRESETS.find(
      (preset) => applyPreset(current, preset).changes.length === 0,
    ) ?? null
  )
}
