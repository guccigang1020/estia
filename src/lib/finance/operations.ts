/**
 * The finance operations.
 *
 * Three things a person can do that move money or issue a legal document, each
 * declared with `defineOperation` so that none of them can reach a write
 * without having passed authorization, validation, the version check, the
 * two-phase idempotency key and the audit trail. There is no second path to a
 * payment row.
 *
 * ── Why these are the operations that matter ──────────────────────────────
 *
 * The service pipeline exists because of payments. A retried card charge, a
 * redelivered webhook, a phone that lost signal between the request and the
 * answer — all three arrive as a second identical request, and the *only*
 * thing standing between them and a second charge is the key reserved before
 * the work begins. So every one of these carries `idempotencyKey`, and the
 * pipeline refuses the request outright if a key arrives with no store wired.
 *
 * `payment.refund` and `payment.void` are already in `SENSITIVE_ACTIONS`, so
 * the pipeline demands a stated reason without this file asking. The reason
 * lands on the refund record as well as the audit row, because the guest's
 * credit note quotes it.
 *
 * ── Habits worth naming ───────────────────────────────────────────────────
 *
 * **Nothing is stashed between steps.** The definition object is shared by
 * every concurrent run, so a value computed in `rule` and read in `execute`
 * would be one request's answer used for another's. Pure things are recomputed
 * where they are needed.
 *
 * **Scope is asserted by hand where there is nothing to load.** The pipeline
 * checks tenant and scope against the loaded resource, which a create
 * operation does not have — so `payment.record` calls `assertCan` again with
 * the resource its own input describes, before it reads anything. Without it a
 * manager scoped to one property could record a payment against another.
 *
 * **The client chooses the id.** A payment's id arrives in the input rather
 * than being generated here, which lets the same id and the same idempotency
 * key travel together from the browser through a retry. A server-generated id
 * would make the retry a different payment.
 */

import { assertCan, type Actor, type Resource } from '../authz/can'
import type { Agorot } from '../booking/types'
import { PAYMENT_METHODS } from '../contracts/states'
import { BusinessRuleError } from '../errors'
import { formatAgorot } from '../plans/plan'
import { defineOperation, s } from '../service'
import {
  issueInvoice as composeIssuedInvoice,
  remainingCreditable,
} from './invoices'
import {
  createPayment,
  deriveStatusFromAmounts,
  movePaymentTo,
} from './payments'
import { paymentResource } from './payment-state-machine'
import {
  assertRefundable,
  requestRefund,
  settleRefund,
  type RefundApprovalPolicy,
} from './refunds'
import type { ExpenseRuleListRow, FinanceRepository } from './repository'
import type { FinanceSnapshot } from './snapshot'
import {
  ALLOCATION_METHODS,
  COLLECTION_CHANNELS,
  EXPENSE_FREQUENCIES,
  EXPENSE_KINDS,
  EXPENSE_SCOPE_KINDS,
  PAYMENT_PURPOSES,
  REFUND_REASONS,
  type Invoice,
  type Payment,
  type Refund,
  type VariableFormula,
} from './types'
import { INVOICE_KINDS } from './types'

function financeResource(actor: Actor, propertyId: string | null): Resource {
  const resource: Resource = { organizationId: actor.organizationId }
  if (propertyId !== null) resource.propertyId = propertyId
  return resource
}

export interface FinanceOperationOptions {
  /** How much may be refunded without a second signature. */
  refundPolicy?: RefundApprovalPolicy
}

/**
 * Build the operations against a repository.
 *
 * A factory rather than module-level constants, because the repository is the
 * thing that varies: Supabase in the application, an in-memory double in the
 * tests. The operations themselves are identical in both.
 */
export function defineFinanceOperations(
  repo: FinanceRepository,
  options: FinanceOperationOptions = {},
) {
  // ── payment.record ──────────────────────────────────────────────────────

  /**
   * Record money that has arrived.
   *
   * Covers cash at the desk, a bank transfer spotted on the statement, and a
   * card settlement a provider has already confirmed. `settledAgorot` is what
   * actually arrived and may be less than what was asked for — a guest who
   * pays ₪2,000 of a ₪3,000 balance produces `partially_paid`, not an error
   * and not a second booking.
   */
  const recordPayment = defineOperation({
    name: 'payment.record',
    permission: 'payment.create',
    resourceType: 'payment',
    input: s.object({
      paymentId: s.uuid({ label: 'מזהה תשלום' }),
      bookingId: s.string({ label: 'הזמנה' }),
      propertyId: s.string({ label: 'נכס' }),
      amountAgorot: s.agorot({ label: 'סכום לתשלום' }),
      /** What actually arrived. Zero records a request that is still open. */
      settledAgorot: s.optional(s.agorot({ label: 'סכום שהתקבל' })),
      method: s.enumOf(PAYMENT_METHODS, { label: 'אמצעי תשלום' }),
      channel: s.enumOf(COLLECTION_CHANNELS, { label: 'ערוץ גבייה' }),
      purpose: s.enumOf(PAYMENT_PURPOSES, { label: 'ייעוד התשלום' }),
      providerId: s.optional(s.nullable(s.string({ max: 60 }))),
      providerRef: s.optional(s.nullable(s.string({ max: 120 }))),
      note: s.optional(s.string({ max: 400, label: 'הערה' })),
    }),

    async rule({ input, context }) {
      // The pipeline could not check scope — there was no resource to load.
      // This is that check, before a single row is read.
      assertCan(
        context.actor,
        'payment.create',
        financeResource(context.actor, input.propertyId),
      )

      const settled = input.settledAgorot ?? 0
      if (settled > input.amountAgorot) {
        throw new BusinessRuleError({
          code: 'finance.settled_exceeds_amount',
          userMessage:
            `התקבלו ${formatAgorot(settled)} על תשלום של ` +
            `${formatAgorot(input.amountAgorot)}. רשום תשלום נפרד על ההפרש.`,
          message: `Settled ${settled} exceeds requested ${input.amountAgorot}`,
        })
      }
    },

    async execute({ input, context, now, tx }): Promise<Payment> {
      const created = createPayment(
        {
          id: input.paymentId,
          organizationId: context.actor.organizationId,
          propertyId: input.propertyId,
          bookingId: input.bookingId,
          purpose: input.purpose,
          method: input.method,
          channel: input.channel,
          amountAgorot: input.amountAgorot,
          providerId: input.providerId ?? null,
          createdByUserId: context.actor.userId,
        },
        now,
      )

      const settled = input.settledAgorot ?? 0
      if (settled === 0) return repo.insertPayment(created, tx)

      const next = {
        amountAgorot: created.amountAgorot,
        authorizedAgorot: 0,
        capturedAgorot: settled,
        refundedAgorot: 0,
      }
      const change = movePaymentTo(
        context.actor,
        created,
        deriveStatusFromAmounts(next, created.status),
        next,
        { now, providerRef: input.providerRef ?? null },
      )

      return repo.insertPayment(change.payment, tx)
    },

    audit({ result, context }) {
      return {
        resourceId: result.id,
        propertyId: result.propertyId,
        summary:
          `${context.auditActor.label} רשם תשלום של ` +
          `${formatAgorot(result.capturedAgorot)} מתוך ` +
          `${formatAgorot(result.amountAgorot)} בהזמנה ${result.bookingId}.`,
        after: {
          status: result.status,
          amountAgorot: result.amountAgorot,
          capturedAgorot: result.capturedAgorot,
        },
      }
    },

    events({ result }) {
      if (result.capturedAgorot === 0) return []
      return [
        {
          name: 'payment.received' as const,
          propertyId: result.propertyId,
          payload: {
            paymentId: result.id,
            bookingId: result.bookingId,
            amountAgorot: result.capturedAgorot,
            status: result.status,
          },
        },
      ]
    },
  })

  // ── payment.refund ──────────────────────────────────────────────────────

  /**
   * Give money back.
   *
   * The ceiling is `capturedAgorot − refundedAgorot`, checked in `rule` before
   * anything is written and again by the payment state machine's own
   * condition. A refund above the policy threshold is created `requested` and
   * moves no money — the second signature is a separate act by a separate
   * person, and an operation that both requested and approved would make the
   * threshold decorative.
   */
  const refundPayment = defineOperation({
    name: 'payment.refund',
    permission: 'payment.refund',
    resourceType: 'payment',
    requiresVersion: true,
    input: s.object({
      refundId: s.uuid({ label: 'מזהה החזר' }),
      amountAgorot: s.agorot({ label: 'סכום ההחזר' }),
      reason: s.enumOf(REFUND_REASONS, { label: 'סיבת ההחזר' }),
    }),

    async loadResource({ request, context }) {
      const payment = await repo.loadPayment(
        context.actor.organizationId,
        request.resourceId ?? '',
      )
      if (!payment) return null
      return {
        resource: paymentResource(payment),
        entity: payment,
        version: payment.version,
      }
    },

    async rule({ input, entity }) {
      assertRefundable(entity, input.amountAgorot)
    },

    async execute({ input, entity, context, now, tx }): Promise<Refund> {
      const refund = requestRefund({
        id: input.refundId,
        payment: entity,
        amountAgorot: input.amountAgorot,
        reason: input.reason,
        // The pipeline has already refused a blank reason: `payment.refund` is
        // in SENSITIVE_ACTIONS, so `context.reason` is present by the time any
        // of this runs.
        reasonText: context.reason ?? '',
        requestedByUserId: context.actor.userId,
        requestedAt: now,
        policy: options.refundPolicy,
      })

      if (refund.approvalStatus !== 'approved') {
        // Waiting for a second person. No money moves.
        return repo.insertRefund(refund, tx)
      }

      const settlement = settleRefund(context.actor, entity, refund, { now })
      if (!settlement) return repo.insertRefund(refund, tx)

      await repo.updatePayment(settlement.change.payment, tx)
      return repo.insertRefund(settlement.refund, tx)
    },

    audit({ result, entity, context }) {
      const pending = result.approvalStatus !== 'approved'
      return {
        resourceId: entity.id,
        propertyId: entity.propertyId,
        summary: pending
          ? `${context.auditActor.label} ביקש החזר של ` +
            `${formatAgorot(result.amountAgorot)} בהזמנה ${result.bookingId}, ` +
            'וההחזר ממתין לאישור.'
          : `${context.auditActor.label} ביצע החזר של ` +
            `${formatAgorot(result.amountAgorot)} בהזמנה ${result.bookingId}.`,
        before: { refundedAgorot: entity.refundedAgorot },
        after: {
          refundedAgorot: pending
            ? entity.refundedAgorot
            : entity.refundedAgorot + result.amountAgorot,
          refundStatus: result.status,
        },
      }
    },

    events({ result, entity }) {
      if (result.approvalStatus !== 'approved') return []
      return [
        {
          name: 'payment.refunded' as const,
          propertyId: entity.propertyId,
          payload: {
            paymentId: entity.id,
            refundId: result.id,
            bookingId: result.bookingId,
            amountAgorot: result.amountAgorot,
          },
        },
      ]
    },
  })

  // ── invoice.issue ───────────────────────────────────────────────────────

  /**
   * Issue a document.
   *
   * The lines come from the booking's finance snapshot, so an invoice reprinted
   * next year is identical to the one that was sent. The number comes from the
   * database's gapless counter and never from this process.
   *
   * A booking may hold only one issued tax invoice. A second one is refused
   * rather than deduplicated, because two tax invoices for one stay is a
   * question from the tax authority and the right answer is a credit note.
   */
  const issueInvoice = defineOperation({
    name: 'invoice.issue',
    permission: 'invoice.issue',
    resourceType: 'invoice',
    input: s.object({
      invoiceId: s.uuid({ label: 'מזהה חשבונית' }),
      kind: s.enumOf(INVOICE_KINDS, { label: 'סוג המסמך' }),
      customerName: s.string({ min: 2, max: 200, label: 'שם הלקוח' }),
      customerTaxId: s.optional(s.nullable(s.string({ max: 20 }))),
      series: s.optional(s.string({ max: 40, label: 'סדרה' })),
      touristVatExempt: s.optional(s.boolean({ label: 'פטור מע״מ לתייר' })),
    }),

    async loadResource({ request, context }) {
      const snapshot = await repo.loadSnapshot(
        context.actor.organizationId,
        request.resourceId ?? '',
      )
      if (!snapshot) return null
      const resource: Resource = { organizationId: snapshot.organizationId }
      if (snapshot.propertyId !== null)
        resource.propertyId = snapshot.propertyId
      return { resource, entity: snapshot }
    },

    async rule({ input, entity, context }) {
      if (input.kind === 'proforma') return

      const existing = await repo.loadInvoicesForBooking(
        context.actor.organizationId,
        entity.bookingId,
      )
      const alreadyIssued = existing.some(
        (invoice) => invoice.status === 'issued' && invoice.kind !== 'proforma',
      )
      if (alreadyIssued) {
        throw new BusinessRuleError({
          code: 'finance.invoice_already_issued',
          userMessage:
            'כבר הופקה חשבונית מס להזמנה הזו. תיקון נעשה באמצעות חשבונית זיכוי.',
          message: `Booking ${entity.bookingId} already has an issued invoice`,
        })
      }
    },

    async execute({ input, entity, now, tx }): Promise<Invoice> {
      const snapshot: FinanceSnapshot = entity
      const series = input.series ?? 'default'
      const year = now.getUTCFullYear()

      const number = await repo.allocateInvoiceNumber(
        snapshot.organizationId,
        series,
        year,
        tx,
      )

      const payments = await repo.loadPaymentsForBooking(
        snapshot.organizationId,
        snapshot.bookingId,
      )

      const invoice = composeIssuedInvoice({
        id: input.invoiceId,
        snapshot,
        kind: input.kind,
        number,
        series,
        year,
        customerName: input.customerName,
        customerTaxId: input.customerTaxId ?? null,
        touristVatExempt: input.touristVatExempt ?? false,
        paymentIds: payments
          .filter((payment) => payment.capturedAgorot > 0)
          .map((payment) => payment.id),
        issuedAt: now,
      })

      return repo.insertInvoice(invoice, tx)
    },

    audit({ result, context }) {
      return {
        resourceId: result.id,
        propertyId: result.propertyId,
        summary:
          `${context.auditActor.label} הפיק מסמך ${result.displayNumber} ` +
          `על סך ${formatAgorot(result.totalAgorot)} בהזמנה ` +
          `${result.bookingId}.`,
        after: {
          displayNumber: result.displayNumber,
          totalAgorot: result.totalAgorot,
          kind: result.kind,
        },
      }
    },

    events({ result }) {
      return [
        {
          name: 'invoice.issued' as const,
          propertyId: result.propertyId,
          payload: {
            invoiceId: result.id,
            bookingId: result.bookingId,
            displayNumber: result.displayNumber,
            totalAgorot: result.totalAgorot,
          },
        },
      ]
    },
  })

  // ── expense.create ──────────────────────────────────────────────────────

  /**
   * Write down a cost the business carries.
   *
   * A rule, not a row per month. `expense_rules` says what recurs and
   * `expense_allocations` says which booking carried a share of it; there is no
   * `expenses` table and this operation does not invent one. What it writes is
   * the terms, and the terms are what `finance_snapshots` freezes onto a
   * booking so that editing a rule today does not change what March cost.
   *
   * ── The two constraints refused here rather than at the database ─────────
   *
   * `expense_rules_formula_pair` requires `(kind = 'variable') = (formula is
   * not null)`, and `expense_rules_scope_target` requires a scope that names
   * something at the level it claims. Both would refuse the insert anyway. They
   * are refused here as well because the database's message names a column the
   * person filling in a form never saw — and because "a variable rule is one
   * that is computed" is a sentence about the domain, not about a table.
   *
   * ── Scope is asserted by hand ───────────────────────────────────────────
   *
   * The pipeline checks tenant and scope against the *loaded* resource, and a
   * create operation has none. Without this call a manager scoped to one
   * property could write a rule against another.
   */
  const createExpenseRule = defineOperation({
    name: 'expense.rule.create',
    permission: 'expense.create',
    resourceType: 'expense_rule',
    input: s.object({
      // The client chooses the id, so the same id and the same idempotency key
      // travel together through a retry. A server-generated id would make the
      // retry a second rule.
      ruleId: s.uuid({ label: 'מזהה כלל' }),
      label: s.string({ min: 2, max: 120, label: 'שם ההוצאה' }),
      category: s.string({ min: 2, max: 60, label: 'קטגוריה' }),
      kind: s.enumOf(EXPENSE_KINDS, { label: 'סוג ההוצאה' }),
      frequency: s.enumOf(EXPENSE_FREQUENCIES, { label: 'תדירות' }),
      amountAgorot: s.agorot({ label: 'סכום' }),
      allocation: s.enumOf(ALLOCATION_METHODS, { label: 'שיטת ייחוס' }),
      scopeKind: s.enumOf(EXPENSE_SCOPE_KINDS, { label: 'תחולה' }),
      scopePropertyId: s.optional(s.nullable(s.uuid({ label: 'נכס' }))),
      // The five formulas the domain declares, flattened: a discriminated
      // union is not a shape a form posts, and a closed set of fields is what
      // stops an expression the customer types from ever existing.
      formulaKind: s.optional(
        s.nullable(s.enumOf(VARIABLE_FORMULA_KINDS, { label: 'נוסחה' })),
      ),
      formulaRateAgorot: s.optional(s.nullable(s.agorot({ label: 'תעריף' }))),
      formulaPercent: s.optional(
        s.nullable(s.number({ min: 0, max: 100, label: 'אחוז' })),
      ),
      effectiveFrom: s.string({
        label: 'בתוקף מ־',
        pattern: /^\d{4}-\d{2}-\d{2}$/,
        patternMessage: 'תאריך אינו תקין.',
      }),
      effectiveTo: s.optional(
        s.nullable(
          s.string({
            label: 'בתוקף עד',
            pattern: /^\d{4}-\d{2}-\d{2}$/,
            patternMessage: 'תאריך אינו תקין.',
          }),
        ),
      ),
      approvalRequired: s.boolean({ label: 'דורש אישור' }),
    }),

    async rule({ input, context }) {
      assertCan(
        context.actor,
        'expense.create',
        financeResource(context.actor, input.scopePropertyId ?? null),
      )

      const formula = formulaFrom(input)

      if (input.kind === 'variable' && formula === null) {
        throw new BusinessRuleError({
          code: 'finance.expense_formula_required',
          userMessage:
            'הוצאה משתנה מחושבת מתוך ההזמנה, ולכן חייבת נוסחה — לפי לילה, ' +
            'לפי אורח, לפי הזמנה או כאחוז מההכנסה.',
          message: 'A variable expense rule was submitted without a formula',
        })
      }

      if (input.kind === 'fixed' && formula !== null) {
        throw new BusinessRuleError({
          code: 'finance.expense_formula_not_allowed',
          userMessage:
            'הוצאה קבועה היא סכום לתקופה ולא חישוב. הסר את הנוסחה, או שנה ' +
            'את סוג ההוצאה למשתנה.',
          message: 'A fixed expense rule was submitted with a formula',
        })
      }

      if (input.kind === 'fixed' && input.amountAgorot <= 0) {
        throw new BusinessRuleError({
          code: 'finance.expense_amount_required',
          userMessage: 'הוצאה קבועה חייבת סכום גדול מאפס.',
          message: 'A fixed expense rule was submitted with no amount',
        })
      }

      if (input.scopeKind === 'property' && !input.scopePropertyId) {
        throw new BusinessRuleError({
          code: 'finance.expense_scope_incomplete',
          userMessage: 'כלל שחל על נכס מסוים חייב לציין באיזה נכס מדובר.',
          message: 'A property-scoped expense rule named no property',
        })
      }

      // `unit` and `booking` scopes exist in the schema and have no screen.
      // Refused rather than written half-formed: a rule scoped to a unit that
      // names no unit is a rule nothing can ever apply.
      if (input.scopeKind === 'unit' || input.scopeKind === 'booking') {
        throw new BusinessRuleError({
          code: 'finance.expense_scope_unsupported',
          userMessage:
            'כרגע אפשר להגדיר כלל לכל הארגון או לנכס מסוים. תחולה ליחידה ' +
            'או להזמנה בודדת עדיין אינה נתמכת במסך הזה.',
          message: `Unsupported expense scope: ${input.scopeKind}`,
        })
      }

      if (
        input.effectiveTo != null &&
        input.effectiveTo <= input.effectiveFrom
      ) {
        throw new BusinessRuleError({
          code: 'finance.expense_dates_ordered',
          userMessage: 'תאריך הסיום חייב להיות אחרי תאריך ההתחלה.',
          message: 'effectiveTo is not after effectiveFrom',
        })
      }
    },

    async execute({ input, context, tx }): Promise<ExpenseRuleListRow> {
      const propertyId = input.scopePropertyId ?? null

      return repo.insertExpenseRule(
        {
          id: input.ruleId,
          organizationId: context.actor.organizationId,
          label: input.label,
          category: input.category,
          kind: input.kind,
          frequency: input.frequency,
          // A variable rule's periodic amount is zero by definition: its cost
          // is whatever the formula produces for a stay.
          amountAgorot: input.kind === 'variable' ? 0 : input.amountAgorot,
          formula: formulaFrom(input),
          allocation: input.allocation,
          scope:
            input.scopeKind === 'property'
              ? { kind: 'property', propertyId }
              : { kind: 'organization' },
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          approvalRequired: input.approvalRequired,
          createdByUserId: context.actor.userId,
        },
        tx,
      )
    },

    audit({ result, context }) {
      return {
        resourceId: result.id,
        propertyId: result.scopePropertyId,
        summary:
          `${context.auditActor.label} הגדיר כלל הוצאה ״${result.label}״ ` +
          (result.kind === 'fixed'
            ? `על סך ${formatAgorot(result.amountAgorot)} לתקופה.`
            : 'המחושב מתוך כל הזמנה.'),
        after: {
          label: result.label,
          kind: result.kind,
          frequency: result.frequency,
          amountAgorot: result.amountAgorot,
          allocation: result.allocation,
          scopeKind: result.scopeKind,
        },
      }
    },
  })

  return { recordPayment, refundPayment, issueInvoice, createExpenseRule }
}

/** The five, as a tuple the schema can validate against. */
const VARIABLE_FORMULA_KINDS = [
  'per_night',
  'per_guest_night',
  'per_booking',
  'per_guest',
  'percent_of_revenue',
] as const

/**
 * The formula, rebuilt from the flat fields a form posts.
 *
 * `null` when no kind was chosen, and `null` when the figure the chosen kind
 * needs is missing — which `rule` above turns into a refusal for a variable
 * rule rather than writing a formula that computes nothing.
 */
function formulaFrom(input: {
  formulaKind?: (typeof VARIABLE_FORMULA_KINDS)[number] | null
  formulaRateAgorot?: number | null
  formulaPercent?: number | null
}): VariableFormula | null {
  const kind = input.formulaKind ?? null
  if (kind === null) return null

  if (kind === 'percent_of_revenue') {
    const percent = input.formulaPercent
    return typeof percent === 'number' ? { kind, percent } : null
  }

  const rate = input.formulaRateAgorot
  return typeof rate === 'number' ? { kind, rateAgorot: rate } : null
}

export type FinanceOperations = ReturnType<typeof defineFinanceOperations>

/**
 * How much of an invoice may still be credited.
 *
 * Re-exported from the document module so a caller assembling a credit-note
 * screen does not have to know which file the ceiling lives in. There is one
 * implementation; this is a name for it.
 */
export { remainingCreditable }

/** What a booking still owes, as a plain figure for a screen. */
export function outstandingAgorot(
  billedAgorot: Agorot,
  payments: readonly Payment[],
): Agorot {
  return (
    billedAgorot -
    payments.reduce(
      (total, payment) =>
        total + payment.capturedAgorot - payment.refundedAgorot,
      0,
    )
  )
}
