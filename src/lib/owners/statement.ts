/**
 * The owner statement. Pure, and a **view over finance** rather than a second
 * accounting engine.
 *
 * ══ THE RULE THIS FILE EXISTS TO KEEP ══════════════════════════════════════
 *
 * There must be exactly one answer to "what did this villa earn in March".
 * `finance/pnl.ts` already computes it, from a frozen per-booking snapshot, and
 * asserts that its own parts add to its own whole. So this module **consumes a
 * `PropertyPnl` and never a price line, never a booking, never an expense
 * rule.** There is no parameter on `buildOwnerStatement` through which a second
 * revenue calculation could enter, which is how the promise is kept by the type
 * signature rather than by anybody's discipline.
 *
 * ── Why the chain ends where it does ──────────────────────────────────────
 *
 * `propertyPnl` proves, with `assertSumsExactly`, that
 *
 *     gross − discount − variable − allocated − unallocated
 *           − commission − ownerShare = netProfit
 *
 * Rearranged, that is the owner's statement:
 *
 *     gross revenue
 *   − fees                (gross − net: discounts, promotions, and whatever
 *                          deduction the pricing contract adds above net)
 *   − expenses            (variable + allocated + unallocated)
 *   − sales commission
 *   − management fee      (what the business retained — `netProfit`)
 *   ─────────────────────
 *   = the property's owner share
 *
 * So the statement's first section is an **identity**, not a recomputation. It
 * cannot disagree with the P&L screen, because disagreeing would require the
 * P&L to disagree with itself. `assertSumsExactly` is called anyway, at the
 * point of construction, so a future change to either side fails here with a
 * stack rather than three weeks later as a ₪2 discrepancy on a document that
 * has already been sent.
 *
 * ── The management fee is the residual, and that is deliberate ────────────
 *
 * It is `pnl.netProfitAgorot`: what is left for the business after every cost
 * and after the owner's contractual share. It is not `x% of revenue` computed
 * here, because the owner's share already came from the snapshotted
 * `OwnerShareRule` — the agreement, frozen per booking — and a second
 * percentage applied afterwards would be the same money counted with two
 * different rules. Whichever basis the agreement uses (gross, net, or profit),
 * this line is exactly the complement of the owner's share and the column adds
 * up.
 *
 * ── Co-owners ─────────────────────────────────────────────────────────────
 *
 * A property may be held by several owners. The property's owner share is
 * split between them with `allocateByWeight` — the largest-remainder method
 * finance already uses — so three equal owners of ₪10.00 receive 3.34 + 3.33 +
 * 3.33 and never three times 3.33. Every co-owner's statement is therefore a
 * part of one whole, and the parts add to it exactly.
 */

import type { Agorot } from '../booking/types'
import { BusinessRuleError } from '../errors'
import {
  CURRENCY,
  allocateByWeight,
  assertSumsExactly,
  sumAgorot,
} from '../finance/money'
import type { PropertyPnl } from '../finance/pnl'
import {
  FULL_SHARE_BPS,
  type OwnerPayout,
  type OwnerStatement,
  type OwnerStatementExpense,
  type OwnerStatementLine,
  type PropertyOwnership,
} from './types'

// ── Shares ────────────────────────────────────────────────────────────────

/**
 * The shares of one property, checked before anything is allocated by them.
 *
 * A 422 and not a 500: shares that do not add to 100% is a state a person put
 * the data into, by linking a second owner at 60% when the first already holds
 * 50%. Refusing to build the statement is the right answer — allocating by
 * weights that sum to 110% would hand each owner a *proportion* of the money
 * and look entirely correct while quietly paying out to the wrong split.
 */
export function assertWholeOwnership(
  ownerships: readonly PropertyOwnership[],
): void {
  if (ownerships.length === 0) {
    throw new BusinessRuleError({
      code: 'owner_statement_no_ownership',
      userMessage:
        'לא ניתן להפיק דוח לנכס שאין לו בעלים רשומים. יש לקשר בעלים לנכס לפני הפקת הדוח.',
      message: 'A statement was requested for a property with no ownership',
    })
  }

  const total = ownerships.reduce(
    (sum, ownership) => sum + ownership.shareBps,
    0,
  )

  if (total !== FULL_SHARE_BPS) {
    throw new BusinessRuleError({
      code: 'owner_shares_do_not_total',
      userMessage:
        'חלקי הבעלות בנכס אינם מסתכמים ב-100%. יש לתקן את החלוקה לפני הפקת דוח.',
      message:
        `Ownership shares total ${total} bps, not ${FULL_SHARE_BPS}, ` +
        `across ${ownerships.length} owner(s)`,
      publicDetails: { totalBps: total, ownerCount: ownerships.length },
    })
  }
}

/**
 * The property's owner share, split between its owners.
 *
 * Returned as a map so a caller cannot pair a share with the wrong owner by
 * getting an index wrong. The order handed to `allocateByWeight` is the order
 * given, and the tie-break inside it is by position, so the same input always
 * produces the same split — a statement that reallocated its leftover agora on
 * every rebuild is not a statement.
 */
export function splitOwnerShare(
  propertyOwnerShareAgorot: Agorot,
  ownerships: readonly PropertyOwnership[],
): ReadonlyMap<string, Agorot> {
  assertWholeOwnership(ownerships)

  const parts = allocateByWeight(
    propertyOwnerShareAgorot,
    ownerships.map((ownership) => ownership.shareBps),
  )

  const split = new Map<string, Agorot>()
  ownerships.forEach((ownership, index) => {
    // A property held twice by the same owner — two links, two dates — is one
    // claim, so the parts add rather than the second overwriting the first.
    split.set(
      ownership.ownerId,
      (split.get(ownership.ownerId) ?? 0) + parts[index],
    )
  })
  return split
}

// ── Expenses ──────────────────────────────────────────────────────────────

/**
 * The named costs behind the expenses total.
 *
 * Aggregated across the period's bookings by rule, because an owner reading
 * "ניקיון ₪4,200" once is being told something, and reading it eleven times at
 * ₪381.82 is being given a spreadsheet. The period costs that reached no
 * booking are carried as their own line rather than pushed onto an arbitrary
 * stay to make the column add up — the same honesty `propertyPnl` shows by
 * keeping `unallocatedFixedCostAgorot` visible.
 */
export function expenseDetail(
  pnl: PropertyPnl,
): readonly OwnerStatementExpense[] {
  const byRule = new Map<string, OwnerStatementExpense>()

  for (const booking of pnl.bookings) {
    for (const cost of [...booking.variableCosts, ...booking.fixedCosts]) {
      const existing = byRule.get(cost.ruleId)
      byRule.set(cost.ruleId, {
        ruleId: cost.ruleId,
        label: cost.label,
        amountAgorot: (existing?.amountAgorot ?? 0) + cost.amountAgorot,
      })
    }
  }

  const detail = [...byRule.values()].sort(
    (a, b) => b.amountAgorot - a.amountAgorot,
  )

  if (pnl.unallocatedFixedCostAgorot !== 0) {
    detail.push({
      ruleId: 'unallocated',
      label: 'עלויות תקופתיות שלא יוחסו להזמנה',
      amountAgorot: pnl.unallocatedFixedCostAgorot,
    })
  }

  return detail
}

// ── The statement ─────────────────────────────────────────────────────────

export interface OwnerStatementInput {
  id: string
  organizationId: string
  ownerId: string
  propertyId: string
  /** Property-local ISO dates, inclusive. */
  periodStart: string
  periodEnd: string
  /**
   * The finance module's own answer for this property and period.
   *
   * The only source of revenue, cost and owner-share figures in this file.
   */
  pnl: PropertyPnl
  /** Every share of this property that was live in the period. */
  ownerships: readonly PropertyOwnership[]
  /** The previous statement's closing balance. Zero for the first one. */
  openingBalanceAgorot?: Agorot
  /** Movements on this owner's account within the period. */
  payouts?: readonly OwnerPayout[]
}

/**
 * Build the period statement. Nothing here reads a clock or a database.
 *
 * The result is a **draft**. Issuing is an operation with a grant behind it and
 * a freeze after it — see `operations.ts`.
 */
export function buildOwnerStatement(
  input: OwnerStatementInput,
): OwnerStatement {
  const { pnl, ownerships } = input

  const ownership = ownerships.find((link) => link.ownerId === input.ownerId)
  if (!ownership) {
    throw new BusinessRuleError({
      code: 'owner_not_linked_to_property',
      userMessage:
        'הבעלים המבוקש אינו רשום כבעלים של הנכס בתקופה הזו, ולכן לא ניתן להפיק לו דוח.',
      message: `Owner ${input.ownerId} holds no share of ${input.propertyId}`,
    })
  }

  // ── Section 1: the property ───────────────────────────────────────────
  //
  // `gross − net` rather than `pnl.discountAgorot`, so a deduction kind added
  // between the two next year lands here instead of disappearing.
  const feesAgorot = pnl.grossRevenueAgorot - pnl.netRevenueAgorot
  const expensesAgorot =
    pnl.variableCostAgorot +
    pnl.allocatedFixedCostAgorot +
    pnl.unallocatedFixedCostAgorot
  const salesCommissionAgorot = pnl.agentCommissionAgorot
  const managementFeeAgorot = pnl.netProfitAgorot
  const propertyOwnerShareAgorot = pnl.ownerShareAgorot

  const resultLines: OwnerStatementLine[] = [
    {
      key: 'gross_revenue',
      label: 'הכנסה ברוטו',
      amountAgorot: pnl.grossRevenueAgorot,
      kind: 'revenue',
    },
    {
      key: 'fees',
      label: 'הנחות, הטבות ודמי הפצה',
      amountAgorot: -feesAgorot,
      kind: 'cost',
    },
    {
      key: 'expenses',
      label: 'הוצאות תפעול הנכס',
      amountAgorot: -expensesAgorot,
      kind: 'cost',
    },
    {
      key: 'sales_commission',
      label: 'עמלות מכירה',
      amountAgorot: -salesCommissionAgorot,
      kind: 'cost',
    },
    {
      key: 'management_fee',
      label: 'דמי ניהול',
      amountAgorot: -managementFeeAgorot,
      kind: 'cost',
    },
    {
      key: 'property_owner_share',
      label: 'חלק הבעלים בנכס',
      amountAgorot: propertyOwnerShareAgorot,
      kind: 'result',
    },
  ]

  // The identity stated in the header, checked rather than believed.
  assertSumsExactly(
    'ownerStatement.property',
    resultLines
      .filter((line) => line.kind !== 'result')
      .map((line) => line.amountAgorot),
    propertyOwnerShareAgorot,
  )

  const expenses = expenseDetail(pnl)
  assertSumsExactly(
    'ownerStatement.expenses',
    expenses.map((expense) => expense.amountAgorot),
    expensesAgorot,
  )

  // ── Section 2: this owner's share of it ───────────────────────────────
  const split = splitOwnerShare(propertyOwnerShareAgorot, ownerships)
  const ownerShareAgorot = split.get(input.ownerId) ?? 0

  // ── Section 3: the account ────────────────────────────────────────────
  const payouts = input.payouts ?? []
  const mine = payouts.filter((payout) => payout.ownerId === input.ownerId)

  const paymentsAgorot = sumAgorot(
    mine
      .filter((payout) => payout.direction === 'from_owner')
      .map((payout) => payout.amountAgorot),
  )
  const payoutsAgorot = sumAgorot(
    mine
      .filter((payout) => payout.direction === 'to_owner')
      .map((payout) => payout.amountAgorot),
  )

  const openingBalanceAgorot = input.openingBalanceAgorot ?? 0
  const closingBalanceAgorot =
    openingBalanceAgorot + ownerShareAgorot + paymentsAgorot - payoutsAgorot

  const balanceLines: OwnerStatementLine[] = [
    {
      key: 'opening_balance',
      label: 'יתרת פתיחה',
      amountAgorot: openingBalanceAgorot,
      kind: 'carried',
    },
    {
      key: 'owner_share',
      label: 'חלקך בתקופה',
      amountAgorot: ownerShareAgorot,
      kind: 'revenue',
    },
    {
      key: 'owner_payments',
      label: 'תקבולים מהבעלים',
      amountAgorot: paymentsAgorot,
      kind: 'revenue',
    },
    {
      key: 'owner_payouts',
      label: 'תשלומים ששולמו לבעלים',
      amountAgorot: -payoutsAgorot,
      kind: 'cost',
    },
    {
      key: 'closing_balance',
      label: 'יתרת סגירה',
      amountAgorot: closingBalanceAgorot,
      kind: 'result',
    },
  ]

  assertSumsExactly(
    'ownerStatement.balance',
    balanceLines
      .filter((line) => line.kind !== 'result')
      .map((line) => line.amountAgorot),
    closingBalanceAgorot,
  )

  return {
    id: input.id,
    organizationId: input.organizationId,
    ownerId: input.ownerId,
    propertyId: input.propertyId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    status: 'draft',
    issuedAt: null,
    issuedBy: null,
    currency: CURRENCY,
    shareBps: ownership.shareBps,
    grossRevenueAgorot: pnl.grossRevenueAgorot,
    feesAgorot,
    expensesAgorot,
    salesCommissionAgorot,
    managementFeeAgorot,
    propertyOwnerShareAgorot,
    resultLines,
    expenses,
    ownerShareAgorot,
    openingBalanceAgorot,
    paymentsAgorot,
    payoutsAgorot,
    closingBalanceAgorot,
    balanceLines,
    bookingCount: pnl.bookingCount,
    withheld: [],
    version: 1,
  }
}

/**
 * Freeze a draft as the issued document.
 *
 * The same argument `invoices.ts` makes and for the same reason: a statement is
 * what an outside party was told they are owed, and a document that can be
 * edited after it was sent is not evidence of anything. Correcting one is a new
 * statement for the same period — `operations.ts` refuses the edit and the
 * screens offer the correction.
 */
export function issueOwnerStatement(
  draft: OwnerStatement,
  issuedBy: string,
  issuedAt: Date,
): OwnerStatement {
  if (draft.status === 'issued') {
    throw new BusinessRuleError({
      code: 'owner_statement_already_issued',
      userMessage:
        'הדוח הזה כבר הופק ואי אפשר לשנות אותו. תיקון נעשה באמצעות הפקת דוח חדש לאותה תקופה.',
      message: `Owner statement ${draft.id} is already issued`,
    })
  }

  return {
    ...draft,
    status: 'issued',
    issuedAt: issuedAt.toISOString(),
    issuedBy,
  }
}
