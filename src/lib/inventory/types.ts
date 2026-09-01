/**
 * The stock module's vocabulary.
 *
 * Nothing here redefines a frozen contract. `InventoryState` and
 * `InventoryMode` come from `src/lib/contracts/states.ts`, the events come from
 * `src/lib/contracts/events.ts`, and `StockLocation` is imported from the
 * preparation module rather than re-declared — a second name for "where the
 * sheets are" is the exact drift the frozen contracts exist to stop.
 *
 * ── Why a date is a string ────────────────────────────────────────────────
 *
 * Every date in this module is an ISO `YYYY-MM-DD` in the property's own
 * calendar, the same as everywhere else in the product. A `Date` carries a
 * time and a zone, and a changeover is a day: representing Friday as an
 * instant is how a forecast run at 23:00 in Jerusalem reports Saturday's
 * shortage under Friday's heading.
 */

import type { InventoryMode, InventoryState } from '../contracts/states'
import type { StockLocation } from '../preparation/types'

export type { StockLocation }
export type { InventoryMode, InventoryState }

/* ------------------------------------------------------------- settings -- */

/**
 * What one organization has asked the stock module to do.
 *
 * `mode` is the whole progressive-complexity story in one value, and the
 * booleans beside it are not redundant with it: the mode sets what is
 * *available*, and a business inside `advanced` may still have turned
 * discrepancy tracking off because their cleaners do not count linen back in.
 * `capabilitiesFor` in `settings.ts` is where the two are combined, once.
 */
export interface InventorySettings {
  organizationId: string
  mode: InventoryMode
  /** A floor in whole units, kept for the booking not yet taken. */
  safetyBufferUnits: number
  /** The same floor as a share of the par level, 0–100. */
  safetyBufferPercent: number
  /** How far ahead a projected shortage is worth telling somebody about. */
  shortageWarningHorizonDays: number
  /** The widest window the forecast screens offer. */
  forecastHorizonDays: number
  /**
   * Days from "a guest used it" to "clean and on the shelf".
   *
   * Null means the business has not said, and the engine then schedules no
   * return at all. Guessing a short turnaround is how a forecast promises
   * towels that are still in the machine.
   */
  linenTurnaroundDays: number | null
  sharedStock: boolean
  reservationsEnabled: boolean
  warehouseEnabled: boolean
  discrepancyTracking: boolean
  transfersEnabled: boolean
}

/**
 * What the product may actually offer this organization.
 *
 * Derived, never stored. Every screen and every action asks this rather than
 * reading `mode` and re-deciding — which is how one screen ends up offering a
 * transfer that the action then refuses.
 */
export interface InventoryCapabilities {
  /** Is the module on at all? Everything else is false when this is false. */
  enabled: boolean
  /** Counting things. True from `basic` up. */
  counting: boolean
  /** Promising stock to a future booking. `tracked` and up. */
  reservations: boolean
  /** The clean / dirty / laundry loop, and therefore expected returns. */
  circulation: boolean
  /** The day-by-day projection. Needs reservations to have anything to walk. */
  forecast: boolean
  /** Moving stock between properties. `advanced`. */
  transfers: boolean
  /** Expected versus collected after checkout. `advanced`. */
  discrepancies: boolean
  /** Suggesting a purchase. `tracked` and up. */
  procurement: boolean
  /** A central store that is not a property. */
  warehouse: boolean
  /** One property's surplus counting toward another's requirement. */
  sharedStock: boolean
}

/* ---------------------------------------------------------------- stock -- */

/**
 * One item at one place, as the forecast needs it.
 *
 * `onHandClean` is deliberately not `quantity`. `inventory_items.quantity` is
 * every unit the business owns of this thing, including the forty in the
 * laundry van; what a Friday changeover can use is the part that is
 * `available`. `ALLOCATABLE_INVENTORY_STATES` is the contract that says which
 * that is, and `unusable` is the rest, carried separately so a screen can say
 * "you own sixty and can use eighteen" instead of one number that is wrong
 * both ways.
 */
export interface ForecastItem {
  itemId: string
  label: string
  propertyId: string
  /** Free text the business wrote: "מחסן קומה ב׳". */
  location: string | null
  unitOfMeasure: string
  /** Units in an allocatable state. What Friday can actually use. */
  onHandClean: number
  /** Owned but not usable now: dirty, in the laundry, damaged, lost. */
  byState: Readonly<Partial<Record<InventoryState, number>>>
  /**
   * `inventory_items.quantity_reserved` — the running total of live
   * reservations. Carried for display and **not** subtracted by the engine:
   * the reservations themselves are the demand lines, and subtracting the
   * total as well would consume the same towels twice.
   */
  reservedTotal: number
  /** The reorder point, `min_quantity`. Null when nobody set one. */
  minQuantity: number | null
  parLevel: number | null
}

/** One day's claim on one item at one property. */
export interface DemandLine {
  /** The day the stock must be clean and present. */
  date: string
  propertyId: string
  itemId: string
  quantity: number
  /** What is claiming it, for the sentence the alert prints. */
  bookingId: string | null
  reservationId: string | null
  label: string | null
}

/** Stock arriving on a day, from wherever it has been. */
export interface ExpectedReturn {
  date: string
  propertyId: string
  itemId: string
  quantity: number
  source: 'laundry' | 'transfer' | 'circulation' | 'purchase'
  /** The batch, order or transfer it came from, when there is one. */
  reference: string | null
}

/* ------------------------------------------------------------- forecast -- */

/**
 * One cell of the timeline: one item at one property on one day.
 *
 * Every number a screen prints comes from here, and the row carries the whole
 * arithmetic rather than a verdict — `required 30, expected clean 24,
 * shortage 6` has to be legible without opening the code that produced it.
 */
export interface ForecastRow {
  date: string
  propertyId: string
  itemId: string
  label: string
  /** What is clean and present at the start of the day. */
  openingClean: number
  /** Arriving today: laundry, transfers, stock consumed earlier coming back. */
  incoming: number
  /** Claimed today. */
  required: number
  /** `openingClean + incoming`. What today can actually draw on. */
  expectedClean: number
  /** `max(0, required − expectedClean)`. */
  shortage: number
  /** What is left after today's claim, before the buffer is considered. */
  closingClean: number
  /** The floor this item is expected to keep. */
  safetyBuffer: number
  /** Enough for today, but the remainder drops under the floor. */
  breachesBuffer: boolean
  /** The running total of live reservations, for display beside the row. */
  reserved: number
}

export type ShortageSeverity = 'warning' | 'critical'

/**
 * A shortage somebody has to be told about, with its arithmetic attached.
 *
 * `message` is a sentence and `required`/`expectedClean`/`shortage` are the
 * numbers it was built from, both, deliberately. A screen renders the numbers
 * in columns and the sentence in an alert, and neither is allowed to be a
 * black box the other cannot reproduce.
 */
export interface ShortageAlert {
  id: string
  severity: ShortageSeverity
  date: string
  propertyId: string
  propertyName: string | null
  itemId: string
  label: string
  required: number
  expectedClean: number
  shortage: number
  safetyBuffer: number
  /** Which bookings are claiming it that day. */
  bookingIds: readonly string[]
  /** Days from today. Zero is "this is happening now". */
  daysAhead: number
  /** The arithmetic, in Hebrew, as one line. */
  message: string
  /** The single thing most worth doing, chosen from `actions`. */
  suggestedAction: ShortageActionKind | null
  /** Everything the organization's capabilities actually support. */
  actions: readonly ShortageAction[]
}

/**
 * What can be done about a shortage.
 *
 * Nothing here is performed by the forecast. `transfer_from_property` in
 * particular is a *suggestion*: taking another property's working stock
 * without asking solves one shortage by creating another, so it becomes a
 * proposal with a named approver.
 */
export type ShortageActionKind =
  | 'order_laundry'
  | 'accelerate_laundry'
  | 'transfer_from_property'
  | 'purchase_request'
  | 'adjust_buffer'
  | 'mark_corrected'
  | 'ignore'

export interface ShortageAction {
  kind: ShortageActionKind
  label: string
  /** Why this one is offered here, in the business's own terms. */
  detail: string
  /** Where the person goes to do it, when the doing lives on another screen. */
  href: string | null
  /** The capability that had to be on for this to be offered at all. */
  requires: keyof InventoryCapabilities | null
}

export interface ForecastResult {
  /** The day the walk started. */
  from: string
  /** The last day walked, inclusive. */
  to: string
  rows: readonly ForecastRow[]
  alerts: readonly ShortageAlert[]
  transfers: readonly TransferSuggestion[]
  /**
   * False when the module is off, or on and unable to project. The screens
   * read this rather than inferring from an empty `rows`, because "nothing to
   * report" and "we do not do this" are different sentences.
   */
  computed: boolean
  /** Why, when `computed` is false. */
  skippedReason: ForecastSkipReason | null
}

export type ForecastSkipReason =
  'module_off' | 'no_forecast_capability' | 'no_items'

/** Stock that could be moved instead of bought. Never performed. */
export interface TransferSuggestion {
  itemId: string
  label: string
  fromPropertyId: string
  fromPropertyName: string | null
  toPropertyId: string
  toPropertyName: string | null
  quantity: number
  /** The day it has to be at the destination. */
  neededBy: string
  /** What the source keeps after giving this away. */
  sourceSurplusAfter: number
}

/* ---------------------------------------------------------- discrepancy -- */

export const DISCREPANCY_RESOLUTIONS = [
  'unresolved',
  'found',
  'damaged',
  'guest_loss',
  'correction',
  'investigating',
  'written_off',
] as const

export type DiscrepancyResolution = (typeof DISCREPANCY_RESOLUTIONS)[number]

export interface Discrepancy {
  id: string
  propertyId: string
  itemId: string
  label: string
  bookingId: string | null
  expected: number
  collected: number
  /** `collected − expected`. Negative is the ordinary case. */
  difference: number
  resolution: DiscrepancyResolution
  resolutionNote: string | null
  detectedOn: string
  resolvedOn: string | null
}

/* ---------------------------------------------------------- reservation -- */

export const RESERVATION_STATUSES = [
  'reserved',
  'released',
  'consumed',
  'expired',
] as const

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number]

export interface Reservation {
  id: string
  propertyId: string
  itemId: string
  bookingId: string | null
  quantity: number
  status: ReservationStatus
  neededFrom: string
  neededTo: string
  note: string | null
}

/* --------------------------------------------------------------- import -- */

/** One row of a spreadsheet or CSV, after parsing and before acceptance. */
export interface ImportRow {
  /** 1-based, counting the header. What the person sees in their editor. */
  lineNumber: number
  name: string
  sku: string | null
  category: string | null
  location: string | null
  unitOfMeasure: string
  quantity: number
  minQuantity: number | null
  parLevel: number | null
  unitCostAgorot: number | null
}

export type ImportRefusalCode =
  | 'missing_name'
  | 'quantity_not_a_number'
  | 'quantity_negative'
  | 'threshold_not_a_number'
  | 'cost_not_a_number'
  | 'duplicate_sku_in_file'
  | 'too_many_columns'
  | 'unknown_column'
  | 'row_empty'

export interface ImportRefusal {
  lineNumber: number
  code: ImportRefusalCode
  /** The offending value, as typed. Echoed so the person can find it. */
  value: string | null
  /** Hebrew. What is wrong and what to do about it. */
  message: string
}

/**
 * What an import would do, before it does it.
 *
 * Split into `create` and `update` rather than "upsert", because those are
 * different sentences to a person about to press a button on their own data:
 * "this adds forty-one items" and "this changes the count of nine you already
 * have" are the two facts they need, and one number hides both.
 */
export interface ImportPlan {
  create: readonly ImportRow[]
  update: readonly ImportRow[]
  /** Identical to what is already stored. Re-running an import changes nothing. */
  unchanged: readonly ImportRow[]
  refused: readonly ImportRefusal[]
  /** Header names the file carried that this product does not know. */
  unknownColumns: readonly string[]
}
