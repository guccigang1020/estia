/**
 * The finance reads, walked the way the product walks them.
 *
 * `dataset-actor.test.ts` proved the eight personas resolve to genuinely
 * different actors. This file takes the next step and proves the *screens*
 * differ: it runs every query the six finance routes make over
 * `createDemoClient(DEMO_DATASET)` — the same 53 payments, 16 invoices, 37
 * lines, 27 invoice-payment links, 7 commissions, 6 expense rules and 8
 * allocations a person sees in demo mode — and asserts what an owner, an
 * accountant, a general manager, an external agent and a cleaner each come back
 * with.
 *
 * ── It now runs through the port ──────────────────────────────────────────
 *
 * `queries.ts` used to hold its own `db.from(...)` calls because
 * `FinanceRepository` was per-booking and had no list method. It has three now,
 * so these tests build a real `SupabaseFinanceRepository` over the demo client
 * and hand it in — which means the columns, the filters, the ordering and the
 * three joins under test are the adapter's, exactly as they are in production.
 *
 * ── Why this is worth writing ─────────────────────────────────────────────
 *
 * Twelve green test files sat beside `src/lib/finance` while no screen imported
 * any of it. A unit test over a pure function cannot tell you that a column
 * name is wrong, that an embed is not declared, or that a redaction hands over
 * the very figure it was meant to withhold. Running the real query over a real
 * dataset can, and does.
 *
 * ── What this is not ──────────────────────────────────────────────────────
 *
 * It is not a test of row level security. `createDemoClient` says so in its own
 * header and it is worth repeating: there is no policy engine behind these
 * arrays, so a query that forgot its tenant filter would return rows here and
 * nothing in production. What is exercised is the floor above it — the `can()`
 * narrowing and the `redact()` field rules the queries apply themselves.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import { holdsGrant, type Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { DemoActorSource } from '@/lib/demo/session'
import type { DemoPlan } from '@/lib/demo/types'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'
import { SupabaseFinanceRepository } from '@/lib/persistence/finance'
import { SEED_PLANS } from '@/lib/plans/catalog'

import {
  commissionTotalAgorot,
  countCommissions,
  countExpenseRules,
  countInvoices,
  countPayments,
  expenseTotals,
  listCommissions,
  listExpenseRules,
  listInvoices,
  listOwners,
  listPayments,
  paymentTotals,
  paymentsNeedingAttention,
  reconcilePayments,
  reconciliationTotals,
} from './queries'

const ORGANIZATION = DEMO_DATASET.organizationId

/** No status filter. The unfiltered list is what most assertions want. */
const ALL = { status: null } as const

function client(): Db {
  return createDemoClient(DEMO_DATASET) as unknown as Db
}

function repository(db: Db = client()): SupabaseFinanceRepository {
  return new SupabaseFinanceRepository(db)
}

function planNamed(code: string): DemoPlan {
  const found = DEMO_PLANS.find((plan) => plan.code === code)
  if (!found) throw new Error(`No demo plan '${code}'`)
  return found
}

/**
 * A package the switcher does not offer.
 *
 * `management` is in `SEED_PLANS` and is deliberately absent from `DEMO_PLANS`,
 * so *every* demo persona is on a package without `owner_portal` — which is why
 * the owners screen renders a plan lock in demo mode and why that lock is
 * worth a test of its own. This builds the plan the demo does not offer, from
 * the catalogue rather than by retyping its entitlements, so the entitled half
 * of that screen can be proved too.
 */
function catalogPlan(code: string): DemoPlan {
  const seed = SEED_PLANS.find((plan) => plan.code === code)
  if (!seed) throw new Error(`No seed plan '${code}'`)
  return { code: seed.code, label: seed.name, entitlements: seed.entitlements }
}

/**
 * The actor a persona resolves to, through the ordinary path.
 *
 * Lifted from `dataset-actor.test.ts` deliberately rather than shared: these
 * are the same modules a paying customer's request runs through, and the point
 * of both files is that nothing demo-specific is substituted for them.
 */
async function actorFor(
  personaId: string,
  plan: DemoPlan = planNamed('pro'),
): Promise<Actor> {
  const persona = DEMO_PERSONAS.find((entry) => entry.id === personaId)
  if (!persona) throw new Error(`No demo persona '${personaId}'`)

  const source = new DemoActorSource(new SupabaseActorSource(client()), plan)

  const resolution = await resolveActor(source, persona.userId, ORGANIZATION)
  if (!resolution.ok) {
    throw new Error(
      `${persona.label} does not resolve to an actor: ${resolution.reason}`,
    )
  }
  return resolution.actor
}

/** The arguments every list query takes, for an unfiltered organization-wide read. */
async function argsFor(personaId: string) {
  const actor = await actorFor(personaId)
  return {
    repo: repository(),
    actor,
    organizationId: ORGANIZATION,
    propertyId: null,
    filter: ALL,
  }
}

/** The same, plus the client the two name lookups need. */
async function expenseArgsFor(personaId: string) {
  const db = client()
  const actor = await actorFor(personaId)
  return {
    repo: repository(db),
    db,
    actor,
    organizationId: ORGANIZATION,
    propertyId: null,
    filter: ALL,
  }
}

/** How many rows the dataset holds, so the assertions cannot drift from it. */
function seeded(table: string): number {
  return DEMO_DATASET.tables[table]?.length ?? 0
}

/* ============================================================== payments == */

describe('the payments list', () => {
  it('serves the owner every seeded payment, with the payer and the money', async () => {
    const payments = await listPayments(await argsFor('owner'))

    expect(payments).toHaveLength(seeded('payments'))
    expect(payments.length).toBeGreaterThanOrEqual(50)

    for (const payment of payments) {
      // Every column the screen prints, present and of the right kind. A
      // renamed column would surface here as `undefined` rather than as a
      // blank cell somebody notices in production.
      expect(typeof payment.id).toBe('string')
      expect(typeof payment.status).toBe('string')
      expect(typeof payment.method).toBe('string')
      expect(typeof payment.purpose).toBe('string')
      expect(typeof payment.channel).toBe('string')
      expect(payment.amountAgorot).toEqual(expect.any(Number))
      expect(Number.isInteger(payment.amountAgorot)).toBe(true)
      expect(payment.recordedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }

    // The payer's name is a real value for this reader, not a placeholder —
    // and the key is present on every row, which is what distinguishes "no
    // name was recorded" from "this reader may not see names".
    expect(payments.every((payment) => 'payerName' in payment)).toBe(true)
    expect(
      payments.some((payment) => typeof payment.payerName === 'string'),
    ).toBe(true)
  })

  it('resolves the booking reference rather than printing an id', async () => {
    const payments = await listPayments(await argsFor('owner'))

    // Every payment in the dataset belongs to a booking that exists, so every
    // row must carry that booking's own reference.
    expect(payments.every((payment) => payment.bookingReference !== null)).toBe(
      true,
    )
  })

  it('withholds the payer from an accountant, who may see the money and not the guest', async () => {
    const actor = await actorFor('accountant')

    // The premise, stated rather than assumed: this is a role that reaches the
    // screen and does not hold the name.
    expect(holdsGrant(actor, 'payment.view')).toBe(true)
    expect(holdsGrant(actor, 'booking.view_price')).toBe(true)
    expect(holdsGrant(actor, 'guest.view_name')).toBe(false)

    const payments = await listPayments(await argsFor('accountant'))

    expect(payments).toHaveLength(seeded('payments'))
    for (const payment of payments) {
      // The key is *gone*, not null and not "אורח" — `redact` deletes it, and
      // the type says the field is optional for exactly this reason.
      expect('payerName' in payment).toBe(false)
      expect(payment.amountAgorot).toEqual(expect.any(Number))
    }
  })

  it('shows a cleaner nothing at all', async () => {
    const actor = await actorFor('housekeeping')

    // `requireGrant('payment.view')` redirects this person before a query is
    // built. This asserts the second floor: even handed the query, the per-row
    // `can()` narrowing admits none of it.
    expect(holdsGrant(actor, 'payment.view')).toBe(false)

    const payments = await listPayments(await argsFor('housekeeping'))
    expect(payments).toEqual([])
    expect(paymentTotals(payments)).toEqual({
      askedAgorot: 0,
      capturedAgorot: 0,
      refundedAgorot: 0,
    })
  })

  it('filters by status, and the filter reaches the query rather than the page', async () => {
    const base = await argsFor('owner')

    const failed = await listPayments({ ...base, filter: { status: 'failed' } })
    const paid = await listPayments({ ...base, filter: { status: 'paid' } })
    const all = await listPayments(base)

    expect(failed.length).toBeGreaterThan(0)
    expect(failed.every((payment) => payment.status === 'failed')).toBe(true)
    expect(paid.every((payment) => payment.status === 'paid')).toBe(true)
    expect(failed.length + paid.length).toBeLessThan(all.length)
  })

  it('accepts `unknown` as a status in its own right', async () => {
    const base = await argsFor('owner')

    // The dataset seeds no payment in `unknown` — its unresolved money is
    // `pending` carrying `requires_attention = 'reconcile_unknown'`. The
    // filter must still be able to ask for it, because the status is real in
    // the product and a screen that could not select it would hide exactly the
    // rows somebody is hunting for.
    const unknown = await listPayments({
      ...base,
      filter: { status: 'unknown' },
    })
    expect(unknown).toEqual([])
  })

  it('finds the money nobody can vouch for, and does not call it failed', async () => {
    const payments = await listPayments(await argsFor('owner'))
    const attention = paymentsNeedingAttention(payments)

    expect(attention.length).toBeGreaterThan(0)
    for (const payment of attention) {
      expect(payment.status).not.toBe('failed')
      expect(payment.requiresAttention).toBe('reconcile_unknown')
      expect(payment.unknownSince).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }

    // And the ones that genuinely failed are a different set.
    const failed = payments.filter((payment) => payment.status === 'failed')
    expect(failed.length).toBeGreaterThan(0)
    expect(
      failed.every((payment) => !attention.some((a) => a.id === payment.id)),
    ).toBe(true)
  })

  it('totals the rows on screen, and refuses to total what it may not see', async () => {
    const payments = await listPayments(await argsFor('owner'))
    const totals = paymentTotals(payments)

    expect(totals).not.toBeNull()
    // The sums are of the listed rows and nothing else, so they are checkable
    // against the rows themselves rather than against a stored figure.
    expect(totals?.askedAgorot).toBe(
      payments.reduce((sum, payment) => sum + (payment.amountAgorot ?? 0), 0),
    )
    expect(totals?.capturedAgorot).toBeLessThan(totals!.askedAgorot)
    expect(totals?.refundedAgorot).toBeGreaterThan(0)

    // A row whose amount was withheld makes the total unanswerable, and the
    // function says so instead of returning a smaller number.
    expect(paymentTotals([{ ...payments[0], amountAgorot: undefined }])).toBe(
      null,
    )
  })

  it('counts every payment for the empty-state decision, filter or no filter', async () => {
    expect(await countPayments(repository(), ORGANIZATION, null)).toBe(
      seeded('payments'),
    )
  })
})

/* ============================================================== invoices == */

describe('the invoices list', () => {
  it('serves the owner every invoice with its lines and its totals', async () => {
    const invoices = await listInvoices(await argsFor('owner'))

    expect(invoices).toHaveLength(seeded('invoices'))

    const lineCount = invoices.reduce(
      (sum, invoice) => sum + (invoice.lines?.length ?? 0),
      0,
    )
    expect(lineCount).toBe(seeded('invoice_lines'))

    for (const invoice of invoices) {
      expect(invoice.lines?.length).toBeGreaterThan(0)
      expect(Number.isInteger(invoice.totalAgorot)).toBe(true)
      // `invoices_total_is_sum`, the constraint, holding in the data that
      // reached the screen.
      expect(invoice.totalAgorot).toBe(
        (invoice.subtotalAgorot ?? 0) + (invoice.taxAgorot ?? 0),
      )
    }
  })

  it('adds the lines up in the query, and the sum agrees with the document', async () => {
    const invoices = await listInvoices(await argsFor('owner'))

    for (const invoice of invoices) {
      // `linesTotalAgorot` is `sumAgorot` over the lines, computed once in the
      // adapter so that no component adds anything up. The document's own total
      // is carried beside it rather than replaced by it — and on this dataset,
      // whose price lines are VAT-inclusive, the two agree.
      expect(invoice.linesTotalAgorot).toBe(invoice.totalAgorot)
    }
  })

  it('keeps a draft honest: no number, no issue date', async () => {
    const invoices = await listInvoices(await argsFor('owner'))
    const drafts = invoices.filter((invoice) => invoice.status === 'draft')

    expect(drafts.length).toBeGreaterThan(0)
    for (const draft of drafts) {
      // `invoices_issued_pair`. A draft that displayed a number would be
      // showing a tax document number that was never allocated.
      expect(draft.number).toBeNull()
      expect(draft.displayNumber).toBeNull()
      expect(draft.issuedOn).toBeNull()
    }

    const cancelled = invoices.filter(
      (invoice) => invoice.status === 'cancelled',
    )
    expect(cancelled.length).toBeGreaterThan(0)
    for (const invoice of cancelled) {
      // A cancelled document keeps its number — a gap reads to a tax authority
      // as a missing document rather than as a mistake somebody fixed.
      expect(invoice.displayNumber).not.toBeNull()
      expect(invoice.cancellationReason).not.toBeNull()
    }
  })

  it('reads the payment links out of invoice_payments, and only for issued documents', async () => {
    const invoices = await listInvoices(await argsFor('owner'))

    const links = invoices.reduce(
      (sum, invoice) => sum + invoice.linkedPaymentCount,
      0,
    )
    expect(links).toBe(seeded('invoice_payments'))

    for (const invoice of invoices) {
      if (invoice.status !== 'issued') {
        // A draft has settled nothing and a cancelled document settled
        // something that was then undone.
        expect(invoice.linkedPaymentCount).toBe(0)
      }
      // Resolved rather than counted: the owner may read payments, so every
      // link comes back as a payment with a status and a method.
      expect(invoice.payments).not.toBeNull()
      expect(invoice.payments).toHaveLength(invoice.linkedPaymentCount)
      for (const payment of invoice.payments ?? []) {
        expect(typeof payment.status).toBe('string')
        expect(Number.isInteger(payment.amountAgorot)).toBe(true)
      }
    }

    expect(invoices.some((invoice) => invoice.linkedPaymentCount > 0)).toBe(
      true,
    )
  })

  it('withholds the customer from an accountant and keeps the document readable', async () => {
    const invoices = await listInvoices(await argsFor('accountant'))

    expect(invoices).toHaveLength(seeded('invoices'))
    for (const invoice of invoices) {
      expect('customerName' in invoice).toBe(false)
      expect('customerTaxId' in invoice).toBe(false)
      // The document itself is not redacted away with the name: an accountant
      // reconciling invoices still has the number, the total and the lines.
      expect(invoice.totalAgorot).toEqual(expect.any(Number))
      expect(invoice.lines?.length).toBeGreaterThan(0)
    }
  })

  it('shows a cleaner nothing at all', async () => {
    const actor = await actorFor('housekeeping')
    expect(holdsGrant(actor, 'invoice.view')).toBe(false)
    expect(await listInvoices(await argsFor('housekeeping'))).toEqual([])
  })

  it('filters by document status', async () => {
    const base = await argsFor('owner')
    const issued = await listInvoices({ ...base, filter: { status: 'issued' } })

    expect(issued.length).toBeGreaterThan(0)
    expect(issued.every((invoice) => invoice.status === 'issued')).toBe(true)
    expect(issued.length).toBeLessThan(seeded('invoices'))
  })

  it('counts every invoice for the empty-state decision', async () => {
    expect(await countInvoices(repository(), ORGANIZATION, null)).toBe(
      seeded('invoices'),
    )
  })
})

/* =========================================================== commissions == */

describe('the commissions list', () => {
  it('serves the owner every commission with its state, payee and base', async () => {
    const commissions = await listCommissions(await argsFor('owner'))

    expect(commissions).toHaveLength(seeded('commissions'))

    for (const commission of commissions) {
      expect(typeof commission.status).toBe('string')
      expect(Number.isInteger(commission.amountAgorot)).toBe(true)
      expect(Number.isInteger(commission.basisAgorot)).toBe(true)
      expect(commission.basis).toBe('accommodation_only')
      // The rule is derived from the columns that reproduce the money, since
      // these rows carry no `metadata.rule`.
      expect(commission.rule.kind).toBe('percent')
      expect(commission.rule.value).toBe(10)
      expect(commission.rule.basis).toBe(commission.basis)
    }

    // The whole ladder is represented, which is the point of the screen.
    const statuses = new Set(commissions.map((entry) => entry.status))
    expect(statuses.size).toBeGreaterThan(1)
    expect([...statuses].every((status) => typeof status === 'string')).toBe(
      true,
    )
  })

  it('names the payee, and says which of the two answered', async () => {
    const commissions = await listCommissions(await argsFor('owner'))

    for (const commission of commissions) {
      // Every seeded row carries both, and `payeeKey` prefers the person — so
      // the person is the payee and the agency is the context beside them.
      expect(commission.payee.kind).toBe('agent')
      if (commission.payee.kind === 'agent') {
        expect(typeof commission.payee.name).toBe('string')
        expect(typeof commission.payee.agencyName).toBe('string')
      }
    }
  })

  it('recomputes nothing: the amount is the stored one', async () => {
    const commissions = await listCommissions(await argsFor('owner'))
    const total = commissionTotalAgorot(commissions)

    expect(total).toBe(
      commissions.reduce((sum, entry) => sum + entry.amountAgorot, 0),
    )
    // A cancelled commission is worth nothing and is stored that way; the
    // screen does not re-derive it from the base and the rate.
    const cancelled = commissions.filter(
      (entry) => entry.status === 'cancelled',
    )
    expect(cancelled.length).toBeGreaterThan(0)
    for (const entry of cancelled) {
      expect(entry.amountAgorot).toBe(0)
      expect(entry.basisAgorot).toBeGreaterThan(0)
    }
  })

  it('shows an external agent what they are owed and not what the stay earned', async () => {
    const actor = await actorFor('sales-agent')

    expect(holdsGrant(actor, 'commission.view')).toBe(true)
    expect(holdsGrant(actor, 'booking.view_price')).toBe(false)

    const commissions = await listCommissions(await argsFor('sales-agent'))
    expect(commissions.length).toBeGreaterThan(0)

    for (const commission of commissions) {
      // What they are owed, and at what rate. This is what `commission.view`
      // is the right to see.
      expect(Number.isInteger(commission.amountAgorot)).toBe(true)
      expect(commission.rateBps).toBe(1000)
      expect(commission.basis).toBe('accommodation_only')

      // The stay's revenue is not theirs to see — and neither is the
      // explanation, which spells the same figure out in a sentence.
      expect('basisAgorot' in commission).toBe(false)
      expect('explanation' in commission).toBe(false)
      expect(commission.rule.label).toBe('')
    }
  })

  it('never lets the base back in through the nested rule label', async () => {
    // The regression this file exists for. `commissions.explanation` reads
    // "10% מסך הלינות (4,500 ₪)" and `CommissionRule.label` is a copy of it one
    // level down, where `redact()` cannot reach. The base must not appear
    // anywhere in the serialised row a reader without `booking.view_price`
    // receives — not as a field, and not inside a sentence.
    const owner = await listCommissions(await argsFor('owner'))
    const agent = await listCommissions(await argsFor('sales-agent'))

    // The premise: the owner's copy really does spell the figure out.
    expect(owner.some((entry) => (entry.rule.label ?? '').includes('₪'))).toBe(
      true,
    )

    for (const entry of agent) {
      const serialised = JSON.stringify(entry)
      expect(serialised).not.toContain('מסך הלינות')
      expect(serialised).not.toContain('₪')
    }
  })

  it('confines the external agent to the property their membership reaches', async () => {
    const everything = await listCommissions(await argsFor('owner'))
    const agents = await listCommissions(await argsFor('sales-agent'))

    // Not a filter applied afterwards: `can()` with `family: 'finance'` is
    // asked per row, and the agent's scope is one property.
    expect(agents.length).toBeLessThan(everything.length)
    const reachable = new Set(agents.map((entry) => entry.propertyId))
    expect(reachable.size).toBe(1)
  })

  it('shows a cleaner nothing at all', async () => {
    const actor = await actorFor('housekeeping')
    expect(holdsGrant(actor, 'commission.view')).toBe(false)
    expect(await listCommissions(await argsFor('housekeeping'))).toEqual([])
  })

  it('filters by commission status', async () => {
    const base = await argsFor('owner')
    const paid = await listCommissions({ ...base, filter: { status: 'paid' } })

    expect(paid.length).toBeGreaterThan(0)
    expect(paid.every((entry) => entry.status === 'paid')).toBe(true)
    expect(paid.every((entry) => entry.paidOn !== null)).toBe(true)
  })

  it('counts every commission for the empty-state decision', async () => {
    expect(await countCommissions(repository(), ORGANIZATION, null)).toBe(
      seeded('commissions'),
    )
  })
})

/* ============================================================== expenses == */

describe('the expenses list', () => {
  it('serves the owner every rule with the shares recorded under it', async () => {
    const rules = await listExpenseRules(await expenseArgsFor('owner'))

    expect(rules).toHaveLength(seeded('expense_rules'))
    expect(rules).toHaveLength(6)

    for (const rule of rules) {
      expect(typeof rule.label).toBe('string')
      expect(typeof rule.category).toBe('string')
      expect(['fixed', 'variable']).toContain(rule.kind)
      expect(Number.isInteger(rule.amountAgorot)).toBe(true)
      expect(rule.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      // `expense_rules_formula_pair` in the data that reached the screen: a
      // variable rule is one that is computed, and a fixed one is not.
      expect(rule.formula !== null).toBe(rule.kind === 'variable')
    }

    // All eight allocations land on the one rule that carries them, which is
    // `per_booking` cleaning — and the shares are read, not derived.
    const allocated = rules.reduce(
      (sum, rule) => sum + (rule.allocationCount ?? 0),
      0,
    )
    expect(allocated).toBe(seeded('expense_allocations'))
    expect(allocated).toBe(8)
  })

  it('reads the variable formula out of jsonb, in the units the domain declares', async () => {
    const rules = await listExpenseRules(await expenseArgsFor('owner'))
    const percent = rules.find(
      (rule) => rule.formula?.kind === 'percent_of_revenue',
    )

    expect(percent).toBeDefined()
    if (percent?.formula?.kind === 'percent_of_revenue') {
      // Stored as 145 basis points, read as 1.45 percentage points — the unit
      // `VariableFormula` declares. Reading it as 145 would price every
      // clearing fee a hundred times too high.
      expect(percent.formula.percent).toBeCloseTo(1.45, 10)
    }
    // A variable rule carries no periodic amount. Rendering one would put ₪0
    // beside a rule that costs money on every stay.
    expect(percent?.amountAgorot).toBe(0)
  })

  it('sums the shares with the domain sum, and never adds fixed to variable', async () => {
    const rules = await listExpenseRules(await expenseArgsFor('owner'))
    const totals = expenseTotals(rules)

    expect(totals.fixedAgorot).toBe(
      rules
        .filter((rule) => rule.kind === 'fixed')
        .reduce((sum, rule) => sum + rule.amountAgorot, 0),
    )
    expect(totals.variableCount).toBe(
      rules.filter((rule) => rule.kind === 'variable').length,
    )
    expect(totals.allocatedAgorot).toBe(
      rules.reduce((sum, rule) => sum + (rule.allocatedAgorot ?? 0), 0),
    )
    expect(totals.allocatedAgorot).toBeGreaterThan(0)
  })

  it('withholds the per-booking shares from a general manager, and keeps the rule readable', async () => {
    const actor = await actorFor('general-manager')

    // The premise, stated rather than assumed. A GM runs the property and may
    // see what the business spends; what each *stay* carried is booking
    // profitability and belongs to finance.
    expect(holdsGrant(actor, 'expense.view')).toBe(true)
    expect(holdsGrant(actor, 'booking.view_profitability')).toBe(false)

    const rules = await listExpenseRules(
      await expenseArgsFor('general-manager'),
    )
    expect(rules.length).toBeGreaterThan(0)

    for (const rule of rules) {
      // The keys are gone, not zero. An empty allocation list reads as "no
      // stay has carried this cost", which is a different and false statement.
      expect('allocations' in rule).toBe(false)
      expect('allocatedAgorot' in rule).toBe(false)
      expect('allocationCount' in rule).toBe(false)

      // The rule itself is not redacted away with them: what the business
      // spends on laundry is exactly what `expense.view` is the right to see.
      expect(Number.isInteger(rule.amountAgorot)).toBe(true)
      expect(typeof rule.label).toBe('string')
    }

    // And the total says so rather than reporting a smaller figure.
    expect(expenseTotals(rules).allocatedAgorot).toBeNull()
  })

  it('never lets a booking id back in through the nested allocation array', async () => {
    // The same nested-redaction trap the commission rule label is. The array
    // carries an amount and a booking reference per stay, one level below where
    // `redact()` can reach, so it must never be built.
    const rules = await listExpenseRules(
      await expenseArgsFor('general-manager'),
    )
    for (const rule of rules) {
      expect(JSON.stringify(rule)).not.toContain('allocations')
    }
  })

  it('shows an accountant the rules and not the per-stay shares', async () => {
    const actor = await actorFor('accountant')
    expect(holdsGrant(actor, 'expense.view')).toBe(true)
    expect(holdsGrant(actor, 'booking.view_profitability')).toBe(false)

    const rules = await listExpenseRules(await expenseArgsFor('accountant'))
    expect(rules).toHaveLength(seeded('expense_rules'))
    expect(rules.every((rule) => !('allocations' in rule))).toBe(true)
  })

  it('shows a cleaner nothing at all', async () => {
    const actor = await actorFor('housekeeping')
    expect(holdsGrant(actor, 'expense.view')).toBe(false)
    expect(
      await listExpenseRules(await expenseArgsFor('housekeeping')),
    ).toEqual([])
  })

  it('filters by kind, and the filter reaches the query', async () => {
    const base = await expenseArgsFor('owner')

    const fixed = await listExpenseRules({
      ...base,
      filter: { status: 'fixed' },
    })
    const variable = await listExpenseRules({
      ...base,
      filter: { status: 'variable' },
    })

    expect(fixed.length).toBeGreaterThan(0)
    expect(variable.length).toBeGreaterThan(0)
    expect(fixed.every((rule) => rule.kind === 'fixed')).toBe(true)
    expect(variable.every((rule) => rule.kind === 'variable')).toBe(true)
    expect(fixed.length + variable.length).toBe(seeded('expense_rules'))
  })

  it('keeps the organization-wide rules when one property is selected', async () => {
    const base = await expenseArgsFor('owner')
    const everything = await listExpenseRules(base)

    const propertyId = everything.find(
      (rule) => rule.scopePropertyId !== null,
    )?.scopePropertyId
    expect(propertyId).toBeDefined()

    const narrowed = await listExpenseRules({
      ...base,
      propertyId: propertyId ?? null,
    })

    // A rule that applies to the whole organization applies to this property
    // too. Dropping them would tell somebody looking at one property that the
    // business has no cleaning cost.
    expect(narrowed.length).toBeGreaterThan(0)
    expect(narrowed.length).toBeLessThan(everything.length)
    expect(
      narrowed.every(
        (rule) =>
          rule.scopePropertyId === null || rule.scopePropertyId === propertyId,
      ),
    ).toBe(true)
    expect(narrowed.some((rule) => rule.scopePropertyId === null)).toBe(true)
    expect(narrowed.some((rule) => rule.scopePropertyId === propertyId)).toBe(
      true,
    )
  })

  it('counts every live rule for the empty-state decision', async () => {
    expect(await countExpenseRules(repository(), ORGANIZATION)).toBe(
      seeded('expense_rules'),
    )
  })
})

/* ======================================================== reconciliation == */

describe('the reconciliation worklist', () => {
  async function rowsFor(personaId: string) {
    const db = client()
    const actor = await actorFor(personaId)
    const payments = await listPayments({
      repo: repository(db),
      actor,
      organizationId: ORGANIZATION,
      propertyId: null,
      filter: ALL,
    })
    return {
      payments,
      rows: await reconcilePayments({
        db,
        actor,
        organizationId: ORGANIZATION,
        payments,
      }),
    }
  }

  it('groups every payment onto the booking it belongs to', async () => {
    const { payments, rows } = await rowsFor('owner')

    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(payments.length)
    expect(rows.reduce((sum, row) => sum + row.paymentCount, 0)).toBe(
      payments.length,
    )
    // One row per booking, never two.
    expect(new Set(rows.map((row) => row.bookingId)).size).toBe(rows.length)
  })

  it('leads with the money nobody can vouch for, and does not call it a difference', async () => {
    const { rows } = await rowsFor('owner')
    const unresolved = rows.filter((row) => row.outcome === 'unresolved')

    expect(unresolved.length).toBeGreaterThan(0)
    // Worst first: every unresolved row sorts above every other row.
    const lastUnresolved = rows.findLastIndex(
      (row) => row.outcome === 'unresolved',
    )
    expect(lastUnresolved).toBe(unresolved.length - 1)

    for (const row of unresolved) {
      expect(row.unresolvedCount).toBeGreaterThan(0)
      expect(row.unresolvedAgorot).toBeGreaterThan(0)
      // Not counted as arrived. A payment the processor never answered about
      // may or may not have been taken, and folding it into either column is a
      // claim nobody can make.
      expect(row.receivedAgorot).toBeLessThan(row.expectedAgorot ?? 0)
    }
  })

  it('matches a stay that was paid in full, to the agora', async () => {
    const { rows } = await rowsFor('owner')
    const matched = rows.filter((row) => row.outcome === 'matched')

    expect(matched.length).toBeGreaterThan(0)
    for (const row of matched) {
      expect(row.differenceAgorot).toBe(0)
      expect(row.unresolvedCount).toBe(0)
      expect(row.receivedAgorot).toBe(row.expectedAgorot)
    }
  })

  it('finds the stays that are short, and says by how much', async () => {
    const { rows } = await rowsFor('owner')
    const differing = rows.filter((row) => row.outcome === 'difference')

    expect(differing.length).toBeGreaterThan(0)
    for (const row of differing) {
      expect(row.differenceAgorot).not.toBe(0)
      expect(row.differenceAgorot).toBe(
        (row.expectedAgorot ?? 0) - row.receivedAgorot,
      )
      expect(row.unresolvedCount).toBe(0)
    }
  })

  it('totals what was expected, what arrived, and what is stuck — separately', async () => {
    const { rows } = await rowsFor('owner')
    const totals = reconciliationTotals(rows)

    expect(totals.expectedAgorot).toBe(
      rows.reduce((sum, row) => sum + (row.expectedAgorot ?? 0), 0),
    )
    expect(totals.receivedAgorot).toBe(
      rows.reduce((sum, row) => sum + row.receivedAgorot, 0),
    )
    expect(totals.differenceAgorot).toBe(
      (totals.expectedAgorot ?? 0) - totals.receivedAgorot,
    )
    // The three are genuinely different figures on this dataset, which is what
    // makes the screen worth opening.
    expect(totals.unresolvedAgorot).toBeGreaterThan(0)
    expect(totals.differenceAgorot).toBeGreaterThan(0)
    expect(totals.receivedAgorot).toBeLessThan(totals.expectedAgorot ?? 0)
  })

  it('shows a cleaner nothing at all', async () => {
    const { rows } = await rowsFor('housekeeping')
    expect(rows).toEqual([])
    expect(reconciliationTotals(rows)).toEqual({
      expectedAgorot: 0,
      receivedAgorot: 0,
      unresolvedAgorot: 0,
      differenceAgorot: 0,
    })
  })

  it('serves an accountant the same worklist, without the guest names', async () => {
    const { rows, payments } = await rowsFor('accountant')

    expect(rows.length).toBeGreaterThan(0)
    expect(payments.every((payment) => !('payerName' in payment))).toBe(true)
    // The expectation is a price and the accountant holds `booking.view_price`,
    // so it is a number rather than the withheld null.
    expect(rows.every((row) => row.expectedAgorot !== null)).toBe(true)
  })
})

/* ================================================================ owners == */

describe('the owners screen', () => {
  it('is a plan lock for every persona the demo offers', async () => {
    // `management` is the only seed plan carrying `owner_portal`, and
    // `DEMO_PLANS` deliberately does not offer it. So even the organization's
    // owner — who holds every grant in the catalogue — does not *hold*
    // `owner.view`, because `holdsGrant` asks the plan as well.
    for (const personaId of ['owner', 'accountant', 'general-manager']) {
      const actor = await actorFor(personaId)
      expect(actor.entitlements.has('owner_portal')).toBe(false)
      expect(holdsGrant(actor, 'owner.view')).toBe(false)
      expect(holdsGrant(actor, 'owner_statement.view')).toBe(false)

      expect(
        await listOwners({ db: client(), actor, organizationId: ORGANIZATION }),
      ).toEqual([])
    }
  })

  it('distinguishes the plan refusal from the permission one', async () => {
    const { authorize } = await import('@/lib/authz/can')

    const owner = await actorFor('owner')
    const cleaner = await actorFor('housekeeping')
    const resource = {
      organizationId: ORGANIZATION,
      family: 'finance',
    } as const

    // The whole reason the screen asks `authorize` rather than `requireGrant`
    // for this half: the two noes are different sentences to the person
    // reading, and only one of them can be fixed by an administrator.
    expect(authorize(owner, 'owner_statement.view', resource)).toMatchObject({
      allowed: false,
      reason: 'plan_does_not_include',
      entitlement: 'owner_portal',
    })
    expect(authorize(cleaner, 'owner_statement.view', resource)).toMatchObject({
      allowed: false,
      reason: 'missing_permission',
    })
  })

  it('reads real memberships once the package includes the portal', async () => {
    // The entitled half, on the package that sells it. The demo seeds no
    // membership holding `property_owner`, so the honest answer is an empty
    // list — and it is an empty list rather than a throw, which is what proves
    // the four reads behind it are wired.
    const actor = await actorFor('owner', catalogPlan('management'))

    expect(actor.entitlements.has('owner_portal')).toBe(true)
    expect(holdsGrant(actor, 'owner_statement.view')).toBe(true)

    const owners = await listOwners({
      db: client(),
      actor,
      organizationId: ORGANIZATION,
    })
    expect(owners).toEqual([])
  })

  it('refuses the cleaner even on the package that sells the portal', async () => {
    const actor = await actorFor('housekeeping', catalogPlan('management'))

    expect(actor.entitlements.has('owner_portal')).toBe(true)
    expect(holdsGrant(actor, 'owner_statement.view')).toBe(false)

    expect(
      await listOwners({ db: client(), actor, organizationId: ORGANIZATION }),
    ).toEqual([])
  })
})
