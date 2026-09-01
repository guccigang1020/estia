/**
 * Can this product actually be offered on THIS booking?
 *
 * Being in the catalogue is not the question. Late checkout can only be sold
 * where no conflicting booking arrives that morning and the cleaning schedule
 * allows it; pool heating only where the property has the capability and the
 * lead time is met; an extra mattress only where capacity allows. A store that
 * lists what it cannot deliver produces an angry telephone call on the day,
 * and the owner is the one who takes it.
 *
 * ── Every input is configuration, none is a constant ──────────────────────
 *
 * Nothing in this file knows what "late checkout" is. It reads
 * `leadTimeHours`, `capacityPerDay`, `maxPerBooking`, `requiresCapability`,
 * the guest band, the property override and the availability rules, and those
 * columns are what make one row behave like late checkout and another like a
 * bottle of wine.
 *
 * ── The two ports, and why they are ports ─────────────────────────────────
 *
 * Two of the questions above cannot be answered from this module's own tables:
 *
 *   · **Occupancy** — "is somebody arriving into this unit tomorrow, and does
 *     housekeeping have room?" belongs to the booking calendar and the
 *     preparation engine, which are two other workers' modules and are being
 *     written right now.
 *   · **Usage** — "how many of these have already been sold for that day?"
 *     is this module's own, and is passed in rather than queried so that the
 *     evaluator stays a pure function the tests can drive.
 *
 * So `OccupancyPort` is declared here, `nullOccupancy` is shipped as its
 * implementation, and the null implementation is DELIBERATELY PERMISSIVE about
 * nothing: it reports "unknown", and `evaluateEligibility` treats an unknown
 * occupancy as a reason to offer the product *with a caveat* rather than
 * either to hide it or to promise it. Hiding it would take a real sale away
 * from a business whose calendar module is not wired yet; promising it would
 * make the product lie. The caveat is rendered on screen.
 *
 * ── The answer is never a boolean ─────────────────────────────────────────
 *
 * `EligibilityVerdict` carries a reason, and the reasons are Hebrew sentences
 * a guest can act on. "אפשר להזמין עד 48 שעות לפני ההגעה" is a product; a
 * greyed-out card with no explanation is a support ticket.
 */

import type {
  BookingFacts,
  CatalogueItem,
  StoreAvailabilityRule,
  StoreItemPropertyOverride,
  StoreSettings,
} from './types'
import { partySize } from './types'
import { nightsBetween } from './pricing'

/* ------------------------------------------------------------------ port -- */

/**
 * What the calendar and the preparation engine know and this module does not.
 *
 * `unknown` is a first-class answer and is the null implementation's only
 * answer. See the header for why that is neither "yes" nor "no".
 */
export type OccupancyAnswer = 'available' | 'conflicting' | 'unknown'

export type OccupancyFacts = {
  /** Is the unit free for the extra hours a late checkout needs? */
  extendedStay: OccupancyAnswer
  /** Does housekeeping have room in the schedule for the delay? */
  cleaningWindow: OccupancyAnswer
  /** Spare physical capacity — an extra mattress, a cot. `null` is unknown. */
  spareCapacity: number | null
}

/**
 * THE PORT. Implemented by the coordinator once the calendar and preparation
 * modules can answer it; `nullOccupancy` is what this module ships with.
 *
 * Shape, for whoever satisfies it:
 *
 *     (input: {
 *       organizationId: string
 *       propertyId: string
 *       bookingId: string | null
 *       from: Date
 *       to: Date
 *     }) => Promise<OccupancyFacts>
 */
export type OccupancyPort = (input: {
  organizationId: string
  propertyId: string
  bookingId: string | null
  from: Date
  to: Date
}) => Promise<OccupancyFacts>

/**
 * The null implementation. Answers "unknown" to everything, honestly.
 *
 * It does not answer "available", which would be a promise this module has no
 * basis for, and it does not answer "conflicting", which would hide products
 * an owner is genuinely able to sell. Everything downstream is written to
 * carry the uncertainty rather than to resolve it silently.
 */
export const nullOccupancy: OccupancyPort = async () => ({
  extendedStay: 'unknown',
  cleaningWindow: 'unknown',
  spareCapacity: null,
})

/* --------------------------------------------------------------- verdict -- */

export type EligibilityReason =
  | 'store_off'
  | 'guest_store_disabled'
  | 'item_not_active'
  | 'not_offered_here'
  | 'capability_missing'
  | 'lead_time_not_met'
  | 'capacity_full'
  | 'max_per_booking_reached'
  | 'party_too_small'
  | 'party_too_large'
  | 'blocked_by_rule'
  | 'outside_permitted_window'
  | 'not_visible_yet'
  | 'conflicting_booking'
  | 'cleaning_window'
  | 'no_spare_capacity'

/** A caveat is not a refusal. The product is offered and something is said. */
export type EligibilityCaveat =
  'occupancy_unknown' | 'cleaning_unknown' | 'capacity_unknown'

export type EligibilityVerdict = {
  eligible: boolean
  /** Present exactly when `eligible` is false. */
  reason: EligibilityReason | null
  /** Hebrew, guest-facing, and always says what could be done instead. */
  message: string | null
  /** Offered anyway, with something the guest must be told. */
  caveats: readonly EligibilityCaveat[]
  /** The most this booking may still buy. `null` where there is no ceiling. */
  remaining: number | null
}

export type EligibilityInput = {
  item: CatalogueItem
  settings: StoreSettings
  booking: BookingFacts | null
  override: StoreItemPropertyOverride | null
  rules: readonly StoreAvailabilityRule[]
  occupancy: OccupancyFacts
  /** How many of this item are already sold, for the day and for the booking. */
  usage: { onDate: number; onBooking: number }
  /** When the guest wants it. Defaults to the stay's own arrival. */
  serviceAt: Date
  now: Date
  /** Guest-facing evaluation applies visibility rules; staff evaluation does not. */
  audience: 'guest' | 'staff'
}

const HOUR_MS = 3_600_000

/**
 * The whole decision, in the order the refusals matter.
 *
 * Order is deliberate: the cheapest and most certain refusals come first, so
 * that a product hidden because the store is off is never also reported as
 * "not enough lead time", which would tell a guest to come back earlier next
 * time about a shop that does not exist.
 */
export function evaluateEligibility(
  input: EligibilityInput,
): EligibilityVerdict {
  const { item, settings, booking, override, occupancy, usage, audience } =
    input

  // ── 1. Is there a store at all? ────────────────────────────────────────
  if (settings.mode === 'off') {
    return refuse('store_off', 'החנות אינה פעילה כרגע.')
  }
  if (audience === 'guest' && !settings.guestStoreEnabled) {
    return refuse(
      'guest_store_disabled',
      'ההזמנות נעשות מול המארח. אפשר לפנות אלינו ונשמח לסדר.',
    )
  }

  // ── 2. Is the product itself sellable? ─────────────────────────────────
  if (item.status !== 'active') {
    return refuse('item_not_active', 'המוצר אינו זמין להזמנה כרגע.')
  }

  // ── 3. Is it offered at THIS house? ────────────────────────────────────
  // The override's `isAvailable = false` is the strong statement, and it is
  // checked before capability so that an owner who has switched a product off
  // at one property gets that answer rather than a technical one.
  if (override && !override.isAvailable) {
    return refuse(
      'not_offered_here',
      'המוצר הזה אינו מוצע בנכס הזה. אפשר לפנות אלינו ונבדוק מה כן אפשרי.',
    )
  }

  if (
    item.requiresCapability !== null &&
    booking !== null &&
    !booking.propertyCapabilities.includes(item.requiresCapability)
  ) {
    return refuse(
      'capability_missing',
      'הנכס הזה אינו מצויד לשירות הזה. אפשר לפנות אלינו ונציע חלופה.',
    )
  }

  // ── 4. The party ───────────────────────────────────────────────────────
  if (booking !== null) {
    const heads = partySize(booking)
    if (item.minGuests !== null && heads < item.minGuests) {
      return refuse(
        'party_too_small',
        `השירות הזה מיועד ל־${item.minGuests} אורחים ומעלה.`,
      )
    }
    if (item.maxGuests !== null && heads > item.maxGuests) {
      return refuse(
        'party_too_large',
        `השירות הזה מיועד לעד ${item.maxGuests} אורחים. אפשר לפנות אלינו לקבוצה גדולה יותר.`,
      )
    }
  }

  // ── 5. Visibility, for a guest only ────────────────────────────────────
  // A member of staff selling by telephone must be able to see everything the
  // business offers; the visibility rules are about what a guest is shown in
  // their own portal, not about what exists.
  if (audience === 'guest' && booking !== null) {
    const hidden = visibilityRefusal(item, booking, input.now)
    if (hidden) return hidden
  }

  // ── 6. Lead time ───────────────────────────────────────────────────────
  const leadHours = override?.leadTimeHoursOverride ?? item.leadTimeHours
  if (leadHours > 0) {
    const noticeHours =
      (input.serviceAt.getTime() - input.now.getTime()) / HOUR_MS
    if (noticeHours < leadHours) {
      return refuse(
        'lead_time_not_met',
        leadHours >= 24
          ? `צריך להזמין לפחות ${Math.round(leadHours / 24)} ימים מראש.`
          : `צריך להזמין לפחות ${leadHours} שעות מראש.`,
      )
    }
  }

  // ── 7. Availability rules ──────────────────────────────────────────────
  const blocked = ruleRefusal(input.rules, item.id, input.serviceAt)
  if (blocked) return blocked

  // ── 8. Capacity ────────────────────────────────────────────────────────
  const perDay = override?.capacityPerDayOverride ?? item.capacityPerDay
  const ruleCeiling = tightestRuleCeiling(input.rules, item.id, input.serviceAt)
  const ceiling = tightest(perDay, ruleCeiling)

  if (ceiling !== null && usage.onDate >= ceiling) {
    return refuse(
      'capacity_full',
      'כל המקומות לתאריך הזה נתפסו. אפשר לבחור תאריך אחר.',
    )
  }

  if (item.maxPerBooking !== null && usage.onBooking >= item.maxPerBooking) {
    return refuse(
      'max_per_booking_reached',
      item.maxPerBooking === 1
        ? 'כבר הזמנת את זה. אם צריך עוד, פנה אלינו.'
        : `אפשר להזמין עד ${item.maxPerBooking} מהפריט הזה.`,
    )
  }

  // ── 9. What only the calendar knows ────────────────────────────────────
  // A definite conflict refuses. An unknown one is a caveat: see the header.
  const caveats: EligibilityCaveat[] = []

  if (item.itemType === 'property_addon') {
    if (occupancy.extendedStay === 'conflicting') {
      return refuse(
        'conflicting_booking',
        'יש הגעה של אורח אחר באותו יום, ולכן אי אפשר להאריך. אפשר לפנות אלינו ונבדוק שוב סמוך לתאריך.',
      )
    }
    if (occupancy.extendedStay === 'unknown') caveats.push('occupancy_unknown')

    if (occupancy.cleaningWindow === 'conflicting') {
      return refuse(
        'cleaning_window',
        'לוח הניקיון אינו מאפשר את זה ביום הזה. אפשר לפנות אלינו ונציע שעה אחרת.',
      )
    }
    if (occupancy.cleaningWindow === 'unknown') caveats.push('cleaning_unknown')
  }

  if (occupancy.spareCapacity !== null && occupancy.spareCapacity <= 0) {
    return refuse(
      'no_spare_capacity',
      'אין כרגע מלאי פנוי לפריט הזה בתאריך שביקשת.',
    )
  }
  if (occupancy.spareCapacity === null && item.fulfilmentKind === 'inventory') {
    caveats.push('capacity_unknown')
  }

  return {
    eligible: true,
    reason: null,
    message: null,
    caveats,
    remaining: remainingFor(item, ceiling, usage),
  }
}

/* --------------------------------------------------------------- helpers -- */

function refuse(
  reason: EligibilityReason,
  message: string,
): EligibilityVerdict {
  return { eligible: false, reason, message, caveats: [], remaining: 0 }
}

/**
 * How many more this booking may buy.
 *
 * The tighter of the two ceilings, because both apply: a business that can
 * perform six massages a day and allows two per booking allows two.
 */
function remainingFor(
  item: CatalogueItem,
  dayCeiling: number | null,
  usage: { onDate: number; onBooking: number },
): number | null {
  const fromDay = dayCeiling === null ? null : dayCeiling - usage.onDate
  const fromBooking =
    item.maxPerBooking === null ? null : item.maxPerBooking - usage.onBooking

  if (fromDay === null) return fromBooking
  if (fromBooking === null) return fromDay
  return Math.min(fromDay, fromBooking)
}

function tightest(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

/**
 * When a product becomes visible inside a booking.
 *
 * `days_before_arrival` is the one that has to count from the ARRIVAL and not
 * from today, which is the mistake that shows a guest a pre-arrival offer the
 * morning they check out.
 */
function visibilityRefusal(
  item: CatalogueItem,
  booking: BookingFacts,
  now: Date,
): EligibilityVerdict | null {
  const hiddenUntil = (message: string) => refuse('not_visible_yet', message)

  switch (item.visibilityRule) {
    case 'always':
      return null

    case 'after_confirmation':
      return booking.isConfirmed
        ? null
        : hiddenUntil('התוספת הזו נפתחת אחרי אישור ההזמנה.')

    case 'after_payment':
      return booking.isPaid
        ? null
        : hiddenUntil('התוספת הזו נפתחת אחרי התשלום על השהות.')

    case 'days_before_arrival': {
      const days = item.visibilityDaysBefore ?? 0
      const arrival = Date.parse(`${booking.checkIn}T00:00:00Z`)
      if (Number.isNaN(arrival)) return null
      const opensAt = arrival - days * 24 * HOUR_MS
      return now.getTime() >= opensAt
        ? null
        : hiddenUntil(`התוספת הזו נפתחת ${days} ימים לפני ההגעה.`)
    }

    case 'during_stay': {
      const arrival = Date.parse(`${booking.checkIn}T00:00:00Z`)
      const departure = Date.parse(`${booking.checkOut}T00:00:00Z`)
      if (Number.isNaN(arrival) || Number.isNaN(departure)) return null
      const at = now.getTime()
      return at >= arrival && at < departure
        ? null
        : hiddenUntil('התוספת הזו זמינה במהלך השהות.')
    }
  }
}

/** ISO weekday, 1 = Monday … 7 = Sunday. Matches 0029's `pickup_days`. */
function isoWeekday(at: Date): number {
  const day = at.getUTCDay()
  return day === 0 ? 7 : day
}

function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10)
}

/**
 * Does a rule stand in the way?
 *
 * A rule applies to this item when `itemId` is null (every item) or matches.
 * `isBlocking` decides the direction, and it is stored rather than inferred
 * from `kind` — a business will eventually want a permitting weekday rule and
 * inferring would make that unsayable.
 *
 * A PERMITTING rule is a whitelist: where any permitting rule exists for an
 * item, the service moment must satisfy at least one of them. That is what
 * makes "the DJ works Fridays and Saturdays" express itself as two matched
 * weekdays rather than as five blackouts.
 */
function ruleRefusal(
  rules: readonly StoreAvailabilityRule[],
  itemId: string,
  serviceAt: Date,
): EligibilityVerdict | null {
  const applicable = rules.filter(
    (rule) => rule.isActive && (rule.itemId === null || rule.itemId === itemId),
  )

  for (const rule of applicable) {
    if (rule.isBlocking && ruleMatches(rule, serviceAt)) {
      return refuse(
        'blocked_by_rule',
        rule.note ?? 'השירות אינו זמין בתאריך שביקשת. אפשר לבחור תאריך אחר.',
      )
    }
  }

  const permitting = applicable.filter((rule) => !rule.isBlocking)
  if (permitting.length === 0) return null

  const permitted = permitting.some((rule) => ruleMatches(rule, serviceAt))
  return permitted
    ? null
    : refuse(
        'outside_permitted_window',
        'השירות ניתן רק בימים ובתאריכים מסוימים. אפשר לבחור מועד אחר.',
      )
}

function ruleMatches(rule: StoreAvailabilityRule, serviceAt: Date): boolean {
  if (
    rule.weekdays.length > 0 &&
    !rule.weekdays.includes(isoWeekday(serviceAt))
  ) {
    return false
  }

  const date = isoDate(serviceAt)
  if (rule.fromDate !== null && date < rule.fromDate) return false
  if (rule.toDate !== null && date > rule.toDate) return false

  if (rule.fromTime !== null || rule.toTime !== null) {
    const time = serviceAt.toISOString().slice(11, 19)
    if (rule.fromTime !== null && time < rule.fromTime) return false
    if (rule.toTime !== null && time > rule.toTime) return false
  }

  return true
}

/** The narrowest per-day ceiling any matching rule imposes. */
function tightestRuleCeiling(
  rules: readonly StoreAvailabilityRule[],
  itemId: string,
  serviceAt: Date,
): number | null {
  let ceiling: number | null = null

  for (const rule of rules) {
    if (!rule.isActive) continue
    if (rule.itemId !== null && rule.itemId !== itemId) continue
    if (rule.maxPerDay === null) continue
    if (!ruleMatches(rule, serviceAt)) continue
    ceiling = tightest(ceiling, rule.maxPerDay)
  }

  return ceiling
}

/**
 * When the guest most likely wants a service, when nobody has said.
 *
 * The arrival for anything bought before the stay, which is the honest default
 * for pool heating and a bottle of wine alike. A `during_stay` product defaults
 * to now, because a guest asking for a massage while they are in the house
 * means today.
 */
export function defaultServiceAt(
  item: Pick<CatalogueItem, 'visibilityRule'>,
  booking: BookingFacts | null,
  now: Date,
): Date {
  if (item.visibilityRule === 'during_stay') return now
  if (!booking) return now

  const arrival = Date.parse(`${booking.checkIn}T15:00:00Z`)
  if (Number.isNaN(arrival)) return now
  // A stay already under way prices from today; one in the future from arrival.
  return arrival > now.getTime() ? new Date(arrival) : now
}

/** Nights, re-exported so callers do not reach into `pricing.ts` for it. */
export { nightsBetween }
