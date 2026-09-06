/**
 * The owner portal's vocabulary.
 *
 * ── What an owner is, and what it deliberately is not ─────────────────────
 *
 * A property owner is an **outside party with a commercial claim on a
 * property**, who may or may not sign in. That is two facts, and conflating
 * them is the mistake this file exists to avoid.
 *
 * `src/app/(app)/finance/owners/_lib` reads owners as *memberships holding the
 * `property_owner` role*, because that is all the schema could offer. It is
 * not enough for a statement: a business manages a villa for a couple who have
 * never heard of ESTIA and are paid by bank transfer, and there is no
 * membership to hang their share on. So `PropertyOwner` is a record of its own,
 * with `userId` nullable — the account is an optional attachment to the owner,
 * not the owner.
 *
 * ── One property, several owners; one owner, several properties ──────────
 *
 * `PropertyOwnership` is the link, and it carries a share in **basis points**.
 * Not a percentage as a float: 33⅓% is `3333` and the third co-owner's share is
 * whatever is left after the largest-remainder allocation, so the three parts
 * add to the property's total exactly. A float would produce three numbers that
 * add to 99.99% of the money and a rounding argument every month.
 *
 * The link is dated. An owner who sold their half in March must still be able
 * to read January's statement, and the statement must still say they held half
 * — which is why the share is copied onto the statement when it is issued and
 * is never read back through the link afterwards.
 *
 * ── What is NOT here ──────────────────────────────────────────────────────
 *
 * **Bank details.** A payout carries a free-text `reference` and nothing else.
 * Storing an owner's account number would put a payment instrument in a table
 * whose whole purpose is to be read by outside parties, and ESTIA does not move
 * money — the business does, in its own bank.
 *
 * **A guest, anywhere.** Not a name, not a phone, not an email, not the agent
 * who sold the night. There is no field on any type in this module that could
 * hold one; see `visibility.ts`, which enforces that at runtime as well as in
 * the type system.
 */

import type { Agorot } from '../booking/types'
import type { Currency } from '../finance/money'

// ── The owner ─────────────────────────────────────────────────────────────

export const OWNER_STATUSES = ['active', 'inactive'] as const

export type OwnerStatus = (typeof OWNER_STATUSES)[number]

export const OWNER_STATUS_LABEL: Record<OwnerStatus, string> = {
  active: 'פעיל',
  inactive: 'לא פעיל',
}

export interface PropertyOwner {
  id: string
  organizationId: string
  /** How this owner is named on their statement. Never derived from a login. */
  displayName: string
  /**
   * The ESTIA account this owner signs in as, when they have one.
   *
   * Null is the common case and not a defect: most owners of a managed villa
   * are paid and telephoned, and never open a screen. The portal is an offer,
   * not a precondition for being owed money.
   */
  userId: string | null
  email: string | null
  phone: string | null
  status: OwnerStatus
  notes: string | null
  createdAt: string
  version: number
}

// ── The ownership link ────────────────────────────────────────────────────

/** A whole property, in basis points. 100% expressed so it cannot be a float. */
export const FULL_SHARE_BPS = 10_000

export interface PropertyOwnership {
  id: string
  organizationId: string
  ownerId: string
  propertyId: string
  /**
   * This owner's share of the property, in basis points of 10,000.
   *
   * An integer, deliberately. It is a **weight** for allocating the property's
   * owner share between co-owners, never a multiplier applied to a total —
   * applying a percentage to a number that was itself derived from a percentage
   * is how two screens come to disagree by two agorot.
   */
  shareBps: number
  /** Property-local ISO date. The day this share began. */
  effectiveFrom: string
  /** Null while the share is current. */
  effectiveTo: string | null
  createdAt: string
  version: number
}

// ── The statement ─────────────────────────────────────────────────────────

export const OWNER_STATEMENT_STATUSES = ['draft', 'issued'] as const

export type OwnerStatementStatus = (typeof OWNER_STATEMENT_STATUSES)[number]

export const OWNER_STATEMENT_STATUS_LABEL: Record<
  OwnerStatementStatus,
  string
> = {
  draft: 'טיוטה',
  issued: 'הופק',
}

/**
 * How a screen renders one row, without inferring meaning from a sign.
 *
 * `carried` is the fourth kind and it earns its place: an opening balance is
 * neither revenue nor a cost, it participates in the sum, and calling it
 * `result` would exclude it from the very total it belongs to. `result` means
 * "a restatement of the running total" and is the one kind the sum skips.
 */
export type OwnerStatementLineKind = 'revenue' | 'cost' | 'result' | 'carried'

export interface OwnerStatementLine {
  key: string
  /** Hebrew, as it is printed. */
  label: string
  /** Signed as it contributes to its section's total. Costs are negative. */
  amountAgorot: Agorot
  kind: OwnerStatementLineKind
}

/** One named cost behind the expenses total, so the figure can be checked. */
export interface OwnerStatementExpense {
  ruleId: string
  label: string
  /** Positive magnitude. The chain subtracts it. */
  amountAgorot: Agorot
}

/**
 * A period statement for one owner and one property.
 *
 * Three sections, and each is a list of lines that adds to its own total. The
 * arithmetic is asserted at construction rather than trusted — see
 * `statement.ts`.
 *
 *   1. **The property this period.** Gross revenue down to the property's whole
 *      owner share. Every figure is the finance module's, consumed and not
 *      recomputed.
 *   2. **This owner's share of it**, allocated between co-owners by their
 *      basis points so the parts add to the whole exactly.
 *   3. **The account.** Opening balance, this period's share, what the owner
 *      paid in, what was paid out, closing balance.
 */
export interface OwnerStatement {
  id: string
  organizationId: string
  ownerId: string
  propertyId: string
  /** Property-local ISO dates, inclusive of the start and the end. */
  periodStart: string
  periodEnd: string
  status: OwnerStatementStatus
  /** Set the moment it is issued, and never again. */
  issuedAt: string | null
  issuedBy: string | null
  currency: Currency

  /** Copied from the link at issue, so a later sale cannot rewrite history. */
  shareBps: number

  // Section 1 — the property.
  grossRevenueAgorot: Agorot
  /**
   * Everything between gross and net: discounts, promotions, and whatever
   * deduction kind the pricing contract adds above net revenue next year.
   *
   * Derived as `gross − net` rather than as a named list, so a new deduction
   * joins it automatically instead of silently vanishing from the statement.
   */
  feesAgorot: Agorot
  expensesAgorot: Agorot
  /**
   * What the sellers earned. `null` when the reader may not see it — see
   * `visibility.ts`. When it is null the amount has been folded into
   * `feesAgorot`, so the lines still add to the same total.
   */
  salesCommissionAgorot: Agorot | null
  /** What the business retained for managing the property. */
  managementFeeAgorot: Agorot
  /** The whole property's owner share, before the co-owner split. */
  propertyOwnerShareAgorot: Agorot
  resultLines: readonly OwnerStatementLine[]
  expenses: readonly OwnerStatementExpense[]

  // Section 2 — this owner.
  ownerShareAgorot: Agorot

  // Section 3 — the account.
  openingBalanceAgorot: Agorot
  /** Money the owner put in, e.g. funding a boiler replacement. */
  paymentsAgorot: Agorot
  /** Money already transferred to the owner in this period. */
  payoutsAgorot: Agorot
  closingBalanceAgorot: Agorot
  balanceLines: readonly OwnerStatementLine[]

  /** How many stays produced these figures. Occupancy, never a guest. */
  bookingCount: number

  /**
   * Line keys folded away for this reader.
   *
   * Empty on the statement as it is stored. A screen that renders a redacted
   * statement can say so out loud rather than presenting a different number
   * under the same label with no explanation.
   */
  withheld: readonly string[]

  version: number
}

// ── Payouts ───────────────────────────────────────────────────────────────

export const OWNER_PAYOUT_METHODS = [
  'bank_transfer',
  'cheque',
  'cash',
  /** Netted against what the owner owes rather than moved. */
  'offset',
] as const

export type OwnerPayoutMethod = (typeof OWNER_PAYOUT_METHODS)[number]

export const OWNER_PAYOUT_METHOD_LABEL: Record<OwnerPayoutMethod, string> = {
  bank_transfer: 'העברה בנקאית',
  cheque: 'המחאה',
  cash: 'מזומן',
  offset: 'קיזוז',
}

/**
 * Which way the money went.
 *
 * Both directions live in one record because they are one account. A business
 * that pays an owner ₪40,000 in June and takes ₪12,000 back in July for a roof
 * has one balance with the owner, and two tables would give it two.
 */
export const OWNER_PAYOUT_DIRECTIONS = ['to_owner', 'from_owner'] as const

export type OwnerPayoutDirection = (typeof OWNER_PAYOUT_DIRECTIONS)[number]

export const OWNER_PAYOUT_DIRECTION_LABEL: Record<
  OwnerPayoutDirection,
  string
> = {
  to_owner: 'תשלום לבעלים',
  from_owner: 'תקבול מהבעלים',
}

export interface OwnerPayout {
  id: string
  organizationId: string
  ownerId: string
  /** Null for a settlement that spans an owner's whole portfolio. */
  propertyId: string | null
  /** The statement it settles, when it settles one. */
  statementId: string | null
  direction: OwnerPayoutDirection
  /** Always a positive magnitude. The direction carries the sign. */
  amountAgorot: Agorot
  method: OwnerPayoutMethod
  /** Property-local ISO date. */
  paidOn: string
  /** The business's own reference. Never a bank account number. */
  reference: string | null
  note: string | null
  recordedBy: string
  createdAt: string
}

// ── Reading shapes ────────────────────────────────────────────────────────

/** One row of the owner list: who, how many properties, what is outstanding. */
export interface OwnerSummary {
  owner: PropertyOwner
  ownerships: readonly PropertyOwnership[]
  /** Statements issued to this owner, newest first. */
  statementCount: number
  /** What the business owes them, from the newest issued statement. */
  balanceAgorot: Agorot
  /** Owner decisions still waiting. */
  pendingApprovals: number
}
