/**
 * The pricing contract.
 *
 * Written to match `supabase/migrations/0072_pricing.sql` column for column
 * and `docs/spec/20-pricing.md` §3 rule for rule. The schema and this file are
 * one model expressed twice, and the tests in this directory are what keeps
 * them from drifting.
 *
 * ══ THE SHAPE OF THE WHOLE MODULE ═══════════════════════════════════════════
 *
 *   resolvePricing(context) → StayPricingRequest → priceStay() → StayQuote
 *
 * 🔒 The output of the rate resolver is a REQUEST, not a price. Every nightly
 * calculation — base, calendar addition, demand, event, guest count, clamp —
 * collapses into one integer per night inside `nightlyOverrides`, and
 * `src/lib/booking/pricing.ts` remains the only place in the product that
 * produces lines and a total. That is what makes "the total is the sum of the
 * lines" true by construction rather than by care, and it is why nothing in
 * this directory imports `sumLines`.
 *
 * ══ MONEY ═══════════════════════════════════════════════════════════════════
 *
 * Integer agorot, everywhere, with one deliberate exception: the intermediate
 * per-night figures inside a `NightResolution` are allowed to be fractional
 * while additions accumulate, because spec §7.5 rounds exactly ONCE per night,
 * at the end. Rounding each addition separately produces a drift that grows
 * with the number of additions. The rounded figure is `nightlyAgorot` and it
 * is the only one that leaves this module.
 *
 * ══ A FIGURE WITH NO SOURCE IS ABSENT, NOT ZERO ═════════════════════════════
 *
 * `Measure` comes from `src/lib/revenue/types.ts` rather than being defined a
 * third time. Occupancy is the case that matters (spec §6 rule 13): a property
 * whose units are all out of service has UNKNOWN occupancy, not 0%, and 0%
 * would fire the cheapest demand tier on a property that sold nothing because
 * it had nothing to sell.
 */

import type { Agorot, BookingSource, DateRange } from '../booking/types'
import type { SpecialDayKind } from '../hebrew-calendar'
import type { EventType } from '../preparation/types'
import type { Measure } from '../revenue/types'

// ── The rate card ─────────────────────────────────────────────────────────

export const RATE_PLAN_KINDS = [
  'flexible',
  'non_refundable',
  'direct',
  'agent',
  'ota',
  'corporate',
  'owner_special',
] as const

export type RatePlanKind = (typeof RATE_PLAN_KINDS)[number]

export const RATE_SCOPES = ['unit', 'unit_group', 'property'] as const

export type RateScope = (typeof RATE_SCOPES)[number]

export const RATE_CALENDAR_SOURCES = [
  'manual',
  'ai_approved',
  'channel_sync',
] as const

export type RateCalendarSource = (typeof RATE_CALENDAR_SOURCES)[number]

export const RATE_MODIFIER_KINDS = [
  'weekend',
  'holiday',
  'occupancy',
  'guest_count',
  'event_type',
] as const

export type RateModifierKind = (typeof RATE_MODIFIER_KINDS)[number]

export const RATE_SUGGESTION_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'auto_applied',
] as const

export type RateSuggestionStatus = (typeof RATE_SUGGESTION_STATUSES)[number]

/**
 * How one plan is derived from another.
 *
 * Resolved recursively, to `MAX_DERIVATION_DEPTH` and no further. A cycle is
 * refused when the plan is SAVED rather than when a quote is priced, because
 * a business that discovers its rate card is circular while a guest is on the
 * telephone has discovered it at the worst possible moment (spec §7.8).
 */
export interface RateDerivation {
  fromRatePlanId: string
  adjust: { kind: 'percent' | 'fixed'; value: number }
}

export interface RatePlan {
  id: string
  organizationId: string
  /** Null is every property in the business, not a missing value. */
  propertyId: string | null
  code: string
  name: string
  kind: RatePlanKind
  /** Empty is every channel. */
  channelScope: readonly BookingSource[]
  /** The grant required to sell from this plan, or null for anybody. */
  requiresGrant: string | null
  derivation: RateDerivation | null
  minNights: number | null
  maxNights: number | null
  advanceDaysMin: number | null
  advanceDaysMax: number | null
  cancellationPolicy: Readonly<Record<string, unknown>>
  floorAgorot: Agorot | null
  ceilingAgorot: Agorot | null
  priority: number
  isActive: boolean
  effectiveFrom: string
  effectiveTo: string | null
  version: number
}

export interface RateRule {
  id: string
  ratePlanId: string
  scopeKind: RateScope
  scopeId: string
  /** Computed by the database from `scopeKind` and `weekdays`. See §7.2. */
  specificity: number
  /** The season, half-open [dateFrom, dateTo). */
  dateFrom: string
  dateTo: string
  /** 0 = Sunday … 6 = Saturday. Empty is every day. */
  weekdays: readonly number[]
  nightlyAgorot: Agorot
  minNights: number | null
  priority: number
  /** Hebrew. Reaches the guest's breakdown through the resolution. */
  label: string | null
  /** The rule row's own validity, which is not the season it prices. */
  effectiveFrom: string
  effectiveTo: string | null
}

export interface RateCalendarEntry {
  id: string
  unitId: string
  ratePlanId: string
  date: string
  nightlyAgorot: Agorot
  source: RateCalendarSource
  suggestionId: string | null
  approvedBy: string | null
  version: number
}

/**
 * The condition on a modifier, per kind. Closed on purpose.
 *
 * What these five shapes cannot express is a SIXTH modifier, not a bigger
 * language — the same argument `QuantityExpression` makes in
 * `preparation/types.ts`. A general expression language here would be a rate
 * card nobody can read and a resolver nobody can prove deterministic.
 */
export type ModifierTrigger =
  | { kind: 'weekend'; weekdays: readonly number[] }
  | { kind: 'holiday'; specialDayKinds: readonly SpecialDayKind[] }
  /** Half-open [fromPercent, toPercent), so 70.0% lands in exactly one tier. */
  | { kind: 'occupancy'; fromPercent: number; toPercent: number }
  | { kind: 'guest_count'; from: number; to: number }
  | { kind: 'event_type'; anyOf: readonly EventType[] }

export interface RateModifier {
  id: string
  kind: RateModifierKind
  scopeKind: RateScope
  scopeId: string
  /** Null applies to every plan: a Saturday is a Saturday on any rate. */
  ratePlanId: string | null
  trigger: ModifierTrigger
  adjustKind: 'percent' | 'fixed'
  /** Basis points for `percent`, agorot for `fixed`. Integer, always. */
  adjustValue: number
  priority: number
  isActive: boolean
}

// ── Recommendations ───────────────────────────────────────────────────────

export interface RateSuggestion {
  id: string
  unitId: string
  ratePlanId: string
  date: string
  /** What the deterministic resolver said. Kept so the engine is measurable. */
  deterministicAgorot: Agorot
  suggestedAgorot: Agorot
  confidenceBps: number | null
  /** Hebrew, and never empty: an unexplained proposal cannot be approved. */
  rationale: string
  inputsHash: string
  status: RateSuggestionStatus
  expiresAt: string | null
  decidedBy: string | null
  decidedAt: string | null
  decisionReason: string | null
}

export interface DynamicPricingPolicy {
  id: string
  propertyId: string | null
  autoApply: boolean
  maxDeltaBps: number
  maxDailyChanges: number
  floorAgorot: Agorot | null
  ceilingAgorot: Agorot | null
  /** Whose name goes on every automatic change this policy makes. */
  enabledByUserId: string | null
  enabledAt: string | null
}

// ── What the resolver is asked, and what it answers ───────────────────────

/**
 * Everything the rate resolver reads. Frozen at step 0 of spec §7.7.
 *
 * `effectiveOn` is a parameter rather than `today` for the reason spec §6 rule
 * 36 gives: `advance_days`, `early_bird` and `last_minute` are all measured
 * from the day the booking was created at the property. Re-pricing that
 * booking in August and measuring from August would make the early-bird
 * discount the guest was given evaporate.
 */
export interface PricingContext {
  organizationId: string
  propertyId: string
  unitId: string
  unitGroupId: string | null
  range: DateRange
  guests: number
  eventType: EventType | null
  source: BookingSource
  /** Grants the actor holds, for `RatePlan.requiresGrant`. */
  grants: ReadonlySet<string>
  /** The date effective-dating is resolved against. */
  effectiveOn: string
  /** The last floor: `units.base_price_agorot`. Never null. */
  baseUnitNightlyAgorot: Agorot
  unitStandardGuests: number
  unitMinNights: number
  propertyMinNights: number
  extraGuestNightlyAgorot?: Agorot
  cleaningFeeAgorot?: Agorot
  depositAgorot?: Agorot
  taxRatePercent?: number
  plans: readonly RatePlan[]
  rules: readonly RateRule[]
  calendar: readonly RateCalendarEntry[]
  modifiers: readonly RateModifier[]
  /**
   * Property occupancy per night, as a `Measure`. Absent means the caller has
   * no occupancy source at all; `{ known: false }` means it looked and there
   * was nothing to divide by. Both suppress the demand addition, and the
   * resolution records which it was.
   */
  occupancyByNight?: Readonly<Record<string, Measure>>
}

/** Where a night's base price came from. The rung of the §7.2 ladder. */
export type NightBaseOrigin = 'rate_calendar' | 'rate_rule' | 'unit_base_price'

/**
 * The account of one night, as it is written into the snapshot's `resolution`.
 *
 * This is the object that turns "₪1,450" into "₪1,450 · עונת סוכות · שבת". It
 * is deliberately verbose: a price a business cannot explain is a price it
 * cannot defend, and the argument always happens months later.
 */
export interface NightResolution {
  date: string
  baseAgorot: Agorot
  baseOrigin: NightBaseOrigin
  /** The winning rule or calendar row, for the audit sentence. */
  baseSourceId: string | null
  baseLabel: string | null
  specificity: number
  /** Fractional until the single rounding. See §7.5. */
  weekendAdd: number
  holidayAdd: number
  /** `max(weekendAdd, holidayAdd)` — spec §6 rule 9, not the sum. */
  calendarAdd: number
  demandAdd: number
  eventAdd: number
  guestAdd: number
  rawAgorot: number
  /** True when the clamp actually moved the number. Never silent. */
  clamped: boolean
  clampedTo: 'floor' | 'ceiling' | null
  /** The occupancy the demand tier was chosen from, or why there was none. */
  occupancy: Measure
  /** The one rounded integer. The only figure that leaves this module. */
  nightlyAgorot: Agorot
}

/** Why a stay could not be priced at all. Each maps to a Hebrew message. */
export type PricingRefusal =
  /** No plan matched the dates, the channel, the length or the actor. */
  | { code: 'no_rate_plan' }
  /** A derived plan chain longer than three, or one that closes a cycle. */
  | { code: 'derivation_too_deep'; ratePlanId: string }
  | { code: 'derivation_cycle'; ratePlanId: string }
  /** The stay is shorter than some rule in its range demands. */
  | { code: 'below_minimum_nights'; required: number; requested: number }
  /** The range itself is not a stay. */
  | { code: 'invalid_range' }

export interface PricingResolution {
  ratePlan: RatePlan
  /** After `derivation` has been applied, if there was one. */
  derivedFromPlanIds: readonly string[]
  nights: readonly NightResolution[]
  /** The strictest minimum any source imposed, for the refusal message. */
  minimumNights: number
  floorAgorot: Agorot | null
  ceilingAgorot: Agorot | null
}

// ── The freeze ────────────────────────────────────────────────────────────

/**
 * 🔒 The frozen explanation of one booking's price.
 *
 * What it is NOT is the price. The price is `booking_price_lines`, written
 * once, and `bookings.total_agorot` is a database-maintained sum of those
 * lines. This is the record of WHY those lines and not others.
 *
 * The separation is what removes the temptation to recompute. Notice what is
 * missing from this interface: there is no total, and no function in this
 * module accepts one of these and returns money. A caller who wants a number
 * has to supply a full `PricingContext`, and a caller holding a full context
 * is a caller pricing something new rather than re-reading something old.
 */
export interface BookingPriceSnapshot {
  id: string
  bookingId: string
  /** 1, 2, 3 … A re-pricing is a new row; nothing is ever updated. */
  sequence: number
  hash: string
  capturedAt: string
  effectiveOn: string
  engineVersion: string
  ratePlanId: string | null
  ratePlanVersion: number | null
  inputs: Readonly<Record<string, unknown>>
  resolution: Readonly<Record<string, unknown>>
  taxRateBps: number | null
  touristVatExempt: boolean
  cancellationPolicy: Readonly<Record<string, unknown>>
  /** Null is the one in force. */
  supersededBy: string | null
}

// ── Constants, each with the reason beside it ─────────────────────────────

/**
 * The specificity ladder of spec §7.2.
 *
 * Mirrors `public.rate_rule_specificity` in 0072 exactly, and
 * `specificity.test.ts` proves the two agree rung for rung. Two definitions of
 * one ladder is a real risk, taken knowingly: the database needs it to write
 * the stored column, and the resolver needs it to rank a calendar entry
 * against a rule, and neither can read the other at the moment it decides.
 */
export const SPECIFICITY = {
  /** One unit, one night, typed by a person. Nothing outranks it. */
  rateCalendar: 100,
  unitWeekday: 80,
  unit: 70,
  unitGroupWeekday: 60,
  unitGroup: 50,
  propertyWeekday: 40,
  property: 30,
  /** `units.base_price_agorot` — the last floor, and never null. */
  unitBasePrice: 0,
} as const

/**
 * How far a derived rate may be chased.
 *
 * Three, because a chain of four is a rate card no person can hold in their
 * head, and a rate card nobody can read is one nobody can check. Spec §7.8.
 */
export const MAX_DERIVATION_DEPTH = 3

/**
 * The Israeli weekend, as a default a business may change.
 *
 * Friday and Saturday. Thursday is deliberately NOT a weekend night here: it
 * is one at some guesthouses and not at others, and a default that is wrong
 * half the time is worse than a default somebody has to set.
 */
export const DEFAULT_WEEKEND_WEEKDAYS: readonly number[] = [5, 6]

/**
 * Basis points in one whole. `1000 bps = 10%`.
 *
 * Named because `adjustValue / 10000` appearing inline in three files is three
 * chances to type `1000`.
 */
export const BPS_PER_UNIT = 10000

/**
 * The version stamped on every snapshot this build writes.
 *
 * Bumped when a change to the resolver would change the EXPLANATION of a
 * price, not only when it would change a number. An old snapshot explained by
 * new logic is a subtler version of the same lie the freeze exists to prevent.
 */
export const PRICING_ENGINE_VERSION = '1.0.0'

/**
 * The most nights one batch approval may cover.
 *
 * Sixty, from spec §17: an approver who is shown two hundred nights approves
 * the list rather than the prices, and a batch that large is a rate card
 * changed by somebody who did not read it.
 */
export const MAX_SUGGESTION_BATCH = 60
