/**
 * The inbox reads, walked over the demo dataset.
 *
 * The first assertion is the one that matters most and it is about the schema
 * rather than about a query: there is no messaging table, in any migration.
 * Everything else here proves that what the screen shows instead is real rows
 * with real permissions on them, rather than a mock wearing a thread's clothes.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import { holdsGrant, type Actor } from '@/lib/authz/can'
import { localDate } from '@/lib/booking/dates'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { DemoActorSource } from '@/lib/demo/session'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'

import {
  MISSING_MESSAGING_TABLES,
  listGuestNotes,
  listInternalNotes,
  listRequestTasks,
  type InboxArgs,
} from './queries'

const ORGANIZATION = DEMO_DATASET.organizationId
const TODAY = localDate(new Date())

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

async function argsFor(personaId: string): Promise<InboxArgs> {
  return {
    db: client(),
    actor: await actorFor(personaId),
    organizationId: ORGANIZATION,
    propertyId: null,
  }
}

/* ============================================================== the gap == */

describe('the messaging domain', () => {
  it('does not exist, and the dataset agrees', () => {
    // `MissingDemoTable` is thrown for a table the dataset has no key for, and
    // `dataset.test.ts` checks every key against the migrations — so a table
    // absent from `DEMO_DATASET.tables` is a table absent from the schema.
    for (const table of MISSING_MESSAGING_TABLES) {
      expect(DEMO_DATASET.tables[table]).toBeUndefined()
    }
    // The names the product would most plausibly have used, for good measure.
    for (const table of ['messages', 'threads', 'conversations']) {
      expect(DEMO_DATASET.tables[table]).toBeUndefined()
    }
  })

  it('still has its permissions, which is what makes the gap a gap', async () => {
    const reception = await actorFor('reception')
    expect(holdsGrant(reception, 'message.view')).toBe(true)
    expect(holdsGrant(reception, 'message.send')).toBe(true)

    // And nothing to assign, which is why the screen offers no such control.
    const owner = await actorFor('owner')
    expect(holdsGrant(owner, 'message.assign')).toBe(true)
  })
})

/* ==================================================== the guest's words == */

describe("a guest's own words on their booking", () => {
  it('gives the owner every booking that carries one', async () => {
    const notes = (await listGuestNotes(await argsFor('owner'), TODAY)) ?? []

    const seeded = DEMO_DATASET.tables.bookings.filter(
      (row) => typeof row.guest_notes === 'string',
    )
    expect(seeded.length).toBeGreaterThan(0)
    expect(notes).toHaveLength(seeded.length)
    for (const note of notes) {
      expect(note.text.length).toBeGreaterThan(0)
      expect(note.guestName).not.toBeNull()
    }
  })

  it('dates the note by the booking, and says so rather than inventing one', async () => {
    const notes = (await listGuestNotes(await argsFor('owner'), TODAY)) ?? []
    const bookings = new Map(
      DEMO_DATASET.tables.bookings.map((row) => [row.id as string, row]),
    )

    for (const note of notes) {
      const row = bookings.get(note.bookingId)
      expect(note.writtenOn).toBe(
        localDate(new Date(row?.created_at as string)),
      )
      // The column has no timestamp of its own; the screen labels this as the
      // moment the booking was taken.
      expect(row?.guest_notes).toBe(note.text)
    }
  })

  it('marks a note about a stay that has already ended', async () => {
    const notes = (await listGuestNotes(await argsFor('owner'), TODAY)) ?? []
    for (const note of notes) {
      expect(note.live).toBe(note.checkOut >= TODAY)
    }
  })

  it('is withheld from a reader who may see the booking and not the guest', async () => {
    // The accountant holds `booking.view` and not `guest.view_name`. A guest's
    // own words are guest data wherever the column sits, so the list is
    // withheld entirely rather than rendered with the name blanked.
    const accountant = await actorFor('accountant')
    expect(holdsGrant(accountant, 'booking.view')).toBe(true)
    expect(holdsGrant(accountant, 'guest.view_name')).toBe(false)

    expect(await listGuestNotes(await argsFor('accountant'), TODAY)).toBeNull()
  })

  it('is withheld from the cleaner, who reads no bookings at all', async () => {
    expect(
      await listGuestNotes(await argsFor('housekeeping'), TODAY),
    ).toBeNull()
  })
})

/* =========================================================== team notes == */

describe('notes the team left itself', () => {
  it('gives reception every booking that carries one', async () => {
    const reception = await actorFor('reception')
    expect(holdsGrant(reception, 'booking.note.internal')).toBe(true)

    const notes =
      (await listInternalNotes(await argsFor('reception'), TODAY)) ?? []
    const seeded = DEMO_DATASET.tables.bookings.filter(
      (row) => typeof row.internal_notes === 'string',
    )

    expect(seeded.length).toBeGreaterThan(0)
    expect(notes).toHaveLength(seeded.length)
  })

  it('is withheld without booking.note.internal, which is its own grant', async () => {
    const accountant = await actorFor('accountant')
    expect(holdsGrant(accountant, 'booking.view')).toBe(true)
    expect(holdsGrant(accountant, 'booking.note.internal')).toBe(false)

    // Seeing a booking is not being allowed to read what the team said about
    // it. That is the whole reason the grant exists separately.
    expect(
      await listInternalNotes(await argsFor('accountant'), TODAY),
    ).toBeNull()
  })
})

/* ====================================================== requests as work == */

describe('guest requests that became work', () => {
  it('finds the seeded request, cancellation and all', async () => {
    const requests = (await listRequestTasks(await argsFor('owner'))) ?? []

    const seeded = DEMO_DATASET.tables.tasks.filter(
      (row) => row.task_type === 'guest_request',
    )
    expect(seeded.length).toBeGreaterThan(0)
    expect(requests).toHaveLength(seeded.length)

    // FINDING: the dataset seeds exactly one guest request and it is
    // `cancelled`, so this list is thin by construction rather than by
    // filtering. It is kept on screen deliberately — an inbox that hides "the
    // guests said never mind" makes somebody chase a withdrawn request — and
    // `tasks_cancelled_has_reason` guarantees there is a reason to print.
    const cancelled = requests.filter((task) => task.status === 'cancelled')
    for (const task of cancelled) {
      expect(task.cancellationReason).not.toBeNull()
    }
  })

  it('names the assignee for a reader holding user.view', async () => {
    const requests = (await listRequestTasks(await argsFor('owner'))) ?? []
    const assigned = requests.filter((task) => task.assignedToUserId !== null)
    expect(assigned.length).toBeGreaterThan(0)
    expect(assigned.every((task) => task.assignedToName !== null)).toBe(true)
  })

  it('leaves the assignee unnamed for reception, who may not read the team', async () => {
    const reception = await actorFor('reception')
    expect(holdsGrant(reception, 'user.view')).toBe(false)

    const requests = (await listRequestTasks(await argsFor('reception'))) ?? []
    expect(requests.every((task) => task.assignedToName === null)).toBe(true)
  })

  it('is the only assignable thing here, and it is assignable as a task', async () => {
    const owner = await actorFor('owner')
    // The point of the whole panel: assignment is real because
    // `task_assignments` and `task.assign` exist, not because messaging does.
    expect(holdsGrant(owner, 'task.assign')).toBe(true)
    expect(DEMO_DATASET.tables.task_assignments.length).toBeGreaterThan(0)
  })

  it('gives the cleaner only her own team’s requests', async () => {
    const cleaner = await actorFor('housekeeping')
    expect(holdsGrant(cleaner, 'task.view')).toBe(true)

    const requests =
      (await listRequestTasks(await argsFor('housekeeping'))) ?? []
    const teams = new Set(requests.map((task) => task.teamId))

    // The seeded guest request belongs to the front desk, so a housekeeping
    // membership reaches none of it — by scope, not by a screen hiding a row.
    expect(teams.has(null)).toBe(false)
    expect(requests.length).toBe(0)
  })
})
