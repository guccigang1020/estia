/**
 * Empty states, and the distinction the product cannot afford to blur.
 *
 * A module with no records and a list with no matches look identical on screen
 * and are opposite situations. The first is a person who has not started and
 * needs to be told what this module is for; the second is a person with plenty
 * of data who has hidden it behind a filter and needs the filter cleared. Show
 * "עוד לא יצרת הזמנות" to someone with four hundred bookings and you have told
 * them the system lost their data.
 *
 * `resolveEmptyReason` is the guard against that, and it is the reason this
 * file is plain TypeScript with a test beside it rather than copy inlined in
 * a component.
 */

/** The modules the product will ship with a list screen. */
export type EmptyModule =
  | 'bookings'
  | 'properties'
  | 'units'
  | 'guests'
  | 'team'
  | 'invoices'
  | 'tasks'
  | 'messages'

export type EmptyReason = 'no_data' | 'no_results'

/** Which inline illustration to draw. `search` belongs to `no_results` only. */
export type EmptyIllustration =
  | 'calendar'
  | 'property'
  | 'unit'
  | 'guest'
  | 'team'
  | 'invoice'
  | 'task'
  | 'message'
  | 'search'

export type EmptyStateCopy = {
  reason: EmptyReason
  illustration: EmptyIllustration
  title: string
  /** Explains what the module does and why the screen is blank. */
  body: string
  /** The one action worth offering here. */
  actionLabel: string
  /** Offered alongside the primary action when it genuinely helps. */
  secondaryActionLabel?: string
}

type ModulePreset = {
  illustration: EmptyIllustration
  title: string
  body: string
  actionLabel: string
  secondaryActionLabel?: string
  /** Plural noun used by the filtered variant: "הזמנות", "אורחים". */
  plural: string
  /**
   * Grammatical gender of that plural. Hebrew agrees adjectives, participles
   * and pronouns with it, so composing the filtered sentence without this
   * produces text that reads as broken to every Israeli user.
   */
  gender: 'm' | 'f'
}

const AGREEMENT = {
  m: { matching: 'שתואמים', other: 'אחרים', exist: 'קיימים', them: 'אותם' },
  f: { matching: 'שתואמות', other: 'אחרות', exist: 'קיימות', them: 'אותן' },
} as const

const MODULES: Record<EmptyModule, ModulePreset> = {
  bookings: {
    illustration: 'calendar',
    title: 'עוד אין הזמנות ביומן',
    body: 'כאן יופיעו כל השהיות של האורחים — מי מגיע, לאיזו יחידה, ומתי. היומן חוסם התנגשויות בעצמו, כך שאותה יחידה לא תוזמן פעמיים.',
    actionLabel: 'צור הזמנה ראשונה',
    secondaryActionLabel: 'ייבא הזמנות קיימות',
    plural: 'הזמנות',
    gender: 'f',
  },
  properties: {
    illustration: 'property',
    title: 'עוד לא הוספת נכס',
    body: 'נכס הוא המיקום הפיזי — כתובת אחת. הוא מחזיק את היחידות שאפשר להזמין, את הצוות שמטפל בהן ואת הדוחות לבעלים.',
    actionLabel: 'הוסף נכס',
    plural: 'נכסים',
    gender: 'm',
  },
  units: {
    illustration: 'unit',
    title: 'לנכס הזה עוד אין יחידות',
    body: 'יחידה היא הדבר שאורח מזמין — חדר, צימר או וילה. בלי יחידה אחת לפחות אי אפשר לפתוח הזמנה או לקבל הזמנה מהאתר.',
    actionLabel: 'הוסף יחידה',
    plural: 'יחידות',
    gender: 'f',
  },
  guests: {
    illustration: 'guest',
    title: 'עוד לא נרשמו אורחים',
    body: 'כל אורח שמזמין נשמר כאן עם היסטוריית השהיות שלו, כדי שבפעם הבאה לא תתחיל מדף ריק. כרטיס אורח נוצר מעצמו עם ההזמנה הראשונה.',
    actionLabel: 'הוסף אורח',
    plural: 'אורחים',
    gender: 'm',
  },
  team: {
    illustration: 'team',
    title: 'אתה עדיין לבד בארגון',
    body: 'הזמנת עובד יוצרת לו חשבון משלו עם תפקיד וטווח — מנקה רואה משימות ולוח זמנים, ולא רואה מחירים או פרטי אורח.',
    actionLabel: 'הזמן חבר צוות',
    plural: 'חברי צוות',
    gender: 'm',
  },
  invoices: {
    illustration: 'invoice',
    title: 'עוד לא הופקו חשבוניות',
    body: 'חשבונית נוצרת אוטומטית עם כל תשלום שנקלט, ונשמרת כמסמך שמוכר לצורכי מס. אפשר גם להפיק חשבונית ידנית.',
    actionLabel: 'הפק חשבונית',
    plural: 'חשבוניות',
    gender: 'f',
  },
  tasks: {
    illustration: 'task',
    title: 'אין משימות פתוחות',
    body: 'משימות ניקיון והכנה נפתחות מעצמן לפי צ׳ק-אאוט וצ׳ק-אין, ואפשר להוסיף משימה חד-פעמית לכל אדם או צוות.',
    actionLabel: 'צור משימה',
    plural: 'משימות',
    gender: 'f',
  },
  messages: {
    illustration: 'message',
    title: 'אין שיחות פתוחות',
    body: 'כל פנייה מהאתר, מהוואטסאפ או מהמייל מגיעה לחוט אחד לכל אורח, כדי שלא תחפש מה נאמר לו בערוץ אחר.',
    actionLabel: 'פתח שיחה',
    plural: 'שיחות',
    gender: 'f',
  },
}

export type EmptyStateInput = {
  module: EmptyModule
  reason: EmptyReason
  /**
   * A short Hebrew description of the active filter, shown back to the user so
   * they can see what is hiding their data: "ספטמבר · וילה הגליל".
   */
  filterSummary?: string
}

export function emptyStateCopy({
  module,
  reason,
  filterSummary,
}: EmptyStateInput): EmptyStateCopy {
  const preset = MODULES[module]

  if (reason === 'no_data') {
    return {
      reason,
      illustration: preset.illustration,
      title: preset.title,
      body: preset.body,
      actionLabel: preset.actionLabel,
      secondaryActionLabel: preset.secondaryActionLabel,
    }
  }

  // Filtered: the data exists. Never offer "create" as the way out of a
  // filter — it answers a question the user did not ask and leaves the filter
  // in place, so the new record disappears the moment it is created.
  const agree = AGREEMENT[preset.gender]
  const filterClause = filterSummary
    ? `הסינון הפעיל (${filterSummary}) לא מחזיר תוצאות`
    : 'הסינון הפעיל לא מחזיר תוצאות'

  return {
    reason,
    illustration: 'search',
    title: `אין ${preset.plural} ${agree.matching} לסינון`,
    body: `${filterClause}. ${preset.plural} ${agree.other} ${agree.exist} במערכת — שינוי או ניקוי הסינון יחזיר ${agree.them}.`,
    actionLabel: 'נקה סינון',
  }
}

export type EmptyReasonInput = {
  /** How many rows are on screen after filtering. */
  visibleCount: number
  /**
   * How many rows exist for this organization before filtering.
   * `undefined` means the screen never asked, which is itself meaningful.
   */
  totalCount?: number
  hasActiveFilters: boolean
}

/**
 * Decides which empty state a list screen is in, or `null` when it is not
 * empty at all.
 *
 * The subtle case is a filter that is active while the module is genuinely
 * untouched: clearing the filter would reveal nothing, so the person still
 * needs the onboarding copy, not "try a different filter".
 */
export function resolveEmptyReason({
  visibleCount,
  totalCount,
  hasActiveFilters,
}: EmptyReasonInput): EmptyReason | null {
  if (visibleCount > 0) return null
  if (!hasActiveFilters) return 'no_data'

  // Filters are on and nothing is visible. Only a known-empty total proves the
  // module itself is empty; an unknown total must not be guessed into
  // "you have never created one".
  if (totalCount === 0) return 'no_data'

  return 'no_results'
}
