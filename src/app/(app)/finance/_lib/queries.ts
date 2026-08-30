/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the finance screens.
 *
 * ── Why this is not `SupabaseFinanceRepository` ───────────────────────────
 *
 * It should be, and it cannot be yet. `FinanceRepository` is a per-booking
 * port: `loadPaymentsForBooking`, `loadInvoicesForBooking`,
 * `loadCommissionsForBooking`. There is no method that answers "every payment
 * in this organization", which is the only question a list screen asks, and
 * building one out of the port means one round trip per booking — an N+1 over
 * a table the business opens every morning. So the reads are plain queries
 * here, exactly as `bookings/_lib/queries.ts` does, over the same
 * request-scoped client the adapter would have used, mapped with the same
 * `@/lib/persistence` helpers and validated against the same frozen
 * vocabularies. Adding three list methods to the port would move this file
 * behind it without changing a single decision in it. That is a gap in the
 * port, and it is written down rather than worked around silently.
 *
 * The reads are also deliberately *narrower* than the adapter's. The adapter's
 * `INVOICE_COLUMNS` asks for `snapshot_captured_at`, which every list row here
 * would carry and no screen would print — and which `asTimestamp` refuses when
 * it is null. Reading only what is shown is both cheaper and the reason these
 * queries survive a row the adapter would reject.
 *
 * ── Three floors, and none of them is this file alone ─────────────────────
 *
 *   1. `requireGrant` at the route refuses `payment.view` / `invoice.view` /
 *      `commission.view` before a query is built.
 *   2. `can()` per row here, with `family: 'finance'`, so a membership scoped
 *      to one property does not see another property's money even though the
 *      grant is held. Same move `loadProperties` makes for inventory.
 *   3. Row level security refuses regardless of both:
 *      `payments_select` carries `has_permission(organization_id,
 *      'payment.view')` *and* `property_in_scope`, `invoices_select` carries
 *      `invoice.view`, `commissions_select` carries `commission.view`. A wrong
 *      organization id in this file returns nothing rather than somebody
 *      else's ledger.
 *
 * `redact()` is the fourth thing and is not a floor of the same kind: it
 * removes fields from rows this reader is entitled to, so that access to a
 * record is not access to every column of it.
 *
 * ── Money ─────────────────────────────────────────────────────────────────
 *
 * Integer agorot throughout, read through `asAgorot`, which refuses a float at
 * the border. Nothing here divides by 100. Every total is `sumAgorot` from the
 * finance domain over figures that are already integers — never a number this
 * file adds up its own way, and never a figure re-derived in a component.
 */

import {
  can,
  holdsGrant,
  redact,
  type Actor,
  type Resource,
} from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import {
  COMMISSION_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  type CommissionBase,
  type CommissionStatus,
  type PaymentMethod,
  type PaymentStatus,
} from '@/lib/contracts/states'
import { PRICE_LINE_KINDS, type PriceLine } from '@/lib/booking/types'
import { localDate } from '@/lib/booking/dates'
import {
  COLLECTION_CHANNELS,
  COMMISSION_BASES,
  INVOICE_KINDS,
  INVOICE_STATUSES,
  PAYMENT_ATTENTIONS,
  PAYMENT_PURPOSES,
  sumAgorot,
  type CollectionChannel,
  type CommissionRule,
  type InvoiceKind,
  type InvoiceStatus,
  type PaymentAttention,
  type PaymentPurpose,
} from '@/lib/finance'
import {
  asAgorot,
  asBoolean,
  asEnum,
  asEnumOrNull,
  asJsonRecord,
  asNumber,
  asNumberOrNull,
  asString,
  asStringOrNull,
  asTimestamp,
  asTimestampOrNull,
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
  db: Db
  actor: Actor
  organizationId: string
  /** A single property, or null for every property in scope. */
  propertyId: string | null
  filter: StatusFilter<S>
  limit?: number
}

/** The resource an authorization question about a finance row is asked about. */
function financeResource(
  organizationId: string,
  propertyId: string | null,
): Resource {
  const resource: Resource = { organizationId, family: 'finance' }
  if (propertyId !== null) resource.propertyId = propertyId
  return resource
}

/**
 * A `timestamptz` as the calendar date it fell on at the property.
 *
 * Not `iso.slice(0, 10)`. A payment taken at 00:30 in Israel is `21:30Z` the
 * previous day, and slicing the ISO string would file it under yesterday — on
 * the screen a bookkeeper uses to reconcile a day's takings. `localDate` is the
 * domain's own conversion, against `PROPERTY_TIME_ZONE`.
 */
function propertyDate(row: Row, column: string): string | null {
  const value = asTimestampOrNull(row, column)
  return value === null ? null : localDate(new Date(value))
}

function requiredPropertyDate(row: Row, column: string): string {
  return localDate(new Date(asTimestamp(row, column)))
}

/* -------------------------------------------------------------- payments -- */

/**
 * One line of the payments list.
 *
 * Deliberately not a `Payment`. The domain record carries `appliedEventIds`,
 * which is a second query per row against `payment_attempts`, and the list
 * shows none of it. Everything here is a column on the row.
 *
 * The optional fields are optional in the type because `redact()` genuinely
 * removes them: a reader without `guest.view_name` has no `payerName` key at
 * all, and the type says so rather than letting a component read `undefined`
 * out of a field it was told was a string.
 */
export type PaymentListItem = {
  id: string
  bookingId: string
  propertyId: string
  /** The booking's own reference, or the payment's snapshot of it. */
  bookingReference: string | null
  status: PaymentStatus
  method: PaymentMethod
  purpose: PaymentPurpose
  channel: CollectionChannel
  /** Set when a person must intervene. Never cleared by automation. */
  requiresAttention: PaymentAttention | null
  /** When the provider stopped answering, as a property-local date. */
  unknownSince: string | null
  /** When the payment was recorded. Always present. */
  recordedOn: string
  /** When the money actually arrived, or null because it has not. */
  paidOn: string | null
  /** Withheld without `guest.view_name`. Never replaced by "אורח". */
  payerName?: string | null
  /** The three amounts, withheld together without `booking.view_price`. */
  amountAgorot?: number
  capturedAgorot?: number
  refundedAgorot?: number
}

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
  requires: Parameters<typeof can>[1]
}>

const PAYMENT_COLUMNS =
  'id, booking_id, property_id, status, method, purpose, channel, ' +
  'amount_agorot, captured_agorot, amount_refunded_agorot, payer_name, ' +
  'payer_reference, requires_attention, unknown_since, paid_at, created_at'

/**
 * The payments this reader may see, newest first.
 *
 * Ordered by `created_at` rather than by `paid_at`: a pending or failed
 * payment has no `paid_at`, and ordering by it would sort exactly the rows
 * somebody is looking for to the bottom of the list.
 */
export async function listPayments(
  args: FinanceListArgs<PaymentStatus>,
): Promise<readonly PaymentListItem[]> {
  const { db, actor, organizationId, propertyId, filter } = args

  let query = db
    .from('payments')
    .select(PAYMENT_COLUMNS)
    .eq('organization_id', organizationId)

  if (propertyId !== null) query = query.eq('property_id', propertyId)
  if (filter.status !== null) query = query.eq('status', filter.status)

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(args.limit ?? FINANCE_PAGE_SIZE)

  if (error) throw error

  const rows = toRows(data).filter((row) =>
    can(
      actor,
      'payment.view',
      financeResource(organizationId, asString(row, 'property_id')),
    ),
  )

  const references = await bookingReferences(
    db,
    actor,
    organizationId,
    rows.map((row) => asString(row, 'booking_id')),
  )

  return rows.map((row) => {
    const bookingId = asString(row, 'booking_id')
    const propertyOfRow = asString(row, 'property_id')

    const item: PaymentListItem = {
      id: asString(row, 'id'),
      bookingId,
      propertyId: propertyOfRow,
      // The booking's own reference where it is readable, and otherwise the
      // one the payment recorded when it was taken. Both are real; neither is
      // invented, and null is a real answer.
      bookingReference:
        references.get(bookingId) ?? asStringOrNull(row, 'payer_reference'),
      status: asEnum(row, 'status', PAYMENT_STATUSES),
      method: asEnum(row, 'method', PAYMENT_METHODS),
      purpose: asEnum(row, 'purpose', PAYMENT_PURPOSES),
      channel: asEnum(row, 'channel', COLLECTION_CHANNELS),
      requiresAttention: asEnumOrNull(
        row,
        'requires_attention',
        PAYMENT_ATTENTIONS,
      ),
      unknownSince: propertyDate(row, 'unknown_since'),
      recordedOn: requiredPropertyDate(row, 'created_at'),
      paidOn: propertyDate(row, 'paid_at'),
      payerName: asStringOrNull(row, 'payer_name'),
      amountAgorot: asAgorot(row, 'amount_agorot'),
      capturedAgorot: asAgorot(row, 'captured_agorot'),
      refundedAgorot: asAgorot(row, 'amount_refunded_agorot'),
    }

    return redact(
      actor,
      item,
      PAYMENT_REDACTIONS,
      financeResource(organizationId, propertyOfRow),
    )
  })
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
  db: Db,
  organizationId: string,
  propertyId: string | null,
): Promise<number> {
  return countRows(db, 'payments', organizationId, propertyId)
}

/* -------------------------------------------------------------- invoices -- */

/** One payment an invoice accounts for, as much of it as this reader may see. */
export type InvoicePaymentLink = {
  id: string
  status: PaymentStatus
  method: PaymentMethod
  amountAgorot?: number
  paidOn: string | null
}

export type InvoiceListItem = {
  id: string
  bookingId: string
  propertyId: string
  kind: InvoiceKind
  status: InvoiceStatus
  series: string
  year: number
  number: number | null
  /** What is printed. Null on a draft, which has not been allocated one. */
  displayNumber: string | null
  issuedOn: string | null
  cancelledOn: string | null
  cancellationReason: string | null
  recordedOn: string
  taxRateBps: number | null
  touristVatExempt: boolean
  /**
   * The itemisation, and the sum of it.
   *
   * `linesTotalAgorot` is `sumLines` over the lines below — the domain's own
   * sum, computed here so that no component adds anything up. It is carried
   * *beside* the document's stored total rather than instead of it: an issued
   * invoice's total is frozen and may not be recomputed, and a screen that
   * silently rendered the sum of the lines in its place would be quietly
   * correcting a legal document.
   */
  lines?: readonly PriceLine[]
  linesTotalAgorot?: number
  subtotalAgorot?: number
  taxAgorot?: number
  totalAgorot?: number
  /** Withheld without `guest.view_name`. */
  customerName?: string
  customerTaxId?: string | null
  /**
   * The payments this document accounts for, read from `invoice_payments`.
   *
   * `linkedPaymentCount` is the number of links and needs only `invoice.view`;
   * `payments` needs `payment.view` as well, because the amounts and the
   * statuses are on the payment rows. A reader holding one and not the other
   * is told how many payments there are rather than shown none.
   */
  linkedPaymentCount: number
  payments: readonly InvoicePaymentLink[] | null
}

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
  requires: Parameters<typeof can>[1]
}>

/**
 * `invoice_payments(payment_id)`, and never `metadata.payment_ids`.
 *
 * 0022 created the join table and 0024 dropped the array after proving nothing
 * was lost. A fallback to the array here would resurrect links somebody
 * deliberately removed, on a deployment where the key still happens to exist.
 */
const INVOICE_COLUMNS =
  'id, booking_id, property_id, kind, status, series, year, number, ' +
  'display_number, customer_name, customer_tax_id, subtotal_agorot, ' +
  'tax_agorot, total_agorot, tax_rate_bps, tourist_vat_exempt, issued_at, ' +
  'cancelled_at, cancellation_reason, created_at, ' +
  'invoice_lines(kind, label, amount_agorot, quantity, line_date, sort_order), ' +
  'invoice_payments(payment_id)'

export async function listInvoices(
  args: FinanceListArgs<InvoiceStatus>,
): Promise<readonly InvoiceListItem[]> {
  const { db, actor, organizationId, propertyId, filter } = args

  let query = db
    .from('invoices')
    .select(INVOICE_COLUMNS)
    .eq('organization_id', organizationId)

  if (propertyId !== null) query = query.eq('property_id', propertyId)
  if (filter.status !== null) query = query.eq('status', filter.status)

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(args.limit ?? FINANCE_PAGE_SIZE)

  if (error) throw error

  const rows = toRows(data).filter((row) =>
    can(
      actor,
      'invoice.view',
      financeResource(organizationId, asString(row, 'property_id')),
    ),
  )

  const linkedIds = rows.flatMap(paymentIdsOf)
  const linked = await linkedPayments(db, actor, organizationId, linkedIds)

  return rows.map((row) => {
    const propertyOfRow = asString(row, 'property_id')
    const ids = paymentIdsOf(row)
    const lines = toPriceLines(row, 'invoice_lines')

    const item: InvoiceListItem = {
      id: asString(row, 'id'),
      bookingId: asString(row, 'booking_id'),
      propertyId: propertyOfRow,
      kind: asEnum(row, 'kind', INVOICE_KINDS),
      status: asEnum(row, 'status', INVOICE_STATUSES),
      series: asString(row, 'series'),
      year: asNumber(row, 'year'),
      number: asNumberOrNull(row, 'number'),
      displayNumber: asStringOrNull(row, 'display_number'),
      issuedOn: propertyDate(row, 'issued_at'),
      cancelledOn: propertyDate(row, 'cancelled_at'),
      cancellationReason: asStringOrNull(row, 'cancellation_reason'),
      recordedOn: requiredPropertyDate(row, 'created_at'),
      taxRateBps: asNumberOrNull(row, 'tax_rate_bps'),
      touristVatExempt: asBoolean(row, 'tourist_vat_exempt'),
      lines,
      linesTotalAgorot: sumAgorot(lines.map((line) => line.amount)),
      subtotalAgorot: asAgorot(row, 'subtotal_agorot'),
      taxAgorot: asAgorot(row, 'tax_agorot'),
      totalAgorot: asAgorot(row, 'total_agorot'),
      customerName: asString(row, 'customer_name'),
      customerTaxId: asStringOrNull(row, 'customer_tax_id'),
      linkedPaymentCount: ids.length,
      payments:
        linked === null
          ? null
          : ids
              .map((id) => linked.get(id))
              .filter((entry): entry is InvoicePaymentLink => entry !== undefined),
    }

    return redact(
      actor,
      item,
      INVOICE_REDACTIONS,
      financeResource(organizationId, propertyOfRow),
    )
  })
}

export async function countInvoices(
  db: Db,
  organizationId: string,
  propertyId: string | null,
): Promise<number> {
  return countRows(db, 'invoices', organizationId, propertyId)
}

/* ----------------------------------------------------------- commissions -- */

/**
 * Who the money is owed to.
 *
 * `agent_user_id` is nullable and `agency_id` is nullable, and
 * `commissions_has_a_payee` requires one of the two — an agency keeps the
 * commercial relationship when the individual leaves. `kind` says which of the
 * two answered, so a screen never has to infer it from a name being present.
 *
 * `unknown` is reachable: the person's `auth.users` row is `on delete set
 * null` and the agency may be unreadable to this member. It is rendered as
 * "the payee is not identifiable", which is a row somebody must look at — not
 * papered over with the agency's name or the agent's id.
 */
export type CommissionPayee =
  | { kind: 'agent'; name: string | null; agencyName: string | null }
  | { kind: 'agency'; name: string | null }
  | { kind: 'unknown' }

export type CommissionListItem = {
  id: string
  bookingId: string
  propertyId: string
  bookingReference: string | null
  status: CommissionStatus
  payee: CommissionPayee
  /** What is owed. Visible to anybody holding `commission.view`. */
  amountAgorot: number
  /** Basis points — 1200 is 12%. Null for a fixed-amount commission. */
  rateBps: number | null
  /** Which base was agreed. The *name* of it, never the figure. */
  basis: CommissionBase
  rule: CommissionRule
  /**
   * The stay revenue the percentage was applied to, withheld without
   * `booking.view_price`. The rule's own free-text label travels with it —
   * see `COMMISSION_REDACTIONS`.
   */
  basisAgorot?: number
  explanation?: string | null
  becameEligibleOn: string | null
  approvedOn: string | null
  paidOn: string | null
  cancellationReason: string | null
  /** Paid, and then the booking was refunded. Somebody must claw it back. */
  clawbackRequired: boolean
  recordedOn: string
}

/**
 * The base is stay revenue, so it is gated on `booking.view_price` — and so is
 * the explanation beside it.
 *
 * That second entry is not tidiness. `commissions.explanation` is free text
 * written when the commission was created, and the demo's own rows read
 * "10% מסך הלינות (4,500 ₪)" — the base, spelled out in a sentence. Withholding
 * `basis_agorot` while printing that would be a redaction that redacts nothing.
 * Anything derived from the base travels with the base.
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
  requires: Parameters<typeof can>[1]
}>

const COMMISSION_COLUMNS =
  'id, booking_id, property_id, agent_user_id, agency_id, status, base, ' +
  'basis_agorot, rate_bps, amount_agorot, explanation, eligible_at, ' +
  'approved_at, paid_at, cancellation_reason, clawback_required, metadata, ' +
  'created_at'

export async function listCommissions(
  args: FinanceListArgs<CommissionStatus>,
): Promise<readonly CommissionListItem[]> {
  const { db, actor, organizationId, propertyId, filter } = args

  let query = db
    .from('commissions')
    .select(COMMISSION_COLUMNS)
    .eq('organization_id', organizationId)

  if (propertyId !== null) query = query.eq('property_id', propertyId)
  if (filter.status !== null) query = query.eq('status', filter.status)

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(args.limit ?? FINANCE_PAGE_SIZE)

  if (error) throw error

  const rows = toRows(data).filter((row) =>
    can(
      actor,
      'commission.view',
      financeResource(organizationId, asString(row, 'property_id')),
    ),
  )

  const [references, people, agencies] = await Promise.all([
    bookingReferences(
      db,
      actor,
      organizationId,
      rows.map((row) => asString(row, 'booking_id')),
    ),
    profileNames(db, namesNeeded(rows, 'agent_user_id')),
    agencyNames(db, namesNeeded(rows, 'agency_id')),
  ])

  return rows.map((row) => {
    const propertyOfRow = asString(row, 'property_id')
    const bookingId = asString(row, 'booking_id')

    const item: CommissionListItem = {
      id: asString(row, 'id'),
      bookingId,
      propertyId: propertyOfRow,
      bookingReference: references.get(bookingId) ?? null,
      status: asEnum(row, 'status', COMMISSION_STATUSES),
      payee: toPayee(row, people, agencies),
      amountAgorot: asAgorot(row, 'amount_agorot'),
      rateBps: asNumberOrNull(row, 'rate_bps'),
      basis: asEnum(row, 'base', COMMISSION_BASES),
      rule: toCommissionRule(row),
      basisAgorot: asAgorot(row, 'basis_agorot'),
      explanation: asStringOrNull(row, 'explanation'),
      becameEligibleOn: propertyDate(row, 'eligible_at'),
      approvedOn: propertyDate(row, 'approved_at'),
      paidOn: propertyDate(row, 'paid_at'),
      cancellationReason: asStringOrNull(row, 'cancellation_reason'),
      clawbackRequired: asBoolean(row, 'clawback_required'),
      recordedOn: requiredPropertyDate(row, 'created_at'),
    }

    return redact(
      actor,
      item,
      COMMISSION_REDACTIONS,
      financeResource(organizationId, propertyOfRow),
    )
  })
}

/** What is owed across the listed commissions, by the domain's own sum. */
export function commissionTotalAgorot(
  commissions: readonly CommissionListItem[],
): number {
  return sumAgorot(commissions.map((commission) => commission.amountAgorot))
}

export async function countCommissions(
  db: Db,
  organizationId: string,
  propertyId: string | null,
): Promise<number> {
  return countRows(db, 'commissions', organizationId, propertyId)
}

/* --------------------------------------------------------------- shared -- */

/**
 * A `head` count, so "you have never taken a payment" and "your filter matched
 * nothing" can be told apart without paying for the rows.
 *
 * The distinction is the whole reason `resolveEmptyReason` takes two numbers:
 * showing a business with fifty invoices the onboarding copy tells them the
 * system lost their documents.
 */
async function countRows(
  db: Db,
  table: 'payments' | 'invoices' | 'commissions',
  organizationId: string,
  propertyId: string | null,
): Promise<number> {
  let query = db
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)

  if (propertyId !== null) query = query.eq('property_id', propertyId)

  const { count, error } = await query
  if (error) throw error
  return count ?? 0
}

/**
 * Booking references for the rows on screen, in one query.
 *
 * Not an embed: there is no `payments.bookings` relation declared for the
 * transaction compiler or the demo client, and adding one for a single text
 * column would widen a surface both files keep deliberately narrow. One `in`
 * over at most a page of ids is cheaper than the embed would have been anyway.
 *
 * Skipped entirely without `booking.view`, because `bookings_select` would
 * return nothing and the query would be a round trip that cannot succeed. An
 * empty map is a real answer: the caller falls back to what the row itself
 * recorded, or renders null.
 */
async function bookingReferences(
  db: Db,
  actor: Actor,
  organizationId: string,
  bookingIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(bookingIds)]
  if (unique.length === 0) return new Map()
  if (!can(actor, 'booking.view', { organizationId })) return new Map()

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
 * The payments an invoice accounts for, or `null` when this reader may not see
 * payments at all.
 *
 * `null` and an empty map are different answers and the screen says so
 * differently: "this invoice has settled nothing yet" versus "there are two
 * payments here and you may not see them". Collapsing the two would tell a
 * reader an invoice is unpaid because of their own permissions.
 */
async function linkedPayments(
  db: Db,
  actor: Actor,
  organizationId: string,
  paymentIds: readonly string[],
): Promise<ReadonlyMap<string, InvoicePaymentLink> | null> {
  if (!can(actor, 'payment.view', { organizationId })) return null

  const unique = [...new Set(paymentIds)]
  if (unique.length === 0) return new Map()

  const { data, error } = await db
    .from('payments')
    .select('id, status, method, amount_agorot, paid_at')
    .eq('organization_id', organizationId)
    .in('id', unique)

  if (error) throw error

  const maySeeAmounts = can(actor, 'booking.view_price', { organizationId })
  const links = new Map<string, InvoicePaymentLink>()

  for (const row of toRows(data)) {
    const link: InvoicePaymentLink = {
      id: asString(row, 'id'),
      status: asEnum(row, 'status', PAYMENT_STATUSES),
      method: asEnum(row, 'method', PAYMENT_METHODS),
      paidOn: propertyDate(row, 'paid_at'),
    }
    if (maySeeAmounts) link.amountAgorot = asAgorot(row, 'amount_agorot')
    links.set(link.id, link)
  }
  return links
}

function paymentIdsOf(row: Row): string[] {
  const embedded = row.invoice_payments
  if (!Array.isArray(embedded)) return []
  return embedded.map((entry) => asString(toRow(entry), 'payment_id'))
}

/**
 * The invoice's lines, sorted the way the adapter sorts them.
 *
 * `sort_order` is the document's own ordering and the only one that can be
 * right: an invoice whose lines arrive in insertion order reads differently
 * from the document that was sent to the customer.
 */
function toPriceLines(row: Row, column: string): PriceLine[] {
  const raw = row[column]
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => toRow(entry))
    .sort((a, b) => asNumber(a, 'sort_order') - asNumber(b, 'sort_order'))
    .map((line) => ({
      kind: asEnum(line, 'kind', PRICE_LINE_KINDS),
      label: asString(line, 'label'),
      amount: asAgorot(line, 'amount_agorot'),
      quantity: asNumber(line, 'quantity'),
      date: asStringOrNull(line, 'line_date'),
    }))
}

function namesNeeded(rows: readonly Row[], column: string): string[] {
  const ids = new Set<string>()
  for (const row of rows) {
    const value = asStringOrNull(row, column)
    if (value !== null) ids.add(value)
  }
  return [...ids]
}

/**
 * Display names for the people a commission is owed to.
 *
 * `user_profiles_select` admits anybody who shares an organization with the
 * subject, so this is readable by every member — and it is only ever asked for
 * ids that appeared on a commission row this reader was already admitted to.
 * A missing name is left null rather than filled with the uuid.
 */
async function profileNames(
  db: Db,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (userIds.length === 0) return new Map()

  const { data, error } = await db
    .from('user_profiles')
    .select('id, full_name')
    .in('id', [...userIds])

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    const name = asStringOrNull(row, 'full_name')
    if (name !== null) names.set(asString(row, 'id'), name)
  }
  return names
}

/**
 * Agency names.
 *
 * `agencies_select` admits an agency this organization works with, which is
 * exactly the set that can appear on one of its commissions. A row this reader
 * cannot see leaves the name null and the payee renders as an agency without a
 * name, which is true.
 */
async function agencyNames(
  db: Db,
  agencyIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (agencyIds.length === 0) return new Map()

  const { data, error } = await db
    .from('agencies')
    .select('id, name')
    .in('id', [...agencyIds])

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    names.set(asString(row, 'id'), asString(row, 'name'))
  }
  return names
}

/**
 * The payee, decided the way the domain decides it.
 *
 * `payeeKey` in `finance/commissions.ts` prefers `agentUserId` and falls back
 * to the agency, and this follows that order rather than inventing a second
 * rule — the two must agree, because one groups a statement and the other
 * labels it.
 */
function toPayee(
  row: Row,
  people: ReadonlyMap<string, string>,
  agencies: ReadonlyMap<string, string>,
): CommissionPayee {
  const agentUserId = asStringOrNull(row, 'agent_user_id')
  const agencyId = asStringOrNull(row, 'agency_id')

  if (agentUserId !== null) {
    return {
      kind: 'agent',
      name: people.get(agentUserId) ?? null,
      agencyName: agencyId === null ? null : (agencies.get(agencyId) ?? null),
    }
  }
  if (agencyId !== null) {
    return { kind: 'agency', name: agencies.get(agencyId) ?? null }
  }
  return { kind: 'unknown' }
}

/**
 * The rule a commission was computed under, read the way the adapter reads it.
 *
 * `metadata.rule` is what the domain wrote, and it is taken whole. When it is
 * absent the rule is derived from the columns that *reproduce the money* — the
 * base, the rate and the amount — so a derived rule cannot contradict the
 * figure beside it. `basis` always comes from the `base` column, which is the
 * constrained one. This mirrors `toCommissionRule` in
 * `persistence/finance.ts`; when the port grows a list method, both disappear
 * into it.
 */
function toCommissionRule(row: Row): CommissionRule {
  const basis = asEnum(row, 'base', COMMISSION_BASES)
  const stored = asJsonRecord(row, 'metadata').rule

  if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
    return { ...(stored as CommissionRule), basis }
  }

  const rateBps = asNumberOrNull(row, 'rate_bps')
  return {
    basis,
    kind: rateBps === null ? 'fixed' : 'percent',
    // Percentage points for `percent`, agorot for `fixed` — the units the
    // domain's own type declares.
    value: rateBps === null ? asAgorot(row, 'amount_agorot') : rateBps / 100,
    label: asStringOrNull(row, 'explanation') ?? '',
  }
}
