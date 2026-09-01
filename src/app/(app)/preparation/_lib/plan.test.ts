/**
 * One stay's plan screen, and the promise it is built to keep.
 *
 * The promise is not "a cleaner is shown no guest name". That is easy and it
 * was already true. The promise is that **a cleaner's page never asks the
 * database for the booking at all** — because the moment it does, keeping the
 * name off the screen becomes a rendering decision, and rendering decisions
 * are the kind that survive one refactor and not two.
 *
 * So the assertions below are about the queries that were issued, not about
 * the markup that came out. `recording()` wraps the demo client and writes
 * down every table touched; the test then names `bookings` and insists it is
 * absent. That is the only form of this assertion that cannot be satisfied by
 * accident.
 *
 * ── Why this is possible at all ───────────────────────────────────────────
 *
 * `0036_work_plan_facts.sql` put the arrival instant, the event type, the
 * party and the guest's own request onto `work_plans`, whose select policy
 * asks for `task.view`. The facts a person needs in order to prepare a room
 * now travel with the plan, exactly as the frozen rules already did. The
 * alternative — widening `booking.view` to cover housekeeping — would have
 * handed them the guest, the total and the source in order to let them read
 * one sentence about a cot.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import type { Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { DemoActorSource } from '@/lib/demo/session'
import { SupabasePreparationPorts, type Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'
import {
  buildWorkPlan,
  captureSnapshot,
  computeRequirements,
  containsFinancialField,
  estimateStaffing,
  templateSections,
  type PreparationBooking,
  type WorkPlan,
} from '@/lib/preparation'
import {
  exampleBooking,
  exampleCatalogue,
} from '@/lib/preparation/testing/example-configuration'

import { loadPlanScreen } from './plan'

const ORGANIZATION = DEMO_DATASET.organizationId
const NOW = '2026-09-01T06:00:00.000Z'

function planNamed(code: string) {
  const plan = DEMO_PLANS.find((entry) => entry.code === code)
  if (!plan) throw new Error(`No demo plan '${code}'`)
  return plan
}

async function actorFor(personaKey: string): Promise<Actor> {
  const persona = DEMO_PERSONAS.find((entry) => entry.id === personaKey)
  if (!persona) throw new Error(`No demo persona '${personaKey}'`)

  const source = new DemoActorSource(
    new SupabaseActorSource(createDemoClient(DEMO_DATASET) as unknown as Db),
    planNamed('pro'),
  )

  const resolution = await resolveActor(source, persona.userId, ORGANIZATION)
  if (!resolution.ok) {
    throw new Error(`${persona.label} does not resolve: ${resolution.reason}`)
  }
  return resolution.actor
}

/**
 * A client that writes down which tables it was asked for.
 *
 * Deliberately a wrapper rather than a flag inside the demo client: the thing
 * under test is what this screen *asks for*, and a recorder the production
 * client knew about would be a recorder somebody could later satisfy by
 * special-casing it.
 */
function recording(db: Db): { db: Db; tables: string[] } {
  const tables: string[] = []
  const wrapped = new Proxy(db as object, {
    get(target, property, receiver) {
      if (property === 'from') {
        return (table: string) => {
          tables.push(table)
          return (db as unknown as { from: (t: string) => unknown }).from(table)
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })

  return { db: wrapped as Db, tables }
}

/** A plan with real facts frozen onto it, exactly as `buildPlan` produces. */
function planFor(booking: PreparationBooking): WorkPlan {
  const snapshot = captureSnapshot({
    catalogue: exampleCatalogue(),
    booking,
    capturedAt: NOW,
  })
  const { facts, requirements } = computeRequirements(booking, snapshot)

  return buildWorkPlan({
    id: 'plan-1',
    booking,
    snapshot,
    requirements,
    staffing: estimateStaffing({
      facts,
      configuration: snapshot.complexity,
      extraItems: booking.extras.length,
    }),
    extraSections: templateSections(snapshot, booking.eventType),
    version: 1,
    createdAt: NOW,
  })
}

/**
 * Ports that answer from one plan and refuse the booking outright.
 *
 * `loadBooking` throws rather than returning null, so a screen that reaches
 * for it fails loudly here instead of quietly rendering without it and passing
 * the test for the wrong reason.
 */
function portsFor(plan: WorkPlan | null) {
  return {
    loadPlan: async () => plan,
    loadSnapshot: async () => null,
    loadPlaceNames: async () => ({
      propertyName: 'וילה כחול ים',
      unitName: 'האגף הראשי',
    }),
    loadBookingReference: async () => 'B1234',
    loadBooking: async () => {
      throw new Error('the screen asked for the booking')
    },
  } as unknown as SupabasePreparationPorts
}

describe('what the plan screen asks the database for', () => {
  it('never touches bookings for a reader without booking.view', async () => {
    const cleaner = await actorFor('housekeeping')
    const { db, tables } = recording(
      createDemoClient(DEMO_DATASET) as unknown as Db,
    )

    const screen = await loadPlanScreen({
      ports: new SupabasePreparationPorts(db),
      actor: cleaner,
      bookingId: DEMO_DATASET.organizationId,
    })

    // The claim, as the query log rather than as the markup.
    expect(tables).not.toContain('bookings')
    expect(tables).not.toContain('booking_price_lines')
    expect(tables).not.toContain('guests')
    // Not vacuous: it did go to the database, and to the right table.
    expect(tables).toContain('work_plans')
    // And it answered rather than throwing.
    expect(screen.view).toBeNull()
  })

  it('does read the booking for a reader who holds booking.view', async () => {
    // The other half. A manager gets the arithmetic, which needs the extras
    // and the stay that the plan does not store, so the read is legitimate
    // and has to actually happen.
    const manager = await actorFor('general-manager')
    const { db, tables } = recording(
      createDemoClient(DEMO_DATASET) as unknown as Db,
    )

    await loadPlanScreen({
      ports: new SupabasePreparationPorts(db),
      actor: manager,
      bookingId: DEMO_DATASET.organizationId,
    })

    expect(tables).toContain('bookings')
  })
})

describe('the facts a cleaner is shown come off the plan', () => {
  const booking = exampleBooking({
    arrivalAt: '2026-09-04T11:00:00.000Z',
    specialRequests: 'שתי מיטות תינוק, אחת בחדר ההורים',
  })

  it('renders the arrival, the party and the request with no booking read', async () => {
    const cleaner = await actorFor('housekeeping')

    const screen = await loadPlanScreen({
      ports: portsFor(planFor(booking)),
      actor: cleaner,
      bookingId: booking.id,
    })

    expect(screen.factsAvailable).toBe(true)
    expect(screen.view?.deadlineAt).toBe('2026-09-04T11:00:00.000Z')
    expect(screen.view?.guestCount).toBe(booking.guests)
    expect(screen.view?.eventTypeLabel).toBe('שבת')
    // The sentence this whole migration exists for.
    expect(screen.view?.specialRequests).toBe(
      'שתי מיטות תינוק, אחת בחדר ההורים',
    )
  })

  it('carries no guest name and no money into the view, still', async () => {
    const cleaner = await actorFor('housekeeping')

    const screen = await loadPlanScreen({
      ports: portsFor(planFor(booking)),
      actor: cleaner,
      bookingId: booking.id,
    })

    // Six new fields reached this object. The runtime scan is what stops one
    // of them having been a price.
    expect(containsFinancialField(screen.view)).toEqual([])
    expect(JSON.stringify(screen.view)).not.toContain('דנה')
  })

  it('says so plainly for a plan built before its facts were frozen', async () => {
    // A plan stored before 0036 cannot be given facts now without the booking
    // read those columns exist to remove. The screen says the next update
    // will fill them in; it does not render a blank deadline.
    const cleaner = await actorFor('housekeeping')
    const stale: WorkPlan = { ...planFor(booking), facts: null }

    const screen = await loadPlanScreen({
      ports: portsFor(stale),
      actor: cleaner,
      bookingId: booking.id,
    })

    expect(screen.factsAvailable).toBe(false)
    expect(screen.view?.deadlineAt).toBeNull()
    expect(screen.view?.specialRequests).toBeNull()
    // The work itself is unaffected, which is the point of degrading here.
    expect(screen.view?.sections.length).toBeGreaterThan(0)
  })
})
