/**
 * The availability engine.
 *
 * ── What this is not ──────────────────────────────────────────────────────
 *
 * **This is not the thing that prevents double bookings.** It cannot be, and
 * writing it as though it were is how a system ends up with two guests holding
 * keys to the same villa on the same Friday.
 *
 * Every check here reads the current state and then returns; the caller acts on
 * the answer some milliseconds later. In that gap another request can read the
 * same state and reach the same happy conclusion. Two agents pressing "confirm"
 * within the same second both see free dates, both are told yes, and both
 * write. No amount of care in this file closes that window, because the window
 * is between this file and the write.
 *
 * The real guarantee is in the database: a `GiST` exclusion constraint on
 * `(unit_id, daterange)` for occupying bookings and live holds, which makes the
 * second overlapping insert fail at commit time no matter what any application
 * layer believed. The operation layer treats that failure as a normal outcome
 * and reports it as a conflict.
 *
 * So what is this for? Two things, both of them worth having:
 *
 *   1. **A useful answer before submitting.** "Those dates are taken, and the
 *      minimum stay in August is three nights" is a better experience than a
 *      constraint violation after the guest has typed their passport number.
 *   2. **Showing what is free.** A calendar has to render free and busy for a
 *      whole month; the database constraint cannot draw that.
 *
 * The code is therefore written as though it will lose a race, because it will.
 * It never mutates anything, it never caches, and nothing downstream is allowed
 * to treat `available: true` as permission to skip the constrained write.
 *
 * ── Half-open, everywhere ─────────────────────────────────────────────────
 *
 * A stay is `[checkIn, checkOut)`. A guest leaving on the 5th and one arriving
 * on the 5th do not collide — that is a same-day turnaround, it is normal, and
 * treating it as a conflict quietly deletes one sellable night per changeover
 * across the entire calendar. `rangesOverlap` in the contract encodes this and
 * is the only overlap test used here.
 */

import { addDays, eachNight, isIsoDate } from './dates'
import {
  OCCUPYING_STATUSES,
  nightsBetween,
  rangesOverlap,
  type BookingStatus,
  type DateRange,
  type Hold,
} from './types'
import { isHoldLive } from './holds'

// ── What the engine is asked ──────────────────────────────────────────────

export interface AvailabilityWindow {
  organizationId: string
  unitId: string
  range: DateRange
}

/** A booking as availability sees it: dates and a status, nothing else. */
export interface OccupyingBooking {
  id: string
  reference?: string
  status: BookingStatus
  checkIn: string
  checkOut: string
}

/**
 * What a unit will and will not accept.
 *
 * Separate from the unit record because these are the fields availability
 * reads, and a rules row that is absent is not the same as a unit with no
 * restrictions — see `loadRules` below.
 */
export interface UnitAvailabilityRules {
  unitId: string
  /** The floor for any stay. `1` for a unit with no minimum. */
  minimumNights: number
  /** Season-specific floors, keyed by arrival date. Overrides the default. */
  minimumNightsByArrival?: Readonly<Record<string, number>>
  /** Not sellable at all: maintenance, owner use, a closed season. */
  blockedDates?: readonly string[]
  /** Sellable, but no arrival may land on these dates. */
  noArrivalDates?: readonly string[]
  noDepartureDates?: readonly string[]
}

/**
 * Where availability facts come from.
 *
 * Injected, exactly as `ActorSource` is for the actor, and for the same reason:
 * the interesting logic here is the overlap arithmetic and the expiry rule, and
 * a function that opens a database connection cannot be exercised across a
 * hundred date combinations in a millisecond.
 *
 * **The engine does not trust the source to have filtered anything.** An
 * implementation may return a wider window, cancelled bookings or swept holds;
 * occupancy and liveness are decided here, over `OCCUPYING_STATUSES` and
 * `isHoldLive`. That is deliberate: it means a SQL `WHERE` clause that drifts
 * from the domain's definition of "occupying" cannot make dates appear free.
 */
export interface AvailabilitySource {
  /** Bookings that might touch the window. Over-returning is fine. */
  loadBookings(window: AvailabilityWindow): Promise<readonly OccupyingBooking[]>
  /** Holds that might touch the window, expired ones included. */
  loadHolds(window: AvailabilityWindow): Promise<readonly Hold[]>
  /** `null` when the unit is unknown or not configured for sale. */
  loadRules(
    organizationId: string,
    unitId: string,
  ): Promise<UnitAvailabilityRules | null>
}

// ── What it answers ───────────────────────────────────────────────────────

export type AvailabilityBlockerKind =
  | 'invalid_range'
  | 'unknown_unit'
  | 'booking'
  | 'hold'
  | 'blocked_date'
  | 'no_arrival'
  | 'no_departure'
  | 'minimum_nights'

export interface AvailabilityBlocker {
  kind: AvailabilityBlockerKind
  /** Hebrew, and specific enough to act on. */
  message: string
  bookingId?: string
  holdId?: string
  date?: string
  requiredNights?: number
  requestedNights?: number
}

export interface AvailabilityResult {
  available: boolean
  nights: number
  /** Every reason, not the first — a form must not reveal problems one by one. */
  blockers: readonly AvailabilityBlocker[]
}

export interface AvailabilityOptions {
  now: Date
  /** Exclude one booking: an amendment must not collide with itself. */
  ignoreBookingId?: string | null
  /** Exclude one hold: a hold being converted must not block its own booking. */
  ignoreHoldId?: string | null
  /**
   * Skip the length-of-stay floor. For a staff member placing a maintenance
   * block, or an override by someone holding `booking.override_availability`.
   */
  ignoreMinimumNights?: boolean
}

const OCCUPYING = new Set<BookingStatus>(OCCUPYING_STATUSES)

/** Does this booking hold the calendar, or is it merely a record? */
export function isOccupying(status: BookingStatus): boolean {
  return OCCUPYING.has(status)
}

/**
 * Can this unit be sold for this range?
 *
 * Collects every blocker rather than returning on the first, so the interface
 * can say "taken, and below the minimum stay" in one breath.
 */
export async function checkAvailability(
  source: AvailabilitySource,
  window: AvailabilityWindow,
  options: AvailabilityOptions,
): Promise<AvailabilityResult> {
  const { range } = window
  const blockers: AvailabilityBlocker[] = []

  const nights = validRange(range) ? nightsBetween(range) : 0
  if (nights <= 0) {
    return {
      available: false,
      nights: 0,
      blockers: [
        {
          kind: 'invalid_range',
          message: 'תאריך העזיבה חייב להיות מאוחר מתאריך ההגעה.',
        },
      ],
    }
  }

  const rules = await source.loadRules(window.organizationId, window.unitId)
  if (!rules) {
    // Deny by default. A missing rules row means the engine cannot vouch for
    // this unit, and inventing a permissive default here would sell a unit
    // nobody has configured for sale.
    return {
      available: false,
      nights,
      blockers: [
        {
          kind: 'unknown_unit',
          message: 'היחידה אינה זמינה למכירה. בדוק את הגדרות היחידה.',
        },
      ],
    }
  }

  const [bookings, holds] = await Promise.all([
    source.loadBookings(window),
    source.loadHolds(window),
  ])

  for (const booking of bookings) {
    if (booking.id === options.ignoreBookingId) continue
    if (!isOccupying(booking.status)) continue
    if (!rangesOverlap(range, booking)) continue

    blockers.push({
      kind: 'booking',
      bookingId: booking.id,
      message:
        `התאריכים תפוסים על ידי הזמנה ${booking.reference ?? booking.id} ` +
        `(${booking.checkIn} עד ${booking.checkOut}).`,
    })
  }

  for (const hold of holds) {
    if (hold.id === options.ignoreHoldId) continue
    // Liveness is decided here and now, never taken on trust from the query.
    // An expired hold blocks nothing, whether or not a sweeper has been by.
    if (!isHoldLive(hold, options.now)) continue
    if (hold.unitId !== window.unitId) continue
    if (!rangesOverlap(range, hold)) continue

    blockers.push({
      kind: 'hold',
      holdId: hold.id,
      message: `התאריכים מוחזקים זמנית (${hold.checkIn} עד ${hold.checkOut}).`,
    })
  }

  // Blocked dates are checked over the nights only. A block on the departure
  // date does not touch this stay — the guest is gone by then.
  const blocked = new Set(rules.blockedDates ?? [])
  for (const night of eachNight(range)) {
    if (blocked.has(night)) {
      blockers.push({
        kind: 'blocked_date',
        date: night,
        message: `היחידה חסומה בתאריך ${night}.`,
      })
    }
  }

  if ((rules.noArrivalDates ?? []).includes(range.checkIn)) {
    blockers.push({
      kind: 'no_arrival',
      date: range.checkIn,
      message: `לא ניתן להגיע בתאריך ${range.checkIn}.`,
    })
  }

  if ((rules.noDepartureDates ?? []).includes(range.checkOut)) {
    blockers.push({
      kind: 'no_departure',
      date: range.checkOut,
      message: `לא ניתן לעזוב בתאריך ${range.checkOut}.`,
    })
  }

  if (!options.ignoreMinimumNights) {
    const required = minimumNightsFor(rules, range.checkIn)
    if (nights < required) {
      blockers.push({
        kind: 'minimum_nights',
        requiredNights: required,
        requestedNights: nights,
        message:
          `שהות מינימלית בתאריכים אלה היא ${required} לילות, ` +
          `והבקשה היא ל-${nights}.`,
      })
    }
  }

  return { available: blockers.length === 0, nights, blockers }
}

/** The length-of-stay floor that applies to an arrival on this date. */
export function minimumNightsFor(
  rules: UnitAvailabilityRules,
  checkIn: string,
): number {
  const seasonal = rules.minimumNightsByArrival?.[checkIn]
  return Math.max(1, seasonal ?? rules.minimumNights)
}

// ── The calendar ──────────────────────────────────────────────────────────

export type DayState = 'free' | 'booked' | 'held' | 'blocked'

export interface DayAvailability {
  date: string
  state: DayState
  bookingId?: string
  holdId?: string
}

/**
 * Free/busy for each night of a window.
 *
 * What a month view renders, and what an external seller is allowed to see:
 * taken or not, and by what kind of thing — never by whom, for how much, or
 * through which channel. Keeping that shape here rather than filtering a
 * booking list at the edge is what makes the internal diary and the
 * availability diary two different objects instead of two views of one.
 */
export async function availabilityCalendar(
  source: AvailabilitySource,
  window: AvailabilityWindow,
  options: AvailabilityOptions,
): Promise<readonly DayAvailability[]> {
  const nights = eachNight(window.range)
  if (nights.length === 0) return []

  const rules = await source.loadRules(window.organizationId, window.unitId)
  const [bookings, holds] = await Promise.all([
    source.loadBookings(window),
    source.loadHolds(window),
  ])

  const blocked = new Set(rules?.blockedDates ?? [])

  return nights.map((date) => {
    const night: DateRange = { checkIn: date, checkOut: addDays(date, 1) }

    const booking = bookings.find(
      (candidate) =>
        candidate.id !== options.ignoreBookingId &&
        isOccupying(candidate.status) &&
        rangesOverlap(night, candidate),
    )
    if (booking) return { date, state: 'booked', bookingId: booking.id }

    const hold = holds.find(
      (candidate) =>
        candidate.id !== options.ignoreHoldId &&
        candidate.unitId === window.unitId &&
        isHoldLive(candidate, options.now) &&
        rangesOverlap(night, candidate),
    )
    if (hold) return { date, state: 'held', holdId: hold.id }

    if (blocked.has(date) || !rules) return { date, state: 'blocked' }

    return { date, state: 'free' }
  })
}

// ── Internals ─────────────────────────────────────────────────────────────

function validRange(range: DateRange): boolean {
  return (
    isIsoDate(range.checkIn) &&
    isIsoDate(range.checkOut) &&
    range.checkOut > range.checkIn
  )
}
