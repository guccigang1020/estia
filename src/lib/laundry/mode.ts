/**
 * The five modes, and the words each one is allowed to use.
 *
 * ── Why the vocabulary is code rather than copy ───────────────────────────
 *
 * `simple` is the mode a single villa owner picks. What they asked for is a
 * list of what has to be clean by Friday. What they must never be shown is
 * "order", "provider", "dispatch", "consolidation", "stock" or "warehouse" —
 * not because those words are wrong, but because every one of them implies
 * this person has an operation they do not have, and the first reaction to a
 * screen full of them is that the product is for somebody bigger.
 *
 * That could be a rule everybody remembers when writing a screen. It would
 * survive about four screens. So the words are attached to the mode here,
 * `FORBIDDEN_IN_SIMPLE` names what may not leak in, and `mode.test.ts` asserts
 * that the `simple` vocabulary contains none of them — which turns "we must
 * remember" into "it does not compile past the suite".
 *
 * ── What each mode actually switches on ───────────────────────────────────
 *
 *   off       nothing. Preparation still works completely; that is the point.
 *   simple    a list, by day. No stock, no orders, no provider.
 *   internal  a work plan with assignees and the state machine.
 *   external  structured orders to a provider.
 *   hybrid    both, decided per item by the profile's `route`.
 *
 * `SECTIONS_BY_MODE` is what the screens read. A section that is not in the
 * list for the current mode is not rendered and its route says so, rather than
 * rendering an empty version of itself — an empty orders screen under `simple`
 * is a promise that orders exist here.
 */

import type { LaundryMode } from '../contracts/states'
import type { LaundryRoute } from './types'

/** The parts of the laundry section that can exist. */
export const LAUNDRY_SECTIONS = [
  'dashboard',
  'requirements',
  'orders',
  'tasks',
  'providers',
  'forecast',
] as const

export type LaundrySection = (typeof LAUNDRY_SECTIONS)[number]

/**
 * Which sections exist under which mode.
 *
 * `off` has none, and the menu entry is hidden rather than the screens
 * rendering an explanation — a section that "does not pretend to exist" is one
 * you cannot navigate to, not one that greets you with an apology.
 *
 * `simple` gets the dashboard, the list and the forecast: what has to be
 * clean, and what is coming. No orders, because there is nobody to send one
 * to; no tasks, because a one-person operation does not assign work to itself;
 * no providers, because that is the whole distinction from `external`.
 *
 * `internal` gets tasks and no providers. `external` gets orders and providers
 * and no tasks. `hybrid` gets everything, because it genuinely is everything.
 */
export const SECTIONS_BY_MODE: Readonly<
  Record<LaundryMode, readonly LaundrySection[]>
> = {
  off: [],
  simple: ['dashboard', 'requirements', 'forecast'],
  internal: ['dashboard', 'requirements', 'tasks', 'forecast'],
  external: ['dashboard', 'requirements', 'orders', 'providers', 'forecast'],
  hybrid: [
    'dashboard',
    'requirements',
    'orders',
    'tasks',
    'providers',
    'forecast',
  ],
}

export function sectionsFor(mode: LaundryMode): readonly LaundrySection[] {
  return SECTIONS_BY_MODE[mode]
}

export function hasSection(
  mode: LaundryMode,
  section: LaundrySection,
): boolean {
  return SECTIONS_BY_MODE[mode].includes(section)
}

/** Is the section switched on at all. */
export function isLaundryActive(mode: LaundryMode): boolean {
  return mode !== 'off'
}

/** Does this mode ever produce an order addressed to an outside company. */
export function sendsToProvider(mode: LaundryMode): boolean {
  return mode === 'external' || mode === 'hybrid'
}

/** Does this mode ever produce work assigned to a member of staff. */
export function producesInternalWork(mode: LaundryMode): boolean {
  return mode === 'internal' || mode === 'hybrid'
}

/**
 * Which way an item goes under this mode.
 *
 * `hybrid` is the only mode that consults the profile, and an item with no
 * route under `hybrid` falls back to internal — the conservative answer,
 * because internal work stays inside the organization and an accidental
 * external route is a message to an outside company nobody chose to send.
 */
export function routeFor(
  mode: LaundryMode,
  profileRoute: LaundryRoute | null,
): LaundryRoute {
  if (mode === 'external') return 'external'
  if (mode === 'hybrid') return profileRoute ?? 'internal'
  return 'internal'
}

// ── The words ─────────────────────────────────────────────────────────────

/**
 * How each mode names things, in Hebrew.
 *
 * One record per mode rather than one set of strings with conditionals inside,
 * because a conditional inside a sentence is how "הזמנה" ends up on a `simple`
 * screen: somebody adds a branch for the case they are working on and the
 * other branch keeps the word.
 */
export interface LaundryVocabulary {
  /** What the section is called. */
  section: string
  /** One line under the heading. */
  tagline: string
  /** What a group of items to be washed is called. */
  batch: string
  /** Plural of the above. */
  batches: string
  /** What the act of starting one is called. */
  begin: string
  /** What "it is done" is called. */
  done: string
  /** What the forward-looking screen is called. */
  forecast: string
}

export const VOCABULARY: Readonly<Record<LaundryMode, LaundryVocabulary>> = {
  // Present so the record is total. Nothing renders under `off`.
  off: {
    section: 'כביסה',
    tagline: 'ניהול הכביסה כבוי. ההכנה לאירוח עובדת במלואה בלעדיו.',
    batch: 'רשימה',
    batches: 'רשימות',
    begin: 'התחלה',
    done: 'הושלם',
    forecast: 'צפי',
  },

  // Not one word here implies an operation. A person, a machine, a Friday.
  simple: {
    section: 'כביסה',
    tagline: 'מה צריך להיות נקי, ועד מתי.',
    batch: 'רשימת כביסה',
    batches: 'רשימות כביסה',
    begin: 'סימון כהתחיל',
    done: 'נקי ומוכן',
    forecast: 'מה צפוי',
  },

  internal: {
    section: 'כביסה',
    tagline: 'מה צריך להיות נקי, מי מטפל בזה, ואיפה זה עומד.',
    batch: 'מחזור כביסה',
    batches: 'מחזורי כביסה',
    begin: 'התחלת מחזור',
    done: 'מוכן',
    forecast: 'צפי כביסה',
  },

  external: {
    section: 'כביסה',
    tagline: 'מה נשלח למכבסה, מתי הוא חוזר, ומה עדיין חסר.',
    batch: 'הזמנת כביסה',
    batches: 'הזמנות כביסה',
    begin: 'שליחה למכבסה',
    done: 'חזר מהמכבסה',
    forecast: 'צפי כביסה',
  },

  hybrid: {
    section: 'כביסה',
    tagline: 'חלק נשלח למכבסה, חלק נעשה בבית. לפי הפריט.',
    batch: 'מחזור כביסה',
    batches: 'מחזורי כביסה',
    begin: 'התחלה',
    done: 'מוכן',
    forecast: 'צפי כביסה',
  },
}

export function vocabularyFor(mode: LaundryMode): LaundryVocabulary {
  return VOCABULARY[mode]
}

/**
 * Words a `simple` operation must never be shown.
 *
 * Every one of them is a real product word used correctly elsewhere. What
 * makes them wrong here is that they describe machinery this customer does not
 * have, and a screen that uses them tells a villa owner that the product is
 * for somebody bigger — which is precisely the reaction the progressive
 * complexity story exists to prevent.
 *
 * `mode.test.ts` asserts the `simple` vocabulary contains none of these, and
 * the screens' own copy is checked against the same list.
 */
export const FORBIDDEN_IN_SIMPLE: readonly string[] = [
  'ספק', // provider
  'מכבסה', // laundry company — there isn't one
  'מלאי', // stock
  'מחסן', // warehouse
  'לוגיסטיקה', // logistics
  'משלוח', // dispatch / shipment
  'איסוף', // collection — implies a van
  'הזמנה', // order
  'חשבונית', // invoice
  'אצווה', // batch, in the industrial sense
]

/**
 * Does this text use a word the `simple` mode has no business showing.
 *
 * Returns the offending words rather than a boolean, because the useful
 * failure message names them.
 */
export function forbiddenSimpleWords(text: string): readonly string[] {
  return FORBIDDEN_IN_SIMPLE.filter((word) => text.includes(word))
}
