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
import { SchemaNotProvisionedError } from './errors'
import type { Payment } from '../finance/types'

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

describe('SupabaseFinanceRepository: what it refuses', () => {
  it('will not read a commission through a two-member enum', async () => {
    // `public.commission_base` has `whole_booking` and `accommodation_only`.
    // The unified COMMISSION_BASES has six and no `whole_booking`. Returning
    // an empty array instead would be indistinguishable from an agent who
    // earned nothing.
    const repository = new SupabaseFinanceRepository(
      new FakeSupabaseClient().asDb(),
    )

    await expect(repository.loadCommissionsForBooking()).rejects.toBeInstanceOf(
      SchemaNotProvisionedError,
    )
    await expect(repository.updateCommission()).rejects.toBeInstanceOf(
      SchemaNotProvisionedError,
    )
  })

  it('names the migration in the message rather than saying "not supported"', async () => {
    const repository = new SupabaseFinanceRepository(
      new FakeSupabaseClient().asDb(),
    )
    const failure = await caught(repository.loadCommissionsForBooking())

    expect(failure.message).toContain('commission_base')
    expect(failure.message).toContain('stay_total')
  })
})

/**
 * The error a promise rejected with.
 *
 * A plain `.catch(e => e)` types as `T | unknown` and every assertion after it
 * needs a cast; this says once that the promise is expected to reject, and
 * fails the test with a useful sentence when it does not.
 */
async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('Expected the call to reject, and it resolved.')
}
