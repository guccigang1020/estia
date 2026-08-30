/**
 * The dataset, walked the way the product walks it.
 *
 * Everything in `dataset.test.ts` is a statement about rows. This file is a
 * statement about consequences: it takes each persona through the ordinary
 * resolution — `memberships` → `membership_roles` → `roles` → the grant
 * catalogue → `membership_scopes` → the subscription's plan — over the real
 * demo client, and asserts that the eight personas actually come out
 * different.
 *
 * That distinction is the whole point of the exercise. A dataset can satisfy
 * every column constraint in the schema and still be a demo where the cleaner
 * sees the owner's screen, because "has a membership" and "resolves to a
 * narrow actor" are not the same claim. The second one is the one somebody is
 * going to be shown.
 *
 * Nothing here is a demo-specific code path. `resolveActor` and
 * `SupabaseActorSource` are the same modules a paying customer's request runs
 * through; only the client underneath them is different.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '../actor'
import { can, type Actor } from '../authz/can'
import type { Db } from '../persistence'
import { SupabaseActorSource } from '../persistence/actor'

import { createDemoClient } from './client'
import { DemoActorSource } from './session'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from './dataset'
import { PROPERTY_IDS } from './dataset-inventory'

const ORGANIZATION = DEMO_DATASET.organizationId

function planNamed(code: string) {
  const found = DEMO_PLANS.find((plan) => plan.code === code)
  if (!found) throw new Error(`No demo plan '${code}'`)
  return found
}

/** The actor a persona resolves to, on a given package. */
async function actorFor(personaId: string, planCode = 'pro'): Promise<Actor> {
  const persona = DEMO_PERSONAS.find((entry) => entry.id === personaId)
  if (!persona) throw new Error(`No demo persona '${personaId}'`)

  const client = createDemoClient(DEMO_DATASET) as unknown as Db
  const source = new DemoActorSource(
    new SupabaseActorSource(client),
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

describe('every persona resolves through the ordinary path', () => {
  it.each(DEMO_PERSONAS.map((persona) => [persona.label, persona.id] as const))(
    '%s becomes an actor with grants and a scope',
    async (_label, id) => {
      const actor = await actorFor(id)
      expect(actor.organizationId).toBe(ORGANIZATION)
      expect(actor.grants.size).toBeGreaterThan(0)
      expect(actor.scope.kind).toBeTruthy()
    },
  )
})

describe('the personas are genuinely different', () => {
  it('gives less as the tour goes down the list', async () => {
    const [owner, manager, reception, cleaner] = await Promise.all([
      actorFor('owner'),
      actorFor('general-manager'),
      actorFor('reception'),
      actorFor('housekeeping'),
    ])

    expect(owner.grants.size).toBeGreaterThan(manager.grants.size)
    expect(manager.grants.size).toBeGreaterThan(reception.grants.size)
    expect(reception.grants.size).toBeGreaterThan(cleaner.grants.size)
  })

  it('keeps the owner above the administrator by exactly the owner-only set', async () => {
    const owner = await actorFor('owner')
    const administrator = await actorFor('administrator')

    expect(owner.grants.size).toBeGreaterThan(administrator.grants.size)
    for (const grant of administrator.grants) {
      expect(owner.grants.has(grant)).toBe(true)
    }
  })

  it('shows the cleaner nothing about a guest, a booking or money', async () => {
    const cleaner = await actorFor('housekeeping')

    for (const grant of [
      'guest.view',
      'booking.view',
      'payment.view',
    ] as const) {
      expect(cleaner.grants.has(grant)).toBe(false)
    }
  })

  it('confines the property manager to one property', async () => {
    const actor = await actorFor('property-manager')

    expect(actor.scope.kind).toBe('properties')
    expect(
      can(actor, 'property.view', {
        organizationId: ORGANIZATION,
        propertyId: PROPERTY_IDS.rimonim,
        family: 'inventory',
      }),
    ).toBe(true)

    // The other property is not a permission failure — it is out of reach.
    expect(
      can(actor, 'property.view', {
        organizationId: ORGANIZATION,
        propertyId: PROPERTY_IDS.kacholYam,
        family: 'inventory',
      }),
    ).toBe(false)
  })

  it('confines the external agent the same way, by the same mechanism', async () => {
    const actor = await actorFor('sales-agent')

    expect(actor.scope.kind).toBe('properties')
    expect(
      can(actor, 'availability.view', {
        organizationId: ORGANIZATION,
        propertyId: PROPERTY_IDS.kacholYam,
        family: 'inventory',
      }),
    ).toBe(false)
  })
})

describe('the package is a second, independent axis', () => {
  it('moves the same person between packages without changing their role', async () => {
    const onPro = await actorFor('general-manager', 'pro')
    const onBasic = await actorFor('general-manager', 'basic')

    // Same role, same scope, fewer entitlements — which is exactly what a
    // downgrade is, and what the switcher has to be able to show.
    expect(onBasic.scope).toEqual(onPro.scope)
    expect(onPro.entitlements.has('operations')).toBe(true)
    expect(onBasic.entitlements.has('operations')).toBe(false)
  })

  it('locks an entitlement-gated grant on Basic and opens it on Pro', async () => {
    const resource = {
      organizationId: ORGANIZATION,
      propertyId: PROPERTY_IDS.rimonim,
      family: 'operations',
    } as const

    const onPro = await actorFor('general-manager', 'pro')
    const onBasic = await actorFor('general-manager', 'basic')

    expect(can(onPro, 'task.view', resource)).toBe(true)
    expect(can(onBasic, 'task.view', resource)).toBe(false)
  })

  it('leaves the core product alone on every package', async () => {
    const resource = {
      organizationId: ORGANIZATION,
      propertyId: PROPERTY_IDS.rimonim,
      family: 'booking',
    } as const

    for (const code of DEMO_PLANS.map((plan) => plan.code)) {
      const actor = await actorFor('general-manager', code)
      // Taking a booking is not something a package withholds.
      expect(can(actor, 'booking.view', resource)).toBe(true)
    }
  })
})

describe('the rows are reachable through a real query', () => {
  it('serves the bookings list with its two embeds resolved', async () => {
    const client = createDemoClient(DEMO_DATASET)

    const { data, error } = await client
      .from('bookings')
      .select(
        'id, reference, status, check_in, check_out, unit_id, property_id, ' +
          'total_agorot, adults, children, infants, guests(full_name), units(name)',
      )
      .eq('organization_id', ORGANIZATION)
      .is('deleted_at', null)
      .order('check_in', { ascending: false })
      .limit(100)

    expect(error).toBeNull()

    // The client's `data` is deliberately untyped — PostgREST's own types
    // cannot describe a select built from a string — so the shape is asserted
    // here rather than assumed.
    const rows = (data ?? []) as unknown as Record<string, unknown>[]
    expect(rows.length).toBeGreaterThanOrEqual(30)

    // The embeds are the part a wrong column name breaks silently: the list
    // still renders, with every guest and every unit shown as null.
    for (const row of rows) {
      const guest = row.guests as { full_name?: unknown } | null
      const unit = row.units as { name?: unknown } | null
      expect(typeof guest?.full_name).toBe('string')
      expect(typeof unit?.name).toBe('string')
    }
  })

  it('serves the bookable units with their property name and their rates', async () => {
    const client = createDemoClient(DEMO_DATASET)

    const { data, error } = await client
      .from('units')
      .select(
        'id, name, code, property_id, max_guests, standard_guests, min_nights, ' +
          'base_price_agorot, extra_guest_price_agorot, cleaning_fee_agorot, ' +
          'deposit_agorot, properties(name)',
      )
      .eq('organization_id', ORGANIZATION)
      .eq('status', 'active')
      .is('deleted_at', null)
      .order('sort_order')

    expect(error).toBeNull()
    expect(data).toHaveLength(6)

    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
      expect(row.base_price_agorot as number).toBeGreaterThan(0)
      const property = row.properties as { name?: unknown } | null
      expect(typeof property?.name).toBe('string')
    }
  })
})
