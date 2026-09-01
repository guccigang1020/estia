/**
 * The laundry contract.
 *
 * ── The one law this module is built on ───────────────────────────────────
 *
 * **This engine computes no quantity.** Not one. `src/lib/preparation` already
 * decided how many sheets, how many towels and how many duvet covers this
 * booking needs, against rules the organization edits and a snapshot frozen at
 * the moment the booking was taken. A laundry requirement is that number,
 * filtered and bundled — never re-derived from the guest count, never
 * recomputed "to be safe".
 *
 * The temptation is real and worth naming, because it is one line of code. The
 * laundry screen wants a number, the booking has twenty-five guests, and
 * `guests × 1` is a towel count. The moment that line is written there are two
 * answers to "how many towels" in one product, they agree in testing and they
 * diverge the first time somebody edits a preparation rule — and the symptom is
 * a laundry order that is right in March and quietly four short in April.
 *
 * So `LaundryRequirement.preparationQuantity` is copied, and the only
 * arithmetic in this module is the part preparation has no opinion about:
 * the item's own spare, and rounding up to whole bundles because a provider
 * counts in bundles.
 *
 * ── The second law: the list of what is linen is configuration ────────────
 *
 * Sheets, pillowcases, duvet covers, bath towels, hand towels, pool towels,
 * blankets, bath mats and robes go to a wash; mattresses, cribs, tables, toilet
 * paper and coffee do not. That sentence is true of most guest houses and it is
 * not true of all of them, and it is NOT in this file. It lives in
 * `LaundryItemProfile` rows, one per catalogue item, in the customer's own
 * database. `no-hardcoded-numbers.test.ts` scans this directory and fails on a
 * business number; there is no equivalent scan for a hardcoded item list, so
 * this paragraph is the guard, and the fixture in `testing/` is where such a
 * list is allowed to exist.
 *
 * ── Money is not here ─────────────────────────────────────────────────────
 *
 * There is no `Agorot` in this file and no price on any type below. A laundry
 * order's cost is an expense, which belongs to the finance module, and the
 * message this engine renders goes to a company with no contractual
 * relationship to the guest. A price on a type here is a price a renderer can
 * one day print. See `message.ts`.
 */

import type {
  LaundryChannel,
  LaundryDispatchMode,
  LaundryMode,
  LaundryStatus,
} from '../contracts/states'
import type { RequirementCategory, RequirementUnit } from '../preparation/types'

export type {
  LaundryChannel,
  LaundryDispatchMode,
  LaundryMode,
  LaundryStatus,
  RequirementCategory,
  RequirementUnit,
}

// ── Routing ───────────────────────────────────────────────────────────────

/**
 * Which way one item goes.
 *
 * Not in the frozen contracts because it is not a lifecycle — it is one item's
 * routing, and it exists only because `hybrid` is the real shape of many
 * businesses: they wash towels in the utility room and send linen out.
 */
export const LAUNDRY_ROUTES = ['internal', 'external'] as const

export type LaundryRoute = (typeof LAUNDRY_ROUTES)[number]

// ── Configuration ─────────────────────────────────────────────────────────

/**
 * What one catalogue item is, as far as laundry is concerned.
 *
 * `itemId` is the organization's own catalogue key — the same one
 * `PreparationRule.itemId` uses — which is what joins a computed requirement to
 * this profile. An item with no profile is not laundry, which is the safe
 * default in both directions: nothing is sent that nobody asked to send, and
 * nothing is silently dropped from a wash it was configured for.
 */
export interface LaundryItemProfile {
  organizationId: string
  itemId: string
  /** Hebrew, shown on the order and on the requirement list. */
  label: string
  /** Does this go to a wash at all. The whole filter, in one boolean. */
  laundryManaged: boolean
  /**
   * Can it survive one. A weighted blanket may be laundry-managed and
   * dry-clean only; collapsing the two facts sends it to a machine.
   */
  washable: boolean
  /** May it leave the premises. Some organizations will not send monograms. */
  externalLaundryAllowed: boolean
  /** Which way, under `hybrid`. Ignored under every other mode. */
  route: LaundryRoute | null
  defaultProviderId: string | null
  /** Overrides the settings' and the provider's, for this item alone. */
  turnaroundHours: number | null
  unit: RequirementUnit
  /**
   * How many pieces the provider counts as one billable bundle. One means the
   * item is counted individually, which is the ordinary case.
   */
  bundleSize: number
  /**
   * Spare added on top of whatever buffer preparation already applied.
   * Deliberately a second, separate number: preparation's buffer covers a
   * guest who wants an extra towel, this one covers a sheet that comes back
   * stained.
   */
  minimumBuffer: number
}

/**
 * How much of a laundry operation this business runs.
 *
 * One resolved value, never a merge of an organization row and a property row
 * column by column. `resolveSettings` picks one and reports which, because a
 * screen where a manager cannot tell which of six values they are actually
 * running on is worse than one that shows them the organization default.
 */
export interface LaundrySettings {
  organizationId: string
  /** `null` for the organization-wide row. */
  propertyId: string | null
  mode: LaundryMode
  dispatchMode: LaundryDispatchMode
  defaultChannel: LaundryChannel
  defaultProviderId: string | null
  turnaroundHours: number
  /** ISO weekday numbers, 1 = Monday .. 7 = Sunday. */
  pickupDays: readonly number[]
  deliveryDays: readonly number[]
  forecastHorizonDays: number
  /** Appended to every order. Never guest information. */
  standingNotes: string | null
}

/** An outside company, as this module reads one. */
export interface LaundryProvider {
  id: string
  organizationId: string
  name: string
  contactName: string | null
  phone: string | null
  email: string | null
  defaultChannel: LaundryChannel
  turnaroundHours: number
  pickupDays: readonly number[]
  deliveryDays: readonly number[]
  /** Pieces, not money. A van will not come for six towels. */
  minimumOrderUnits: number
  notes: string | null
  isActive: boolean
}

// ── Explainability ────────────────────────────────────────────────────────

/**
 * One step of the arithmetic, in the reader's own language.
 *
 * EVERY NUMBER THIS MODULE SHOWS CARRIES ONE OF THESE. The charter's rule is
 * that a projected figure shows its arithmetic and there is no black-box
 * quantity, and the practical reason is an argument that happens in every
 * guest house: a manager is told the house needs 28 bath towels for 25 guests,
 * and "the system said so" loses. "25 מגבות = 25 אורחים × 1 לאורח, ועוד 3
 * מרווח" wins, and it wins because it is checkable.
 *
 * `value` is what the step arrived at, so a screen can render the chain as a
 * running total rather than as prose it has to parse.
 */
export interface ExplanationStep {
  /**
   * A stable key for the kind of step, so a test can assert the chain's shape
   * without matching Hebrew.
   */
  kind:
    | 'preparation'
    | 'preparation_buffer'
    | 'laundry_buffer'
    | 'bundle'
    | 'adjustment'
    | 'aggregate'
  /** Hebrew, shown under the number. */
  text: string
  /** The running figure after this step. */
  value: number
}

// ── The engine's output ───────────────────────────────────────────────────

/**
 * One item that has to be clean, at one property, by one moment.
 *
 * `preparationQuantity` is the canonical figure, copied. `quantity` is what
 * goes on the order. The two are different only by `buffer` and by rounding to
 * whole bundles, and `explanation` shows exactly that.
 */
export interface LaundryRequirement {
  itemId: string
  label: string
  unit: RequirementUnit
  category: RequirementCategory
  route: LaundryRoute
  propertyId: string
  /** ISO instant it must be clean by. */
  requiredBy: string
  /** Internal. Which booking caused it. Never rendered to a provider. */
  sourceBookingId: string | null
  /** THE CANONICAL FIGURE, COPIED FROM PREPARATION. Never recomputed. */
  preparationQuantity: number
  /** The item profile's own spare, on top of preparation's. */
  buffer: number
  /** How many pieces one bundle is. */
  bundleSize: number
  /** Whole bundles, after rounding up. */
  bundles: number
  /** What goes on the order: bundles × bundleSize. */
  quantity: number
  providerId: string | null
  turnaroundHours: number
  explanation: readonly ExplanationStep[]
}

/**
 * A preparation requirement that is NOT going to a wash, and why.
 *
 * Reported rather than dropped. A manager who expects to see duvet covers on
 * the list and does not is owed the reason — "no profile", "not laundry
 * managed", "not washable" — because every one of those is a configuration
 * mistake somebody can fix, and a silently shorter list is one nobody knows to
 * look at.
 */
export interface SkippedRequirement {
  itemId: string
  label: string
  quantity: number
  reason:
    | 'no_profile'
    | 'not_laundry_managed'
    | 'not_washable'
    | 'external_not_allowed'
  /** Hebrew, shown beside the item. */
  explanation: string
}

export interface LaundryRequirementResult {
  mode: LaundryMode
  propertyId: string
  requiredBy: string
  requirements: readonly LaundryRequirement[]
  skipped: readonly SkippedRequirement[]
}

// ── Turnaround ────────────────────────────────────────────────────────────

/**
 * Whether the linen can physically be back in time.
 *
 * The specification's rule is that availability is never silently assumed, and
 * the failure it prevents is concrete: a Friday-afternoon arrival, a provider
 * whose turnaround is 48 hours, and a collection on Thursday morning. Every
 * individual fact is fine and the beds are unmade.
 *
 * `shortfallHours` is zero when safe, so a screen can sort by it and a test can
 * assert on it without reading `atRisk`.
 */
export interface TurnaroundAssessment {
  itemId: string
  label: string
  propertyId: string
  /** ISO instant the van collects, or is assumed to. */
  pickupAt: string
  turnaroundHours: number
  /** ISO instant it comes back: pickup plus turnaround. */
  expectedReturnAt: string
  /** ISO instant it has to be clean by. */
  requiredBy: string
  atRisk: boolean
  /** How many hours late, rounded up. Zero when it arrives in time. */
  shortfallHours: number
  /** Hebrew, both times named. */
  explanation: string
}

// ── Consolidation ─────────────────────────────────────────────────────────

/**
 * One provider run over several properties.
 *
 * `properties` is the record and `totals` is derived from it, never the other
 * way round. A consolidated figure of 74 linen sets tells a driver nothing;
 * 30 to the Galilee house and 44 to the Carmel one is the delivery, and the
 * specification's word for losing that is "collapsed into a total".
 */
export interface ConsolidatedRun {
  providerId: string | null
  route: LaundryRoute
  /** The tightest required-by across every property in the run. */
  requiredBy: string
  properties: readonly PropertyBreakdown[]
  /** Summed from `properties`. Convenience, never the source of truth. */
  totals: readonly ConsolidatedTotal[]
  /** Pieces in the whole run, for a provider's minimum. */
  totalUnits: number
}

export interface PropertyBreakdown {
  propertyId: string
  requiredBy: string
  lines: readonly LaundryRequirement[]
  units: number
}

export interface ConsolidatedTotal {
  itemId: string
  label: string
  unit: RequirementUnit
  quantity: number
  /** Which property contributed what. The breakdown, per item. */
  byProperty: readonly { propertyId: string; quantity: number }[]
  explanation: readonly ExplanationStep[]
}

// ── Forecast ──────────────────────────────────────────────────────────────

/**
 * One confirmed booking's contribution to the forward demand curve.
 *
 * `requirements` is the canonical preparation output for that booking. The
 * forecast filters and sums; it never asks how many guests there are.
 */
export interface ForecastEntry {
  bookingId: string
  propertyId: string
  /** ISO date the linen must be clean by. */
  requiredOn: string
  requirements: readonly import('../preparation/types').Requirement[]
}

export interface ForecastDay {
  /** ISO date. */
  date: string
  items: readonly ForecastItem[]
  /** Pieces needed that day, across every item. */
  units: number
  bookingIds: readonly string[]
}

export interface ForecastItem {
  itemId: string
  label: string
  unit: RequirementUnit
  quantity: number
}

export interface LaundryForecast {
  /** ISO date the window opens. */
  from: string
  /** ISO date the window closes, inclusive. */
  to: string
  horizonDays: number
  days: readonly ForecastDay[]
  /** The headline: "בשבעה הימים הקרובים, 112 מגבות רחצה ו-74 מערכות מצעים". */
  totals: readonly ForecastItem[]
  /** How many confirmed bookings the curve was built from. */
  bookingCount: number
  /** Hebrew, the headline as a sentence. */
  headline: string
}

// ── Orders ────────────────────────────────────────────────────────────────

/**
 * The three-column quantity, kept apart on purpose.
 *
 * `calculated` is what the engine derived. `adjustment` is what a person
 * changed it by. `final` is the sum, and it is derived here and generated in
 * the database, so no writer anywhere can store a third number.
 *
 * The rule the charter states is that the calculated figure is never
 * destroyed, and the reason is the question asked three weeks later. It is
 * never "how many did we send" — the delivery note answers that — it is "did we
 * send the wrong number, or did the engine get it wrong". One column cannot
 * answer it. A reason is mandatory for the same kind of reason: what somebody
 * said at the time is the only part of an override that is still useful later.
 */
export interface OrderLineQuantity {
  calculated: number
  adjustment: number
  /** Always `calculated + adjustment`. Never independently stored. */
  final: number
  /** Mandatory whenever `adjustment` is non-zero. */
  reason: string | null
  adjustedByUserId: string | null
  /** ISO instant. */
  adjustedAt: string | null
}

export interface LaundryOrderLine {
  id: string
  organizationId: string
  orderId: string
  /** Always present, even on a single-property order. The breakdown is record. */
  propertyId: string
  itemId: string
  label: string
  unit: RequirementUnit
  quantity: OrderLineQuantity
  /** ISO instant. Per line, because a run can carry two arrival times. */
  requiredBy: string
  /** Internal. Never given to the message renderer. */
  sourceBookingId: string | null
  explanation: readonly ExplanationStep[]
  notes: string | null
}

/**
 * One run, as this module reads one.
 *
 * NOTHING ABOUT A GUEST APPEARS ON THIS TYPE. No name, no telephone, no price,
 * no payment state, no agent. That is not an omission waiting to be corrected:
 * `message.ts` renders from exactly this object, so the privacy guarantee is
 * that there is nothing here to leak rather than that the renderer remembers
 * to leave it out. `message.test.ts` drives the whole path from a booking
 * carrying every one of those fields and asserts none of them survive.
 */
export interface LaundryOrder {
  id: string
  organizationId: string
  /** `null` means consolidated. The breakdown lives on the lines. */
  propertyId: string | null
  providerId: string | null
  status: LaundryStatus
  mode: LaundryMode
  dispatchMode: LaundryDispatchMode
  channel: LaundryChannel
  /** The only identifier a provider gets. Opaque on purpose. */
  reference: string
  /** Derived from provider, required-by day and line content. See `orders.ts`. */
  requirementKey: string
  requiredBy: string
  pickupAt: string | null
  expectedReturnAt: string | null
  returnedAt: string | null
  sentAt: string | null
  sentBody: string | null
  /** Never rendered to a provider. */
  internalNotes: string | null
  /** Rendered to a provider, reviewed by whoever sends it. */
  providerNotes: string | null
  lines: readonly LaundryOrderLine[]
  version: number
}
