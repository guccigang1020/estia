/**
 * The four states the portal could not express: held, in-stay, cancelled — and
 * the phase question all three are answers to.
 *
 * ── EXECUTION CONTEXT — pure, and deliberately client-safe ────────────────
 *
 * No database, no clock of its own, no server import. Every function here
 * takes the journey it was given and a `now`, and returns the same answer for
 * the same arguments. That is not an aesthetic: the hold countdown ticks in
 * the browser, and the only way the ticking number and the server's first
 * render can agree is if both call the same function. A Client Component may
 * import this leaf. It may NOT import `@/lib/guest-journey`, which reaches the
 * Postgres driver and takes every route down.
 *
 * ── What this file is NOT allowed to do ───────────────────────────────────
 *
 * It does not gate a secret. The address, the directions, the parking, the
 * access code and the wifi password come back from `guest_portal_journey` as
 * SQL NULL until the release policy allows it — §9 of migration 0034 — and
 * nothing below re-implements that. A null field is a WITHHELD field, and the
 * honest rendering is a sentence saying so, never a placeholder that implies
 * we know the value.
 *
 * There is one exception and it is a subtraction, not an addition:
 * `redactCancelledJourney` and `cancelledPortalView` strip fields the database
 * is still willing to return. See §cancelled — that is defence in depth
 * against a real gap, and it can only ever remove disclosure.
 *
 * ── Why the phase is derived here and not read from a column ──────────────
 *
 * `bookings.status` has twenty members and the portal has five shapes. Mapping
 * one onto the other in each screen is how `checked_out` comes to mean
 * "during the stay" on one page and "after it" on another. So it is decided
 * once, in `guestPortalPhase`, and every screen asks that.
 */

import {
  addDays,
  formatDayMonth,
  formatDayMonthYear,
  formatRange,
  parseIsoDate,
} from '../booking/dates'
import type { PaymentStatus } from '../contracts/states'
// Type-only, and that is the whole relationship. This module reads a decision
// somebody else made; it never calls the resolver and never re-derives one.
// A `import { resolveCollectionPolicy }` on this line would be the second
// opinion about what a guest owes that `payments/resolver.ts` exists to stop.
import type { CollectionDecision } from '../payments/resolver'
import { formatAgorot } from '../plans/plan'

import type { GuestArrival, GuestJourney, GuestStay } from './types'

// ── §1 · Which of the five screens is this ────────────────────────────────

/**
 * The shapes the portal takes.
 *
 * `pre_arrival` is the one the existing screens already build — confirm, sign,
 * pay, complete details, learn where the house is. The other four are what
 * this module adds.
 */
export const GUEST_PORTAL_PHASES = [
  'hold',
  'pre_arrival',
  'in_stay',
  'post_stay',
  'cancelled',
] as const

export type GuestPortalPhase = (typeof GUEST_PORTAL_PHASES)[number]

/** Statuses where nothing further will happen and the portal says so plainly. */
const CANCELLED_STATUSES: ReadonlySet<string> = new Set([
  'cancelled',
  'no_show',
])

/**
 * Held for a named guest, not yet committed.
 *
 * Exactly one status, and `BOOKING_STATUSES` says why in its own comment:
 * an option holds a date, an enquiry does not. A quote is a price somebody was
 * given, not a claim on the calendar, and telling that guest "התאריכים נשמרו
 * עבורך" would be a promise the business never made.
 */
const HELD_STATUSES: ReadonlySet<string> = new Set(['option'])

/**
 * The stay is over as a matter of record, whatever the calendar says.
 *
 * Checked before `inStay`, and that order is the point: a guest who left on
 * the third night of five is `checked_out` while the projection's `inStay` is
 * still true by date. Reading `inStay` first would show them the wifi password
 * for a house they are no longer in.
 */
const DEPARTED_STATUSES: ReadonlySet<string> = new Set([
  'checked_out',
  'inspection',
  'deposit_release',
  'completed',
  'review_requested',
])

export function guestPortalPhase(
  journey: GuestJourney,
  now: Date,
): GuestPortalPhase {
  const { status, checkOut, inStay } = journey.current

  if (CANCELLED_STATUSES.has(status)) return 'cancelled'
  if (HELD_STATUSES.has(status)) return 'hold'
  if (DEPARTED_STATUSES.has(status)) return 'post_stay'

  // The projection's own answer, computed in SQL from the status and the
  // calendar together. Trusted rather than recomputed — an early check-in is
  // ordinary and the database is the side that knows about it.
  if (inStay) return 'in_stay'

  // Half-open, exactly as `bookings.stay` is: the departure date is not a
  // night of the stay, so on the morning of check-out the portal has already
  // become the post-stay screen.
  if (todayAtProperty(now) >= checkOut) return 'post_stay'

  return 'pre_arrival'
}

/**
 * Today, at the property.
 *
 * `localDate` in `booking/dates` is the canonical implementation and takes a
 * time zone; this narrows to the same default it uses. At 22:30 UTC it is
 * already tomorrow in Israel, and a guest whose stay ended this morning must
 * not see the during-stay screen for another two hours.
 */
function todayAtProperty(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

// ── §2 · The hold ─────────────────────────────────────────────────────────

/**
 * What the portal knows about a claim on the dates.
 *
 * A narrow shape rather than `Hold` from the booking core, and the reason is
 * that the two are not the same object. `public.holds` claims a UNIT before a
 * booking exists; what the portal is looking at is a BOOKING in status
 * `option`, which is the same promise made after the guest has a name. There
 * is no hold row to read.
 *
 * ── The column that does not exist yet ────────────────────────────────────
 *
 * `guest_portal_journey` projects no expiry, and `bookings` carries none. So
 * `expiresAt: null` is the shipped reality until somebody adds one, and it is
 * modelled as a first-class state rather than as a missing field: an undated
 * hold gets the truthful sentence and NO countdown. Inventing a deadline
 * would be the same class of lie as inventing availability.
 */
export type GuestHold = {
  /** ISO instant the claim lapses. Null when no deadline is known. */
  expiresAt: string | null
  /** Somebody gave the dates back. */
  releasedAt: string | null
  /** The hold became a booking. */
  convertedToBookingId: string | null
}

/** What the portal has today: a held booking with no deadline it can show. */
export const UNDATED_GUEST_HOLD: GuestHold = {
  expiresAt: null,
  releasedAt: null,
  convertedToBookingId: null,
}

export type GuestHoldState =
  /** The dates are held and a deadline is known. */
  | 'live'
  /** The dates are held and no deadline is known. */
  | 'undated'
  /** The claim is over. The dates are back on sale. */
  | 'lapsed'

/**
 * Is the claim still standing?
 *
 * The three rules are `isHoldLive`'s in `src/lib/booking/holds.ts`, which is
 * the authority, and `stay.test.ts` asserts this function agrees with it on
 * every combination rather than trusting the comment. They are restated here
 * rather than imported because `isHoldLive` takes a whole `Hold` — a unit id,
 * an organization, a reason — none of which the portal has or should have.
 *
 *   1. released       → over
 *   2. converted      → over
 *   3. expiry passed  → over, strictly: a hold expiring at 14:30:00 does not
 *                       hold at 14:30:00
 *
 * An unparseable expiry is treated as lapsed, matching `isHoldLive`: the safe
 * reading is the one that frees inventory, and on this screen it is also the
 * one that does not show a guest a countdown made of `NaN`.
 */
export function guestHoldState(hold: GuestHold, now: Date): GuestHoldState {
  if (hold.releasedAt !== null) return 'lapsed'
  if (hold.convertedToBookingId !== null) return 'lapsed'
  if (hold.expiresAt === null) return 'undated'

  const expires = Date.parse(hold.expiresAt)
  if (Number.isNaN(expires)) return 'lapsed'

  return expires > now.getTime() ? 'live' : 'lapsed'
}

/**
 * Milliseconds left, floored at zero.
 *
 * Zero and negative collapse to zero on purpose. The countdown in the browser
 * recomputes this every second and a negative number would render as a clock
 * running backwards past the deadline — which is the exact failure the brief
 * names: a countdown that keeps running after expiry is worse than no hold
 * screen at all.
 */
export function guestHoldRemainingMs(hold: GuestHold, now: Date): number {
  if (guestHoldState(hold, now) !== 'live' || hold.expiresAt === null) return 0
  return Math.max(0, Date.parse(hold.expiresAt) - now.getTime())
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The remaining time, in Hebrew, with the duals a Hebrew reader expects.
 *
 * שעה · שעתיים · 3 שעות, and not `1 שעות`. Rounded DOWN at every unit, because
 * a guest told they have two hours when they have two hours and fifty seconds
 * is being told something true; the reverse is not.
 */
export function formatHoldRemaining(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'פחות מדקה'

  if (ms >= DAY) {
    const days = Math.floor(ms / DAY)
    const hours = Math.floor((ms % DAY) / HOUR)
    const head = days === 1 ? 'יום' : days === 2 ? 'יומיים' : `${days} ימים`
    if (hours === 0) return head
    return conjoin(head, countHours(hours))
  }

  if (ms >= HOUR) {
    const hours = Math.floor(ms / HOUR)
    const minutes = Math.floor((ms % HOUR) / MINUTE)
    if (minutes === 0) return countHours(hours)
    return conjoin(countHours(hours), countMinutes(minutes))
  }

  const minutes = Math.floor(ms / MINUTE)
  if (minutes <= 0) return 'פחות מדקה'
  return countMinutes(minutes)
}

/**
 * `ושעה`, but `ו-12 דקות`.
 *
 * The vav joins straight onto a word and takes a hyphen only before a numeral,
 * where running it into the digits produces something nobody reads as Hebrew.
 * Both forms appear on this screen — `שעתיים ו-12 דקות` and `יומיים ושעה` —
 * so which one is used is decided by the following character, not by the unit.
 */
function conjoin(head: string, tail: string): string {
  return /^\d/.test(tail) ? `${head} ו-${tail}` : `${head} ו${tail}`
}

function countHours(hours: number): string {
  if (hours === 1) return 'שעה'
  if (hours === 2) return 'שעתיים'
  return `${hours} שעות`
}

function countMinutes(minutes: number): string {
  if (minutes === 1) return 'דקה'
  if (minutes === 2) return 'שתי דקות'
  return `${minutes} דקות`
}

/** The one thing a held screen asks. Never two. */
export type GuestHoldAction = {
  id: 'confirm' | 'contact'
  label: string
  /** Relative to the portal root. Null when the action is not a navigation. */
  path: string | null
}

export type GuestHoldView = {
  state: GuestHoldState
  headline: string
  body: string
  /** `3.9–7.9`, the dates being held. */
  stayLabel: string
  /**
   * The deadline, for a `<time>` element and for the browser's own clock.
   * **Null unless the state is `live`** — a lapsed deadline is not a deadline,
   * and handing one to a countdown is how the timer keeps running past zero.
   */
  expiresAt: string | null
  /** Null unless `live`. Recomputed in the browser by the same function. */
  remainingMs: number | null
  /** Null unless `live`. `שעתיים ו-12 דקות`. */
  remaining: string | null
  action: GuestHoldAction
  /**
   * The sentence under the action. On a lapsed hold this is where the honest
   * limit of what we know goes, rather than in a button that cannot succeed.
   */
  note: string
}

/**
 * The held screen.
 *
 * ── Why a lapsed hold offers a conversation and not a button ──────────────
 *
 * The brief asks for "check again or contact the business", and only one of
 * those is a thing this product can currently do. There is no availability
 * port wired into the portal — `NO_REBOOK_PORT` returns nothing by design —
 * so a "בדוק שוב" button would either lie about a free date or fail. Offering
 * to reach the business is an action that actually succeeds, and the note
 * says the dates may be gone rather than implying they are still there.
 */
export function guestHoldView(
  journey: GuestJourney,
  hold: GuestHold,
  now: Date,
): GuestHoldView {
  const state = guestHoldState(hold, now)
  const stayLabel = formatRange({
    checkIn: journey.current.checkIn,
    checkOut: journey.current.checkOut,
  })

  if (state === 'lapsed') {
    return {
      state,
      headline: 'ההחזקה על התאריכים הסתיימה',
      body:
        `התאריכים ${stayLabel} כבר אינם שמורים עבורך, והם חזרו למכירה. ` +
        'איננו יכולים לדעת מכאן אם הם עדיין פנויים.',
      stayLabel,
      expiresAt: null,
      remainingMs: null,
      remaining: null,
      action: { id: 'contact', label: 'פנייה לבית האירוח', path: null },
      note: 'בית האירוח יבדוק את הזמינות ויחזור אליך עם תשובה.',
    }
  }

  if (state === 'undated') {
    return {
      state,
      headline: 'התאריכים נשמרו עבורך',
      body:
        `התאריכים ${stayLabel} שמורים על שמך. ` +
        'בית האירוח לא קבע מועד אחרון לאישור.',
      stayLabel,
      expiresAt: null,
      remainingMs: null,
      remaining: null,
      action: { id: 'confirm', label: 'אישור ההזמנה', path: '' },
      note: 'עם האישור ההזמנה תיסגר והתאריכים יהיו שלך.',
    }
  }

  const remainingMs = guestHoldRemainingMs(hold, now)

  return {
    state,
    headline: 'התאריכים נשמרו עבורך',
    body: `התאריכים ${stayLabel} שמורים על שמך עד ${formatDeadline(hold.expiresAt)}.`,
    stayLabel,
    expiresAt: hold.expiresAt,
    remainingMs,
    remaining: formatHoldRemaining(remainingMs),
    action: { id: 'confirm', label: 'אישור ההזמנה', path: '' },
    note: 'לאחר מכן התאריכים חוזרים למכירה ולא נוכל להבטיח אותם.',
  }
}

function formatDeadline(iso: string | null): string {
  if (iso === null) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''

  const time = new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at)
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)

  return `${formatDayMonthYear(date)} בשעה ${time}`
}

// ── §3 · During the stay ──────────────────────────────────────────────────

/**
 * The sections of the guide, in the order a guest needs them.
 *
 * Wifi first and by a distance. It is the single most requested piece of
 * information in any short stay, and burying it under the house rules is how
 * somebody ends up telephoning at eleven at night.
 */
export const GUEST_STAY_SECTION_IDS = [
  'wifi',
  'access',
  'guide',
  'house_rules',
  'emergency',
  'requests',
  'checkout',
] as const

export type GuestStaySectionId = (typeof GUEST_STAY_SECTION_IDS)[number]

/**
 * One section, with content the property actually configured.
 *
 * `fields` carries values that are read character by character — a network
 * name, a password, a door code — and are therefore rendered LTR and
 * monospaced by the component. `body` is prose.
 *
 * There is no `pending` and no `placeholder` member, on purpose. A section
 * with nothing configured is not emitted, so there is no shape in which this
 * type can carry "we would tell you but we cannot".
 */
export type GuestStaySection = {
  id: GuestStaySectionId
  title: string
  body: string | null
  fields: { label: string; value: string; verbatim: boolean }[]
}

/**
 * The guide, as this property configured it.
 *
 * ── Nothing here is invented ──────────────────────────────────────────────
 *
 * Air conditioning, the pool, the jacuzzi, the barbecue, the hot water, the
 * Shabbat equipment, the rubbish, the quiet hours — every one of those is
 * words a property wrote into `guest_journey_content.property_guide`, and this
 * function renders that text or omits the section. There is no default guide
 * and no list of topics with empty bodies beside them: a guest reading
 * "מיזוג אוויר" with nothing under it learns that the screen is generated
 * rather than written for them, and stops reading the parts that were.
 *
 * ── Withheld is not the same as absent, and neither is rendered ───────────
 *
 * Before the stay begins the wifi fields come back as SQL NULL, so nothing
 * matches and nothing is emitted. That is correct, and `staySealedNotice` is
 * the one sentence that explains it — placed once at the top of the screen
 * rather than as five greyed-out boxes.
 */
export function buildStaySections(journey: GuestJourney): GuestStaySection[] {
  // No `arrival` here on purpose: the access section is `guestAccessView`'s
  // answer, and reaching into `journey.arrival` from this function again is
  // how the door code comes to have two renderings that disagree about when
  // it stops working.
  const { stay, settings, checkout } = journey
  const topics = new Set(settings.duringStayTopics)
  const sections: GuestStaySection[] = []

  if (topics.has('wifi') && stay.wifiNetwork) {
    sections.push({
      id: 'wifi',
      title: 'רשת אלחוטית',
      body: null,
      fields: [
        { label: 'שם הרשת', value: stay.wifiNetwork, verbatim: true },
        // Absent when the property configured a network and no password — an
        // open network is a real configuration, not a missing field.
        ...(stay.wifiPassword
          ? [{ label: 'סיסמה', value: stay.wifiPassword, verbatim: true }]
          : []),
      ],
    })
  }

  if (topics.has('access')) {
    // Delegated rather than rebuilt. `guestAccessView` is the one answer to
    // "how does this guest get in", and a second assembly of the code and its
    // window here is how the during-stay screen and the arrival screen come to
    // disagree about when a door code stops working.
    const access = guestAccessView(journey)
    if (access) {
      sections.push({
        id: 'access',
        title: 'כניסה לנכס',
        body: access.instructions,
        fields: [
          ...(access.code
            ? [{ label: 'קוד כניסה', value: access.code, verbatim: true }]
            : []),
          ...(access.validity
            ? [{ label: 'תוקף', value: access.validity, verbatim: false }]
            : []),
        ],
      })
    }
  }

  if (topics.has('guide') && stay.propertyGuide) {
    sections.push({
      id: 'guide',
      title: 'מדריך הנכס',
      body: stay.propertyGuide,
      fields: [],
    })
  }

  // House rules and the emergency contact are not in `during_stay_topics` —
  // that vocabulary is `{wifi,guide,access,checkout}`. They are governed by
  // whether the property wrote them, which is the same rule by a shorter road.
  if (stay.houseRules) {
    sections.push({
      id: 'house_rules',
      title: 'כללי הבית',
      body: stay.houseRules,
      fields: [],
    })
  }

  if (stay.emergencyContact) {
    sections.push({
      id: 'emergency',
      title: 'מקרה חירום',
      body: stay.emergencyContact,
      fields: [],
    })
  }

  if (settings.requestsEnabled && settings.requestCategories.length > 0) {
    sections.push({
      id: 'requests',
      title: 'בקשה במהלך השהות',
      body: 'מגבות, מצעים, ניקיון או תקלה — נטפל בזה.',
      fields: [],
    })
  }

  if (topics.has('checkout') && (checkout.instructions || checkout.enabled)) {
    sections.push({
      id: 'checkout',
      title: 'יציאה מהנכס',
      body: checkout.instructions,
      fields: checkout.checkOutTime
        ? [
            {
              label: 'שעת יציאה',
              value: shortTime(checkout.checkOutTime),
              verbatim: false,
            },
          ]
        : [],
    })
  }

  return sections
}

/** `11:00:00` → `11:00`. The seconds are a column type, not information. */
function shortTime(value: string): string {
  return value.slice(0, 5)
}

const HEBREW_WEEKDAY = [
  'יום א׳',
  'יום ב׳',
  'יום ג׳',
  'יום ד׳',
  'יום ה׳',
  'יום ו׳',
  'שבת',
] as const

/**
 * `2026-09-07` → `יום ב׳`.
 *
 * UTC arithmetic on a date-only string, on the rule stated at the head of
 * `dates.ts`: a stay date is a calendar date at the property, and running it
 * through the local `Date` constructor names the wrong day for anybody west of
 * Greenwich — which on this screen means a door code advertised as valid until
 * the wrong morning.
 */
export function hebrewWeekday(iso: string): string | null {
  const date = parseIsoDate(iso)
  return date ? HEBREW_WEEKDAY[date.getUTCDay()] : null
}

export type GuestAccessView = {
  /**
   * The door code, or null.
   *
   * Null is the ordinary case twice over: most properties have no smart lock,
   * and those that do get SQL NULL here until `guest_arrival_released` allows
   * it. This type does not distinguish "withheld" from "does not exist", and
   * that is deliberate — the guest is not told which, so no component can leak
   * a distinction it was never handed.
   */
  code: string | null
  /** `מ-15:00 עד יום ב׳ 11:00`. Null when the property configured no times. */
  validity: string | null
  /** The words the business wrote: the key box, meeting the host, ringing on arrival. */
  instructions: string | null
  /** True when there is no code and the instructions are the whole answer. */
  manualOnly: boolean
}

/**
 * How this guest gets in, and for how long.
 *
 * ── The window is the half of this that was missing ───────────────────────
 *
 * A code with no stated validity is a code a guest assumes works until they
 * leave — including on the morning they are locked out at 11:05 because the
 * lock rotated at check-out time. The window is built from the two times the
 * property already configures (`default_check_in_time`, `default_check_out_time`,
 * with the booking's own arrival time winning where it has one) and the stay's
 * departure date. Nothing is invented: with either time missing, no window is
 * claimed at all.
 *
 * ── Null, so that rendering it is always safe ─────────────────────────────
 *
 * Returns null when there is neither a code nor instructions, which is what
 * lets a caller render this unconditionally and never produce an empty card.
 * The gating that matters is not here and cannot be — it is
 * `guest_arrival_released` in SQL, and deleting a condition in a template
 * yields a blank row rather than somebody's front door.
 *
 * A cancelled or no-show booking is refused before anything else is read.
 * `guest_arrival_released` tests neither status, so the projection will happily
 * hand over a live door code for a booking the business has written off; this
 * is the second of the two places that removes it.
 */
export function guestAccessView(journey: GuestJourney): GuestAccessView | null {
  if (CANCELLED_STATUSES.has(journey.current.status)) return null

  const { accessCode, accessInstructions, checkInTime } = journey.arrival
  if (!accessCode && !accessInstructions) return null

  const from = checkInTime ? shortTime(checkInTime) : null
  const until = journey.checkout.checkOutTime
    ? shortTime(journey.checkout.checkOutTime)
    : null
  const weekday = hebrewWeekday(journey.current.checkOut)

  return {
    code: accessCode,
    validity:
      from && until
        ? weekday
          ? `מ-${from} עד ${weekday} ${until}`
          : `מ-${from} עד ${until} ביום העזיבה`
        : null,
    instructions: accessInstructions,
    manualOnly: accessCode === null,
  }
}

/**
 * The one sentence that explains an empty guide before the stay begins.
 *
 * Null once the stay has begun, and null when the guide would be empty anyway
 * — promising that details "will appear" for a property that configured none
 * is a promise nobody can keep, and the guest finds out at eleven at night.
 */
export function staySealedNotice(journey: GuestJourney): string | null {
  if (journey.stay.inStay) return null
  const topics = new Set(journey.settings.duringStayTopics)
  if (!topics.has('wifi') && !topics.has('guide')) return null
  return 'פרטי הרשת האלחוטית ומדריך הנכס ייפתחו כאן עם תחילת השהות.'
}

// ── §4 · Money in an unknown state ────────────────────────────────────────

/**
 * The sentence a timed-out provider gets. Word for word.
 *
 * `PAYMENT_STATUSES` puts it plainest: a processor that times out has either
 * charged the card or not, and we cannot tell. Reporting that as `failed` is
 * how a guest is charged twice on the retry — so `unknown` never renders the
 * word נכשל anywhere in this module, and `stay.test.ts` asserts it.
 */
export const PAYMENT_UNKNOWN_NOTICE =
  'אנחנו בודקים את סטטוס התשלום. אין לבצע תשלום נוסף כרגע.'

export type GuestPaymentNotice = {
  tone: 'info' | 'success' | 'warning' | 'danger'
  message: string
  /**
   * False when the guest must not be offered a way to pay again. `unknown` is
   * the case this exists for: a retry button under "we are checking" is the
   * double charge with an extra step.
   */
  mayRetry: boolean
}

export function paymentNotice(
  status: PaymentStatus | null,
): GuestPaymentNotice | null {
  if (status === null) return null

  switch (status) {
    case 'unknown':
      return {
        tone: 'warning',
        message: PAYMENT_UNKNOWN_NOTICE,
        mayRetry: false,
      }
    case 'pending':
      return {
        tone: 'info',
        message: 'התשלום נרשם וממתין לאישור.',
        mayRetry: false,
      }
    case 'authorized':
      return {
        tone: 'info',
        message: 'התשלום אושר וטרם נגבה.',
        mayRetry: false,
      }
    case 'paid':
      return { tone: 'success', message: 'התשלום התקבל.', mayRetry: false }
    case 'partially_paid':
      return {
        tone: 'info',
        message: 'התקבל תשלום חלקי.',
        mayRetry: true,
      }
    case 'failed':
      return {
        tone: 'danger',
        message: 'התשלום לא עבר. אפשר לנסות שוב.',
        mayRetry: true,
      }
    case 'refunded':
      return { tone: 'info', message: 'הסכום הוחזר במלואו.', mayRetry: false }
    case 'partially_refunded':
      return { tone: 'info', message: 'הוחזר חלק מהסכום.', mayRetry: false }
    case 'cancelled':
      return { tone: 'info', message: 'החיוב בוטל.', mayRetry: false }
  }
}

// ── §5 · Cancelled ────────────────────────────────────────────────────────

/**
 * A cancelled booking's portal, and the reason it is a subtraction.
 *
 * ── The gap this closes ───────────────────────────────────────────────────
 *
 * `guest_arrival_released` in migration 0034 decides disclosure from the
 * release policy, the manual override, and a list of statuses. **`cancelled`
 * and `no_show` are in none of those tests.** So a booking cancelled after
 * the guest confirmed — with `arrival_release = 'after_confirmation'`, the
 * shipped default — still comes back from the projection carrying the
 * address, the directions, the parking and the door code. The link is not
 * revoked by cancelling either: `guest_link_booking`'s four refusals are
 * malformed, missing, revoked and expired, and cancellation is not among them.
 *
 * A revoked door code still on a screen is a security failure, not a cosmetic
 * one. The durable fix is in SQL and belongs to whoever owns the migration —
 * it is reported. Until then this is the layer that removes it, and it can
 * only ever remove: nothing here discloses a field the database withheld.
 *
 * ── What is left on the screen ────────────────────────────────────────────
 *
 * What still matters after a cancellation: that it was cancelled, what happens
 * to the money, who to talk to, and the documents that outlive the booking. A
 * signed contract is one of those — the terms somebody agreed to do not stop
 * existing because the stay did.
 *
 * Arrival instructions, access codes, the wifi, the store and the requests
 * form are all gone. Not disabled. Gone.
 */
export function redactCancelledJourney(journey: GuestJourney): GuestJourney {
  const arrival: GuestArrival = {
    released: false,
    checkInTime: null,
    addressNote: null,
    addressLine1: null,
    addressLine2: null,
    // The city stays, for the same reason §9 of the migration gives for not
    // gating it: it is on the confirmation the guest already holds and in the
    // property's public listing, and withholding it is theatre rather than
    // protection. It is not an address — no street, no number, no map.
    city: journey.arrival.city,
    directions: null,
    mapUrl: null,
    parking: null,
    accessInstructions: null,
    accessCode: null,
  }

  const stay: GuestStay = {
    inStay: false,
    wifiNetwork: null,
    wifiPassword: null,
    propertyGuide: null,
    houseRules: null,
    emergencyContact: null,
  }

  return {
    ...journey,
    arrival,
    stay,
    // The requests list goes with the stay. A cancelled booking with an open
    // towel request on screen invites somebody to add another.
    requests: [],
    checkout: {
      checkOutTime: null,
      instructions: null,
      declaredAt: journey.checkout.declaredAt,
      enabled: false,
    },
  }
}

/** A thing that still exists after the booking does not. */
export type GuestCancelledDocument = {
  id: 'contract'
  title: string
  /** When it was signed. The document's own date, not the cancellation's. */
  signedAt: string
  path: string
}

/**
 * What the money is doing. Supplied by the caller, because no refund state is
 * projected today — see the note at the foot of this file.
 */
export type GuestRefundInput = {
  status: PaymentStatus | null
  amountAgorot: number | null
}

export type GuestCancelledView = {
  headline: string
  body: string
  stayLabel: string
  /** The refund sentence, or null when there is nothing true to say. */
  refund: GuestPaymentNotice | null
  refundAmountAgorot: number | null
  documents: GuestCancelledDocument[]
  action: { id: 'contact'; label: string }
}

/**
 * The cancelled screen's whole payload.
 *
 * Note the type: there is no address field, no access code field, no wifi
 * field and no store link on `GuestCancelledView`. The redaction above is the
 * belt; this shape is the braces. A future edit that wanted to put a door code
 * back on this screen would have to add a member to a type whose comment says
 * why it has none.
 */
export function cancelledPortalView(
  journey: GuestJourney,
  refund: GuestRefundInput = { status: null, amountAgorot: null },
): GuestCancelledView {
  const stayLabel = `${formatDayMonthYear(journey.current.checkIn)} – ${formatDayMonthYear(journey.current.checkOut)}`

  const documents: GuestCancelledDocument[] = journey.contract.signature
    ? [
        {
          id: 'contract',
          title: journey.contract.signature.title,
          signedAt: journey.contract.signature.signedAt,
          path: 'contract',
        },
      ]
    : []

  return {
    headline: 'ההזמנה בוטלה',
    body:
      `ההזמנה לתאריכים ${stayLabel} בוטלה. ` +
      'הפרטים להגעה ולכניסה לנכס אינם זמינים עוד.',
    stayLabel,
    refund: paymentNotice(refund.status),
    refundAmountAgorot: refund.amountAgorot,
    documents,
    action: { id: 'contact', label: 'פנייה לבית האירוח' },
  }
}

// ── §6 · The payment schedule ─────────────────────────────────────────────

/**
 * ── This section computes no policy. Read that sentence twice ─────────────
 *
 * `resolveCollectionPolicy` is the only implementation in this product of
 * "what must happen before this booking is confirmed" — organization default,
 * then per-booking override replacing it whole. Everything below reads a
 * `CollectionDecision` that function already produced. There is no percentage
 * arithmetic here, no `switch` on `decision.policy`, and no second opinion
 * about the deposit. What this section does is turn one number and one
 * deadline into rows a person on a telephone can check against their bank.
 *
 * The failure it is written against is specific and it is expensive: the desk
 * believes a deposit was waived, the guest's screen asks for it, and there is
 * no record that can settle which is right. That is what one resolver prevents,
 * and it only prevents it while files like this one stay consumers.
 */

export type GuestInstalmentState = 'paid' | 'due' | 'overdue' | 'upcoming'

export type GuestInstalment = {
  id: 'deposit' | 'balance' | 'total'
  label: string
  amountAgorot: number
  /** `₪2,400`, through the product's one rounding rule. */
  amountLabel: string
  state: GuestInstalmentState
  /** `YYYY-MM-DD`, when the policy names a deadline. Null when it does not. */
  dueDate: string | null
  /** `שולם` · `לתשלום עד 12.9` · `לתשלום לאישור ההזמנה`. */
  detail: string
}

export type GuestPaymentSchedule = {
  /** `30% בעת ההזמנה · 70% עד 3 ימים לפני ההגעה`. Null when there is no split. */
  policyLabel: string | null
  instalments: GuestInstalment[]
  totalAgorot: number
  /**
   * `₪7,500`.
   *
   * Formatted here and not in the component, for the same reason the
   * instalments carry an `amountLabel`: `formatAgorot` is the product's one
   * rounding rule, and a `/ 100` written in a template is the beginning of a
   * second one that will disagree with this one on the first booking whose
   * total is not a round number of shekels.
   */
  totalLabel: string
  paidAgorot: number
  outstandingAgorot: number
}

/**
 * The percentages, for the one-line summary and for nothing else.
 *
 * Derived from the amounts the resolver produced rather than read from
 * `depositPercentBps` — which this module is not given and should not be. A
 * business with a flat ₪1,500 deposit on a ₪7,000 stay gets a truthful "21%
 * בעת ההזמנה", and there is no second place where a percentage could come to
 * disagree with the money printed beside it.
 */
function splitLabel(
  depositAgorot: number,
  totalAgorot: number,
  balanceDueDaysBefore: number | null,
): string | null {
  if (totalAgorot <= 0 || depositAgorot <= 0) return null
  if (depositAgorot >= totalAgorot) return null

  const deposit = Math.round((depositAgorot / totalAgorot) * 100)
  const when =
    balanceDueDaysBefore === null
      ? 'לפני ההגעה'
      : balanceDueDaysBefore === 0
        ? 'ביום ההגעה'
        : balanceDueDaysBefore === 1
          ? 'עד יום לפני ההגעה'
          : `עד ${balanceDueDaysBefore} ימים לפני ההגעה`

  return `${deposit}% בעת ההזמנה · ${100 - deposit}% ${when}`
}

export type GuestPaymentScheduleInput = {
  journey: GuestJourney
  /** From `resolveCollectionPolicy`. Never rebuilt, never second-guessed. */
  decision: CollectionDecision
  now: Date
  /**
   * What has actually been collected, if the caller knows it.
   *
   * Optional, and the fallback is stated rather than buried: absent, what has
   * been paid TOWARDS THE AMOUNT DUE NOW is recovered from the decision as
   * `dueNowAgorot - shortfallAgorot`. That is exact for the deposit row and
   * says nothing about money paid beyond it — so a guest who settled the whole
   * stay by bank transfer against a deposit-only policy still sees the balance
   * as outstanding. That is the direction that costs a telephone call. The
   * other one tells somebody they are square when they are not.
   *
   * `GuestCollection` does not carry the figure today; `collection.ts` builds
   * `CollectionFacts`, hands them to the resolver and keeps none of them. One
   * field on that type closes this, and it belongs to another owner — so it is
   * reported rather than routed around.
   */
  settledAgorot?: number
}

/**
 * What is paid, what is due, and by when.
 *
 * Null when the business asks for nothing in advance and nothing has been
 * collected. `policy: 'none'` is what the frozen contract calls a legitimate
 * and common configuration — most of this market — and a card reading "₪0
 * שולם" on a guesthouse booking is an empty card with extra steps.
 */
export function guestPaymentSchedule(
  input: GuestPaymentScheduleInput,
): GuestPaymentSchedule | null {
  const { decision, journey } = input
  const totalAgorot = journey.current.totalAgorot
  const dueNow = decision.dueNowAgorot
  const settled =
    input.settledAgorot ?? Math.max(0, dueNow - decision.shortfallAgorot)

  // Nothing asked and nothing arrived. Say nothing.
  if (dueNow <= 0 && settled <= 0) return null
  // A booking whose price lines were never entered. Percentages of zero are
  // not information, and `₪0` on a payment card starts an argument.
  if (totalAgorot <= 0) return null

  const dueDate =
    decision.balanceDueDaysBefore !== null &&
    parseIsoDate(journey.current.checkIn) !== null
      ? addDays(journey.current.checkIn, -decision.balanceDueDaysBefore)
      : null

  const today = todayAtProperty(input.now)
  const instalments: GuestInstalment[] = []

  if (dueNow >= totalAgorot) {
    // Everything up front. One row — two rows for one payment only invite the
    // reader to add them together and get the total twice.
    const paid = settled >= totalAgorot
    instalments.push({
      id: 'total',
      label: 'תשלום מלא',
      amountAgorot: totalAgorot,
      amountLabel: formatAgorot(totalAgorot),
      state: paid ? 'paid' : 'due',
      dueDate: null,
      detail: paid ? 'שולם' : 'לתשלום לאישור ההזמנה',
    })
  } else {
    const depositPaid = settled >= dueNow
    instalments.push({
      id: 'deposit',
      label: 'מקדמה',
      amountAgorot: dueNow,
      amountLabel: formatAgorot(dueNow),
      state: depositPaid ? 'paid' : 'due',
      dueDate: null,
      detail: depositPaid ? 'שולם' : 'לתשלום לאישור ההזמנה',
    })

    const balance = totalAgorot - dueNow
    if (balance > 0) {
      // Marked paid only when the money is known to have covered the whole
      // stay. Short of that the product does not know the balance arrived, so
      // it states the thing it does know, which is the deadline.
      const paid = settled >= totalAgorot
      const late = !paid && dueDate !== null && dueDate < today

      instalments.push({
        id: 'balance',
        label: 'יתרה',
        amountAgorot: balance,
        amountLabel: formatAgorot(balance),
        state: paid ? 'paid' : late ? 'overdue' : 'upcoming',
        dueDate,
        detail: paid
          ? 'שולם'
          : dueDate === null
            ? 'לתשלום לפני ההגעה'
            : late
              ? // Never "באיחור". The guest may have paid by transfer three
                // days ago and be waiting for somebody to record it; accusing
                // them is how a portal loses the room.
                `מועד התשלום היה ${formatDayMonth(dueDate)}`
              : `לתשלום עד ${formatDayMonth(dueDate)}`,
      })
    }
  }

  return {
    policyLabel: splitLabel(
      dueNow >= totalAgorot ? 0 : dueNow,
      totalAgorot,
      decision.balanceDueDaysBefore,
    ),
    instalments,
    totalAgorot,
    totalLabel: formatAgorot(totalAgorot),
    paidAgorot: Math.min(settled, totalAgorot),
    outstandingAgorot: Math.max(0, totalAgorot - settled),
  }
}

/**
 * ── Three things this module is waiting on, stated where they will be found ─
 *
 * 1. **A hold deadline.** `guest_portal_journey` projects no expiry and
 *    `bookings` carries no column for one, so every held booking today is
 *    `undated` and gets no countdown. One column — `bookings.option_expires_at`
 *    — plus one line in the projection turns every held screen live, and
 *    `guestHoldView` already handles it.
 *
 * 2. **A refund state.** `GuestRefundInput` is an argument rather than a read
 *    for the same reason: nothing in 0034 projects what happened to the money
 *    after a cancellation. Passing `{ status: null }` renders no claim about
 *    it at all, which is the honest default and the shipped one.
 *
 * 3. **What has actually been collected.** `guestPaymentSchedule` recovers it
 *    from `dueNowAgorot - shortfallAgorot`, which is exact up to the amount
 *    due and blind beyond it. `GuestCollection` builds `CollectionFacts`,
 *    hands them to the resolver and keeps none — one field carrying
 *    `settledAgorot` through would let the balance row say `שולם` for a guest
 *    who paid everything by transfer.
 *
 * None of the three is faked. A screen that shows a countdown from a guessed
 * deadline, a refund from an assumed status, or a balance marked paid on an
 * inference, is worse than a screen that says less.
 */
