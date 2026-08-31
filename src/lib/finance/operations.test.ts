import { beforeEach, describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../audit/pipeline'
import { AuthorizationError, can } from '../authz/can'
import {
  FIELD_PERMISSIONS,
  PERMISSIONS,
  type Grant,
} from '../authz/permissions'
import {
  BusinessRuleError,
  ConflictError,
  IdempotencyConflictError,
  NotFoundError,
  ValidationError,
} from '../errors'
import {
  InMemoryEventBus,
  InMemoryIdempotencyStore,
  type OperationContext,
  type OperationServices,
} from '../service'
import { defineFinanceOperations, outstandingAgorot } from './operations'
import { createPayment } from './payments'
import { InMemoryFinanceRepository } from './repository'
import {
  AT,
  BOOKING,
  ORG,
  OTHER_ORG,
  PROPERTY,
  cleanerActor,
  financeActor,
  snapshotFor,
} from './testing'
import type { Payment } from './types'

const NOW = AT('2026-03-11T10:00:00.000Z')
const PAYMENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const REFUND_ID = 'bbbbbbbb-0000-4000-8000-000000000002'
const INVOICE_ID = 'cccccccc-0000-4000-8000-000000000003'

let repo: InMemoryFinanceRepository
let audit: InMemoryAuditWriter
let idempotency: InMemoryIdempotencyStore
let events: InMemoryEventBus
let ops: ReturnType<typeof defineFinanceOperations>

beforeEach(() => {
  repo = new InMemoryFinanceRepository()
  audit = new InMemoryAuditWriter()
  idempotency = new InMemoryIdempotencyStore()
  events = new InMemoryEventBus()
  ops = defineFinanceOperations(repo)
})

function services(): OperationServices {
  return { audit, idempotency, events }
}

function context(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    actor: financeActor(),
    auditActor: { type: 'user', userId: 'user-finance', label: 'דנה כהן' },
    correlationId: 'corr-1',
    now: NOW,
    reason: null,
    ...overrides,
  }
}

const recordInput = {
  paymentId: PAYMENT_ID,
  bookingId: BOOKING,
  propertyId: PROPERTY,
  amountAgorot: 100_000,
  settledAgorot: 100_000,
  method: 'card' as const,
  channel: 'payment_link' as const,
  purpose: 'full' as const,
}

async function recordOnce(key: string | null = 'key-1') {
  return ops.recordPayment.run({
    request: { input: recordInput, idempotencyKey: key },
    context: context(),
    services: services(),
  })
}

// ── Idempotency ───────────────────────────────────────────────────────────

describe('a retried payment does not act twice', () => {
  it('replays the original answer and writes nothing new', async () => {
    const first = await recordOnce()
    expect(first.replayed).toBe(false)
    expect(first.data.status).toBe('paid')

    const second = await recordOnce()

    expect(second.replayed).toBe(true)
    expect(second.data.id).toBe(first.data.id)
    // One payment, one audit row, one event. The retry produced none of them.
    expect(repo.payments.size).toBe(1)
    expect(audit.records).toHaveLength(1)
    expect(events.published).toHaveLength(1)
  })

  it('is the key that does the work, not the payload', async () => {
    // Proves the previous test passes for the right reason: without a key,
    // the same request twice really does record money twice.
    await recordOnce(null)
    await ops.recordPayment.run({
      request: {
        input: { ...recordInput, paymentId: PAYMENT_ID.replace('1', '9') },
        idempotencyKey: null,
      },
      context: context(),
      services: services(),
    })
    expect(repo.payments.size).toBe(2)
  })

  it('refuses a key that was used for a different request', async () => {
    await recordOnce()

    await expect(
      ops.recordPayment.run({
        request: {
          input: { ...recordInput, amountAgorot: 200_000 },
          idempotencyKey: 'key-1',
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError)

    expect(repo.payments.size).toBe(1)
  })

  it('refuses outright when a key arrives with no store wired', async () => {
    // Honouring the key by ignoring it is the exact failure the key exists to
    // prevent, dressed as success.
    await expect(
      ops.recordPayment.run({
        request: { input: recordInput, idempotencyKey: 'key-1' },
        context: context(),
        services: { audit },
      }),
    ).rejects.toMatchObject({ code: 'operation_misconfigured', status: 500 })
  })

  it('frees the key when the operation failed, so the retry can proceed', async () => {
    await expect(
      ops.recordPayment.run({
        request: {
          input: { ...recordInput, settledAgorot: 900_000 },
          idempotencyKey: 'key-2',
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)

    expect(idempotency.size).toBe(0)
  })
})

describe('a retried refund does not act twice', () => {
  async function paidPayment(): Promise<Payment> {
    const payment = {
      ...createPayment(
        {
          id: PAYMENT_ID,
          organizationId: ORG,
          propertyId: PROPERTY,
          bookingId: BOOKING,
          purpose: 'full',
          method: 'card',
          channel: 'payment_link',
          amountAgorot: 100_000,
          providerId: 'in_memory',
        },
        NOW,
      ),
      status: 'paid' as const,
      capturedAgorot: 100_000,
    }
    await repo.insertPayment(payment)
    return payment
  }

  const refundRequest = (key: string | null = 'refund-key') => ({
    input: {
      refundId: REFUND_ID,
      amountAgorot: 20_000,
      reason: 'correction' as const,
    },
    resourceId: PAYMENT_ID,
    expectedVersion: 1,
    idempotencyKey: key,
  })

  it('refunds once however many times the request arrives', async () => {
    await paidPayment()
    const ctx = context({ reason: 'חיוב כפול' })

    const first = await ops.refundPayment.run({
      request: refundRequest(),
      context: ctx,
      services: services(),
    })
    expect(first.replayed).toBe(false)

    const second = await ops.refundPayment.run({
      request: refundRequest(),
      context: ctx,
      services: services(),
    })

    expect(second.replayed).toBe(true)
    expect(repo.refunds.size).toBe(1)
    expect(repo.payments.get(PAYMENT_ID)?.refundedAgorot).toBe(20_000)
    expect(audit.records).toHaveLength(1)
  })

  it('demands a stated reason, because a refund is a sensitive action', async () => {
    await paidPayment()

    await expect(
      ops.refundPayment.run({
        request: refundRequest('no-reason'),
        context: context({ reason: null }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    expect(repo.refunds.size).toBe(0)
  })

  it('refuses a refund larger than the capture', async () => {
    await paidPayment()

    await expect(
      ops.refundPayment.run({
        request: {
          ...refundRequest('too-big'),
          input: {
            refundId: REFUND_ID,
            amountAgorot: 500_000,
            reason: 'correction' as const,
          },
        },
        context: context({ reason: 'טעות' }),
        services: services(),
      }),
    ).rejects.toMatchObject({ code: 'finance.refund_exceeds_capture' })

    expect(repo.payments.get(PAYMENT_ID)?.refundedAgorot).toBe(0)
  })

  it('refuses a request built against a stale version', async () => {
    await paidPayment()

    await expect(
      ops.refundPayment.run({
        request: { ...refundRequest('stale'), expectedVersion: 7 },
        context: context({ reason: 'טעות' }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('leaves the money alone while a large refund awaits approval', async () => {
    await paidPayment()

    const outcome = await ops.refundPayment.run({
      request: {
        ...refundRequest('needs-approval'),
        input: {
          refundId: REFUND_ID,
          amountAgorot: 80_000,
          reason: 'goodwill' as const,
        },
      },
      context: context({ reason: 'פיצוי' }),
      services: services(),
    })

    expect(outcome.data.approvalStatus).toBe('requested')
    expect(repo.payments.get(PAYMENT_ID)?.refundedAgorot).toBe(0)
    // No `payment.refunded` event: no money moved.
    expect(outcome.events).toHaveLength(0)
  })
})

describe('a retried invoice does not act twice', () => {
  beforeEach(async () => {
    await repo.insertSnapshot(snapshotFor({ taxRatePercent: 18 }))
  })

  const issueRequest = (key: string | null = 'invoice-key') => ({
    input: {
      invoiceId: INVOICE_ID,
      kind: 'tax_invoice' as const,
      customerName: 'דנה כהן',
    },
    resourceId: BOOKING,
    idempotencyKey: key,
  })

  it('issues one document and one number', async () => {
    const first = await ops.issueInvoice.run({
      request: issueRequest(),
      context: context(),
      services: services(),
    })
    expect(first.data.number).toBe(1)
    expect(first.data.displayNumber).toBe('2026-000001')

    const second = await ops.issueInvoice.run({
      request: issueRequest(),
      context: context(),
      services: services(),
    })

    expect(second.replayed).toBe(true)
    expect(repo.invoices.size).toBe(1)
    // The counter did not move on the replay.
    expect(second.data.number).toBe(1)
  })

  it('hands out consecutive numbers to different bookings', async () => {
    await repo.insertSnapshot(snapshotFor({ bookingId: 'booking-2' }))

    const first = await ops.issueInvoice.run({
      request: issueRequest('a'),
      context: context(),
      services: services(),
    })
    const second = await ops.issueInvoice.run({
      request: {
        input: {
          invoiceId: INVOICE_ID.replace('3', '4'),
          kind: 'tax_invoice' as const,
          customerName: 'רון לוי',
        },
        resourceId: 'booking-2',
        idempotencyKey: 'b',
      },
      context: context(),
      services: services(),
    })

    expect([first.data.number, second.data.number]).toEqual([1, 2])
  })

  it('refuses a second tax invoice for the same booking', async () => {
    await ops.issueInvoice.run({
      request: issueRequest('a'),
      context: context(),
      services: services(),
    })

    await expect(
      ops.issueInvoice.run({
        request: {
          ...issueRequest('b'),
          input: {
            invoiceId: INVOICE_ID.replace('3', '5'),
            kind: 'tax_invoice' as const,
            customerName: 'דנה כהן',
          },
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toMatchObject({ code: 'finance.invoice_already_issued' })
  })

  it('allows a proforma alongside a tax invoice', async () => {
    await ops.issueInvoice.run({
      request: issueRequest('a'),
      context: context(),
      services: services(),
    })

    const proforma = await ops.issueInvoice.run({
      request: {
        input: {
          invoiceId: INVOICE_ID.replace('3', '6'),
          kind: 'proforma' as const,
          customerName: 'דנה כהן',
        },
        resourceId: BOOKING,
        idempotencyKey: 'c',
      },
      context: context(),
      services: services(),
    })

    expect(proforma.data.kind).toBe('proforma')
    expect(repo.invoices.size).toBe(2)
  })

  it('publishes invoice.issued from the frozen catalogue', async () => {
    const outcome = await ops.issueInvoice.run({
      request: issueRequest(),
      context: context(),
      services: services(),
    })
    expect(outcome.events.map((event) => event.name)).toEqual([
      'invoice.issued',
    ])
  })

  it('is not found when the booking was never snapshotted', async () => {
    await expect(
      ops.issueInvoice.run({
        request: { ...issueRequest('x'), resourceId: 'no-such-booking' },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

// ── Authorization ─────────────────────────────────────────────────────────

/** Every grant in the catalogue that decides money or the records behind it. */
const FINANCE_GRANTS: readonly Grant[] = [
  ...PERMISSIONS,
  ...FIELD_PERMISSIONS,
].filter(
  (grant) =>
    grant.startsWith('finance.') ||
    grant.startsWith('payment.') ||
    grant.startsWith('deposit.') ||
    grant.startsWith('expense.') ||
    grant.startsWith('invoice.') ||
    grant.startsWith('commission.') ||
    grant.startsWith('report.financial.') ||
    grant.startsWith('owner_statement.') ||
    grant.startsWith('agent_statement.') ||
    grant.startsWith('agent_agreement.') ||
    grant === 'booking.view_price' ||
    grant === 'booking.view_deposit' ||
    grant === 'booking.view_profitability' ||
    grant === 'booking.view_payment_status' ||
    grant === 'owner.view_commission' ||
    grant === 'rate.view_net',
)

describe('a cleaner is refused every finance grant', () => {
  it('holds none of them', () => {
    const cleaner = cleanerActor()
    expect(FINANCE_GRANTS.length).toBeGreaterThan(15)

    for (const grant of FINANCE_GRANTS) {
      expect(can(cleaner, grant), `cleaner should not hold ${grant}`).toBe(
        false,
      )
      expect(
        can(cleaner, grant, { organizationId: ORG, propertyId: PROPERTY }),
        `cleaner should not hold ${grant} on a resource`,
      ).toBe(false)
    }
  })

  it('is refused before a single row is read', async () => {
    await expect(
      ops.recordPayment.run({
        request: { input: recordInput, idempotencyKey: 'k' },
        context: context({ actor: cleanerActor() }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)

    expect(repo.payments.size).toBe(0)
    expect(audit.records).toHaveLength(0)
    // The key was never consumed, so the refusal cannot poison a later
    // legitimate attempt.
    expect(idempotency.size).toBe(0)
  })

  it('is refused a refund and an invoice too', async () => {
    await repo.insertSnapshot(snapshotFor())

    await expect(
      ops.refundPayment.run({
        request: {
          input: {
            refundId: REFUND_ID,
            amountAgorot: 100,
            reason: 'correction' as const,
          },
          resourceId: PAYMENT_ID,
          expectedVersion: 1,
        },
        context: context({ actor: cleanerActor(), reason: 'ניסיון' }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)

    await expect(
      ops.issueInvoice.run({
        request: {
          input: {
            invoiceId: INVOICE_ID,
            kind: 'tax_invoice' as const,
            customerName: 'דנה',
          },
          resourceId: BOOKING,
        },
        context: context({ actor: cleanerActor() }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })
})

describe('tenant isolation', () => {
  it('cannot reach another organization’s payment', async () => {
    await repo.insertPayment({
      ...createPayment(
        {
          id: PAYMENT_ID,
          organizationId: ORG,
          propertyId: PROPERTY,
          bookingId: BOOKING,
          purpose: 'full',
          method: 'card',
          channel: 'payment_link',
          amountAgorot: 100_000,
        },
        NOW,
      ),
      status: 'paid',
      capturedAgorot: 100_000,
    })

    // Indistinguishable from "no such record", so probing another tenant's
    // ids cannot confirm that they exist.
    await expect(
      ops.refundPayment.run({
        request: {
          input: {
            refundId: REFUND_ID,
            amountAgorot: 100,
            reason: 'correction' as const,
          },
          resourceId: PAYMENT_ID,
          expectedVersion: 1,
        },
        context: context({
          actor: financeActor(),
          reason: 'ניסיון',
        }),
        services: services(),
      }),
    ).resolves.toBeTruthy()

    const intruder = financeActor()
    await expect(
      ops.refundPayment.run({
        request: {
          input: {
            refundId: REFUND_ID,
            amountAgorot: 100,
            reason: 'correction' as const,
          },
          resourceId: PAYMENT_ID,
          expectedVersion: 1,
        },
        context: context({
          actor: { ...intruder, organizationId: OTHER_ORG },
          reason: 'ניסיון',
        }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('outstandingAgorot', () => {
  it('is what was billed less what is actually held', () => {
    const payment = {
      ...createPayment(
        {
          id: PAYMENT_ID,
          organizationId: ORG,
          bookingId: BOOKING,
          purpose: 'deposit',
          method: 'bit',
          channel: 'payment_link',
          amountAgorot: 30_000,
        },
        NOW,
      ),
      capturedAgorot: 30_000,
      refundedAgorot: 5_000,
    }
    expect(outstandingAgorot(100_000, [payment])).toBe(75_000)
  })
})

/* ================================================== expense.rule.create == */

const EXPENSE_RULE_ID = 'dddddddd-0000-4000-8000-000000000004'

const expenseInput = {
  ruleId: EXPENSE_RULE_ID,
  label: 'תחזוקת בריכה',
  category: 'אחזקה',
  kind: 'fixed' as const,
  frequency: 'monthly' as const,
  amountAgorot: 145_000,
  allocation: 'per_day' as const,
  scopeKind: 'organization' as const,
  effectiveFrom: '2026-01-01',
  approvalRequired: true,
}

/**
 * `Record<string, unknown>` rather than a `Partial` of the input.
 *
 * `expenseInput` is written with `as const` on its enum fields so the happy
 * path is checked against the real tuples — which makes a `Partial` of it
 * refuse `{ kind: 'variable' }`, and the refusals below are exactly the cases
 * that have to vary those fields. What validates the result is the operation's
 * own schema, which is the check that matters here.
 */
async function createExpenseOnce(
  overrides: Record<string, unknown> = {},
  key: string | null = 'expense-key-1',
) {
  return ops.createExpenseRule.run({
    request: { input: { ...expenseInput, ...overrides }, idempotencyKey: key },
    context: context(),
    services: services(),
  })
}

describe('expense.rule.create', () => {
  it('writes the rule and records one audit event naming what was agreed', async () => {
    const outcome = await createExpenseOnce()

    expect(outcome.data.id).toBe(EXPENSE_RULE_ID)
    expect(outcome.data.kind).toBe('fixed')
    expect(outcome.data.amountAgorot).toBe(145_000)
    expect(outcome.data.approvalRequired).toBe(true)
    expect(repo.expenseRules.get(EXPENSE_RULE_ID)).toBeDefined()

    expect(audit.records).toHaveLength(1)
    expect(audit.records[0].action).toBe('expense.create')
    expect(audit.records[0].summary).toContain('תחזוקת בריכה')
  })

  it('replays rather than writing a second rule for the same key', async () => {
    const first = await createExpenseOnce()
    const second = await createExpenseOnce()

    expect(second.replayed).toBe(true)
    expect(second.data.id).toBe(first.data.id)
    expect(repo.expenseRules.size).toBe(1)
    // The audit event belongs to the run that actually happened.
    expect(audit.records).toHaveLength(1)
  })

  it('refuses a cleaner, who holds no expense grant at all', async () => {
    await expect(
      ops.createExpenseRule.run({
        request: { input: expenseInput, idempotencyKey: 'expense-key-2' },
        context: context({ actor: cleanerActor() }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)

    expect(repo.expenseRules.size).toBe(0)
  })

  it('refuses a variable rule with no formula, before the database does', async () => {
    // `expense_rules_formula_pair` would refuse the insert anyway. It is
    // refused here as well because the database's message names a column the
    // person filling in a form never saw — and because "a variable rule is one
    // that is computed" is a sentence about the domain, not about a table.
    await expect(
      createExpenseOnce(
        { kind: 'variable', amountAgorot: 0, formulaKind: null },
        'expense-key-3',
      ),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses a fixed rule that carries a formula', async () => {
    await expect(
      createExpenseOnce(
        { formulaKind: 'per_night', formulaRateAgorot: 4_200 },
        'expense-key-4',
      ),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses a fixed rule worth nothing', async () => {
    await expect(
      createExpenseOnce({ amountAgorot: 0 }, 'expense-key-5'),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses a property-scoped rule that names no property', async () => {
    await expect(
      createExpenseOnce({ scopeKind: 'property' }, 'expense-key-6'),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses an end date that is not after the start', async () => {
    await expect(
      createExpenseOnce({ effectiveTo: '2026-01-01' }, 'expense-key-7'),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('writes a variable rule with the formula the domain declares', async () => {
    const outcome = await createExpenseOnce(
      {
        kind: 'variable',
        amountAgorot: 0,
        formulaKind: 'percent_of_revenue',
        formulaPercent: 1.45,
        allocation: 'by_revenue',
      },
      'expense-key-8',
    )

    expect(outcome.data.kind).toBe('variable')
    // A variable rule's cost is its formula. Its periodic amount is zero by
    // definition, and writing anything else would put a figure on a screen
    // that nothing ever charges.
    expect(outcome.data.amountAgorot).toBe(0)
    expect(outcome.data.formula).toEqual({
      kind: 'percent_of_revenue',
      percent: 1.45,
    })
  })

  it('refuses a scope the screen cannot fill in', async () => {
    // `unit` and `booking` exist in the schema and have no screen. Refused
    // rather than written half-formed: a rule scoped to a unit that names no
    // unit is a rule nothing can ever apply.
    await expect(
      createExpenseOnce({ scopeKind: 'unit' }, 'expense-key-9'),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses a negative amount at the schema, not at the database', async () => {
    await expect(
      createExpenseOnce({ amountAgorot: -1 }, 'expense-key-10'),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})
