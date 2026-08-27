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
  'damaged',
  'out_of_service',
] as const

export type InventoryState = (typeof INVENTORY_STATES)[number]

/** States that can still be promised to a future booking. */
export const ALLOCATABLE_INVENTORY_STATES: readonly InventoryState[] = [
  'available',
]

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
