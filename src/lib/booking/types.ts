/**
 * The booking domain contract.
 *
 * Written before either the schema or the logic, because both are being built
 * at once and a booking model invented twice is a booking model that disagrees
 * with itself. Everything here is shared vocabulary: the database columns, the
 * state machine, the availability engine and the API all use these names and
 * these values, spelled exactly this way.
 *
 * Changing anything in this file is a change to a contract. It requires the
 * migration, the domain code and the tests to move together.
 */

// ── Status ────────────────────────────────────────────────────────────────

/**
 * A booking is a workflow, not a record with a flag.
 *
 * The sequence below is the life of a stay from enquiry to review. Statuses
 * are explicit rather than derived so that "what is happening with this
 * booking" has one answer everywhere — the calendar, the dashboard, the guest
 * portal and the housekeeping board must never disagree about it.
 */
export const BOOKING_STATUSES = [
  'inquiry',
  'quote',
  'option', // held for a named guest, not yet committed
  'awaiting_payment',
  'deposit_paid',
  'contract_pending',
  'confirmed',
  'pre_arrival',
  'ready_for_check_in',
  'checked_in',
  'in_house',
  'checkout_pending',
  'checked_out',
  'inspection',
  'deposit_release',
  'completed',
  'review_requested',
  // Terminal states outside the happy path.
  'cancelled',
  'no_show',
] as const

export type BookingStatus = (typeof BOOKING_STATUSES)[number]

/**
 * Statuses that occupy the calendar.
 *
 * The distinction matters more than it looks: availability is computed from
 * this set, so adding a status without deciding whether it blocks dates is how
 * a double booking happens. An enquiry does not hold a date; an option does.
 */
export const OCCUPYING_STATUSES: readonly BookingStatus[] = [
  'option',
  'awaiting_payment',
  'deposit_paid',
  'contract_pending',
  'confirmed',
  'pre_arrival',
  'ready_for_check_in',
  'checked_in',
  'in_house',
  'checkout_pending',
]

/** Nothing further happens to a booking in one of these. */
export const TERMINAL_STATUSES: readonly BookingStatus[] = [
  'completed',
  'cancelled',
  'no_show',
]

// ── Attribution ───────────────────────────────────────────────────────────

/**
 * Where the booking came from.
 *
 * Recorded on every booking from the first migration. A commission dispute
 * against a table that does not know who sold the stay cannot be settled, and
 * back-filling this onto live bookings means guessing at money.
 */
export const BOOKING_SOURCES = [
  'direct_website',
  'direct_manual', // phone, walk-in, WhatsApp — entered by staff
  'agent',
  'agency',
  'airbnb',
  'booking_com',
  'vrbo',
  'other_channel',
] as const

export type BookingSource = (typeof BOOKING_SOURCES)[number]

export interface BookingAttribution {
  source: BookingSource
  /** The specific channel or site within a source, when there is one. */
  sourceChannel: string | null
  /** The selling agent, when a person earns commission on this booking. */
  agentUserId: string | null
  /** The agency the agent belongs to, denormalised so a leaver does not erase it. */
  agencyId: string | null
  /** Marketing campaign, for the website funnel. */
  campaignId: string | null
  /** A referral that introduced the guest without selling the stay. */
  referralId: string | null
}

// ── Holds ─────────────────────────────────────────────────────────────────

/**
 * A temporary claim on dates.
 *
 * An agent closing a sale needs the dates to stop moving for a few minutes,
 * and a guest in checkout needs the same. A hold is therefore part of the
 * availability model itself, not a feature layered on top: every availability
 * query has to know about it, which is why it is defined here and not
 * discovered later.
 *
 * A hold that outlives its purpose locks up a business's inventory, so expiry
 * is mandatory and unbounded holds are not representable.
 */
export const HOLD_REASONS = [
  'agent_quote',
  'guest_checkout',
  'staff_manual',
  'maintenance_block',
] as const

export type HoldReason = (typeof HOLD_REASONS)[number]

export interface Hold {
  id: string
  organizationId: string
  unitId: string
  /** Inclusive first night. */
  checkIn: string
  /** Exclusive; the guest leaves on this date and it is bookable by the next. */
  checkOut: string
  reason: HoldReason
  /** The agent or staff member who placed it. */
  heldByUserId: string
  /** Never null. A hold without an expiry is an outage waiting to happen. */
  expiresAt: string
  releasedAt: string | null
  /** Set once the hold turns into a real booking. */
  convertedToBookingId: string | null
}

// ── Dates ─────────────────────────────────────────────────────────────────

/**
 * A stay, as half-open [checkIn, checkOut).
 *
 * Check-out day is not occupied: one guest leaves in the morning and the next
 * arrives that afternoon, and treating the range as closed loses a night per
 * turnaround across the whole calendar. Every overlap test in the system
 * follows this convention.
 */
export interface DateRange {
  /** ISO date, YYYY-MM-DD. Time of day lives on the unit, not the booking. */
  checkIn: string
  checkOut: string
}

/** Do two stays collide? Half-open, so a same-day turnaround does not. */
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.checkIn < b.checkOut && b.checkIn < a.checkOut
}

/** Nights in a stay. Zero-length and reversed ranges are invalid, not zero. */
export function nightsBetween(range: DateRange): number {
  const start = Date.parse(`${range.checkIn}T00:00:00Z`)
  const end = Date.parse(`${range.checkOut}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end)) return NaN
  return Math.round((end - start) / 86_400_000)
}

// ── Money ─────────────────────────────────────────────────────────────────

/**
 * Every amount in the booking domain is an integer in agorot, as everywhere
 * else in the product. See `src/lib/plans/plan.ts` for the reasoning.
 */
export type Agorot = number

/**
 * One line of what the guest is paying for.
 *
 * The total is never a single number typed by a person: it is the sum of
 * lines, so a price can be explained. "Why is it ₪6,400?" is the most common
 * question a guest asks, and a system that cannot answer it invites arguments
 * it cannot win.
 */
export const PRICE_LINE_KINDS = [
  'accommodation',
  'extra_guest',
  'addon',
  'cleaning_fee',
  'discount',
  'promotion',
  'tax',
  'deposit',
  'agent_commission',
] as const

export type PriceLineKind = (typeof PRICE_LINE_KINDS)[number]

export interface PriceLine {
  kind: PriceLineKind
  label: string
  /** Negative for discounts, so the total is always a plain sum. */
  amount: Agorot
  quantity: number
  /** The night this line belongs to, for per-night accommodation lines. */
  date: string | null
}
