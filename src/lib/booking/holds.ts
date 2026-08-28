/**
 * Holds — a temporary claim on dates.
 *
 * An agent on the phone needs the dates to stop moving while the guest fetches
 * a credit card; a guest in checkout needs the same for the ninety seconds the
 * payment takes. Without holds both are racing every other seller in the
 * system, and the losing party finds out after they have committed to a price.
 *
 * The danger runs the other way too, and `docs/ARCHITECTURE.md` §12 is explicit
 * about it: an agent who holds dates and never closes is removing the
 * business's inventory from sale for free. Three safeguards follow from that,
 * and all three are enforced here rather than left to a caller:
 *
 *   1. **Expiry is mandatory.** `Hold.expiresAt` is not nullable in the
 *      contract, so an unbounded hold is not representable. This file never
 *      constructs one without an expiry and refuses a duration beyond the
 *      policy for its reason.
 *
 *   2. **Expiry is honoured on read.** `isHoldLive` compares against `now`
 *      every single time. A hold whose moment has passed blocks nothing and
 *      counts towards nothing — whether or not a sweeper job has been by, and
 *      whether or not one exists. A background job that quietly stops running
 *      would otherwise lock a business's calendar and there would be no
 *      symptom until someone complained about a month of lost bookings.
 *
 *   3. **Concurrency is capped.** An agent gets a small number of live holds at
 *      once. The count is computed over live holds only, which is the reason
 *      point 2 matters twice: an expired hold that still consumed the allowance
 *      would lock the agent out rather than the calendar.
 *
 * Everything here is a pure function over a `Hold` and a clock. Nothing reads a
 * database and nothing mutates its argument — a "released" hold is a new
 * object, so a caller cannot half-apply a change and leave the original in an
 * inconsistent state.
 */

import { BusinessRuleError } from '../errors'
import {
  rangesOverlap,
  type DateRange,
  type Hold,
  type HoldReason,
} from './types'

// ── Policy ────────────────────────────────────────────────────────────────

export interface HoldPolicy {
  /** Live holds one person may have at once, for this reason. */
  maxConcurrent: number
  /** What a hold gets when nobody says otherwise. */
  defaultMinutes: number
  /** The ceiling, including on an extension. */
  maxMinutes: number
}

/**
 * Per reason, because the reasons are not comparable.
 *
 * A guest in checkout needs minutes and holds one thing at a time. An agent
 * working a deal needs half an hour and may legitimately be juggling a few.
 * Staff blocking a unit for maintenance are not competing for inventory at all
 * — they are removing it deliberately — so their limits are generous.
 *
 * §12 also describes a reliability score that widens an agent's allowance as
 * they prove themselves. That belongs to the agent record rather than to this
 * table, which is why `holdPolicyFor` takes an override: the caller supplies
 * the agent's earned allowance, and the default here is what a new agent gets.
 */
export const HOLD_POLICY: Record<HoldReason, HoldPolicy> = {
  agent_quote: { maxConcurrent: 5, defaultMinutes: 30, maxMinutes: 120 },
  guest_checkout: { maxConcurrent: 2, defaultMinutes: 15, maxMinutes: 30 },
  staff_manual: { maxConcurrent: 20, defaultMinutes: 120, maxMinutes: 1440 },
  maintenance_block: {
    maxConcurrent: 200,
    defaultMinutes: 1440,
    // Thirty days. A longer closure is a seasonal block on the unit, which is
    // a property setting and not a hold somebody has to remember to renew.
    maxMinutes: 43_200,
  },
}

export const HOLD_REASON_LABEL: Record<HoldReason, string> = {
  agent_quote: 'הצעת סוכן',
  guest_checkout: 'תשלום בתהליך',
  staff_manual: 'החזקה ידנית',
  maintenance_block: 'חסימת תחזוקה',
}

export function holdPolicyFor(
  reason: HoldReason,
  overrides: Partial<HoldPolicy> = {},
): HoldPolicy {
  return { ...HOLD_POLICY[reason], ...overrides }
}

// ── Liveness ──────────────────────────────────────────────────────────────

/**
 * Does this hold block anything?
 *
 * Three ways to stop blocking, and all three are checked on every read:
 * somebody released it, it turned into a booking, or its time ran out.
 *
 * The expiry comparison is strict — a hold expiring at 14:30:00 does not block
 * at 14:30:00. The alternative keeps inventory locked for one extra tick for no
 * benefit, and makes an exactly-at-expiry test read as a coin flip.
 */
export function isHoldLive(hold: Hold, now: Date): boolean {
  if (hold.releasedAt !== null) return false
  if (hold.convertedToBookingId !== null) return false

  const expires = Date.parse(hold.expiresAt)
  // An unparseable expiry is treated as expired. The contract says a hold
  // always has one; if the data says otherwise, the safe reading is the one
  // that frees inventory rather than the one that locks it forever.
  if (Number.isNaN(expires)) return false

  return expires > now.getTime()
}

export function liveHolds(holds: readonly Hold[], now: Date): Hold[] {
  return holds.filter((hold) => isHoldLive(hold, now))
}

/** Live holds this person is currently holding, across all units. */
export function countLiveHoldsBy(
  holds: readonly Hold[],
  userId: string,
  now: Date,
): number {
  return holds.filter(
    (hold) => hold.heldByUserId === userId && isHoldLive(hold, now),
  ).length
}

/** Does the hold cover the whole of this stay, on the half-open convention? */
export function holdCovers(hold: Hold, range: DateRange): boolean {
  return hold.checkIn <= range.checkIn && hold.checkOut >= range.checkOut
}

export function holdOverlaps(hold: Hold, range: DateRange): boolean {
  return rangesOverlap(hold, range)
}

// ── Creating ──────────────────────────────────────────────────────────────

/** A hold before the database has given it an id. */
export type HoldDraft = Omit<Hold, 'id'>

export interface PlanHoldInput {
  organizationId: string
  unitId: string
  range: DateRange
  reason: HoldReason
  heldByUserId: string
  now: Date
  /** Requested duration. Falls back to the policy default. */
  minutes?: number
  policy?: Partial<HoldPolicy>
  /** Live holds this person already has. Counted live, by the caller's clock. */
  liveHoldCount: number
}

/**
 * Work out the hold that should be written, or refuse.
 *
 * Returns a draft rather than writing one: the write belongs to the operation,
 * inside its transaction, next to the constraint that is the real guarantee
 * that these dates are free.
 */
export function planHold(input: PlanHoldInput): HoldDraft {
  const policy = holdPolicyFor(input.reason, input.policy)
  const minutes = input.minutes ?? policy.defaultMinutes

  if (input.liveHoldCount >= policy.maxConcurrent) {
    throw new BusinessRuleError({
      code: 'hold.limit_reached',
      message:
        `Hold limit reached: ${input.liveHoldCount} live holds, ` +
        `limit ${policy.maxConcurrent} for ${input.reason}`,
      userMessage:
        `הגעת למספר ההחזקות המרבי (${policy.maxConcurrent}). ` +
        'שחרר החזקה קיימת או המתן לפקיעתה כדי להחזיק תאריכים נוספים.',
      publicDetails: { limit: policy.maxConcurrent },
    })
  }

  assertDurationWithinPolicy(minutes, policy)

  return {
    organizationId: input.organizationId,
    unitId: input.unitId,
    checkIn: input.range.checkIn,
    checkOut: input.range.checkOut,
    reason: input.reason,
    heldByUserId: input.heldByUserId,
    expiresAt: expiryFrom(input.now, minutes),
    releasedAt: null,
    convertedToBookingId: null,
  }
}

export function expiryFrom(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString()
}

function assertDurationWithinPolicy(minutes: number, policy: HoldPolicy): void {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new BusinessRuleError({
      code: 'hold.invalid_duration',
      message: `Invalid hold duration: ${minutes}`,
      userMessage: 'משך ההחזקה חייב להיות גדול מאפס.',
    })
  }
  if (minutes > policy.maxMinutes) {
    throw new BusinessRuleError({
      code: 'hold.duration_too_long',
      message: `Hold duration ${minutes}m exceeds ${policy.maxMinutes}m`,
      userMessage:
        `משך ההחזקה המרבי הוא ${policy.maxMinutes} דקות. ` +
        'לחסימה ארוכה יותר השתמש בחסימת יחידה.',
      publicDetails: { maxMinutes: policy.maxMinutes },
    })
  }
}

// ── Changing ──────────────────────────────────────────────────────────────

/**
 * Push the expiry out.
 *
 * The new expiry is capped relative to *now*, not to when the hold was created,
 * because the contract's `Hold` carries no creation timestamp — see the note at
 * the foot of this file. The practical effect is that an agent cannot hold
 * dates for longer than the policy window at any moment, though they can renew
 * indefinitely while they are actively working the deal. Capping total lifetime
 * needs a field this type does not have.
 *
 * An expired hold is not extended back to life. Its dates have already been
 * returned to sale and may well have been sold; reviving it would be a second
 * claim on inventory that someone else is now holding.
 */
export function extendHold(
  hold: Hold,
  input: { now: Date; minutes?: number; policy?: Partial<HoldPolicy> },
): Hold {
  assertHoldIsLive(hold, input.now)

  const policy = holdPolicyFor(hold.reason, input.policy)
  const minutes = input.minutes ?? policy.defaultMinutes
  assertDurationWithinPolicy(minutes, policy)

  return { ...hold, expiresAt: expiryFrom(input.now, minutes) }
}

/**
 * Give the dates back.
 *
 * Deliberately tolerant of an *expired* hold: releasing one is tidying up, and
 * refusing would leave rows nobody can close. It refuses only a hold that is
 * already released or already a booking, because those are genuine
 * double-actions and the caller has misunderstood the state.
 */
export function releaseHold(hold: Hold, now: Date): Hold {
  if (hold.convertedToBookingId !== null) {
    throw new BusinessRuleError({
      code: 'hold.already_converted',
      message: `Hold ${hold.id} already became booking ${hold.convertedToBookingId}`,
      userMessage: 'ההחזקה כבר הפכה להזמנה ולכן אין מה לשחרר.',
    })
  }
  if (hold.releasedAt !== null) {
    throw new BusinessRuleError({
      code: 'hold.already_released',
      message: `Hold ${hold.id} was already released at ${hold.releasedAt}`,
      userMessage: 'ההחזקה כבר שוחררה.',
    })
  }
  return { ...hold, releasedAt: now.toISOString() }
}

/**
 * Turn the hold into a booking.
 *
 * `releasedAt` is set as well as `convertedToBookingId`, and that is the whole
 * point of this function: a converted hold that stayed live would overlap the
 * very booking it just produced, and the exclusion constraint in the database
 * would reject the booking the hold existed to protect. Belt and braces —
 * `isHoldLive` also returns false on a converted hold, so either field alone
 * would be enough, and both are set so that a query written against only one of
 * them still gets the right answer.
 */
export function convertHold(hold: Hold, bookingId: string, now: Date): Hold {
  assertHoldIsLive(hold, now)
  return {
    ...hold,
    convertedToBookingId: bookingId,
    releasedAt: now.toISOString(),
  }
}

export function assertHoldIsLive(hold: Hold, now: Date): void {
  if (isHoldLive(hold, now)) return

  const reason =
    hold.convertedToBookingId !== null
      ? 'ההחזקה כבר הפכה להזמנה.'
      : hold.releasedAt !== null
        ? 'ההחזקה שוחררה.'
        : 'תוקף ההחזקה פג והתאריכים חזרו למכירה.'

  throw new BusinessRuleError({
    code: 'hold.not_live',
    message: `Hold ${hold.id} is not live at ${now.toISOString()}`,
    userMessage: `${reason} בדוק את הזמינות ובצע החזקה חדשה.`,
    publicDetails: { holdId: hold.id },
  })
}

/**
 * The hold really does cover the stay being booked.
 *
 * Without this an agent could hold two cheap nights and convert them into a
 * fortnight, which is inventory taken without ever having been claimed.
 */
export function assertHoldCovers(hold: Hold, range: DateRange): void {
  if (holdCovers(hold, range)) return
  throw new BusinessRuleError({
    code: 'hold.does_not_cover_dates',
    message:
      `Hold ${hold.id} covers ${hold.checkIn}..${hold.checkOut}, ` +
      `booking asks ${range.checkIn}..${range.checkOut}`,
    userMessage:
      'ההחזקה אינה מכסה את כל תאריכי ההזמנה. בדוק זמינות לתאריכים המבוקשים.',
  })
}

/**
 * ── A note for whoever owns `types.ts` ────────────────────────────────────
 *
 * `Hold` has no `createdAt` and no extension counter. Two safeguards §12 asks
 * for therefore cannot be enforced from the type alone:
 *
 *   - a cap on a hold's *total* lifetime, as opposed to its remaining time;
 *   - a cap on how many times one hold may be renewed.
 *
 * Both are one column each (`created_at`, `extension_count`). Until they exist,
 * `extendHold` caps each renewal against the clock, which bounds how long dates
 * can be held without anyone looking at them, but not how long a determined
 * agent can keep renewing.
 */
