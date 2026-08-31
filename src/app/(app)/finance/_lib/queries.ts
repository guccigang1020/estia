/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the finance screens.
 *
 * ── This file used to be `SupabaseFinanceRepository`'s absence ────────────
 *
 * It held its own `db.from('payments').select(…)` because the port had no
 * method that answered "every payment in this organization" — `FinanceRepository`
 * was per-booking, and building a list out of it meant one round trip per
 * booking, an N+1 over the table the business opens every morning. The header
 * that stood here said so and said the fix out loud: three list methods on the
 * port would move this file behind it without changing a single decision in it.
 *
 * That is what happened. `listPayments`, `listInvoices` and `listCommissions`
 * are now on `FinanceRepository`, with the same columns, the same filters, the
 * same newest-first ordering, the same page ceiling and the same three joins;
 * `SupabaseFinanceRepository` implements them and `InMemoryFinanceRepository`
 * doubles them. The two reads that raised over the demo dataset were closed at
 * the same time — `snapshot_captured_at` is nullable and is read as such, and
 * `payment_provider_events` is a declared, empty demo table rather than a
 * missing one.
 *
 * ── What stayed here, and why it is not the repository's ──────────────────
 *
 * Authorization. `can()` per row and `redact()` per field decide what *this
 * reader* may see, and a data port that took an `Actor` would put the
 * authorization engine inside the persistence layer and force the in-memory
 * double to reimplement it. The two reads that are themselves conditional on a
 * grant — a booking's reference, a commission rule's label — are expressed as
 * flags on the query: this file answers the authorization question and the port
 * obeys the answer.
 *
 * ── Three floors, and none of them is this file alone ─────────────────────
 *
 *   1. `requireGrant` at the route refuses `payment.view` / `invoice.view` /
 *      `commission.view` / `expense.view` before a query is built.
 *   2. `can()` per row here, with `family: 'finance'`, so a membership scoped
 *      to one property does not see another property's money even though the
 *      grant is held.
 *   3. Row level security refuses regardless of both: `payments_select` carries
 *      `has_permission(organization_id, 'payment.view')` *and*
 *      `property_in_scope`, `invoices_select` carries `invoice.view`,
 *      `commissions_select` carries `commission.view`, `expense_rules_select`
 *      and `expense_allocations_select` carry `expense.view`.
 *
 * `redact()` is the fourth thing and is not a floor of the same kind: it
 * removes fields from rows this reader is entitled to, so that access to a
 * record is not access to every column of it.
 *
 * ── The redaction `redact()` cannot perform ───────────────────────────────
 *
 * `redact` deletes keys on the record it is handed and cannot reach into a
 * nested object, which is correct behaviour and not a bug in it: a field rule
 * cannot know that another field's value was copied somewhere else. Three
 * values in this module are copies one level down, and each is withheld by
 * never being built rather than by being deleted afterwards:
 *
 *   · `CommissionListItem.rule.label`, derived from `commissions.explanation`,
 *     which spells the base out in words.
 *   · `InvoiceListItem.payments[].amountAgorot`, which is a price.
 *   · `ExpenseRuleListItem.allocations[]`, which is what each stay was charged.
 *
 * ── Money ─────────────────────────────────────────────────────────────────
 *
 * Integer agorot throughout, read through `asAgorot` at the border, which
 * refuses a float. Nothing here divides by 100. Every total is `sumAgorot` from
 * the finance domain over figures that are already integers — never a number
 * this file adds up its own way, and never a figure re-derived in a component.
 */

import {
  can,
  holdsGrant,
  redact,
  type Actor,
  type Resource,
} from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import type { CommissionStatus, PaymentStatus } from '@/lib/contracts/states'
import {
  sumAgorot,
  type CommissionListRow,
  type ExpenseAllocationRow,
  type ExpenseKind,
  type ExpenseRuleListRow,
  type FinanceRepository,
  type InvoiceListRow,
  type InvoicePaymentLinkRow,
  type InvoiceStatus,
  type PaymentListRow,
} from '@/lib/finance'
import {
  asAgorot,
  asString,
  asStringOrNull,
  toRow,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'

import type { StatusFilter } from './filters'

/* ---------------------------------------------------------------- shared -- */

/**
 * The ceiling on one page.
 *
 * The same number and the same reasoning as `BOOKING_PAGE_SIZE`: the query
 * stays honest about paging, and the screen says out loud when it has hit it
 * rather than letting a list quietly stop.
 */
export const FINANCE_PAGE_SIZE = 100

export type FinanceListArgs<S extends string> = {
  /** The port, not a client. See the header. */
  repo: FinanceRepository
  actor: Actor
  organizationId: string
  /** A single property, or null for every property in scope. */
  propertyId: string | null
  filter: StatusFilter<S>
  limit?: number
}

/**
 * A record whose listed keys `redact()` may delete.
 *
 * The port answers with every field present; what a given reader sees is
 * decided here. Writing the item type as the row type with those keys made
 * optional keeps one definition of what a payment row *is*, so a column added
 * to the port cannot be forgotten on the screen.
 */
type Redactable<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>

/** The resource an authorization question about a finance row is asked about. */
function financeResource(
  organizationId: string,
  propertyId: string | null,
): Resource {
  const resource: Resource = { organizationId, family: 'finance' }
  if (propertyId !== null) resource.propertyId = propertyId
  return resource
}

/* -------------------------------------------------------------- payments -- */

/**
 * One line of the payments list.
 *
 * The optional fields are optional in the type because `redact()` genuinely
 * removes them: a reader without `guest.view_name` has no `payerName` key at
 * all, and the type says so rather than letting a component read `undefined`
 * out of a field it was told was a string.
 */
export type PaymentListItem = Redactable<
  PaymentListRow,
  'payerName' | 'amountAgorot' | 'capturedAgorot' | 'refundedAgorot'
>

/**
 * The fields a reader may hold `payment.view` and still not see.
 *
 * `guest.name` and `booking.price` are `SENSITIVE_FIELDS` entries from the
 * catalogue, not names invented here. Nobody in the shipped role set holds
 * `payment.view` without `booking.view_price` — `FINANCE_CORE` carries both —
 * so this withholds nothing today. It is written because the catalogue lets a
 * business compose a role that says "may see that money moved, may not see the
 * prices of stays", and the honest render of that is a missing amount rather
 * than a fabricated ₪0.
 */
const PAYMENT_REDACTIONS = [
  { key: 'payerName', requires: 'guest.view_name' },
  { key: 'amountAgorot', requires: 'booking.view_price' },
  { key: 'capturedAgorot', requires: 'booking.view_price' },
  { key: 'refundedAgorot', requires: 'booking.view_price' },
] as const satisfies ReadonlyArray<{
  key: keyof PaymentListItem
  requires: Grant
}>

/** The payments this reader may see, newest first. */
export async function listPayments(
  args: FinanceListArgs<PaymentStatus>,
): Promise<readonly PaymentListItem[]> {
  const { repo, actor, organizationId, propertyId, filter } = args

  const rows = await repo.listPayments({
    organizationId,
    propertyId,
    status: filter.status,
    limit: args.limit ?? FINANCE_PAGE_SIZE,
    // `holdsGrant`, not `can(..., resource)`: the question is whether this
    // person may read bookings at all. The scope question is answered per row
    // below, and asking it here against a resource carrying no property would
    // refuse every property-scoped reader.
    withBookingReferences: holdsGrant(actor, 'booking.view'),
  })

  return rows
    .filter((row) =>
      can(
        actor,
        'payment.view',
        financeResource(organizationId, row.propertyId),
      ),
    )
    .map((row) =>
      redact(
        actor,
        { ...row } as PaymentListItem,
        PAYMENT_REDACTIONS,
        financeResource(organizationId, row.propertyId),
      ),
    )
}

/**
 * What the listed payments add up to, or `null` when the money is withheld.
 *
 * Three sums, not one. "The payments on screen total ₪48,000" is a sentence
 * that means nothing when a third of them failed — what was *asked for*, what
 * was *taken* and what went *back* are three different facts, and a single
 * figure would be whichever of them the reader assumed.
 *
 * `null` rather than zero when `amountAgorot` was redacted: a reader who may
 * not see one payment's amount may certainly not see the sum of forty.
 */
export type PaymentTotals = {
  askedAgorot: number
  capturedAgorot: number
  refundedAgorot: number
}

export function paymentTotals(
  payments: readonly PaymentListItem[],
): PaymentTotals | null {
  const amounts: number[] = []
  const captured: number[] = []
  const refunded: number[] = []

  for (const payment of payments) {
    if (
      payment.amountAgorot === undefined ||
      payment.capturedAgorot === undefined ||
      payment.refundedAgorot === undefined
    ) {
      return null
    }
    amounts.push(payment.amountAgorot)
    captured.push(payment.capturedAgorot)
    refunded.push(payment.refundedAgorot)
  }

  return {
    askedAgorot: sumAgorot(amounts),
    capturedAgorot: sumAgorot(captured),
    refundedAgorot: sumAgorot(refunded),
  }
}

/**
 * How many payments need a person, among the ones on screen.
 *
 * `unknown` and `requiresAttention` are counted together because they are the
 * same sentence to whoever is reading: the automation has stopped and will not
 * start again on its own.
 */
export function paymentsNeedingAttention(
  payments: readonly PaymentListItem[],
): readonly PaymentListItem[] {
  return payments.filter(
    (payment) =>
      payment.status === 'unknown' || payment.requiresAttention !== null,
  )
}

/** How many payments exist for this organization and property, before any filter. */
export async function countPayments(
  repo: FinanceRepository,
  organizationId: string,
  propertyId: string | null,
): Promise<number> {
  return repo.countPayments(organizationId, propertyId)
}

/* -------------------------------------------------------------- invoices -- */

/** One payment an invoice accounts for. The port's row, named for the screen. */
export type InvoicePaymentLink = InvoicePaymentLinkRow

export type InvoiceListItem = Redactable<
  InvoiceListRow,
  | 'customerName'
  | 'customerTaxId'
  | 'lines'
  | 'linesTotalAgorot'
  | 'subtotalAgorot'
  | 'taxAgorot'
  | 'totalAgorot'
>

const INVOICE_REDACTIONS = [
  { key: 'customerName', requires: 'guest.view_name' },
  { key: 'customerTaxId', requires: 'guest.view_name' },
  { key: 'lines', requires: 'booking.view_price' },
  { key: 'linesTotalAgorot', requires: 'booking.view_price' },
  { key: 'subtotalAgorot', requires: 'booking.view_price' },
  { key: 'taxAgorot', requires: 'booking.view_price' },
  { key: 'totalAgorot', requires: 'booking.view_price' },
] as const satisfies ReadonlyArray<{
  key: keyof InvoiceListItem
  requires: Grant
}>

export async function listInvoices(
  args: FinanceListArgs<InvoiceStatus>,
): Promise<readonly InvoiceListItem[]> {
  const { repo, actor, organizationId, propertyId, filter } = args

  const rows = await repo.listInvoices({
    organizationId,
    propertyId,
    status: filter.status,
    limit: args.limit ?? FINANCE_PAGE_SIZE,
    // `null` and an empty list are different answers and the screen says so
    // differently: "this invoice has settled nothing yet" versus "there are two
    // payments here and you may not see them". Collapsing the two would tell a
    // reader an invoice is unpaid because of their own permissions.
    withLinkedPayments: holdsGrant(actor, 'payment.view'),
    withLinkedAmounts: holdsGrant(actor, 'booking.view_price'),
  })

  return rows
    .filter((row) =>
      can(
        actor,
        'invoice.view',
        financeResource(organizationId, row.propertyId),
      ),
    )
    .map((row) =>
      redact(
        actor,
        { ...row } as InvoiceListItem,
        INVOICE_REDACTIONS,
        financeResource(organizationId, row.propertyId),
      ),
    )
}

export async function countInvoices(
  repo: FinanceRepository,
  organizationId: string,
  propertyId: string | null,
): Promise<number> {
  return repo.countInvoices(organizationId, propertyId)
}

/* ----------------------------------------------------------- commissions -- */

export type { CommissionPayee } from '@/lib/finance'

export type CommissionListItem = Redactable<
  CommissionListRow,
  'basisAgorot' | 'explanation'
>

/**
 * The base is stay revenue, so it is gated on `booking.view_price` — and so is
 * the explanation beside it.
 *
 * That second entry is not tidiness. `commissions.explanation` is free text
 * written when the commission was created, and the demo's own rows read
 * "10% מסך הלינות (4,500 ₪)" — the base, spelled out in a sentence. Withholding
 * `basis_agorot` while printing that would be a redaction that redacts nothing.
 * Anything derived from the base travels with the base, including the copy of
 * it inside `rule.label`, which is withheld at the port because `redact()`
 * cannot reach one level down.
 *
 * `amountAgorot` and `rateBps` are deliberately *not* here: what an agent is
 * owed and at what rate is exactly what `commission.view` is the right to see,
 * and an external seller holds it for their own records and no others — by
 * scope, which floor 2 above already applied.
 */
const COMMISSION_REDACTIONS = [
  { key: 'basisAgorot', requires: 'booking.view_price' },
  { key: 'explanation', requires: 'booking.view_price' },
] as const satisfies ReadonlyArray<{
  key: keyof CommissionListItem
  requires: Grant
}>

export async function listCommissions(
  args: FinanceListArgs<CommissionStatus>,
): Promise<readonly CommissionListItem[]> {
  const { repo, actor, organizationId, propertyId, filter } = args

  const rows = await repo.listCommissions({
    organizationId,
    propertyId,
    status: filter.status,
    limit: args.limit ?? FINANCE_PAGE_SIZE,
    withBookingReferences: holdsGrant(actor, 'booking.view'),
    withRuleLabel: holdsGrant(actor, 'booking.view_price'),
  })

  return rows
    .filter((row) =>
      can(
        actor,
        'commission.view',
        financeResource(organizationId, row.propertyId),
      ),
    )
    .map((row) =>
      redact(
        actor,
        { ...row } as CommissionListItem,
        COMMISSION_REDACTIONS,
        financeResource(organizationId, row.propertyId),
      ),
    )
}

/** What is owed across the listed commissions, by the domain's own sum. */
export function commissionTotalAgorot(
  commissions: readonly CommissionListItem[],
): number {
  return sumAgorot(commissions.map((commission) => commission.amountAgorot))
}

export async function countCommissions(
  repo: FinanceRepository,
  organizationId: string,
  propertyId: string | null,
): Promise<number> {
  return repo.countCommissions(organizationId, propertyId)
}

/* -------------------------------------------------------------- expenses -- */

/**
 * One expense rule, and what it has actually cost.
 *
 * There is no `expenses` table and this list is not a ledger. `expense_rules`
 * says what recurs and `expense_allocations` says which booking carried a share
 * of it, which is how this schema models cost — so the screen shows a rule and
 * the shares recorded under it, and never a row per month that nobody wrote.
 *
 * `allocations` and `allocatedAgorot` are what each *stay* was charged, which
 * is booking profitability rather than a cost the business incurred. They are
 * gated on `booking.view_profitability` — the grant `FINANCE_CORE` carries and
 * an operations manager does not — while the rule's own amount is visible to
 * anybody holding `expense.view`, because what the business spends on laundry
 * is exactly what that grant is the right to see.
 */
export type ExpenseRuleListItem = Omit<
  ExpenseRuleListRow,
  'scopePropertyId'
> & {
  /** Null for an organization-wide rule, which applies to every property. */
  scopePropertyId: string | null
  /** The property's own name, when the scope names one and it is readable. */
  scopePropertyName: string | null
  /** How many stays have carried a share. Needs `booking.view_profitability`. */
  allocationCount?: number
  /** `sumAgorot` over those shares. */
  allocatedAgorot?: number
  allocations?: readonly ExpenseAllocationListItem[]
}

export type ExpenseAllocationListItem = {
  id: string
  bookingId: string
  bookingReference: string | null
  amountAgorot: number
  periodStart: string
  periodEnd: string
  /** Hebrew, one line, written when the allocation ran. */
  basis: string | null
  allocatedOn: string
}

/**
 * Both keys, deleted together.
 *
 * `allocations` is a nested array carrying an amount per booking, so the array
 * itself is never built for a reader who may not see it — see `listExpenseRules`
 * below. This entry is the second half of the same decision, so that the keys
 * are *absent* rather than present and empty: an empty allocation list reads as
 * "no stay has carried this cost", which is a different and false statement.
 */
const EXPENSE_REDACTIONS = [
  { key: 'allocationCount', requires: 'booking.view_profitability' },
  { key: 'allocatedAgorot', requires: 'booking.view_profitability' },
  { key: 'allocations', requires: 'booking.view_profitability' },
] as const satisfies ReadonlyArray<{
  key: keyof ExpenseRuleListItem
  requires: Grant
}>

export type ExpenseListArgs = {
  repo: FinanceRepository
  /** For the two names the port does not carry: the property and the booking. */
  db: Db
  actor: Actor
  organizationId: string
  propertyId: string | null
  filter: StatusFilter<ExpenseKind>
  limit?: number
}

/**
 * The expense rules this reader may see.
 *
 * `can()` is asked with the property the *scope* names, which for an
 * organization-wide rule is nothing at all — and a resource carrying no
 * location is only reachable by an organization-wide scope, by the engine's own
 * rule. So a manager scoped to one property sees that property's rules and not
 * the organization's, which is the model working rather than a filter this file
 * invented.
 */
export async function listExpenseRules(
  args: ExpenseListArgs,
): Promise<readonly ExpenseRuleListItem[]> {
  const { repo, db, actor, organizationId, propertyId, filter } = args

  const rules = (
    await repo.listExpenseRules({
      organizationId,
      propertyId,
      kind: filter.status,
      limit: args.limit ?? FINANCE_PAGE_SIZE,
    })
  ).filter((rule) =>
    can(
      actor,
      'expense.view',
      financeResource(organizationId, rule.scopePropertyId),
    ),
  )

  // Never built for a reader who may not see it. `redact` deletes keys on the
  // record it is handed and cannot reach into the array, so the array must not
  // exist — and skipping the read is the other half of the same sentence.
  const maySeeShares = holdsGrant(actor, 'booking.view_profitability')

  const allocations = maySeeShares
    ? await repo.listExpenseAllocations(
        organizationId,
        rules.map((rule) => rule.id),
      )
    : []

  const [propertyNames, references] = await Promise.all([
    propertyNamesFor(
      db,
      actor,
      organizationId,
      rules.map((rule) => rule.scopePropertyId),
    ),
    bookingReferences(
      db,
      actor,
      organizationId,
      allocations.map((allocation) => allocation.bookingId),
    ),
  ])

  const byRule = new Map<string, ExpenseAllocationRow[]>()
  for (const allocation of allocations) {
    const list = byRule.get(allocation.ruleId) ?? []
    list.push(allocation)
    byRule.set(allocation.ruleId, list)
  }

  return rules.map((rule) => {
    const mine = byRule.get(rule.id) ?? []

    const item: ExpenseRuleListItem = {
      ...rule,
      scopePropertyName:
        rule.scopePropertyId === null
          ? null
          : (propertyNames.get(rule.scopePropertyId) ?? null),
    }

    if (maySeeShares) {
      item.allocationCount = mine.length
      item.allocatedAgorot = sumAgorot(mine.map((entry) => entry.amountAgorot))
      item.allocations = mine.map((entry) => ({
        id: entry.id,
        bookingId: entry.bookingId,
        bookingReference: references.get(entry.bookingId) ?? null,
        amountAgorot: entry.amountAgorot,
        periodStart: entry.periodStart,
        periodEnd: entry.periodEnd,
        basis: entry.basis,
        allocatedOn: entry.allocatedOn,
      }))
    }

    return redact(
      actor,
      item,
      EXPENSE_REDACTIONS,
      financeResource(organizationId, rule.scopePropertyId),
    )
  })
}

export async function countExpenseRules(
  repo: FinanceRepository,
  organizationId: string,
): Promise<number> {
  return repo.countExpenseRules(organizationId)
}

/**
 * What the listed rules commit the business to, split the way they behave.
 *
 * Fixed and variable are not added together, and the reason is not tidiness: a
 * fixed rule's amount is a figure per period — ₪3,100 a month — and a variable
 * rule's is a rate per stay or a percentage of revenue. Summing the two
 * produces a number whose unit is nothing.
 *
 * `allocatedAgorot` is `null` rather than zero when the shares were withheld.
 */
export type ExpenseTotals = {
  fixedAgorot: number
  variableCount: number
  allocatedAgorot: number | null
}

export function expenseTotals(
  rules: readonly ExpenseRuleListItem[],
): ExpenseTotals {
  const fixed = rules.filter((rule) => rule.kind === 'fixed')
  const withheld = rules.some((rule) => rule.allocatedAgorot === undefined)

  return {
    fixedAgorot: sumAgorot(fixed.map((rule) => rule.amountAgorot)),
    variableCount: rules.length - fixed.length,
    allocatedAgorot: withheld
      ? null
      : sumAgorot(rules.map((rule) => rule.allocatedAgorot ?? 0)),
  }
}

/* -------------------------------------------------------- reconciliation -- */

/**
 * What one booking was billed, against what actually arrived.
 *
 * Not `reconcile()` from the finance domain — that one compares our ledger with
 * a *processor's* file, which is a different question and needs a file nobody
 * has uploaded. This is the other reconciliation a business does every week:
 * the stay was quoted at ₪4,200, ₪1,260 arrived as a deposit, and the balance
 * is either late, short, or sitting in a state nobody can resolve.
 *
 * `unresolvedAgorot` is the reason the screen exists. A processor that timed
 * out leaves money that is neither a success nor a failure, and folding it into
 * either one is a lie: counted as arrived, the booking looks settled; counted
 * as missing, somebody chases a guest who has already paid. It is its own
 * figure and it is stated first.
 */
export type ReconciliationRow = {
  bookingId: string
  propertyId: string
  bookingReference: string | null
  /** What the booking was billed. Null when the reader may not see prices. */
  expectedAgorot: number | null
  /** Captured minus refunded, over the payments on this booking. */
  receivedAgorot: number
  /** Asked for, in a state nobody can resolve. Never counted as received. */
  unresolvedAgorot: number
  /** `expected − received`. Null when the expectation is unreadable. */
  differenceAgorot: number | null
  paymentCount: number
  unresolvedCount: number
  outcome: ReconciliationOutcome
  /** The most recent moment money moved on this booking, or null. */
  lastMovedOn: string | null
}

/**
 * The three answers, and they are ordered by how much attention they need.
 *
 * `unresolved` outranks `difference` deliberately: a booking that is ₪500 short
 * *and* holds an unknown payment is not a short booking, it is a booking nobody
 * can yet say anything about.
 */
export const RECONCILIATION_OUTCOMES = [
  'unresolved',
  'difference',
  'matched',
] as const

export type ReconciliationOutcome = (typeof RECONCILIATION_OUTCOMES)[number]

export type ReconciliationTotals = {
  expectedAgorot: number | null
  receivedAgorot: number
  unresolvedAgorot: number
  differenceAgorot: number | null
}

/**
 * Group the payments on screen by the booking they belong to.
 *
 * The expectation comes from `bookings.total_agorot` — the booking's own
 * billed figure — and is read separately because it is not on a payment row and
 * because a reader without `booking.view_price` may not have it. When it is
 * absent the row still says what arrived: "₪1,260 came in against this stay"
 * is true and useful without knowing what the stay cost.
 */
export async function reconcilePayments(args: {
  db: Db
  actor: Actor
  organizationId: string
  payments: readonly PaymentListItem[]
}): Promise<readonly ReconciliationRow[]> {
  const { db, actor, organizationId, payments } = args

  const billed = await billedTotals(
    db,
    actor,
    organizationId,
    payments.map((payment) => payment.bookingId),
  )

  const byBooking = new Map<string, PaymentListItem[]>()
  for (const payment of payments) {
    const list = byBooking.get(payment.bookingId) ?? []
    list.push(payment)
    byBooking.set(payment.bookingId, list)
  }

  const rows: ReconciliationRow[] = []

  for (const [bookingId, group] of byBooking) {
    const unresolved = paymentsNeedingAttention(group)

    // Withheld amounts make the arithmetic unanswerable rather than smaller.
    // A reader who may not see one payment's amount must not be shown a total
    // that silently omits it.
    const amountsVisible = group.every(
      (payment) =>
        payment.capturedAgorot !== undefined &&
        payment.refundedAgorot !== undefined &&
        payment.amountAgorot !== undefined,
    )

    const received = amountsVisible
      ? sumAgorot(
          group.map(
            (payment) =>
              (payment.capturedAgorot ?? 0) - (payment.refundedAgorot ?? 0),
          ),
        )
      : 0
    const unresolvedAgorot = amountsVisible
      ? sumAgorot(unresolved.map((payment) => payment.amountAgorot ?? 0))
      : 0

    const expected = amountsVisible ? (billed.get(bookingId) ?? null) : null
    const difference = expected === null ? null : expected - received

    const moments = group
      .map((payment) => payment.paidOn)
      .filter((day): day is string => day !== null)
      .sort()

    rows.push({
      bookingId,
      propertyId: group[0].propertyId,
      bookingReference: group[0].bookingReference,
      expectedAgorot: expected,
      receivedAgorot: received,
      unresolvedAgorot,
      differenceAgorot: difference,
      paymentCount: group.length,
      unresolvedCount: unresolved.length,
      outcome:
        unresolved.length > 0
          ? 'unresolved'
          : difference === null || difference === 0
            ? 'matched'
            : 'difference',
      lastMovedOn: moments.length > 0 ? moments[moments.length - 1] : null,
    })
  }

  // Worst first, then by size of the gap, then by reference so the order is
  // stable between two runs that found the same thing.
  const rank: Record<ReconciliationOutcome, number> = {
    unresolved: 0,
    difference: 1,
    matched: 2,
  }

  return rows.sort((a, b) => {
    if (rank[a.outcome] !== rank[b.outcome]) {
      return rank[a.outcome] - rank[b.outcome]
    }
    const gap =
      Math.abs(b.differenceAgorot ?? 0) - Math.abs(a.differenceAgorot ?? 0)
    if (gap !== 0) return gap
    return (a.bookingReference ?? '').localeCompare(b.bookingReference ?? '')
  })
}

export function reconciliationTotals(
  rows: readonly ReconciliationRow[],
): ReconciliationTotals {
  const expectations = rows.map((row) => row.expectedAgorot)
  const complete = expectations.every((value) => value !== null)

  const expected = complete
    ? sumAgorot(expectations.map((value) => value ?? 0))
    : null
  const received = sumAgorot(rows.map((row) => row.receivedAgorot))

  return {
    expectedAgorot: expected,
    receivedAgorot: received,
    unresolvedAgorot: sumAgorot(rows.map((row) => row.unresolvedAgorot)),
    differenceAgorot: expected === null ? null : expected - received,
  }
}

/* ---------------------------------------------------------------- owners -- */

/**
 * An external property owner.
 *
 * There is no `owners` table and no `owner_statements` table — the schema
 * models an external owner as what they are to the system: a membership holding
 * the `property_owner` role, scoped to the properties they own. So that is what
 * this reads, rather than inventing a table to make the screen look fuller.
 *
 * Reachable only with the `owner_portal` entitlement. Every grant in the owner
 * family is mapped to it in `ENTITLEMENT_FOR_GRANT`, so `holdsGrant` is false
 * for the whole family on a package that does not include it, and the screen
 * renders the lock rather than an empty list.
 */
export type OwnerListItem = {
  membershipId: string
  userId: string
  /** Withheld without `user.view`. The properties are still named. */
  name?: string | null
  email?: string | null
  membershipStatus: string
  /** The properties their membership scope reaches, named where readable. */
  properties: readonly { id: string; name: string | null }[]
}

const OWNER_REDACTIONS = [
  { key: 'name', requires: 'user.view' },
  { key: 'email', requires: 'user.view' },
] as const satisfies ReadonlyArray<{
  key: keyof OwnerListItem
  requires: Grant
}>

/** The system role an external property owner's membership carries. */
const OWNER_ROLE_CODE = 'property_owner'

export async function listOwners(args: {
  db: Db
  actor: Actor
  organizationId: string
}): Promise<readonly OwnerListItem[]> {
  const { db, actor, organizationId } = args

  // Refused before a query is built, for the same reason the route refuses:
  // the whole owner family is gated on `owner_portal`, and a package without it
  // has no owners to read.
  if (
    !holdsGrant(actor, 'owner.view') &&
    !holdsGrant(actor, 'owner_statement.view')
  ) {
    return []
  }

  const { data: roleRows, error: roleError } = await db
    .from('membership_roles')
    .select('membership_id, roles(code)')
    .eq('organization_id', organizationId)

  if (roleError) throw roleError

  const membershipIds = toRows(roleRows)
    .filter((row) => roleCodeOf(row) === OWNER_ROLE_CODE)
    .map((row) => asString(row, 'membership_id'))

  if (membershipIds.length === 0) return []

  const [memberships, scopes] = await Promise.all([
    db
      .from('memberships')
      .select('id, user_id, status')
      .eq('organization_id', organizationId)
      .in('id', membershipIds),
    db
      .from('membership_scopes')
      .select('membership_id, kind, property_ids')
      .eq('organization_id', organizationId)
      .in('membership_id', membershipIds),
  ])

  if (memberships.error) throw memberships.error
  if (scopes.error) throw scopes.error

  const scopeRows = toRows(scopes.data)
  const membershipRows = toRows(memberships.data)

  const [profiles, propertyNames] = await Promise.all([
    profileNames(
      db,
      membershipRows.map((row) => asString(row, 'user_id')),
    ),
    propertyNamesFor(
      db,
      actor,
      organizationId,
      scopeRows.flatMap(propertyIdsOf),
    ),
  ])

  return membershipRows.map((row) => {
    const membershipId = asString(row, 'id')
    const userId = asString(row, 'user_id')
    const profile = profiles.get(userId)

    const properties = scopeRows
      .filter((scope) => asString(scope, 'membership_id') === membershipId)
      .flatMap(propertyIdsOf)
      .map((id) => ({ id, name: propertyNames.get(id) ?? null }))

    const item: OwnerListItem = {
      membershipId,
      userId,
      name: profile?.name ?? null,
      email: profile?.email ?? null,
      membershipStatus: asString(row, 'status'),
      properties,
    }

    return redact(actor, item, OWNER_REDACTIONS, {
      organizationId,
      family: 'finance',
    })
  })
}

/* --------------------------------------------------------------- shared -- */

/**
 * Booking references for the rows on screen, in one query.
 *
 * Skipped entirely without `booking.view`, because `bookings_select` would
 * return nothing and the query would be a round trip that cannot succeed. An
 * empty map is a real answer: the caller renders null rather than an id.
 */
async function bookingReferences(
  db: Db,
  actor: Actor,
  organizationId: string,
  bookingIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(bookingIds)]
  if (unique.length === 0) return new Map()
  if (!holdsGrant(actor, 'booking.view')) return new Map()

  const { data, error } = await db
    .from('bookings')
    .select('id, reference')
    .eq('organization_id', organizationId)
    .in('id', unique)

  if (error) throw error

  const references = new Map<string, string>()
  for (const row of toRows(data)) {
    references.set(asString(row, 'id'), asString(row, 'reference'))
  }
  return references
}

/**
 * What each booking was billed.
 *
 * `booking.view_price` and not `booking.view`: the reference is a label and the
 * total is a price, and a reader may hold the first without the second. An
 * absent entry makes the expectation null rather than zero, so the screen says
 * "what arrived" instead of claiming the stay was free.
 */
async function billedTotals(
  db: Db,
  actor: Actor,
  organizationId: string,
  bookingIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const unique = [...new Set(bookingIds)]
  if (unique.length === 0) return new Map()
  if (!holdsGrant(actor, 'booking.view_price')) return new Map()

  const { data, error } = await db
    .from('bookings')
    .select('id, total_agorot')
    .eq('organization_id', organizationId)
    .in('id', unique)

  if (error) throw error

  const totals = new Map<string, number>()
  for (const row of toRows(data)) {
    totals.set(asString(row, 'id'), asAgorot(row, 'total_agorot'))
  }
  return totals
}

/**
 * Property names for the rows on screen.
 *
 * `property.view` is asked once rather than per row: `properties_select`
 * already narrows to the reader's scope, and a name that does not come back
 * leaves the label null rather than printing a uuid at somebody.
 */
async function propertyNamesFor(
  db: Db,
  actor: Actor,
  organizationId: string,
  propertyIds: readonly (string | null)[],
): Promise<ReadonlyMap<string, string>> {
  const unique = [
    ...new Set(propertyIds.filter((id): id is string => id !== null)),
  ]
  if (unique.length === 0) return new Map()
  if (!holdsGrant(actor, 'property.view')) return new Map()

  const { data, error } = await db
    .from('properties')
    .select('id, name')
    .eq('organization_id', organizationId)
    .in('id', unique)

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    names.set(asString(row, 'id'), asString(row, 'name'))
  }
  return names
}

/**
 * Display name and email for the people behind a membership.
 *
 * `user_profiles_select` admits anybody who shares an organization with the
 * subject, and this is only ever asked for ids that appeared on a membership
 * this reader was already admitted to. What the *reader* may see of it is
 * decided by `redact` at the call site.
 */
async function profileNames(
  db: Db,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, { name: string | null; email: string | null }>> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return new Map()

  const { data, error } = await db
    .from('user_profiles')
    .select('id, full_name, email')
    .in('id', unique)

  if (error) throw error

  const profiles = new Map<
    string,
    { name: string | null; email: string | null }
  >()
  for (const row of toRows(data)) {
    profiles.set(asString(row, 'id'), {
      name: asStringOrNull(row, 'full_name'),
      email: asStringOrNull(row, 'email'),
    })
  }
  return profiles
}

/** `membership_roles.roles(code)`, embedded one-to-one. */
function roleCodeOf(row: Row): string | null {
  const embedded = row.roles
  if (embedded === null || embedded === undefined) return null
  const one = Array.isArray(embedded) ? embedded[0] : embedded
  if (one === null || one === undefined) return null
  return asStringOrNull(toRow(one), 'code')
}

/** `membership_scopes.property_ids`, which is an array column and may be empty. */
function propertyIdsOf(row: Row): string[] {
  if (asStringOrNull(row, 'kind') !== 'properties') return []
  const raw = row.property_ids
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is string => typeof value === 'string')
}
