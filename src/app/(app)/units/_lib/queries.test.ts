/**
 * The units read, walked the way the product walks it.
 *
 * `dataset-actor.test.ts` proved the personas resolve to genuinely different
 * actors. This file takes the next step for the inventory screen: it runs the
 * real query over `createDemoClient(DEMO_DATASET)` — the same seven units in
 * two properties a person sees in demo mode — and asserts what an owner, an
 * administrator, a general manager, a receptionist, an accountant, a
 * property-scoped manager, an external agent and a cleaner each come back
 * with.
 *
 * ── Why this is worth writing ─────────────────────────────────────────────
 *
 * A unit test over a pure function cannot tell you that a column name is
 * wrong, that the `units.properties` embed is not declared, or that a
 * redaction hands over the very figure it was meant to withhold. Running the
 * real query over a real dataset can.
 *
 * ── What this is not ──────────────────────────────────────────────────────
 *
 * It is not a test of row level security. `createDemoClient` says so in its
 * own header: there is no policy engine behind these arrays, so a query that
 * forgot its tenant filter would return rows here and nothing in production.
 * What is exercised is the floor above it — the `can()` narrowing and the
 * `redact()` field rules the query applies itself.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import type { Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { PROPERTY_IDS, UNITS } from '@/lib/demo/dataset-inventory'
import { DemoActorSource } from '@/lib/demo/session'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'

import {
  countUnits,
  listUnits,
  sellableUnits,
  unsellableUnits,
} from './queries'

const ORGANIZATION = DEMO_DATASET.organizationId

function client(): Db {
  return createDemoClient(DEMO_DATASET) as unknown as Db
}

function planNamed(code: string) {
  const found = DEMO_PLANS.find((plan) => plan.code === code)
  if (!found) throw new Error(`No demo plan '${code}'`)
  return found
}

/**
 * The actor a persona resolves to, through the ordinary path.
 *
 * Lifted from `dataset-actor.test.ts` deliberately rather than shared: these
 * are the same modules a paying customer's request runs through, and the point
 * of both files is that nothing demo-specific is substituted for them.
 */
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

async function unitsFor(personaId: string, propertyId: string | null = null) {
  return listUnits({
    db: client(),
    actor: await actorFor(personaId),
    organizationId: ORGANIZATION,
    propertyId,
  })
}

/** How many rows the dataset holds, so the assertions cannot drift from it. */
function seeded(table: string): number {
  return DEMO_DATASET.tables[table]?.length ?? 0
}

/* ================================================================ list == */

describe('the units list', () => {
  it('serves the owner every seeded unit, named by its property', async () => {
    const units = await unitsFor('owner')

    expect(units).toHaveLength(seeded('units'))
    expect(units.length).toBeGreaterThanOrEqual(7)

    for (const unit of units) {
      // Every column the screen prints, present and of the right kind. A
      // renamed column surfaces here as a thrown `RowShapeError` rather than
      // as a blank cell somebody notices in production.
      expect(typeof unit.id).toBe('string')
      expect(typeof unit.code).toBe('string')
      expect(typeof unit.name).toBe('string')
      expect(typeof unit.status).toBe('string')
      expect(Number.isInteger(unit.maxGuests)).toBe(true)
      expect(Number.isInteger(unit.basePriceAgorot)).toBe(true)
      // The embed is the part a wrong relation name breaks silently: the list
      // still renders, with every property shown as null.
      expect(typeof unit.propertyName).toBe('string')
    }
  })

  it('keeps `bathrooms` a real number, not a rounded one', async () => {
    // `numeric(3,1)` arrives from PostgREST as a string, and 1.5 bathrooms is
    // a real listing. Rounding it in either direction is a complaint.
    const units = await unitsFor('owner')
    const halves = units.filter((unit) => !Number.isInteger(unit.bathrooms))

    expect(halves.length).toBeGreaterThan(0)
    for (const unit of units) expect(typeof unit.bathrooms).toBe('number')
  })

  it('orders by the business own sort order, as the property page does', async () => {
    // `sort_order` then `code`, matching `loadUnits` in the properties module.
    // Not alphabetical: the seeded order interleaves the two properties, and
    // sorting by name here would show the same seven units in a different
    // order on two screens of one product.
    const codes = (await unitsFor('owner')).map((unit) => unit.code)
    expect(codes).toEqual(UNITS.map((unit) => unit.code))
  })

  it('narrows to the selected property without changing the answer', async () => {
    const all = await unitsFor('owner')
    const rimonim = await unitsFor('owner', PROPERTY_IDS.rimonim)
    const kachol = await unitsFor('owner', PROPERTY_IDS.kacholYam)

    expect(rimonim.length + kachol.length).toBe(all.length)
    expect(
      rimonim.every((unit) => unit.propertyId === PROPERTY_IDS.rimonim),
    ).toBe(true)
  })

  it('counts what exists before any narrowing', async () => {
    const db = client()
    expect(await countUnits(db, ORGANIZATION, null)).toBe(seeded('units'))
    expect(
      await countUnits(db, ORGANIZATION, PROPERTY_IDS.kacholYam),
    ).toBeGreaterThan(0)
  })
})

/* ============================================================== draft == */

describe('what can actually be sold', () => {
  it('separates the draft unit from the sellable ones', async () => {
    const units = await unitsFor('owner')
    const blocked = unsellableUnits(units)

    // The dataset seeds exactly one, and it is the point of the split: a unit
    // that is not `active` has no rules row as far as `loadRules` is
    // concerned, so `checkAvailability` refuses it and the calendar shows it
    // blocked all year.
    expect(blocked).toHaveLength(1)
    expect(blocked[0]?.status).toBe('draft')
    expect(sellableUnits(units)).toHaveLength(units.length - 1)
  })

  it('applies exactly the rule the booking engine applies', async () => {
    const units = await unitsFor('owner')
    for (const unit of sellableUnits(units)) expect(unit.status).toBe('active')
    for (const unit of unsellableUnits(units))
      expect(unit.status).not.toBe('active')
  })

  it('still shows the draft unit its price and its capacity', async () => {
    // It is inventory, not a placeholder. Hiding its figures would make the
    // screen read as though the unit were incomplete rather than unpublished.
    const draft = unsellableUnits(await unitsFor('owner'))[0]

    expect(draft).toBeDefined()
    expect(draft?.basePriceAgorot).toBeGreaterThan(0)
    expect(draft?.maxGuests).toBeGreaterThan(0)
  })
})

/* ============================================================== scope == */

describe('who sees which units', () => {
  it('gives the property manager one property and not the other', async () => {
    const units = await unitsFor('property-manager')

    expect(units.length).toBeGreaterThan(0)
    expect(
      units.every((unit) => unit.propertyId === PROPERTY_IDS.rimonim),
    ).toBe(true)
    // Not a filter applied to a full result: the other property's units are
    // out of scope, which is a different mechanism from being hidden.
    expect(units.length).toBeLessThan(seeded('units'))
  })

  it('gives the cleaner nothing at all', async () => {
    // A cleaner holds `task.view` and three siblings. Inventory is not among
    // them, and the empty list is the grant answering, not a filter.
    expect(await unitsFor('housekeeping')).toEqual([])
  })

  it('gives the external agent nothing, which is a finding rather than a bug', async () => {
    // `sales_agent` stands on the `availability_booking` rung, so it holds
    // `availability.view`, `booking.view` and `booking.create` — and no
    // `property.view`, which is what this screen is gated on. An external
    // seller can therefore see that a date is free and cannot list the
    // inventory it belongs to. Asserted because it is surprising, and reported
    // rather than quietly widened here.
    expect(await unitsFor('sales-agent')).toEqual([])
  })

  it('gives an administrator the same inventory as the owner', async () => {
    const owner = await unitsFor('owner')
    const administrator = await unitsFor('administrator')

    expect(administrator.map((unit) => unit.id)).toEqual(
      owner.map((unit) => unit.id),
    )
  })
})

/* =========================================================== redaction == */

describe('what each reader may see of a unit', () => {
  it('shows the owner every figure', async () => {
    for (const unit of await unitsFor('owner')) {
      expect(unit.basePriceAgorot).toEqual(expect.any(Number))
      expect(unit.cleaningFeeAgorot).toEqual(expect.any(Number))
      expect(unit.depositAgorot).toEqual(expect.any(Number))
    }
  })

  it('withholds the deposit from a general manager, and only the deposit', async () => {
    // `BOOKING_DESK` carries `rate.view_public` and does not carry
    // `booking.view_deposit`. What a business holds against damage is a
    // different disclosure from what it charges for a night, and the two are
    // separate grants precisely so this can differ.
    const units = await unitsFor('general-manager')

    expect(units.length).toBeGreaterThan(0)
    for (const unit of units) {
      expect('basePriceAgorot' in unit).toBe(true)
      expect('depositAgorot' in unit).toBe(false)
    }
  })

  it('shows reception both, because reception holds the deposit grant', async () => {
    const units = await unitsFor('reception')

    expect(units.length).toBeGreaterThan(0)
    for (const unit of units) {
      expect('basePriceAgorot' in unit).toBe(true)
      expect('depositAgorot' in unit).toBe(true)
    }
  })

  it('withholds every rate from an accountant', async () => {
    // The accountant may read what was charged — `booking.view_price` — and
    // not today's rate card, which is `rate.view_public`. The distinction is
    // real: one is history and one is what the business will accept tomorrow.
    const units = await unitsFor('accountant')

    expect(units.length).toBeGreaterThan(0)
    for (const unit of units) {
      expect('basePriceAgorot' in unit).toBe(false)
      expect('cleaningFeeAgorot' in unit).toBe(false)
      expect('extraGuestPriceAgorot' in unit).toBe(false)
      expect('depositAgorot' in unit).toBe(false)
      // Everything that is not money is still there — the row is readable,
      // only the figures are withheld.
      expect(typeof unit.name).toBe('string')
      expect(Number.isInteger(unit.maxGuests)).toBe(true)
    }
  })

  it('deletes the key rather than blanking it', async () => {
    // The distinction the whole redaction model rests on: "there is no
    // deposit on this unit" and "you may not see the deposit" must not render
    // identically, and they cannot if the key is absent rather than zero.
    const [unit] = await unitsFor('accountant')

    expect(unit).toBeDefined()
    expect(unit?.depositAgorot).toBeUndefined()
    expect(Object.hasOwn(unit as object, 'depositAgorot')).toBe(false)
  })
})
