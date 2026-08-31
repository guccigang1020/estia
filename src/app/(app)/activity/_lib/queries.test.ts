/**
 * The activity reads, walked over the demo dataset.
 *
 * The interesting assertions here are about *absence*. `audit_events` is seeded
 * as an empty array on purpose, and the screen has to tell three states apart
 * that all render as "no rows": the trail is empty, the reader may not see the
 * trail, and the query failed. Two of the three are exercised below; the third
 * is the page's `settle` wrapper.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import { holdsGrant, type Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { DemoActorSource } from '@/lib/demo/session'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'

import {
  ACTIVITY_GRANTS,
  ACTIVITY_PAGE_SIZE,
  byDay,
  listAuditEvents,
  listBookingTransitions,
  mergeActivity,
  type ActivityArgs,
} from './queries'

const ORGANIZATION = DEMO_DATASET.organizationId

function client(): Db {
  return createDemoClient(DEMO_DATASET) as unknown as Db
}

async function actorFor(personaId: string, planCode = 'pro'): Promise<Actor> {
  const persona = DEMO_PERSONAS.find((entry) => entry.id === personaId)
  if (!persona) throw new Error(`No demo persona '${personaId}'`)

  const plan = DEMO_PLANS.find((entry) => entry.code === planCode)
  if (!plan) throw new Error(`No demo plan '${planCode}'`)

  const resolution = await resolveActor(
    new DemoActorSource(new SupabaseActorSource(client()), plan),
    persona.userId,
    ORGANIZATION,
  )
  if (!resolution.ok) {
    throw new Error(
      `${persona.label} does not resolve to an actor: ${resolution.reason}`,
    )
  }
  return resolution.actor
}

async function argsFor(personaId: string): Promise<ActivityArgs> {
  return {
    db: client(),
    actor: await actorFor(personaId),
    organizationId: ORGANIZATION,
    propertyId: null,
  }
}

function seeded(table: string): number {
  return DEMO_DATASET.tables[table]?.length ?? 0
}

/* ================================================================ audit == */

describe('the audit trail', () => {
  it('is empty for the owner, and that is a fact about the dataset', async () => {
    // `DEMO_DATASET` carries `audit_events: []` deliberately — `dataset.ts`
    // says seeding it would be seeding the output of the very code paths the
    // demo exists to exercise, and an audit trail nobody performed is fiction.
    // An empty array here is therefore the *correct* answer, and the screen
    // says so in words rather than rendering a blank.
    expect(seeded('audit_events')).toBe(0)
    expect(await listAuditEvents(await argsFor('owner'))).toEqual([])
  })

  it('is withheld from reception rather than shown as empty', async () => {
    const reception = await actorFor('reception')
    expect(holdsGrant(reception, 'audit.view')).toBe(false)

    // `null`, not `[]`. "Nothing has been done here" and "you may not read what
    // was done here" are opposite statements and the screen prints them
    // differently.
    expect(await listAuditEvents(await argsFor('reception'))).toBeNull()
  })

  it('is withheld from the cleaner', async () => {
    expect(await listAuditEvents(await argsFor('housekeeping'))).toBeNull()
  })
})

/* ========================================================== transitions == */

describe('booking transitions', () => {
  it('gives the owner every seeded transition, newest first', async () => {
    // Above the page size, so this measures the read rather than the ceiling.
    const rows =
      (await listBookingTransitions({
        ...(await argsFor('owner')),
        limit: 500,
      })) ?? []

    expect(rows.length).toBe(seeded('booking_status_history'))
    expect(rows.length).toBeGreaterThan(50)

    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index].occurredAt <= rows[index - 1].occurredAt).toBe(true)
    }
  })

  it('stops at the page size rather than quietly returning everything', async () => {
    const rows = (await listBookingTransitions(await argsFor('owner'))) ?? []

    // The dataset holds more transitions than one page. The screen says so out
    // loud when the list is exactly this long, which is the alternative to a
    // list that silently stops.
    expect(seeded('booking_status_history')).toBeGreaterThan(ACTIVITY_PAGE_SIZE)
    expect(rows).toHaveLength(ACTIVITY_PAGE_SIZE)
  })

  it('labels every row with the record it came from', async () => {
    const rows = (await listBookingTransitions(await argsFor('owner'))) ?? []
    for (const row of rows) {
      expect(row.source).toBe('booking_status')
      expect(row.resourceType).toBe('bookings')
      // The transition itself, so the screen can render the two badges the
      // rest of the product uses rather than composing a sentence here.
      expect(row.toStatus).toBeDefined()
    }
  })

  it('names the booking by its reference, not by its uuid', async () => {
    const rows = (await listBookingTransitions(await argsFor('owner'))) ?? []
    expect(rows.length).toBeGreaterThan(0)
    // Every seeded booking has a reference and the owner may read all of them,
    // so nothing should fall back to the id.
    expect(rows.every((row) => row.bookingReference !== null)).toBe(true)
    expect(rows.every((row) => row.summary === row.bookingReference)).toBe(true)
  })

  it('names who moved it for a reader holding user.view', async () => {
    const owner = await actorFor('owner')
    expect(holdsGrant(owner, 'user.view')).toBe(true)

    const rows = (await listBookingTransitions(await argsFor('owner'))) ?? []
    expect(rows.some((row) => row.actorLabel !== null)).toBe(true)
  })

  it('leaves the actor unnamed for reception, who may not read the team', async () => {
    const reception = await actorFor('reception')
    expect(holdsGrant(reception, 'user.view')).toBe(false)

    const rows =
      (await listBookingTransitions(await argsFor('reception'))) ?? []
    expect(rows.length).toBeGreaterThan(0)
    // Null, never a uuid in a column headed "מי". The screen renders
    // "משתמש שאינו זמין לצפייה".
    expect(rows.every((row) => row.actorLabel === null)).toBe(true)
  })

  it('narrows the property manager to their own property', async () => {
    // Above the page size on both reads, or the comparison below would be
    // comparing two ceilings rather than two scopes.
    const rows =
      (await listBookingTransitions({
        ...(await argsFor('property-manager')),
        limit: 500,
      })) ?? []
    const properties = new Set(rows.map((row) => row.propertyId))

    expect(rows.length).toBeGreaterThan(0)
    expect(properties.size).toBe(1)

    // And strictly fewer rows than the owner sees, or the narrowing is not
    // narrowing anything.
    const all =
      (await listBookingTransitions({
        ...(await argsFor('owner')),
        limit: 500,
      })) ?? []
    expect(rows.length).toBeLessThan(all.length)
  })

  it('is withheld from the cleaner, who holds no booking grant', async () => {
    const cleaner = await actorFor('housekeeping')
    expect(holdsGrant(cleaner, 'booking.view')).toBe(false)
    expect(
      await listBookingTransitions(await argsFor('housekeeping')),
    ).toBeNull()
  })
})

/* ================================================================ merge == */

describe('the merged feed', () => {
  it('drops a withheld source instead of treating it as empty', async () => {
    const args = await argsFor('reception')
    const audit = await listAuditEvents(args)
    const transitions = await listBookingTransitions(args)

    expect(audit).toBeNull()
    const merged = mergeActivity([audit, transitions])

    // The reception feed is exactly the transitions. The *fact* that the audit
    // trail was withheld is stated on the screen, not encoded as zero rows.
    expect(merged.length).toBeGreaterThan(0)
    expect(merged.every((entry) => entry.source === 'booking_status')).toBe(
      true,
    )
  })

  it('orders newest first and caps the page', async () => {
    const args = await argsFor('owner')
    const merged = mergeActivity([
      await listAuditEvents(args),
      await listBookingTransitions(args),
    ])

    expect(merged.length).toBeLessThanOrEqual(50)
    for (let index = 1; index < merged.length; index += 1) {
      expect(merged[index].occurredAt <= merged[index - 1].occurredAt).toBe(
        true,
      )
    }
  })

  it('groups by the property-local day, in feed order', async () => {
    const args = await argsFor('owner')
    const merged = mergeActivity([
      await listAuditEvents(args),
      await listBookingTransitions(args),
    ])
    const days = byDay(merged)

    expect(days.length).toBeGreaterThan(0)
    expect(days.reduce((total, group) => total + group.entries.length, 0)).toBe(
      merged.length,
    )
    // Each day appears once — a second group for the same date would render the
    // same heading twice.
    expect(new Set(days.map((group) => group.day)).size).toBe(days.length)
  })

  it('returns nothing at all when both sources are withheld', async () => {
    const args = await argsFor('housekeeping')
    expect(
      mergeActivity([
        await listAuditEvents(args),
        await listBookingTransitions(args),
      ]),
    ).toEqual([])
  })
})

/* ================================================================ door === */

describe('who the route admits', () => {
  it('admits the owner on the booking grant and the accountant too', async () => {
    const admitted = async (personaId: string) => {
      const actor = await actorFor(personaId)
      return ACTIVITY_GRANTS.find((grant) => holdsGrant(actor, grant))
    }

    expect(await admitted('owner')).toBe('booking.view')
    expect(await admitted('reception')).toBe('booking.view')
    expect(await admitted('accountant')).toBe('booking.view')
    // The cleaner holds neither, and is refused at the door rather than shown
    // an empty feed.
    expect(await admitted('housekeeping')).toBeUndefined()
  })
})
