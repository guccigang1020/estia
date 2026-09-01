/**
 * Frozen state vocabularies.
 *
 * These are the canonical names for the lifecycles the product talks about.
 * They live here, apart from any one module, for a specific reason: when the
 * payments module and the finance report and the agent portal each define what
 * "paid" means, they eventually disagree, and the disagreement surfaces as a
 * customer seeing two different numbers for the same booking.
 *
 * Rules for this file:
 *   · A module consumes these. It never redefines them locally.
 *   · The database enums use these exact strings, in this exact order.
 *   · Adding a value is a contract change: the migration, the domain code and
 *     the tests move together.
 *
 * Booking statuses are NOT here — they belong to `src/lib/booking/types.ts`,
 * which was frozen first and is where the rest of the booking vocabulary
 * already lives. Splitting them would be worse than the asymmetry.
 */

// ── Payment ───────────────────────────────────────────────────────────────

/**
 * A payment's life.
 *
 * `authorized` and `paid` are separate because a deposit is often held
 * without being taken — the money is reserved on the card and only captured
 * later, or released untouched. Collapsing them loses the distinction between
 * "we can take this" and "we have taken this".
 *
 * `unknown` is the one that matters most. A processor that times out has
 * either charged the card or not, and we cannot tell. Reporting that as
 * `failed` is how a guest gets charged twice on the retry.
 */
export const PAYMENT_STATUSES = [
  'pending',
  'authorized',
  'paid',
  'partially_paid',
  'failed',
  'refunded',
  'partially_refunded',
  'cancelled',
  'unknown',
] as const

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]

/** Statuses where money has actually moved to the business. */
export const SETTLED_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'paid',
  'partially_paid',
  'partially_refunded',
]

export const PAYMENT_METHODS = [
  'card',
  'bit',
  'bank_transfer',
  'cash',
  'paybox',
  'other',
] as const

export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

// ── Commission ────────────────────────────────────────────────────────────

/**
 * What an agent is owed, and how sure we are of it.
 *
 * The ladder exists because a commission is a promise long before it is a
 * debt. It is estimated when the booking is made, becomes eligible only once
 * the business's own conditions are met — payment received, cancellation
 * window passed, stay completed — and only then can a person approve it and
 * pay it. Paying on `estimated` means paying for stays that never happened.
 */
/**
 * What a commission percentage is a percentage *of*.
 *
 * This was defined twice, in two modules, with different members — the agent
 * domain offered "whole booking or accommodation only", the finance domain
 * "stay total, gross or net". Both readings are real deals, and neither list
 * contained the other, so the same rule would have paid two different amounts
 * depending on which module happened to evaluate it. That is the single most
 * expensive kind of drift this file exists to stop.
 *
 * The union of the two, stated once. The distinction is not academic: on a
 * ₪9,500 booking with ₪1,500 of extras, ten percent is ₪800 or ₪950 or less
 * again after channel fees, and an agent who expected one and received another
 * has a grievance nobody can settle from the record.
 */
export const COMMISSION_BASES = [
  /** Room revenue alone — excludes extras, cleaning, taxes and the deposit. */
  'accommodation_only',
  /** Accommodation plus extras, before tax. */
  'stay_total',
  /** Everything the guest paid. */
  'gross_revenue',
  /** Gross less channel fees, so an OTA booking pays commission on less. */
  'net_revenue',
  /** Gross less the direct operating costs of the stay. */
  'net_of_direct_costs',
  /** What the stay actually contributed, after direct and allocated costs. */
  'net_contribution',
] as const

export type CommissionBase = (typeof COMMISSION_BASES)[number]

export const COMMISSION_BASE_LABEL: Record<CommissionBase, string> = {
  accommodation_only: 'לינה בלבד',
  stay_total: 'סך השהות',
  gross_revenue: 'הכנסה ברוטו',
  net_revenue: 'הכנסה נטו',
  net_of_direct_costs: 'הכנסה בניכוי עלויות ישירות',
  net_contribution: 'תרומה נטו',
}

export const COMMISSION_STATUSES = [
  'estimated',
  'pending',
  'eligible',
  'approved',
  'paid',
  'cancelled',
] as const

export type CommissionStatus = (typeof COMMISSION_STATUSES)[number]

// ── Task ──────────────────────────────────────────────────────────────────

/**
 * Operational work.
 *
 * `blocked` is deliberately distinct from `in_progress`: a cleaner waiting for
 * linen that has not arrived is not making progress, and a board that cannot
 * show the difference cannot show a supervisor where the day is stuck.
 *
 * `verified` follows `completed` because a business may require inspection
 * before a unit counts as ready. Where it does not, the two collapse.
 */
export const TASK_STATUSES = [
  'new',
  'assigned',
  'accepted',
  'in_progress',
  'blocked',
  'awaiting_approval',
  'completed',
  'verified',
  'cancelled',
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const

export type TaskPriority = (typeof TASK_PRIORITIES)[number]

export const TASK_TYPES = [
  'cleaning',
  'preparation',
  'inspection',
  'maintenance',
  'guest_request',
  'delivery',
  'inventory',
  'finance',
  'administrative',
  'custom',
] as const

export type TaskType = (typeof TASK_TYPES)[number]

// ── Inventory ─────────────────────────────────────────────────────────────

/**
 * Where a physical item is in its cycle.
 *
 * `reserved` is what stops two events from being promised the same twenty
 * mattresses. Without it, stock looks sufficient right up to the morning both
 * events need it.
 */
export const INVENTORY_STATES = [
  'available',
  'reserved',
  'in_use',
  'dirty',
  'laundry',
  // Washed and on its way back, but not yet on the shelf. Distinct from
  // 'laundry' because a forecast has to know whether an item will be here by
  // Friday afternoon, and 'somewhere between the van and the cupboard' is a
  // different answer from 'still in the machine'.
  'returning',
  'damaged',
  'out_of_service',
  // Not damaged — gone. Kept apart from 'damaged' because the two lead to
  // different conversations: one is repaired or written off, the other is
  // investigated.
  'lost',
] as const

export type InventoryState = (typeof INVENTORY_STATES)[number]

/** States that can still be promised to a future booking. */
export const ALLOCATABLE_INVENTORY_STATES: readonly InventoryState[] = [
  'available',
]

// ── Laundry ───────────────────────────────────────────────────────────────

/**
 * How much of a laundry operation a business actually runs.
 *
 * The mode is the whole progressive-complexity story for this module in one
 * value. A single villa owner picks `simple` and gets a list of what must be
 * clean by Friday; a management company picks `external` and gets orders,
 * providers and turnaround arithmetic. Nothing above `off` is ever required
 * for a booking to be taken or a property to be prepared.
 *
 * `hybrid` is not a compromise between the two — it is the real shape of many
 * businesses, which wash towels themselves and send linen out.
 */
export const LAUNDRY_MODES = [
  'off',
  'simple',
  'internal',
  'external',
  'hybrid',
] as const

export type LaundryMode = (typeof LAUNDRY_MODES)[number]

/**
 * The life of one laundry order or internal batch.
 *
 * Deliberately longer than most businesses will use. A `simple` operation
 * moves an order from `draft` to `completed` and never touches the middle; an
 * internal laundry room uses every state. The vocabulary is frozen so that a
 * dashboard, an automation rule and a provider's status update all mean the
 * same thing by "washing" — but nothing forces a business through states it
 * has no use for. See `LAUNDRY_STATUS_IS_TERMINAL`.
 */
export const LAUNDRY_STATUSES = [
  'draft',
  // Awaiting a human decision, because sending an order is talking to an
  // outside party in the organization's name.
  'awaiting_approval',
  'to_collect',
  'collected',
  'sorting',
  'washing',
  'drying',
  'folding',
  'ready',
  'delivered_to_property',
  'completed',
  'cancelled',
] as const

export type LaundryStatus = (typeof LAUNDRY_STATUSES)[number]

/** Nothing further happens to an order in one of these. */
export const TERMINAL_LAUNDRY_STATUSES: readonly LaundryStatus[] = [
  'completed',
  'cancelled',
]

/**
 * When an order leaves the organization, and therefore when it stops being
 * freely editable.
 *
 * Everything from `to_collect` onward has been acted on by somebody — a
 * provider was told, a van came, a machine ran. Changing quantities after that
 * point is a new order or an amendment, never a silent edit.
 */
export const COMMITTED_LAUNDRY_STATUSES: readonly LaundryStatus[] = [
  'to_collect',
  'collected',
  'sorting',
  'washing',
  'drying',
  'folding',
  'ready',
  'delivered_to_property',
  'completed',
]

/**
 * Who presses send, and whether anybody does.
 *
 * The default is `approval_required` and that is a safety decision rather
 * than a taste one: an order sent automatically is a message in the
 * organization's name to an outside company, and a business must opt into
 * that rather than discover it.
 */
export const LAUNDRY_DISPATCH_MODES = [
  'manual_send',
  'approval_required',
  'auto_send',
] as const

export type LaundryDispatchMode = (typeof LAUNDRY_DISPATCH_MODES)[number]

/** How an order reaches a provider. Constrained by enabled integrations. */
export const LAUNDRY_CHANNELS = [
  'whatsapp',
  'sms',
  'email',
  'print',
  'export',
  'copy',
] as const

export type LaundryChannel = (typeof LAUNDRY_CHANNELS)[number]

// ── Inventory depth ───────────────────────────────────────────────────────

/**
 * How much stock arithmetic a business has asked for.
 *
 * `off` is a first-class answer and the default. Preparation, the cleaner's
 * plan and the laundry list all work without a single counted item — what is
 * skipped is validation against stock and the forward forecast, not the
 * operation itself.
 *
 * `basic` counts things. `tracked` adds reservation against future bookings
 * and the clean/dirty/laundry circulation. `advanced` adds transfers between
 * properties, discrepancy reconciliation and procurement suggestions.
 */
export const INVENTORY_MODES = ['off', 'basic', 'tracked', 'advanced'] as const

export type InventoryMode = (typeof INVENTORY_MODES)[number]

// ── Payment collection ────────────────────────────────────────────────────

/**
 * What the business asks of a guest before a booking counts as confirmed.
 *
 * This is a policy, not a payment. `none` is a legitimate and common answer —
 * a great many Israeli villas confirm by telephone and take the money on
 * arrival — and the product must not treat that as an unfinished
 * configuration. `manual` covers a bank transfer, Bit, PayBox, cash or a
 * cheque: money that moves outside the product and is recorded inside it.
 *
 * Kept in the frozen contracts because the guest portal, the booking screen,
 * the automation catalogue and the settings screen each have to mean exactly
 * the same thing by "deposit".
 */
export const PAYMENT_COLLECTION_POLICIES = [
  'none',
  'manual',
  'deposit',
  'full',
  'schedule',
  'after_approval',
  'custom',
] as const

export type PaymentCollectionPolicy =
  (typeof PAYMENT_COLLECTION_POLICIES)[number]

/**
 * What has to be true before a booking is confirmed.
 *
 * A set rather than a single value, because the real answers are combinations:
 * "contract signed **and** deposit recorded" is the common one, and hard-coding
 * a single confirmation path is exactly what this replaces. An empty set means
 * a manager's approval alone, which is the product's oldest behaviour and
 * stays available.
 */
export const CONFIRMATION_REQUIREMENTS = [
  'manager_approval',
  'guest_confirmation',
  'contract_signed',
  'deposit_recorded',
  'deposit_paid_live',
  'full_payment',
] as const

export type ConfirmationRequirement = (typeof CONFIRMATION_REQUIREMENTS)[number]

// ── Commerce ──────────────────────────────────────────────────────────────

/**
 * How much of a shop a business is actually running.
 *
 * `simple` is a catalogue and orders somebody handles by hand — which is what
 * a villa owner selling a שולחן שוק and pool heating actually needs, and it
 * requires no payment provider at all. `commerce` adds live payment.
 * `advanced` adds stock, suppliers, operational recipes and margin.
 */
export const STORE_MODES = ['off', 'simple', 'commerce', 'advanced'] as const

export type StoreMode = (typeof STORE_MODES)[number]

/**
 * What kind of thing is being sold.
 *
 * The type is not decoration: it decides what the product can be connected to.
 * A `property_addon` such as late checkout has to be checked against the
 * calendar and the cleaning schedule before it can be offered; a `service`
 * such as a DJ has a provider and a lead time; a `physical` bottle of wine may
 * draw on stock. `package` is a combination priced as one.
 */
export const STORE_ITEM_TYPES = [
  'physical',
  'service',
  'experience',
  'property_addon',
  'package',
  'custom',
] as const

export type StoreItemType = (typeof STORE_ITEM_TYPES)[number]

/**
 * How a price is arrived at.
 *
 * `quote` is a first-class answer, not a missing price: a caterer for thirty
 * people is quoted, and a product that pretends to a fixed figure it cannot
 * honour is worse than one that says "בקש הצעה".
 */
export const STORE_PRICING_MODELS = [
  'fixed',
  'per_guest',
  'per_child',
  'per_night',
  'per_hour',
  'per_unit',
  'starting_from',
  'quote',
] as const

export type StorePricingModel = (typeof STORE_PRICING_MODELS)[number]

export const STORE_ITEM_STATUSES = [
  'draft',
  'active',
  'paused',
  // Never deleted: an archived product still has to be readable from the
  // orders that bought it, at the price they paid.
  'archived',
] as const

export type StoreItemStatus = (typeof STORE_ITEM_STATUSES)[number]

/**
 * The life of one store order.
 *
 * Longer than most businesses will use, and deliberately so — a wine bottle
 * goes `pending → confirmed → completed` while a DJ goes through approval, a
 * provider request and a fulfilment window. One vocabulary so that a
 * dashboard, an automation rule and a provider update mean the same thing.
 */
export const STORE_ORDER_STATUSES = [
  'draft',
  'pending',
  'awaiting_approval',
  'awaiting_payment',
  'confirmed',
  'in_preparation',
  'ready',
  'fulfilled',
  'completed',
  'cancelled',
  'refunded',
] as const

export type StoreOrderStatus = (typeof STORE_ORDER_STATUSES)[number]

/** Nothing further happens to an order in one of these. */
export const TERMINAL_STORE_ORDER_STATUSES: readonly StoreOrderStatus[] = [
  'completed',
  'cancelled',
  'refunded',
]

/**
 * Where an order stops being freely editable.
 *
 * From `confirmed` onward a guest has been told something and money may have
 * moved. Changing quantities or prices after that is an amendment with its own
 * audit trail and, where it costs more, its own consent — never a silent edit.
 */
export const COMMITTED_STORE_ORDER_STATUSES: readonly StoreOrderStatus[] = [
  'confirmed',
  'in_preparation',
  'ready',
  'fulfilled',
  'completed',
]

/**
 * How an order's money stands, separately from the order's own progress.
 *
 * The same separation the booking already makes between its state and its
 * payment: an order can be `confirmed` and `unpaid` when the business has
 * chosen to add it to the booking balance, and coupling the two would make
 * that ordinary arrangement impossible to express.
 */
export const STORE_PAYMENT_STATUSES = [
  'unpaid',
  'pending_verification',
  'partially_paid',
  'paid',
  'refunded',
] as const

export type StorePaymentStatus = (typeof STORE_PAYMENT_STATUSES)[number]

/**
 * How the guest pays for store items, chosen by the business.
 *
 * `with_booking` — the purchase joins the booking's remaining balance, which
 * is how most Israeli guesthouses would actually handle pool heating added by
 * telephone. Live payment is one option among several and is never required.
 */
export const STORE_PAYMENT_MODES = [
  'with_booking',
  'pay_now',
  'manual',
  'on_arrival',
  'pay_later',
  'approval_first',
  'custom',
] as const

export type StorePaymentMode = (typeof STORE_PAYMENT_MODES)[number]

/** What happens operationally when an item is bought. */
export const STORE_FULFILMENT_KINDS = [
  'none',
  'staff_task',
  'external_provider',
  'inventory',
  'custom',
] as const

export type StoreFulfilmentKind = (typeof STORE_FULFILMENT_KINDS)[number]

/** When an item becomes visible to a guest inside their booking. */
export const STORE_VISIBILITY_RULES = [
  'always',
  'after_confirmation',
  'after_payment',
  'days_before_arrival',
  'during_stay',
] as const

export type StoreVisibilityRule = (typeof STORE_VISIBILITY_RULES)[number]

// ── Approval ──────────────────────────────────────────────────────────────

/**
 * A request to do something the requester is not allowed to do alone.
 *
 * The product treats exceeding a limit as a request rather than a refusal —
 * an agent who needs a 12% discount when 5% is allowed gets an approval flow,
 * not a closed door. `expired` exists because an unanswered request must not
 * hold a sale open forever.
 */
export const APPROVAL_STATUSES = [
  'requested',
  'approved',
  'rejected',
  'expired',
  'withdrawn',
] as const

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

export const APPROVAL_TYPES = [
  'discount',
  'refund',
  'expense',
  'maintenance',
  'agent_booking',
  'owner_request',
  'price_override',
  'availability_override',
] as const

export type ApprovalType = (typeof APPROVAL_TYPES)[number]

// ── Pagination ────────────────────────────────────────────────────────────

/**
 * How every list is read.
 *
 * Cursor-based rather than offset-based: an offset shifts under you when rows
 * are inserted while somebody pages through, so a booking can be shown twice
 * or missed entirely. On a busy calendar that is not hypothetical.
 */
export interface PageRequest {
  /** Opaque; from the previous response. Absent means the first page. */
  cursor?: string
  /** Clamped by the server. A caller asking for everything gets a page. */
  limit?: number
}

export interface Page<T> {
  items: T[]
  /** Absent when there is nothing more. */
  nextCursor?: string
  /** Only when a count is cheap. Never a count query over a large table. */
  totalCount?: number
}

/** The server's ceiling, regardless of what a caller asks for. */
export const MAX_PAGE_SIZE = 200
export const DEFAULT_PAGE_SIZE = 50
