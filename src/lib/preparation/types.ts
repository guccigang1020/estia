/**
 * The preparation and event costing contract.
 *
 * Two questions are answered from the same booking. *What has to be done* —
 * how many mattresses, how many sheets, how many towels, who cleans and for
 * how long — and *what it is worth* — revenue less the cost of producing it.
 * They share a vocabulary because they share a cause: the same twenty-five
 * guests that need twenty-five pillows are the twenty-five guests the
 * consumables line is priced from, and two models of "how big is this
 * booking" would disagree by the end of the first month.
 *
 * ── The law this file exists to enforce ───────────────────────────────────
 *
 * **No requirement quantity is written in code.** Not one. A rule is a record
 * an organization edits; the engine multiplies, divides, adds a buffer and
 * rounds up. The worked example everyone quotes — 25 guests over 5 double-
 * width beds giving 25 sleeping places, 25 linen sets, 25 pillows and 15
 * mattresses — is an *output*. If any of those figures appeared as a literal
 * here, the next customer with 4 beds would get the wrong plan and nobody
 * would find out until the guests arrived. `no-hardcoded-numbers.test.ts`
 * enforces this by scanning every non-test file in this directory.
 *
 * Money is `Agorot` and dates are ISO strings, both imported from the booking
 * contract rather than restated. See `src/lib/booking/types.ts`.
 */

import type { Agorot, DateRange, PriceLine } from '../booking/types'
import type { InventoryState, TaskStatus } from '../contracts/states'

// ── What kind of stay this is ─────────────────────────────────────────────

/**
 * The event type, which decides which template of extra requirements applies.
 *
 * A wedding and a Shabbat both put twenty-five people in the same house and
 * need almost entirely different preparation. The type is on the booking, not
 * inferred from the guest count, because inference gets it wrong on exactly
 * the bookings that matter most.
 */
export const EVENT_TYPES = [
  'accommodation',
  'day_event',
  'overnight_event',
  'wedding',
  'birthday',
  'retreat',
  'corporate',
  'shabbat',
  'family_event',
  'custom',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

/**
 * A property characteristic a rule can branch on.
 *
 * Deliberately an open string map rather than a closed enum: an organization
 * that runs kosher kitchens, or one with a wheelchair-accessible unit, needs
 * to write rules against that fact without a code change. The constants below
 * are the ones ESTIA itself understands; anything else is the customer's.
 */
export type PropertyFlags = Readonly<Record<string, boolean>>

export const FLAG_POOL = 'pool'
export const FLAG_OUTDOOR = 'outdoor'
export const FLAG_KOSHER_KITCHEN = 'kosher_kitchen'
export const FLAG_ACCESSIBLE = 'accessible'

// ── Beds ──────────────────────────────────────────────────────────────────

/**
 * A kind of bed, with its capacity and the linen it consumes.
 *
 * `capacity` and `positions` are separate and the difference is the whole
 * point. A "Jewish bed" is two single beds pushed together: it sleeps two
 * (capacity 2) and it is physically two mattresses (positions 2), so it takes
 * two single sheets rather than one double. A double bed sleeps two on one
 * mattress and takes one double sheet. Collapsing the two numbers into one is
 * how a laundry order comes out half the size it needed to be.
 *
 * `linen` is per bed of this type, not per position, so a bed type that wants
 * an odd number of pillows can say so.
 */
export interface BedType {
  id: string
  /** Hebrew, shown to the cleaner. */
  label: string
  /** How many people sleep in it. */
  capacity: number
  /** How many separate mattresses it is. */
  positions: number
  /** What making this bed consumes, per bed. */
  linen: readonly BedLinenRequirement[]
  /** Minutes to set one up and make it. Feeds the duration estimate. */
  setupMinutes: number
  /**
   * May this type be brought in to cover a shortfall? A crib is not an answer
   * to "we are three people short".
   */
  usableAsExtra: boolean
}

export interface BedLinenRequirement {
  itemId: string
  label: string
  /** Per bed of the owning type. */
  quantity: number
  unit: RequirementUnit
}

/** What a property physically holds of one bed type. */
export interface PropertyBedStock {
  bedTypeId: string
  /** Made up in a bedroom and ready. */
  permanent: number
  /** On site but folded away; usable, costs setup time. */
  storage: number
  /** Recorded as absent. Counted nowhere; surfaced as a maintenance fact. */
  missing: number
}

/**
 * Everything about the physical place that preparation depends on.
 *
 * Snapshotted with the booking. A property that gains a bedroom in March must
 * not change what February's plan said it needed.
 */
export interface PropertyConfiguration {
  organizationId: string
  propertyId: string
  unitId: string | null
  label: string
  bedrooms: number
  bathrooms: number
  flags: PropertyFlags
  beds: readonly PropertyBedStock[]
  /**
   * The bed type conjured out of nothing when storage runs out — the floor
   * mattress. Named rather than guessed, because "cheapest type with capacity
   * 1" is a heuristic that will one day pick a crib.
   */
  extraSleepingBedTypeId: string
  /**
   * The ceiling on extras. A house with a fire certificate for eighteen does
   * not sleep twenty-five however many mattresses exist. `null` is no ceiling.
   */
  maximumSleepingPlaces: number | null
}

// ── The basis every rule and every cost is measured against ───────────────

/**
 * The quantities a rule may multiply.
 *
 * One list, shared by the requirement rules and the cost formulas, because
 * "per guest" must mean the same thing to the towel rule and to the
 * consumables line. Two lists would drift, and the drift would show up as a
 * P&L that disagrees with the work plan it was costed from.
 */
export const FACT_BASES = [
  'guests',
  'adults',
  'children',
  'nights',
  'bedrooms',
  'bathrooms',
  'permanent_capacity',
  'sleeping_places',
  'extra_beds',
  /** Always one. Lets "per booking" and "per event" be ordinary arithmetic. */
  'booking',
] as const

export type FactBasis = (typeof FACT_BASES)[number]

/**
 * The resolved measurements of one booking against one property.
 *
 * Computed once, before any rule runs, because `sleeping_places` and
 * `extra_beds` are themselves the output of the bed allocation. A rule that
 * asked for them mid-evaluation would be reading a number that had not been
 * decided yet.
 */
export interface PreparationFacts {
  guests: number
  adults: number
  children: number
  nights: number
  bedrooms: number
  bathrooms: number
  permanentCapacity: number
  sleepingPlaces: number
  extraBeds: number
  booking: number
  eventType: EventType
  flags: PropertyFlags
}

// ── Rules ─────────────────────────────────────────────────────────────────

export const REQUIREMENT_CATEGORIES = [
  'sleeping',
  'linen',
  'towels',
  'bathrooms',
  'kitchen',
  'event',
  'cleaning',
  'consumables',
  'special_setup',
] as const

export type RequirementCategory = (typeof REQUIREMENT_CATEGORIES)[number]

export const REQUIREMENT_UNITS = [
  'piece',
  'set',
  'pack',
  'person',
  'hour',
] as const

export type RequirementUnit = (typeof REQUIREMENT_UNITS)[number]

/**
 * The sections a cleaner's plan is divided into, in the order they are worked.
 *
 * A single list of ninety items is a list nobody finishes correctly. The
 * sections are fixed rather than free text because the dependency graph and
 * the readiness percentages are both written against them.
 */
export const PLAN_SECTIONS = [
  'cleaning',
  'bedrooms',
  'extra_sleeping',
  'bathrooms',
  'towels',
  'kitchen',
  'event_setup',
  'outdoor',
  'pool',
  'final_inspection',
] as const

export type PlanSectionKey = (typeof PLAN_SECTIONS)[number]

/**
 * How much of something is needed, as arithmetic over one basis.
 *
 * `factor / divisor` covers every shape the specification asks for: one bath
 * towel per guest, one hand towel per *couple* (divisor two), two staff per
 * however many guests. `plus` covers the flat additions. Anything the four
 * fields cannot express is a second rule, not a bigger expression language —
 * a rule engine that grows an interpreter stops being editable by the person
 * who runs the house.
 *
 * The result always rounds **up**: half a towel is a towel.
 */
export interface QuantityExpression {
  basis: FactBasis
  factor?: number
  divisor?: number
  plus?: number
}

/**
 * A margin over the computed quantity, which always rounds up.
 *
 * Two shapes because the business states it two ways: "towels plus ten
 * percent" and "pillows plus two". Neither is expressible as the other —
 * a percentage of a small number rounds to nothing, and a flat two on a
 * hundred-guest wedding is not a buffer.
 */
export type RequirementBuffer =
  { kind: 'percent'; percent: number } | { kind: 'flat'; amount: number }

/**
 * The comparisons a condition may make, as a value rather than only a type.
 *
 * A screen that lets somebody write a rule has to offer these as choices, and
 * a service boundary has to refuse anything else. Both need the list at
 * runtime, and a second copy typed out beside the union is the copy that
 * drifts — so the union is derived from the list, exactly as `EVENT_TYPES`
 * and `REQUIREMENT_UNITS` already are.
 */
export const CONDITION_COMPARATORS = ['lt', 'lte', 'eq', 'gte', 'gt'] as const

export type ConditionComparator = (typeof CONDITION_COMPARATORS)[number]

/**
 * When a rule applies at all.
 *
 * The thresholds — "twenty or more guests means four packs of toilet paper" —
 * are values inside these records. They are never `if` statements, so a
 * customer whose threshold is fifteen changes a number instead of asking for
 * a release.
 */
export type RuleCondition =
  | {
      kind: 'compare'
      basis: FactBasis
      comparator: ConditionComparator
      value: number
    }
  | { kind: 'event_type'; anyOf: readonly EventType[] }
  | { kind: 'flag'; flag: string; equals: boolean }
  | { kind: 'all'; of: readonly RuleCondition[] }
  | { kind: 'any'; of: readonly RuleCondition[] }
  | { kind: 'not'; of: RuleCondition }

/**
 * One thing that has to be present, and how many of it.
 *
 * `effectiveFrom` / `effectiveTo` are what make a rule change safe: editing a
 * rule closes the old row and opens a new one rather than mutating history.
 * The snapshot mechanism in `snapshot.ts` is the second, stronger guarantee —
 * see the note there for why one of the two is not enough.
 */
export interface PreparationRule {
  id: string
  organizationId: string
  category: RequirementCategory
  /** The organization's own catalogue key. Joins rules, stock and costs. */
  itemId: string
  /** Hebrew, shown to the cleaner. */
  label: string
  unit: RequirementUnit
  quantity: QuantityExpression
  condition: RuleCondition | null
  buffer: RequirementBuffer | null
  section: PlanSectionKey
  requiresPhoto: boolean
  /** Hebrew, shown under the item. */
  instructions: string | null
  /** Minutes of work per unit, for the duration and critical-path estimate. */
  minutesPerUnit: number
  /** ISO date the rule starts applying. */
  effectiveFrom: string
  /** ISO date it stops, exclusive. `null` while it is current. */
  effectiveTo: string | null
}

/**
 * The extra requirements an event type brings with it.
 *
 * A Shabbat adds an urn, hotplates, candles, tables, chairs, a kiddush cup and
 * tablecloths — and a second urn once the party is big enough, which is one
 * more ordinary conditional rule and not a special case in the engine.
 */
export interface EventTemplate {
  id: string
  organizationId: string
  eventType: EventType
  label: string
  rules: readonly PreparationRule[]
  /** Sections this event needs shown even when no rule fills them. */
  sections: readonly PlanSectionKey[]
}

// ── Requirements ──────────────────────────────────────────────────────────

/**
 * One line of the answer, with its derivation attached.
 *
 * A requirement is the *total* of one item across the whole booking — the
 * laundry order and the shopping list read from here. Where the work happens
 * is on the sources: five made-up beds put ten sheets in the bedrooms section
 * and fifteen floor mattresses put fifteen more in the extra-sleeping section,
 * and the same twenty-five sheets are one line to the laundry and two jobs to
 * the cleaner. Splitting them would make the laundry order wrong; merging them
 * would make the work plan wrong.
 *
 * `sources` is not diagnostics. A manager told the house needs 28 bath towels
 * for 25 guests will ask why, and "the rules said so" loses the argument. Each
 * source names the rule, its section, what it computed before the buffer and
 * what it computed after.
 */
export interface Requirement {
  category: RequirementCategory
  itemId: string
  label: string
  unit: RequirementUnit
  quantity: number
  /** Where most of the work sits. The sources hold the full distribution. */
  section: PlanSectionKey
  requiresPhoto: boolean
  instructions: string | null
  minutes: number
  sources: readonly RequirementSource[]
}

export interface RequirementSource {
  ruleId: string
  /**
   * `bed` for anything derived from the sleeping allocation, `extra` for
   * something the guest asked for by name, `rule` for the ordinary case.
   */
  origin: 'rule' | 'bed' | 'extra'
  section: PlanSectionKey
  base: number
  buffered: number
  minutes: number
}

/** Where one bed came from and how many were taken. */
export type BedSource = 'permanent' | 'storage' | 'added'

export interface BedAllocationLine {
  bedTypeId: string
  label: string
  source: BedSource
  count: number
  /** Sleeping places these beds provide, in total. */
  capacity: number
}

/**
 * How the guests were laid out across the beds that exist.
 *
 * `unplacedGuests` is non-zero only when the property's ceiling or its bed
 * catalogue genuinely cannot hold the party. It is reported rather than
 * thrown, because the manager's next move is to change the booking or the
 * property, and an exception at this depth tells them neither.
 */
export interface SleepingAllocation {
  guests: number
  permanentCapacity: number
  lines: readonly BedAllocationLine[]
  sleepingPlaces: number
  extraBeds: number
  unplacedGuests: number
  /**
   * Separate mattresses laid out, as against places slept in.
   *
   * The two differ exactly where a bed sleeps more than one person on one
   * mattress, and the difference is what decides a double sheet against two
   * single ones. Reported so the laundry forecast reads the beds rather than
   * inferring them from the head count.
   */
  positions: number
}

/** The complete answer to "what does this booking need". */
export interface RequirementPlan {
  facts: PreparationFacts
  allocation: SleepingAllocation
  requirements: readonly Requirement[]
}

// ── Inventory ─────────────────────────────────────────────────────────────

/**
 * Where a piece of stock is in its cycle.
 *
 * Taken whole from `src/lib/contracts/states.ts` and not redefined. Linen is
 * the only stock in a guest house that is simultaneously an asset, a
 * consumable and a bottleneck — counting it as a single "on hand" number is
 * how a property runs out of sheets on a Friday with forty sets sitting in a
 * laundry van — but that makes linen's *cycle* special, not its vocabulary.
 * The cycle lives in `inventory.ts` as `LINEN_TRANSITIONS`, a transition table
 * over these shared states.
 *
 * The specification described the linen loop as seven steps ending
 * `laundry → clean → available`. `clean` is expressed here as the moment of
 * the `laundry → available` transition rather than as a seventh state: a
 * second inventory vocabulary in one product is the exact failure the frozen
 * contract exists to prevent, and "clean but not yet back in the cupboard" is
 * a fact about location, which `StockLocation` already carries.
 */
export type StockLocation =
  | { kind: 'property'; propertyId: string }
  | { kind: 'warehouse'; warehouseId: string }

/**
 * What exists, where, and how much of it must never be touched.
 *
 * `safetyStock` is not a shortage threshold — it is the floor a business keeps
 * for the booking it has not taken yet. Eating into it is allowed and
 * reported; not knowing it happened is not.
 */
export interface StockLevel {
  itemId: string
  label: string
  location: StockLocation
  onHand: number
  /** Already promised to other bookings. */
  reserved: number
  safetyStock: number
  /** Per-state counts, for linen. Absent for everything else. */
  byState?: Readonly<Partial<Record<InventoryState, number>>>
}

export type InventorySeverity = 'info' | 'warning' | 'critical'

export interface InventoryLine {
  itemId: string
  label: string
  required: number
  /** `onHand - reserved` at the property. */
  available: number
  shortage: number
  safetyStock: number
  /** Fulfilling this requirement would leave stock under the floor. */
  breachesSafetyStock: boolean
}

export interface InventoryAlert {
  itemId: string
  severity: InventorySeverity
  /** Hebrew, shown to the manager. */
  message: string
  shortage: number
}

/** Stock that exists elsewhere and could be moved here instead of bought. */
export interface TransferSuggestion {
  itemId: string
  from: StockLocation
  to: StockLocation
  quantity: number
}

export interface ProcurementTask {
  itemId: string
  label: string
  quantity: number
  /** ISO date it has to be here by. */
  neededBy: string
}

export interface InventoryCheck {
  lines: readonly InventoryLine[]
  alerts: readonly InventoryAlert[]
  transfers: readonly TransferSuggestion[]
  procurement: readonly ProcurementTask[]
  /** True when nothing is short and no floor is breached. */
  satisfied: boolean
}

// ── The work plan ─────────────────────────────────────────────────────────

/**
 * A person changing a computed quantity, without erasing what was computed.
 *
 * Three values, never two. `PlanItem.requiredCount` stays exactly what the
 * rules produced, `delta` is what a person added or removed, and the final
 * figure is their sum — derived by `finalCount` rather than stored. Storing
 * only the final number is the shape that loses the argument three weeks
 * later: nobody can then tell whether the house needed thirty towels because
 * the engine said so or because somebody typed it, and the engine's own figure
 * is gone.
 *
 * The reason is mandatory, for the same reason `SectionOverride.reason` is.
 */
export interface QuantityAdjustment {
  /** Signed. Positive adds to the calculated figure, negative removes. */
  delta: number
  /** In the adjuster's own words. Hebrew, and never empty. */
  reason: string
  byUserId: string
  at: string
}

export interface PlanItem {
  id: string
  itemId: string
  label: string
  category: RequirementCategory
  unit: RequirementUnit
  /**
   * What the rules computed, and only that. A manual change lands on
   * `adjustment` beside it and never on this number, which is what keeps the
   * arithmetic explainable after somebody has intervened.
   */
  requiredCount: number
  completedCount: number
  requiresPhoto: boolean
  photoIds: readonly string[]
  instructions: string | null
  minutes: number
  /**
   * A manual change to the calculated figure, or `null` where there is none.
   *
   * Optional so that every plan stored before adjustments existed still parses
   * and every caller that builds a `PlanItem` still compiles.
   */
  adjustment?: QuantityAdjustment | null
}

export interface PlanSection {
  key: PlanSectionKey
  /** Hebrew heading. */
  label: string
  items: readonly PlanItem[]
  /** Sections that must be complete before this one may be. */
  dependsOn: readonly PlanSectionKey[]
  status: SectionStatus
  minutes: number
  assignedToUserId: string | null
  /** Present when a supervisor closed the section with items outstanding. */
  override: SectionOverride | null
  /**
   * The plan version whose changes the person working this section has seen.
   *
   * `null` — and absent — means nothing has been acknowledged, which is the
   * right answer for a section nobody has started. It matters only where work
   * is already under way: a booking that grew from twenty-five to thirty while
   * the beds were being made must show "ההזמנה השתנתה — ההכנה עודכנה" until
   * the person holding it says they have seen it. See `needsAcknowledgement`.
   */
  acknowledgedVersion?: number | null
}

/**
 * A section's status, in the product's frozen task vocabulary.
 *
 * A plan section *is* a unit of operational work — the thing the task board
 * shows — so it uses `TaskStatus` rather than a private four-value union that
 * would have to be translated at every boundary. Only a subset is reachable
 * from inside a plan: a section is `new` until somebody ticks something,
 * `in_progress` while they do, `blocked` when a dependency holds it up, and
 * `completed` once it is closed. Assignment and verification are the task
 * board's business, not the plan's.
 */
export type SectionStatus = TaskStatus

/**
 * A supervisor closing a section that is not finished.
 *
 * The reason is mandatory and stored, because the interesting question three
 * weeks later is never "was it overridden" but "what did they say at the
 * time". The audit event carries the same sentence.
 */
export interface SectionOverride {
  supervisorUserId: string
  reason: string
  at: string
  /** What was still outstanding when it was closed. */
  outstanding: readonly { itemId: string; missing: number }[]
}

/**
 * The booking facts this revision was computed for, carried on the plan.
 *
 * ── Why these live here and not on the booking ────────────────────────────
 *
 * A cleaner holds `task.view` and nothing else. `work_plans_select` asks for
 * exactly that; `bookings_select` asks for `booking.view`, which they do not
 * have and must not be given — handing it over to let somebody read "two baby
 * cots" would hand them the guest, the price and the source in the same
 * motion, which is the privacy inversion the whole role model exists to
 * prevent.
 *
 * So the four facts a person doing the work actually needs are captured when
 * the plan is computed and stored beside it, in the same spirit as
 * `snapshotHash`: the plan already refuses to re-read the catalogue, and now
 * it refuses to re-read the booking too. What is deliberately absent is
 * everything else on that row — no guest, no price, no deposit, no source, no
 * channel. A field cannot leak from a type that has nowhere to put it.
 *
 * ── These move; the snapshot does not ─────────────────────────────────────
 *
 * The distinction is worth stating because the two look alike. The *rules* are
 * frozen for ever, so a plan built in March still costs what it cost in March.
 * The *facts* are measurements of a booking that is still alive: a stay that
 * slides a week has a new arrival, and a party that grows has new counts. Both
 * are rewritten on every recomputation, which is exactly what makes the
 * deadline on a cleaner's screen the real one.
 */
export interface PlanFacts {
  /** ISO instant. The deadline every readiness figure is measured against. */
  arrivalAt: string
  eventType: EventType
  /** The guest's own words. Hebrew, and null when they said nothing. */
  specialRequests: string | null
  /** Every head, infants included. */
  guests: number
  adults: number
  children: number
}

export interface WorkPlan {
  id: string
  organizationId: string
  bookingId: string
  propertyId: string
  unitId: string
  version: number
  /** The rules this plan was built from. Never re-read from the catalogue. */
  snapshotHash: string
  createdAt: string
  sections: readonly PlanSection[]
  /** Total estimated minutes along the longest dependency chain. */
  criticalPathMinutes: number
  /** Recommended crew, from the complexity score. */
  recommendedStaff: number
  /**
   * What the plan was computed for, readable without the booking row.
   *
   * `null` for a plan stored before `0036_work_plan_facts.sql` added the
   * columns. That is not a defect to paper over: the facts cannot be
   * back-filled without reading the booking, which is the read this field
   * exists to avoid. A plan with no facts renders without them and says so.
   */
  facts: PlanFacts | null
}

// ── Delta ─────────────────────────────────────────────────────────────────

export interface RequirementChange {
  itemId: string
  label: string
  category: RequirementCategory
  section: PlanSectionKey
  from: number
  to: number
  /** Positive for an addition, negative for a removal. */
  delta: number
}

/**
 * What changed between two versions of a plan.
 *
 * Produced on every recomputation and never suppressed. A booking that grows
 * from twenty-five to thirty guests while a cleaner is already halfway through
 * the bedrooms is the single most expensive silent change in this domain.
 */
export interface PlanDelta {
  fromVersion: number
  toVersion: number
  added: readonly RequirementChange[]
  removed: readonly RequirementChange[]
  unchanged: number
  /** Sections touched, so the people working them can be told. */
  affectedSections: readonly PlanSectionKey[]
  notifyUserIds: readonly string[]
}

export interface PlanVersion {
  plan: WorkPlan
  delta: PlanDelta
  supersedesVersion: number
  changedByUserId: string
  changedAt: string
  reason: string | null
}

// ── Complexity and staffing ───────────────────────────────────────────────

/**
 * The weights that turn a booking into a difficulty score.
 *
 * Every weight is configuration. A business whose houses are all one storey
 * and whose events are all Shabbat dinners has a completely different curve
 * from one running weddings, and neither is wrong.
 */
export interface ComplexityConfiguration {
  perGuest: number
  perBedroom: number
  perBathroom: number
  perExtraBed: number
  perEventType: Readonly<Partial<Record<EventType, number>>>
  perFlag: Readonly<Record<string, number>>
  perExtraItem: number
  /** One member of staff absorbs this much score. */
  scorePerStaff: number
  minimumStaff: number
  /** Minutes of work per point of score. */
  minutesPerPoint: number
  minimumMinutes: number
  /** What an hour of that work costs the business. */
  hourlyRate: Agorot
}

export interface StaffingEstimate {
  score: number
  contributions: readonly { key: string; points: number }[]
  recommendedStaff: number
  /** Wall-clock duration for the recommended crew. */
  estimatedMinutes: number
  /** Crew size times duration. */
  staffMinutes: number
  labourCost: Agorot
}

// ── Readiness ─────────────────────────────────────────────────────────────

export const READINESS_COMPONENTS = [
  'cleaning',
  'sleeping',
  'towels',
  'kitchen',
  'payment',
  'contract',
] as const

export type ReadinessComponent = (typeof READINESS_COMPONENTS)[number]

export interface ReadinessLine {
  component: ReadinessComponent
  percent: number
  /** Hebrew explanation of what the percentage counted. */
  detail: string
}

export interface ReadinessAlert {
  severity: InventorySeverity
  component: ReadinessComponent | 'overall'
  message: string
}

export interface ReadinessReport {
  lines: readonly ReadinessLine[]
  overallPercent: number
  hoursToArrival: number
  alerts: readonly ReadinessAlert[]
}

export interface ReadinessPolicy {
  /** Below this percent, close to arrival, is a critical alert. */
  criticalPercent: number
  /** How close "close to arrival" is. */
  criticalHours: number
  /** A component below this is worth a warning at any distance. */
  warningPercent: number
}

// ── Costing ───────────────────────────────────────────────────────────────

/**
 * A variable cost, as arithmetic rather than a number.
 *
 * `per_requirement` is the important one: laundry costs twelve shekels per
 * linen set, and the number of linen sets is whatever the preparation rules
 * decided. Binding the cost to the requirement rather than re-deriving it from
 * the guest count means the P&L and the work plan can never disagree about how
 * much laundry there was.
 */
export type CostFormula =
  | { kind: 'fixed'; amount: Agorot }
  | { kind: 'per_unit'; basis: FactBasis; unitAmount: Agorot }
  | {
      kind: 'above_threshold'
      basis: FactBasis
      threshold: number
      unitAmount: Agorot
    }
  | {
      kind: 'per_requirement'
      itemId?: string
      category?: RequirementCategory
      unitAmount: Agorot
    }
  | { kind: 'sum'; of: readonly CostFormula[] }

export interface VariableCostRule {
  id: string
  organizationId: string
  key: string
  /** Hebrew, shown in the breakdown. */
  label: string
  formula: CostFormula
  condition: RuleCondition | null
  effectiveFrom: string
  effectiveTo: string | null
}

export const COST_FREQUENCIES = [
  'monthly',
  'quarterly',
  'annual',
  'one_time',
] as const

export type CostFrequency = (typeof COST_FREQUENCIES)[number]

/**
 * How a fixed cost reaches a single booking.
 *
 * Five methods because five different kinds of cost behave differently. Rent
 * accrues whether or not anyone stays (`per_calendar_day`); a cleaner's
 * retainer only earns out on occupied nights; a licence fee is per booking;
 * water is per guest; and a management fee follows the money
 * (`per_property_share`). Choosing one is an accounting decision the business
 * makes, so it is a column, not a convention.
 */
export const ALLOCATION_METHODS = [
  'per_calendar_day',
  'per_occupied_night',
  'per_booking',
  'per_guest',
  'per_property_share',
] as const

export type AllocationMethod = (typeof ALLOCATION_METHODS)[number]

/** How a cost held above one property is split between them first. */
export const SHARING_METHODS = [
  'equal',
  'by_revenue',
  'by_units',
  'custom_percent',
] as const

export type SharingMethod = (typeof SHARING_METHODS)[number]

export interface CostShare {
  propertyId: string
  /** Units at the property, revenue in the period, or the custom percent. */
  weight: number
}

export interface SharingRule {
  method: SharingMethod
  shares: readonly CostShare[]
}

export type CostScope =
  | { kind: 'organization' }
  | { kind: 'property'; propertyId: string }
  | { kind: 'unit'; unitId: string }

export interface FixedCost {
  id: string
  organizationId: string
  key: string
  label: string
  scope: CostScope
  amount: Agorot
  frequency: CostFrequency
  allocation: AllocationMethod
  /** Required for organization-scope costs; ignored otherwise. */
  sharing: SharingRule | null
  effectiveFrom: string
  effectiveTo: string | null
}

/**
 * The denominators.
 *
 * Allocation is division, and a division needs a period to divide over. These
 * are measured facts about the month the booking sits in — not estimates —
 * which is why they are supplied rather than computed here.
 */
export interface AllocationContext {
  propertyId: string
  /** Days the cost's period covers: 31 for a January monthly cost. */
  periodDays: number
  /** Nights sold at this property in the period. */
  periodOccupiedNights: number
  periodBookings: number
  periodGuests: number
  periodRevenue: Agorot
  /** Units at this property, for `by_units` sharing. */
  periodUnits: number
}

/**
 * Defined once, in `contracts/states`. This module computes the four a costing
 * model can reach — gross, accommodation only, net of direct costs and net
 * contribution. The catalogue also carries `stay_total` and `net_revenue`,
 * which belong to agent commission and finance.
 */
export { COMMISSION_BASES, COMMISSION_BASE_LABEL } from '../contracts/states'
import type { CommissionBase } from '../contracts/states'
export type { CommissionBase }

export interface CommissionRule {
  id: string
  organizationId: string
  basis: CommissionBase
  /** Basis points. 1,000 is ten percent. Integer, so no float creeps in. */
  rateBasisPoints: number
  effectiveFrom: string
  effectiveTo: string | null
}

/**
 * One line of the profit statement, with the sentence that explains it.
 *
 * `explain` is Hebrew and is written by whichever calculator produced the
 * line, because only it knows that ₪525 was 350 plus fifteen guests over the
 * threshold. A generic breakdown can only show the number, which is the black
 * box the specification forbids.
 */
export interface PnLLine {
  key: string
  label: string
  amount: Agorot
  explain: string
}

export interface PnLGroup {
  lines: readonly PnLLine[]
  /** Always the plain sum of `lines`. Never independently rounded. */
  total: Agorot
}

export interface EventPnL {
  bookingId: string
  revenue: PnLGroup
  directCosts: PnLGroup
  allocatedFixedCosts: PnLGroup
  commission: PnLGroup
  netContribution: Agorot
  /** Basis points of revenue. 4,875 is 48.75%. */
  marginBasisPoints: number
}

export interface CostActual {
  key: string
  amount: Agorot
}

export interface VarianceLine {
  key: string
  label: string
  estimated: Agorot
  actual: Agorot
  /** Actual less estimated. Positive means it cost more than expected. */
  variance: Agorot
}

export interface VarianceReport {
  lines: readonly VarianceLine[]
  totalEstimated: Agorot
  totalActual: Agorot
  totalVariance: Agorot
}

// ── The booking, as preparation sees it ───────────────────────────────────

export interface BookingExtra {
  itemId: string
  label: string
  quantity: number
  category: RequirementCategory
  section: PlanSectionKey
  unit: RequirementUnit
  minutesPerUnit: number
}

/**
 * The slice of a booking this engine reads.
 *
 * Narrow on purpose. Preparation has no business knowing the guest's phone
 * number, and a type that could carry it is a type that eventually does.
 */
export interface PreparationBooking {
  id: string
  organizationId: string
  propertyId: string
  unitId: string
  stay: DateRange
  guests: number
  adults: number
  children: number
  /**
   * Of the guests, the ones who sleep in a cot rather than a bed.
   *
   * Optional, and absent means *unrecorded* rather than none — the same
   * distinction `SleepingAllocationInput.couples` draws, for the same reason.
   * Deriving it as `guests - adults - children` was the obvious alternative
   * and is a trap: nothing enforces that invariant, so any caller that grew
   * the party by moving `guests` alone would have had five extra people
   * silently reclassified as babies and left without beds.
   *
   * The engine reads it in exactly one place — `sleepingGuestsOf` — because an
   * infant is a head everywhere else: they are on the fire count, they eat,
   * and they generate laundry.
   */
  infants?: number
  eventType: EventType
  extras: readonly BookingExtra[]
  /** ISO instant. Drives the readiness countdown. */
  arrivalAt: string
  priceLines: readonly PriceLine[]
  /**
   * What the guest asked for, in their own words. Hebrew free text.
   *
   * On the booking rather than in `extras` because it is not countable: "שתי
   * מיטות תינוק, אחת בחדר ההורים" is an instruction to a person and not a
   * quantity for an engine. It reaches the cleaner — see `cleaner-view.ts` —
   * because a request nobody doing the work ever reads is a request that was
   * not honoured.
   *
   * Optional, so a caller written before the column existed still compiles.
   */
  specialRequests?: string | null
  /**
   * The sleeping shape the desk recorded, as asked for by name.
   *
   * Distinct from `SleepingAllocation`, which is an *output* — the beds the
   * house turned out to be short of. A booking may want a cot in a house with
   * a spare bedroom, and the two numbers are allowed to disagree.
   */
  sleeping?: SleepingShape
}

/**
 * Couples, extra beds and cots, exactly as the desk typed them.
 *
 * Structurally the same three numbers as `SleepingRequest` in
 * `src/lib/booking/party.ts`, and deliberately not an import of it: this
 * module is the engine's vocabulary and the booking domain's must be free to
 * grow a field without changing what preparation reads. `couples` is recorded
 * and, today, consumed by nothing — `allocateSleeping` lays four adults out
 * identically whether they are two couples or four colleagues — which is a
 * real gap in the allocator's input and is stated here rather than hidden.
 */
export interface SleepingShape {
  couples: number
  extraBedsRequested: number
  cotsRequested: number
}

// ── Catalogue and snapshot ────────────────────────────────────────────────

/**
 * Everything an organization has configured, unfiltered.
 *
 * This is the *live* set: it changes when somebody edits a rule. Nothing in
 * this module computes from it directly — see `snapshot.ts`.
 */
export interface PreparationCatalogue {
  organizationId: string
  bedTypes: readonly BedType[]
  rules: readonly PreparationRule[]
  eventTemplates: readonly EventTemplate[]
  propertyConfiguration: PropertyConfiguration
  variableCosts: readonly VariableCostRule[]
  fixedCosts: readonly FixedCost[]
  commissionRules: readonly CommissionRule[]
  complexity: ComplexityConfiguration
  readinessPolicy: ReadinessPolicy
  sectionLabels: Readonly<Record<PlanSectionKey, string>>
}

/**
 * The frozen ruleset a booking is computed against, for ever.
 *
 * The reasoning is in `snapshot.ts`. The shape matters here: it is the
 * catalogue with the effective-dating already resolved and the pricing of the
 * day attached, so nothing downstream needs a date to interpret it.
 */
export interface PreparationSnapshot {
  organizationId: string
  /** Content hash. Identical configurations share one, and tampering shows. */
  hash: string
  /** When it was taken. */
  capturedAt: string
  /** The date whose rules were resolved. Usually the booking's arrival. */
  effectiveOn: string
  bedTypes: readonly BedType[]
  rules: readonly PreparationRule[]
  eventTemplates: readonly EventTemplate[]
  propertyConfiguration: PropertyConfiguration
  variableCosts: readonly VariableCostRule[]
  fixedCosts: readonly FixedCost[]
  commissionRule: CommissionRule | null
  complexity: ComplexityConfiguration
  readinessPolicy: ReadinessPolicy
  sectionLabels: Readonly<Record<PlanSectionKey, string>>
  /** What the guest was quoted, frozen alongside what it costs to deliver. */
  priceLines: readonly PriceLine[]
}
