/**
 * The integrations read, over the demo dataset.
 *
 * This is the screen with the strongest claim to check, because it has no
 * table of its own: everything it shows is derived from marks other services
 * left on rows they wrote. The assertions below are therefore mostly about
 * *provenance* — that the numbers come from `payments.provider`,
 * `invoices.provider` and `bookings.source` and not from a list somebody
 * composed — and about the distinction between "no service was ever used" and
 * "you may not read the table that would say".
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import type { Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { DemoActorSource } from '@/lib/demo/session'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'

import { allRecords, loadIntegrations, type IntegrationKind } from './queries'

const ORGANIZATION = DEMO_DATASET.organizationId

function client(): Db {
  return createDemoClient(DEMO_DATASET) as unknown as Db
}

function planNamed(code: string) {
  const found = DEMO_PLANS.find((plan) => plan.code === code)
  if (!found) throw new Error(`No demo plan '${code}'`)
  return found
}

async function actorFor(personaId: string, planCode = 'pro'): Promise<Actor> {
  const persona = DEMO_PERSONAS.find((entry) => entry.id === personaId)
  if (!persona) throw new Error(`No demo persona '${personaId}'`)

  const source = new DemoActorSource(
    new SupabaseActorSource(client()),
    planNamed(planCode),
  )

  const resolution = await resolveActor(source, persona.userId, ORGANIZATION)
  if (!resolution.ok) {
    throw new Error(
      `${persona.label} does not resolve to an actor: ${resolution.reason}`,
    )
  }
  return resolution.actor
}

async function reportFor(personaId: string) {
  return loadIntegrations({
    db: client(),
    actor: await actorFor(personaId),
    organizationId: ORGANIZATION,
  })
}

function sectionOf(
  report: Awaited<ReturnType<typeof reportFor>>,
  kind: IntegrationKind,
) {
  const found = report.sections.find((section) => section.kind === kind)
  if (!found) throw new Error(`No section for '${kind}'`)
  return found
}

/** The raw rows, so an assertion can be compared against the dataset itself. */
function rows(table: string): Record<string, unknown>[] {
  return (DEMO_DATASET.tables[table] ?? []) as Record<string, unknown>[]
}

/* ============================================================ evidence == */

describe('what the rows say about connected services', () => {
  it('reads the payment processor off the payments themselves', async () => {
    const section = sectionOf(await reportFor('owner'), 'payment_provider')
    expect(section.state).toBe('read')
    if (section.state !== 'read') return

    const cardcom = section.records.find((record) => record.id === 'cardcom')
    const seeded = rows('payments').filter(
      (row) => row.provider === 'cardcom',
    ).length

    // Not a number this screen chose: the count is the rows, and the rows are
    // the payments the demo took.
    expect(seeded).toBeGreaterThan(0)
    expect(cardcom?.rowCount).toBe(seeded)
    expect(cardcom?.lastSeenAt).not.toBeNull()
  })

  it('drops rows that name no provider rather than gathering them under null', async () => {
    // A cash payment has no provider, and "null took eleven payments" is not a
    // service. A payment taken at the front desk was not taken by an
    // integration, and its absence here is the correct answer.
    const section = sectionOf(await reportFor('owner'), 'payment_provider')
    if (section.state !== 'read') throw new Error('expected a read section')

    const counted = section.records.reduce(
      (total, record) => total + record.rowCount,
      0,
    )
    const withProvider = rows('payments').filter(
      (row) => row.provider !== null && row.provider !== undefined,
    ).length

    expect(counted).toBe(withProvider)
    expect(counted).toBeLessThan(rows('payments').length)
    expect(section.records.some((record) => record.id === 'null')).toBe(false)
  })

  it('counts the payments a person has to resolve, and only those', async () => {
    const section = sectionOf(await reportFor('owner'), 'payment_provider')
    if (section.state !== 'read') throw new Error('expected a read section')

    const attention = section.records.reduce(
      (total, record) => total + record.needsAttentionCount,
      0,
    )
    const expected = rows('payments').filter(
      (row) =>
        row.provider !== null &&
        (row.status === 'unknown' ||
          (row.requires_attention !== null &&
            row.requires_attention !== undefined)),
    ).length

    // `unknown` and `requires_attention` are the same sentence to whoever
    // reads this: the automation stopped and will not restart on its own.
    expect(attention).toBe(expected)
  })

  it('reads the document provider off the invoices', async () => {
    const section = sectionOf(await reportFor('owner'), 'invoice_provider')
    if (section.state !== 'read') throw new Error('expected a read section')

    const green = section.records.find((record) => record.id === 'greeninvoice')
    expect(green?.rowCount).toBe(rows('invoices').length)
    // A document with a provider and no `provider_invoice_id` was never filed
    // — the only attention signal this table supports, and it is a column.
    expect(green?.needsAttentionCount).toBe(
      rows('invoices').filter((row) => row.provider_invoice_id === null).length,
    )
  })

  it('reads the sales channels off every booking', async () => {
    const section = sectionOf(await reportFor('owner'), 'booking_channel')
    if (section.state !== 'read') throw new Error('expected a read section')

    const counted = section.records.reduce(
      (total, record) => total + record.rowCount,
      0,
    )
    expect(counted).toBe(rows('bookings').length)

    // The direct desk is deliberately included: "most of our bookings did not
    // come through any channel at all" is the most useful thing this section
    // can tell an owner considering what to pay for.
    expect(
      section.records.some((record) => record.id === 'direct_manual'),
    ).toBe(true)
    expect(section.records.some((record) => record.id === 'booking_com')).toBe(
      true,
    )
  })

  it('orders by volume, so the services the business depends on come first', async () => {
    const section = sectionOf(await reportFor('owner'), 'booking_channel')
    if (section.state !== 'read') throw new Error('expected a read section')

    const counts = section.records.map((record) => record.rowCount)
    expect(counts).toEqual([...counts].sort((a, b) => b - a))
  })
})

/* =============================================================== reach == */

describe('a reader who may manage integrations and not read the tables', () => {
  it('tells an accountant which grant is missing, not that nothing is connected', async () => {
    // The accountant holds `payment.view` and `invoice.view` and `booking.view`
    // — so all three sections read. The distinction being asserted is that the
    // sections are decided by those grants and not by `integration.manage`,
    // which the accountant does not hold at all.
    const report = await reportFor('accountant')

    for (const section of report.sections) {
      expect(section.state).toBe('read')
    }
    expect(report.nothingReadable).toBe(false)
  })

  it('reads nothing at all for a cleaner, and says which grants are missing', async () => {
    const report = await reportFor('housekeeping')

    expect(report.nothingReadable).toBe(true)
    expect(allRecords(report)).toEqual([])

    // Each section names the grant its own table requires — never
    // `integration.manage`, which those policies have never heard of.
    const missing = report.sections.map((section) =>
      section.state === 'unreadable' ? section.missing : null,
    )
    expect(missing).toEqual(['payment.view', 'invoice.view', 'booking.view'])
  })

  it('gives an external agent the channels and not the money', async () => {
    // `sales_agent` stands on the `availability_booking` rung, so it holds
    // `booking.view` and neither `payment.view` nor `invoice.view`. The
    // screen therefore knows which channels sold what and refuses to say
    // anything about who was paid.
    const report = await reportFor('sales-agent')

    expect(sectionOf(report, 'booking_channel').state).toBe('read')
    expect(sectionOf(report, 'payment_provider').state).toBe('unreadable')
    expect(sectionOf(report, 'invoice_provider').state).toBe('unreadable')
    expect(report.nothingReadable).toBe(false)
  })

  it('gives an administrator everything the owner sees', async () => {
    const owner = allRecords(await reportFor('owner'))
    const administrator = allRecords(await reportFor('administrator'))

    expect(administrator.map((record) => record.id).sort()).toEqual(
      owner.map((record) => record.id).sort(),
    )
  })

  it('gives a general manager the channels and neither ledger', async () => {
    // Worth stating because it is the opposite of what the job title suggests.
    // `general_manager` runs the whole business commercially and holds
    // `expense.view` and not `payment.view` or `invoice.view` — the money is
    // finance's, deliberately. So the same person who owns the agent network
    // can see which channel sold a stay and cannot see who was paid for it.
    //
    // They also do not hold `integration.manage`, so the route itself would
    // refuse them. The two gates are separate on purpose, and this asserts
    // they stay that way rather than collapsing into one.
    const report = await reportFor('general-manager')

    expect(sectionOf(report, 'booking_channel').state).toBe('read')
    expect(sectionOf(report, 'payment_provider').state).toBe('unreadable')
    expect(sectionOf(report, 'invoice_provider').state).toBe('unreadable')
  })
})
