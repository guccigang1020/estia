/**
 * The finance mapping, against a recording client.
 *
 * These tests cannot prove a column name is right — the fake answers with
 * whatever the test seeded, so a misspelling is misspelled consistently. What
 * they can prove is the part where a careful reader would still get it wrong:
 * the optimistic-lock predicate that runs one behind, the columns a trigger
 * owns and this adapter must therefore never send, and the refusals.
 */

import { describe, expect, it } from 'vitest'

import { FakeSupabaseClient, hasFilter } from './fake-client'
import { SupabaseFinanceRepository } from './finance'
import type { Commission, Invoice, Payment } from '../finance/types'

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay-1',
    organizationId: 'org-a',
    propertyId: 'prop-a',
    bookingId: 'book-1',
    purpose: 'balance',
    method: 'card',
    channel: 'payment_link',
    status: 'paid',
    currency: 'ILS',
    amountAgorot: 150_000,
    authorizedAgorot: 150_000,
    capturedAgorot: 150_000,
    refundedAgorot: 0,
    providerId: 'stripe',
    providerRef: 'pi_1',
    scheduleId: null,
    instalmentNumber: null,
    dueOn: null,
    appliedEventIds: [],
    lastProviderEventAt: null,
    requiresAttention: null,
    unknownSince: null,
    createdAt: new Date('2026-01-01T10:00:00.000Z'),
    updatedAt: new Date('2026-01-01T10:00:00.000Z'),
    createdByUserId: 'user-a',
    version: 5,
    ...overrides,
  } as Payment
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    organizationId: 'org-a',
    propertyId: 'prop-a',
    bookingId: 'book-1',
    kind: 'tax_invoice',
    status: 'issued',
    series: 'A',
    year: 2026,
    number: 184,
    displayNumber: '2026-000184',
    customerName: 'דנה כהן',
    customerTaxId: null,
    lines: [],
    subtotalAgorot: 127_119,
    taxAgorot: 22_881,
    totalAgorot: 150_000,
    taxRateBps: 1800,
    touristVatExempt: false,
    currency: 'ILS',
    issuedAt: new Date('2026-01-01T10:00:00.000Z'),
    cancelledAt: null,
    cancellationReason: null,
    archivedAt: null,
    paymentIds: [],
    snapshotCapturedAt: '2026-01-01T09:00:00.000Z',
    ...overrides,
  } as Invoice
}

const INVOICE_ROW = {
  id: 'inv-1',
  organization_id: 'org-a',
  property_id: 'prop-a',
  booking_id: 'book-1',
  kind: 'tax_invoice',
  status: 'issued',
  series: 'A',
  year: 2026,
  number: 184,
  display_number: '2026-000184',
  customer_name: 'דנה כהן',
  customer_tax_id: null,
  subtotal_agorot: 127_119,
  tax_agorot: 22_881,
  total_agorot: 150_000,
  tax_rate_bps: 1800,
  tourist_vat_exempt: false,
  currency: 'ILS',
  issued_at: '2026-01-01T10:00:00+00:00',
  cancelled_at: null,
  cancellation_reason: null,
  archived_at: null,
  snapshot_captured_at: '2026-01-01T09:00:00+00:00',
  metadata: {},
  invoice_lines: [],
  invoice_payments: [],
}

function commission(overrides: Partial<Commission> = {}): Commission {
  return {
    id: 'com-1',
    organizationId: 'org-a',
    propertyId: 'prop-a',
    bookingId: 'book-1',
    agentUserId: 'agent-1',
    agencyId: null,
    status: 'eligible',
    basisAgorot: 950_000,
    rateBps: 1000,
    amountAgorot: 95_000,
    rule: {
      basis: 'stay_total',
      kind: 'percent',
      value: 10,
      label: 'עשרה אחוזים',
    },
    statementId: null,
    payoutBatchId: null,
    becameEligibleAt: new Date('2026-01-05T10:00:00.000Z'),
    approvedByUserId: null,
    paidAt: null,
    cancelledReason: null,
    clawbackRequired: false,
    createdAt: new Date('2026-01-01T10:00:00.000Z'),
    version: 3,
    ...overrides,
  } as Commission
}

const COMMISSION_ROW = {
  id: 'com-1',
  organization_id: 'org-a',
  property_id: 'prop-a',
  booking_id: 'book-1',
  agent_user_id: 'agent-1',
  agency_id: null,
  status: 'eligible',
  base: 'stay_total',
  basis_agorot: 950_000,
  rate_bps: 1000,
  amount_agorot: 95_000,
  explanation: 'עשרה אחוזים',
  statement_id: null,
  payout_batch_id: null,
  eligible_at: '2026-01-05T10:00:00+00:00',
  approved_by: null,
  paid_at: null,
  cancellation_reason: null,
  clawback_required: false,
  metadata: {
    rule: {
      basis: 'stay_total',
      kind: 'percent',
      value: 10,
      label: 'עשרה אחוזים',
    },
  },
  created_at: '2026-01-01T10:00:00+00:00',
  version: 3,
}

const PAYMENT_ROW = {
  id: 'pay-1',
  organization_id: 'org-a',
  property_id: 'prop-a',
  booking_id: 'book-1',
  purpose: 'balance',
  method: 'card',
  channel: 'payment_link',
  status: 'paid',
  currency: 'ILS',
  amount_agorot: 150_000,
  authorized_agorot: 150_000,
  captured_agorot: 150_000,
  amount_refunded_agorot: 0,
  provider: 'stripe',
  provider_payment_id: 'pi_1',
  schedule_id: null,
  instalment_number: null,
  due_on: null,
  last_provider_event_at: null,
  requires_attention: null,
  unknown_since: null,
  created_at: '2026-01-01T10:00:00+00:00',
  updated_at: '2026-01-01T10:00:00+00:00',
  created_by: 'user-a',
  version: 5,
}

describe('SupabaseFinanceRepository: payments', () => {
  it('locks on `version - 1`, because the domain already incremented it', async () => {
    // The trap the module header is about. `payments.ts` returns
    // `version: payment.version + 1` before the record reaches this layer, so
    // the stored row is still one behind. `= payment.version` would conflict
    // on every single update; the mistake in the other direction — no
    // predicate — would never conflict at all, and that one is silent.
    const client = new FakeSupabaseClient({
      responses: { payments: { data: [PAYMENT_ROW] } },
    })

    await new SupabaseFinanceRepository(client.asDb()).updatePayment(
      payment({ version: 5 }),
    )

    const update = client.queriesFor('payments')[0]
    expect(hasFilter(update, 'eq', 'version', 4)).toBe(true)
    expect(hasFilter(update, 'eq', 'version', 5)).toBe(false)
  })

  it('scopes every write by organization as well as by id', async () => {
    const client = new FakeSupabaseClient({
      responses: { payments: { data: [PAYMENT_ROW] } },
    })

    await new SupabaseFinanceRepository(client.asDb()).updatePayment(payment())

    const update = client.queriesFor('payments')[0]
    // RLS is the real floor. This is the second one, and it is what stops a
    // leak the moment somebody hands this adapter the admin client.
    expect(hasFilter(update, 'eq', 'organization_id', 'org-a')).toBe(true)
  })

  it('never sends the columns a trigger owns', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        // `.single()` on the insert's returning clause, so one object.
        'payments:insert': { data: PAYMENT_ROW },
        payment_provider_events: { data: [] },
      },
    })

    await new SupabaseFinanceRepository(client.asDb()).insertPayment(payment())

    const insert = client.queriesFor('payments')[0]
    const sent = insert.payload as Record<string, unknown>

    // `refunds_recalc_payment` recomputes this from the settled refunds. A
    // caller that also wrote it would be overwritten on the next refund
    // change — silently, and correctly.
    expect(sent).not.toHaveProperty('amount_refunded_agorot')
    // `tg_touch_row` owns this one.
    expect(sent).not.toHaveProperty('version')
  })

  it('raises a conflict rather than reporting a silent no-op', async () => {
    // Zero rows means somebody wrote first, or the row is invisible to this
    // caller. Both mean the update did not happen, and reporting success
    // would be a lost update.
    const client = new FakeSupabaseClient({
      responses: { payments: [{ data: [] }, { data: null }] },
    })

    await expect(
      new SupabaseFinanceRepository(client.asDb()).updatePayment(payment()),
    ).rejects.toMatchObject({ code: 'version_conflict' })
  })

  it('reads applied event ids from payment_provider_events, not from a column', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        payments: { data: PAYMENT_ROW },
        payment_provider_events: {
          data: [
            { payment_id: 'pay-1', event_id: 'evt_applied', applied_at: 'x' },
            // Recorded but not applied. An event that arrived, was found
            // stale and was filed is evidence — treating it as applied would
            // make the next genuine delivery look like a redelivery.
            { payment_id: 'pay-1', event_id: 'evt_stale', applied_at: null },
          ],
        },
      },
    })

    const loaded = await new SupabaseFinanceRepository(
      client.asDb(),
    ).loadPayment('org-a', 'pay-1')

    expect(loaded?.appliedEventIds).toEqual(['evt_applied'])
  })
})

describe('SupabaseFinanceRepository: invoice numbering', () => {
  it('calls next_invoice_number() and never reads-then-writes', async () => {
    // The counter row lock inside the function is the serialisation. "Read
    // the highest, add one" is the double-booking race in different clothes,
    // and two tax invoices sharing a number is not fixable afterwards.
    const client = new FakeSupabaseClient({
      responses: { 'rpc:next_invoice_number': { data: 184 } },
    })

    const number = await new SupabaseFinanceRepository(
      client.asDb(),
    ).allocateInvoiceNumber('org-a', 'A', 2026)

    expect(number).toBe(184)
    expect(client.queriesFor('rpc:next_invoice_number')[0].payload).toEqual({
      target_organization_id: 'org-a',
      target_series: 'A',
      target_year: 2026,
    })
    // No select against invoices to find the highest number.
    expect(client.queriesFor('invoices')).toHaveLength(0)
  })
})

describe('SupabaseFinanceRepository: snapshots', () => {
  it('reads the newest capture, and does not delete the superseded ones', async () => {
    const client = new FakeSupabaseClient({
      responses: { finance_snapshots: { data: [] } },
    })

    await new SupabaseFinanceRepository(client.asDb()).loadSnapshot(
      'org-a',
      'book-1',
    )

    const read = client.queriesFor('finance_snapshots')[0]
    expect(read.filters).toContainEqual({
      op: 'order',
      column: 'captured_at',
      value: { ascending: false },
    })
    expect(hasFilter(read, 'limit', 'limit', 1)).toBe(true)
  })
})

describe('SupabaseFinanceRepository: which payments settled an invoice', () => {
  it('reads the join table and never metadata.payment_ids', async () => {
    // 0022 replaced the array. Reading both would give two answers to "which
    // payments settled this", and a stale copy in `metadata` would resurrect
    // a link somebody deliberately removed.
    const client = new FakeSupabaseClient({
      responses: {
        invoices: {
          data: [
            {
              ...INVOICE_ROW,
              metadata: { payment_ids: ['pay-ghost'] },
              invoice_payments: [{ payment_id: 'pay-1' }],
            },
          ],
        },
      },
    })

    const [loaded] = await new SupabaseFinanceRepository(
      client.asDb(),
    ).loadInvoicesForBooking('org-a', 'book-1')

    expect(loaded.paymentIds).toEqual(['pay-1'])
    expect(client.queriesFor('invoices')[0].columns).toContain(
      'invoice_payments(payment_id)',
    )
  })

  it('writes the links as rows and stops writing the array', async () => {
    // The row carries `booking_id` because both composite foreign keys are
    // checked against it: an invoice for one stay cannot be settled by a
    // payment against another, which an array of ids could never check.
    const client = new FakeSupabaseClient({
      responses: {
        invoices: { data: INVOICE_ROW },
        invoice_payments: { data: null },
      },
    })

    await new SupabaseFinanceRepository(client.asDb()).insertInvoice(
      invoice({ paymentIds: ['pay-1', 'pay-2'] }),
    )

    const write = client.queriesFor('invoices')[0]
    expect(write.payload).not.toHaveProperty('metadata')

    const links = client.queriesFor('invoice_payments')[0]
    expect(links.verb).toBe('insert')
    expect(links.payload).toEqual([
      {
        invoice_id: 'inv-1',
        payment_id: 'pay-1',
        organization_id: 'org-a',
        booking_id: 'book-1',
      },
      {
        invoice_id: 'inv-1',
        payment_id: 'pay-2',
        organization_id: 'org-a',
        booking_id: 'book-1',
      },
    ])
  })

  it('reconciles by difference on update, because there is no UPDATE to make', async () => {
    // `invoice_payments` has neither an UPDATE grant nor an UPDATE policy: the
    // row is its key. Clearing every link to rewrite an unchanged one would
    // read as a reallocation in anything watching the table, and would briefly
    // leave an issued invoice accounting for nothing.
    const client = new FakeSupabaseClient({
      responses: {
        invoices: {
          data: [
            {
              ...INVOICE_ROW,
              invoice_payments: [
                { payment_id: 'pay-1' },
                { payment_id: 'pay-old' },
              ],
            },
          ],
        },
        invoice_payments: { data: null },
      },
    })

    await new SupabaseFinanceRepository(client.asDb()).updateInvoice(
      invoice({ paymentIds: ['pay-1', 'pay-2'] }),
    )

    const [removed, added] = client.queriesFor('invoice_payments')
    expect(removed.verb).toBe('delete')
    expect(removed.filters.find((f) => f.op === 'in')?.value).toEqual([
      'pay-old',
    ])
    // `pay-1` was already linked and is left alone.
    expect(added.payload).toEqual([
      {
        invoice_id: 'inv-1',
        payment_id: 'pay-2',
        organization_id: 'org-a',
        booking_id: 'book-1',
      },
    ])
  })

  it('touches the join table not at all when the set did not change', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        invoices: {
          data: [
            { ...INVOICE_ROW, invoice_payments: [{ payment_id: 'pay-1' }] },
          ],
        },
      },
    })

    await new SupabaseFinanceRepository(client.asDb()).updateInvoice(
      invoice({ paymentIds: ['pay-1'] }),
    )

    expect(client.queriesFor('invoice_payments')).toHaveLength(0)
  })
})

describe('SupabaseFinanceRepository: commissions', () => {
  it('reads every commission on the booking, cancelled ones included', async () => {
    // A cancelled commission is part of what the booking explains. Filtering
    // here would make an agent's total silently disagree with the bookings it
    // was computed from.
    const client = new FakeSupabaseClient({
      responses: { commissions: { data: [COMMISSION_ROW] } },
    })

    const [loaded] = await new SupabaseFinanceRepository(
      client.asDb(),
    ).loadCommissionsForBooking('org-a', 'book-1')

    expect(loaded).toMatchObject({
      id: 'com-1',
      status: 'eligible',
      rule: {
        basis: 'stay_total',
        kind: 'percent',
        value: 10,
        label: 'עשרה אחוזים',
      },
      clawbackRequired: false,
    })

    const read = client.queriesFor('commissions')[0]
    expect(hasFilter(read, 'eq', 'status')).toBe(false)
  })

  it('derives the rule from the money columns when metadata has none', async () => {
    // Not invented: `base`, `rate_bps` and `amount_agorot` are what reproduce
    // the figure, so a rule derived from them agrees with the amount beside
    // it by construction.
    const client = new FakeSupabaseClient({
      responses: {
        commissions: {
          data: [{ ...COMMISSION_ROW, metadata: {}, rate_bps: null }],
        },
      },
    })

    const [loaded] = await new SupabaseFinanceRepository(
      client.asDb(),
    ).loadCommissionsForBooking('org-a', 'book-1')

    expect(loaded.rule).toEqual({
      basis: 'stay_total',
      kind: 'fixed',
      value: 95_000,
      label: 'עשרה אחוזים',
    })
  })

  it('takes the basis from the enum column and not from the stored blob', async () => {
    // The column is the constrained one. A `basis` in jsonb that disagreed
    // with it would be exactly the drift 0018 has just finished removing.
    const client = new FakeSupabaseClient({
      responses: {
        commissions: {
          data: [
            {
              ...COMMISSION_ROW,
              base: 'gross_revenue',
              metadata: {
                rule: {
                  basis: 'net_revenue',
                  kind: 'percent',
                  value: 10,
                  label: 'ל',
                },
              },
            },
          ],
        },
      },
    })

    const [loaded] = await new SupabaseFinanceRepository(
      client.asDb(),
    ).loadCommissionsForBooking('org-a', 'book-1')

    expect(loaded.rule.basis).toBe('gross_revenue')
  })

  it('locks one version behind, because the domain pre-increments', async () => {
    // `commissions.ts` returns `version + 1` before the record reaches this
    // file and `tg_touch_row` increments the stored value again. Locking on
    // `commission.version` would never conflict — which is the silent failure.
    const client = new FakeSupabaseClient({
      responses: { commissions: { data: [COMMISSION_ROW] } },
    })

    await new SupabaseFinanceRepository(client.asDb()).updateCommission(
      commission({ version: 8 }),
    )

    const write = client.queriesFor('commissions')[0]
    expect(hasFilter(write, 'eq', 'version', 7)).toBe(true)
    expect(write.payload).not.toHaveProperty('version')
  })

  it('conflicts rather than reporting a save that matched nothing', async () => {
    const client = new FakeSupabaseClient({
      responses: { commissions: { data: [] } },
    })

    await expect(
      new SupabaseFinanceRepository(client.asDb()).updateCommission(
        commission({ version: 8 }),
      ),
    ).rejects.toMatchObject({ code: 'version_conflict' })
  })

  it('refuses a stored base the domain has no meaning for', async () => {
    // The read-side guard 0018 leaves in place, on the record that decides
    // what a person is paid.
    const client = new FakeSupabaseClient({
      responses: {
        commissions: { data: [{ ...COMMISSION_ROW, base: 'whole_booking' }] },
      },
    })

    await expect(
      new SupabaseFinanceRepository(client.asDb()).loadCommissionsForBooking(
        'org-a',
        'book-1',
      ),
    ).rejects.toThrow(/base/)
  })
})
