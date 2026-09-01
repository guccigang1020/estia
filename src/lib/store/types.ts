/**
 * The store's domain vocabulary.
 *
 * Every state name in here is imported from `src/lib/contracts/states.ts` and
 * none is redefined. What this file adds is the *shapes* — a catalogue item as
 * the domain works with it, an order line as it is stored, the eligibility
 * question and its answer — which are local to this module and belong nowhere
 * else.
 *
 * ── The one distinction the rest of the module rests on ────────────────────
 *
 * `CatalogueItem` and `OrderLineSnapshot` look similar and are opposites.
 *
 *   · A `CatalogueItem` is **live**. It is what the owner is editing right
 *     now, and its price is whatever they last typed.
 *   · An `OrderLineSnapshot` is **frozen**. It is what a guest agreed to, and
 *     nothing that happens to the catalogue afterwards may reach it.
 *
 * The two are deliberately different types rather than one type with a flag,
 * because a flag is something a caller forgets to check and a type is
 * something the compiler checks for them. There is exactly one function in
 * this module that turns the first into the second — `snapshotLine` in
 * `snapshot.ts` — and no function anywhere that goes the other way.
 */

import type {
  StoreFulfilmentKind,
  StoreItemStatus,
  StoreItemType,
  StoreMode,
  StoreOrderStatus,
  StorePaymentMode,
  StorePaymentStatus,
  StorePricingModel,
  StoreVisibilityRule,
} from '../contracts/states'
import type { Agorot } from '../booking/types'

/* --------------------------------------------------------- configuration -- */

/** Where an order came from. Mirrors `store_order_source` in 0032. */
export type StoreOrderSource = 'guest_portal' | 'staff' | 'automation'

/** How a line's price was arrived at. Mirrors `store_order_lines.price_source`. */
export type StorePriceSource = 'catalogue' | 'override' | 'manual' | 'quote'

export type StoreAvailabilityRuleKind =
  'weekday' | 'date_range' | 'blackout' | 'season'

export type StoreProviderRequestStatus =
  'draft' | 'sent' | 'confirmed' | 'unconfirmed' | 'cancelled'

export type StoreAmendmentStatus =
  'proposed' | 'awaiting_consent' | 'applied' | 'rejected' | 'withdrawn'

/**
 * How much of a shop this business runs, and what it has agreed to be shown.
 *
 * `paymentModesEnabled` empty means "the default only", which is the honest
 * reading of a business that has thought about this once and moved on.
 */
export type StoreSettings = {
  organizationId: string
  /** `null` is the organization default; a value narrows it to one property. */
  propertyId: string | null
  mode: StoreMode
  defaultPaymentMode: StorePaymentMode
  paymentModesEnabled: readonly StorePaymentMode[]
  approvalRequiredDefault: boolean
  guestStoreEnabled: boolean
  guestStoreHeading: string | null
  guestStoreIntro: string | null
  currency: string
  orderReferencePrefix: string
  cartTtlHours: number
}

export type StoreCategory = {
  id: string
  name: string
  slug: string
  description: string | null
  icon: string | null
  sortOrder: number
  isActive: boolean
}

/** One choice on a product — a size, a guest band, a style. */
export type StoreItemOption = {
  id: string
  name: string
  selection: 'single' | 'multi'
  isRequired: boolean
  sortOrder: number
  values: readonly StoreItemOptionValue[]
}

export type StoreItemOptionValue = {
  id: string
  label: string
  /** Signed: a smaller size is a negative delta. */
  priceDeltaAgorot: Agorot
  isDefault: boolean
  isAvailable: boolean
  sortOrder: number
}

/** An extra bought inside a product. Never listed on its own. */
export type StoreItemAddon = {
  id: string
  name: string
  description: string | null
  priceAgorot: Agorot
  pricingModel: StorePricingModel
  maxQuantity: number | null
  isActive: boolean
  sortOrder: number
}

/** A question the product asks, whose answer is stored with the order. */
export type StoreItemQuestion = {
  key: string
  label: string
  kind: 'text' | 'choice' | 'number'
  required: boolean
  choices?: readonly string[]
}

/**
 * What happens to a purchase if the stay does not.
 *
 * Copied onto the order line at purchase. §11 judges a cancelled booking
 * against the copy, never against whatever the catalogue says today.
 */
export type StoreCancellationPolicy = {
  kind: 'free_until_hours' | 'non_refundable' | 'percentage' | 'unspecified'
  /** For `free_until_hours`: free up to this many hours before the service. */
  hoursBefore?: number
  /** For `percentage`: what fraction comes back, 0–100. */
  refundPercent?: number
}

/**
 * The operational recipe. What buying this creates for somebody to do.
 *
 * `dueOffsetHours` is relative to the service moment and is usually negative:
 * the pool is heated four hours before the guest wants to swim in it.
 */
export type StoreFulfilmentRecipe = {
  taskType?: string
  title?: string
  description?: string
  dueOffsetHours?: number
  checklist?: readonly string[]
  teamId?: string | null
}

/**
 * What §10 ranks against. Never a filter that hides an owner's product —
 * only a reason to put one above another.
 */
export type StoreAudience = {
  occasions?: readonly string[]
  suitsCouple?: boolean
  suitsFamily?: boolean
  suitsGroup?: boolean
}

/**
 * A catalogue row, live.
 *
 * Its price is whatever the owner last typed and it changes underneath
 * everybody. That is correct and is the reason `OrderLineSnapshot` exists.
 */
export type CatalogueItem = {
  id: string
  organizationId: string
  categoryId: string | null
  name: string
  slug: string
  shortDescription: string | null
  description: string | null
  itemType: StoreItemType
  status: StoreItemStatus
  pricingModel: StorePricingModel
  /** `null` only for `quote`. Integer agorot. */
  basePriceAgorot: Agorot | null
  /** `advanced` mode only, and `null` everywhere else. */
  costAgorot: Agorot | null
  supplierReference: string | null
  taxRateBps: number | null
  minQuantity: number
  maxQuantity: number | null
  maxPerBooking: number | null
  unitLabel: string | null
  leadTimeHours: number
  capacityPerDay: number | null
  requiresCapability: string | null
  minGuests: number | null
  maxGuests: number | null
  visibilityRule: StoreVisibilityRule
  visibilityDaysBefore: number | null
  /** `null` means "whatever the organization's default says". */
  requiresApproval: boolean | null
  /** `null` means "whatever the organization's default says". */
  paymentMode: StorePaymentMode | null
  fulfilmentKind: StoreFulfilmentKind
  fulfilmentRecipe: StoreFulfilmentRecipe
  providerId: string | null
  customizationQuestions: readonly StoreItemQuestion[]
  cancellationPolicy: StoreCancellationPolicy
  media: readonly string[]
  tags: readonly string[]
  audience: StoreAudience
  isFeatured: boolean
  sortOrder: number
  options: readonly StoreItemOption[]
  addons: readonly StoreItemAddon[]
}

/** The same product, at one house. Every field is "inherit" when absent. */
export type StoreItemPropertyOverride = {
  itemId: string
  propertyId: string
  isAvailable: boolean
  priceOverrideAgorot: Agorot | null
  leadTimeHoursOverride: number | null
  capacityPerDayOverride: number | null
  providerOverrideId: string | null
  notes: string | null
}

export type StoreAvailabilityRule = {
  id: string
  /** `null` means every item. */
  itemId: string | null
  /** `null` means every property. */
  propertyId: string | null
  kind: StoreAvailabilityRuleKind
  /** ISO weekday numbers, 1 = Monday … 7 = Sunday. */
  weekdays: readonly number[]
  fromDate: string | null
  toDate: string | null
  fromTime: string | null
  toTime: string | null
  maxPerDay: number | null
  /** `true` forbids, `false` permits. Stated, never inferred from `kind`. */
  isBlocking: boolean
  note: string | null
  isActive: boolean
}

export type StorePackage = {
  id: string
  categoryId: string | null
  name: string
  slug: string
  shortDescription: string | null
  description: string | null
  /** The package's own price. Deliberately NOT the sum of its members. */
  priceAgorot: Agorot
  pricingModel: StorePricingModel
  status: StoreItemStatus
  media: readonly string[]
  audience: StoreAudience
  cancellationPolicy: StoreCancellationPolicy
  visibilityRule: StoreVisibilityRule
  visibilityDaysBefore: number | null
  isFeatured: boolean
  sortOrder: number
  memberItemIds: readonly string[]
}

export type StoreProvider = {
  id: string
  name: string
  contactName: string | null
  phone: string | null
  email: string | null
  serviceTypes: readonly string[]
  defaultChannel: string
  leadTimeHours: number
  notes: string | null
  isActive: boolean
}

export type StorePromoCode = {
  id: string
  code: string
  description: string | null
  discountKind: 'percent' | 'amount'
  percent: number | null
  amountAgorot: Agorot | null
  minOrderAgorot: Agorot
  maxUses: number | null
  uses: number
  maxUsesPerBooking: number | null
  validFrom: string | null
  validUntil: string | null
  itemIds: readonly string[]
  isActive: boolean
}

/* ---------------------------------------------------------------- orders -- */

/**
 * One line of a placed order. FROZEN.
 *
 * Every `…Snapshot` field is a copy taken at purchase. `itemId` is present for
 * reporting and is deliberately *not* a route back to a price: nothing in this
 * module reads a `CatalogueItem` to produce a figure on one of these.
 */
export type OrderLineSnapshot = {
  id: string
  orderId: string
  /** Reporting only. `null` once the product has been removed. */
  itemId: string | null
  packageId: string | null
  itemNameSnapshot: string
  itemTypeSnapshot: StoreItemType
  pricingModelSnapshot: StorePricingModel
  /** THE PRICE. What the guest agreed, per unit, in integer agorot. */
  unitPriceAgorot: Agorot
  optionsAgorot: Agorot
  addonsAgorot: Agorot
  lineDiscountAgorot: Agorot
  quantity: number
  /** Generated by the database from the five fields above it. */
  lineTotalAgorot: Agorot
  priceSnapshotAt: string
  priceSource: StorePriceSource
  customizationAnswers: Readonly<Record<string, string | number>>
  fulfilmentKindSnapshot: StoreFulfilmentKind
  fulfilmentRecipeSnapshot: StoreFulfilmentRecipe
  leadTimeHoursSnapshot: number
  cancellationPolicySnapshot: StoreCancellationPolicy
  providerId: string | null
  lineStatus: StoreOrderStatus
  notes: string | null
  sortOrder: number
  chosenOptions: readonly OrderLineOptionSnapshot[]
}

export type OrderLineOptionSnapshot = {
  id: string
  optionId: string | null
  optionValueId: string | null
  optionNameSnapshot: string
  valueLabelSnapshot: string
  priceDeltaAgorot: Agorot
  sortOrder: number
}

export type StoreOrder = {
  id: string
  organizationId: string
  propertyId: string
  bookingId: string | null
  guestId: string | null
  reference: string
  source: StoreOrderSource
  status: StoreOrderStatus
  paymentStatus: StorePaymentStatus
  paymentMode: StorePaymentMode
  currency: string
  subtotalAgorot: Agorot
  discountAgorot: Agorot
  taxAgorot: Agorot
  /** The sum of the lines, less the order discount, plus tax. Never a rate. */
  totalAgorot: Agorot
  promoCodeId: string | null
  promoCodeSnapshot: string | null
  requestedForDate: string | null
  requestedForTime: string | null
  guestNotes: string | null
  internalNotes: string | null
  approvedAt: string | null
  confirmedAt: string | null
  fulfilledAt: string | null
  cancelledAt: string | null
  cancellationReason: string | null
  refundedAt: string | null
  amendmentCount: number
  createdAt: string
  lines: readonly OrderLineSnapshot[]
}

export type StoreOrderPayment = {
  id: string
  orderId: string
  mode: StorePaymentMode
  method: string
  /** Signed. A refund is a negative row, never a deletion. */
  amountAgorot: Agorot
  status: StorePaymentStatus
  reference: string | null
  notes: string | null
  recordedAt: string
}

export type StoreOrderAmendment = {
  id: string
  orderId: string
  kind: string
  status: StoreAmendmentStatus
  beforeState: Readonly<Record<string, unknown>>
  afterState: Readonly<Record<string, unknown>>
  /** Signed. Positive means the guest owes more, which is what needs consent. */
  deltaAgorot: Agorot
  reason: string
  consentRequired: boolean
  consentGivenAt: string | null
  appliedAt: string | null
  createdAt: string
}

export type StoreProviderRequest = {
  id: string
  orderId: string
  orderLineId: string | null
  providerId: string
  propertyId: string
  status: StoreProviderRequestStatus
  channel: string
  serviceName: string
  serviceDate: string
  serviceTime: string | null
  durationMinutes: number | null
  quantity: number
  operationalNotes: string | null
  reference: string
  sentAt: string | null
  confirmedAt: string | null
}

/* ------------------------------------------------------------ the booking -- */

/**
 * What the store needs to know about the stay it is selling into.
 *
 * Deliberately a **narrow view** rather than the booking itself. Two reasons,
 * and the second is the important one:
 *
 *   1. `src/lib/booking/types.ts` belongs to another owner and importing its
 *      full `Booking` here would couple this module to every future change in
 *      it.
 *   2. This shape is what the eligibility engine, the personalization ranker
 *      and the provider renderer are each handed — and none of them can leak a
 *      guest's telephone number to a DJ if the type they were given never
 *      carried one. `provider-request.ts` takes `BookingFacts` and the test
 *      beside it proves the point.
 */
export type BookingFacts = {
  id: string
  organizationId: string
  propertyId: string
  reference: string
  status: string
  /** ISO date, `YYYY-MM-DD`. */
  checkIn: string
  checkOut: string
  adults: number
  children: number
  infants: number
  /** Free-text keys the property offers — 'heated_pool', 'sound_system'. */
  propertyCapabilities: readonly string[]
  /** Whether money is still owed on the stay itself. Drives `with_booking`. */
  balanceAgorot: Agorot
  /** Is the stay confirmed? Drives `after_confirmation` visibility. */
  isConfirmed: boolean
  /** Has the stay been paid? Drives `after_payment` visibility. */
  isPaid: boolean
  /** What the guest said the stay is for, when they said anything. */
  occasion: string | null
}

/** Total heads, which is what a per-guest price multiplies by. */
export function partySize(booking: BookingFacts): number {
  return booking.adults + booking.children
}
