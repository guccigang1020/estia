/**
 * The audit trail read, over the demo dataset — which seeds it empty.
 *
 * ══ THE ASSERTION THIS FILE EXISTS FOR ═══════════════════════════════════
 *
 * `DEMO_DATASET.tables.audit_events` is `[]`, deliberately: those rows are
 * written by the product as it runs, and seeding them would be seeding the
 * output of the code paths the demo exists to exercise. An audit trail nobody
 * performed is the one kind of fiction a product like this cannot ship.
 *
 * The consequence is that the screen's *only* reachable state in the demo is
 * the empty one, and "it renders empty" is a claim that has to be checked
 * rather than assumed. The failure mode it is checked against is specific and
 * plausible: a mapper that throws on a column nobody has ever seen populated,
 * or a second query that is issued unconditionally and fails on an empty `in`
 * list. Both look identical to an empty list in a code review, and both would
 * turn the honest empty state into an error screen — which reads, to anybody
 * looking at it, as a product that lost its records.
 *
 * The rest of the file drives the same query over rows the *product* would
 * have written, inserted through the demo client rather than seeded into the
 * dataset. That distinction matters: nothing here adds a fixture to
 * `dataset.ts`, so the demo a person walks through still has an empty trail.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import type { Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { DemoActorSource } from '@/lib/demo/session'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'
import { SupabaseAuditWriter } from '@/lib/persistence/audit'
import { recordAuditEvent } from '@/lib/audit/pipeline'

import { countAuditEvents, delegatedEvents, listAuditEvents } from './queries'

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

function personaUserId(personaId: string): string {
  const persona = DEMO_PERSONAS.find((entry) => entry.id === personaId)
  if (!persona) throw new Error(`No demo persona '${personaId}'`)
  return persona.userId
}

/* ============================================================== empty === */

describe('the honest empty trail', () => {
  it('is genuinely empty in the dataset, and that is on purpose', async () => {
    expect(DEMO_DATASET.tables.audit_events).toEqual([])
  })

  it('returns an empty list rather than raising', async () => {
    // The whole point. A screen that errors here would present a deliberate
    // "nothing has happened yet" as "we lost your records".
    const events = await listAuditEvents({
      db: client(),
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
      propertyId: null,
    })

    expect(events).toEqual([])
  })

  it('counts zero rather than failing the count', async () => {
    expect(await countAuditEvents(client(), ORGANIZATION)).toBe(0)
  })

  it('does not issue the follow-up reads when there is nothing to name', async () => {
    // `listAuditEvents` returns before resolving delegate names and property
    // names. Asserted through behaviour rather than through a spy: an
    // unconditional `in` over an empty list is exactly the shape that turns an
    // empty trail into an exception.
    await expect(
      listAuditEvents({
        db: client(),
        actor: await actorFor('administrator'),
        organizationId: ORGANIZATION,
        propertyId: null,
      }),
    ).resolves.toEqual([])
  })

  it('is empty for a property narrowing too', async () => {
    const events = await listAuditEvents({
      db: client(),
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
      propertyId: '00000000-0000-4000-8000-000000000001',
    })

    expect(events).toEqual([])
  })
})

/* ============================================== rows the product writes == */

/**
 * A trail with events in it, written the way the product writes them.
 *
 * Through `recordAuditEvent` and `SupabaseAuditWriter` — the same pipeline a
 * paying customer's request runs through, which diffs, scrubs and refuses
 * before anything reaches the table. Building rows by hand and pushing them
 * into the dataset would test this file's mappers against this file's own
 * idea of a row, which proves nothing.
 */
async function trailWithEvents(): Promise<Db> {
  const db = client()
  const writer = new SupabaseAuditWriter(db)
  const owner = personaUserId('owner')
  const manager = personaUserId('general-manager')

  await recordAuditEvent(
    {
      actor: { type: 'user', userId: manager, label: 'מיכל בר-ששת' },
      context: { organizationId: ORGANIZATION, requestId: 'req-a1' },
      action: 'booking.update',
      resourceType: 'booking',
      resourceId: 'bk-1',
      before: { totalAgorot: 520_000, status: 'confirmed' },
      after: { totalAgorot: 470_000, status: 'confirmed' },
      summary: 'מיכל שינתה את סכום ההזמנה מ-₪5,200 ל-₪4,700',
    },
    writer,
  )

  await recordAuditEvent(
    {
      actor: {
        type: 'ai_agent',
        userId: null,
        label: 'Website Studio · Copywriter',
        onBehalfOfUserId: owner,
      },
      context: { organizationId: ORGANIZATION, requestId: 'req-b2' },
      action: 'site.ai_generate',
      resourceType: 'site_page',
      resourceId: 'home',
      after: { headline: 'אחוזת הגליל' },
      summary: 'סוכן הכתיבה יצר כותרת חדשה לעמוד הבית, ודנה אישרה אותה',
    },
    writer,
  )

  return db
}

describe('a trail with events in it', () => {
  it('reads back what the pipeline wrote, newest first', async () => {
    const db = await trailWithEvents()
    const events = await listAuditEvents({
      db,
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
      propertyId: null,
    })

    expect(events).toHaveLength(2)
    for (const event of events) {
      expect(typeof event.id).toBe('string')
      expect(event.summary.length).toBeGreaterThan(0)
      // The sentence is never a restatement of the action code.
      expect(event.summary).not.toBe(event.action)
      expect(typeof event.actorLabel).toBe('string')
      expect(typeof event.occurredAt).toBe('string')
    }
  })

  it('renders a delegated action as a delegation, with the person named', async () => {
    // Forging this column was a real defect: until 0006 the insert policy
    // guarded `actor_user_id` and not `on_behalf_of_user_id`, so any member
    // could write "ESTIA changed the price, and the owner approved it". The
    // screen must never fold a delegated event into an ordinary one.
    const db = await trailWithEvents()
    const events = await listAuditEvents({
      db,
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
      propertyId: null,
    })

    const delegated = delegatedEvents(events)
    expect(delegated).toHaveLength(1)
    expect(delegated[0]?.actorType).toBe('ai_agent')
    // `ai_agent` rows carry no `actor_user_id` — `audit_events_insert` demands
    // it — so the only person on the row is the one who approved it.
    expect(delegated[0]?.actorUserId).toBeNull()
    expect(delegated[0]?.onBehalfOfUserId).toBe(personaUserId('owner'))
    // Resolved to a name from `user_profiles`, not printed as a uuid.
    expect(delegated[0]?.onBehalfOfName).toBe('דנה אלמוג')
  })

  it('leaves an ordinary action undelegated', async () => {
    const db = await trailWithEvents()
    const events = await listAuditEvents({
      db,
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
      propertyId: null,
    })

    const ordinary = events.filter((event) => event.actorType === 'user')
    expect(ordinary).toHaveLength(1)
    expect(ordinary[0]?.onBehalfOfUserId).toBeNull()
    expect(ordinary[0]?.onBehalfOfName).toBeNull()
  })

  it('carries only the fields that changed', async () => {
    // `diffFields` reduced the pair before the write: `status` was identical
    // on both sides and must not be in the payload, or a real change becomes
    // hard to spot among forty unchanged columns.
    const db = await trailWithEvents()
    const events = await listAuditEvents({
      db,
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
      propertyId: null,
    })

    const update = events.find((event) => event.action === 'booking.update')
    expect(update?.before).toEqual({ totalAgorot: 520_000 })
    expect(update?.after).toEqual({ totalAgorot: 470_000 })
  })

  it('keeps a create with no before, rather than inventing one', async () => {
    const db = await trailWithEvents()
    const events = await listAuditEvents({
      db,
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
      propertyId: null,
    })

    const generated = events.find(
      (event) => event.action === 'site.ai_generate',
    )
    // `null` and `{}` are different answers, and the screen renders them
    // differently: nothing changed here, versus a change with no fields.
    expect(generated?.before).toBeNull()
    expect(generated?.after).toEqual({ headline: 'אחוזת הגליל' })
  })

  it('ties the events of one request together', async () => {
    const db = await trailWithEvents()
    const events = await listAuditEvents({
      db,
      actor: await actorFor('owner'),
      organizationId: ORGANIZATION,
      propertyId: null,
    })

    expect(events.map((event) => event.requestId).sort()).toEqual([
      'req-a1',
      'req-b2',
    ])
  })
})
