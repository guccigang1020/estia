/**
 * The roster read, walked the way the product walks it.
 *
 * The team screen is one of the two places in this section where an
 * over-broad read is most damaging — the other is the audit trail — so what is
 * asserted here is mostly what each persona does *not* get back.
 *
 * The queries run over `createDemoClient(DEMO_DATASET)`: ten memberships, ten
 * role assignments, ten scope rows, three teams and two properties. Nothing
 * demo-specific is substituted for the modules under test; only the client
 * underneath them is different, and it enforces no row level security at all
 * — which is stated in its own header and is worth repeating, because it means
 * everything asserted below is the *application* floor doing the work.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import type { Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { DemoActorSource } from '@/lib/demo/session'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'

import {
  countMembers,
  listMembers,
  listScopeChoices,
  membersNeedingAttention,
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

async function rosterFor(personaId: string) {
  return listMembers({
    db: client(),
    actor: await actorFor(personaId),
    organizationId: ORGANIZATION,
  })
}

function seeded(table: string): number {
  return DEMO_DATASET.tables[table]?.length ?? 0
}

/* ================================================================ list == */

describe('the roster', () => {
  it('serves the owner every membership in the organization', async () => {
    const members = await rosterFor('owner')

    expect(members).toHaveLength(seeded('memberships'))
    expect(members.length).toBeGreaterThanOrEqual(10)

    for (const member of members) {
      expect(typeof member.membershipId).toBe('string')
      expect(typeof member.userId).toBe('string')
      // The profile join is the part a wrong column name breaks silently: the
      // roster still renders, with every person shown as unnamed.
      expect(typeof member.fullName).toBe('string')
      expect(typeof member.status).toBe('string')
    }
  })

  it('resolves every membership to at least one named role', async () => {
    // A membership with no roles is legitimate and resolves to an actor
    // holding nothing — this dataset simply has none, and if it grew one the
    // screen would say so rather than showing a blank cell.
    for (const member of await rosterFor('owner')) {
      expect(member.roles.length).toBeGreaterThan(0)
      for (const role of member.roles) {
        expect(typeof role.code).toBe('string')
        // The Hebrew name comes from `public.roles`, not from this screen.
        expect(role.name.length).toBeGreaterThan(0)
        expect(role.name).not.toBe(role.code)
      }
    }
  })

  it('names the scope of each membership from rows, never from an id', async () => {
    const members = await rosterFor('owner')

    const scoped = members.filter(
      (member) => member.scope.scope.kind === 'properties',
    )
    const teamScoped = members.filter(
      (member) => member.scope.scope.kind === 'team',
    )

    // The dataset narrows the property manager and the external agent to one
    // property, and the two cleaners plus the handyman to a team. Both are
    // what makes switching persona change which rows exist.
    expect(scoped.length).toBeGreaterThan(0)
    expect(teamScoped.length).toBeGreaterThan(0)

    for (const member of [...scoped, ...teamScoped]) {
      expect(member.scope.names.length).toBeGreaterThan(0)
      // Nothing unresolvable, so nothing had to be counted instead of named.
      expect(member.scope.unresolvedCount).toBe(0)
    }
  })

  it('counts what exists, so an empty screen can be told from an empty read', async () => {
    expect(await countMembers(client(), ORGANIZATION)).toBe(
      seeded('memberships'),
    )
  })
})

/* ============================================================== status == */

describe('membership status', () => {
  it('reads the status off the row and refuses an unknown one', async () => {
    const members = await rosterFor('owner')
    for (const member of members) {
      expect([
        'invited',
        'pending',
        'active',
        'suspended',
        'removed',
      ]).toContain(member.status)
    }
  })

  it('gives every active membership a joining date, as the constraint demands', async () => {
    // `memberships_joined_when_active`: an active membership must say when it
    // became one, because that is what an audit trail dates from.
    for (const member of await rosterFor('owner')) {
      if (member.status === 'active') expect(member.joinedAt).not.toBeNull()
    }
  })

  it('finds nothing needing attention in this dataset, and says so honestly', async () => {
    // Every seeded membership is `active`. This is a gap in the demo dataset,
    // not in the screen: the four statuses that mean somebody is waiting —
    // invited, pending, suspended, removed — have no row here to render. The
    // assertion is written as an equality so that seeding one later turns this
    // into a failure that has to be looked at rather than a silent pass.
    expect(membersNeedingAttention(await rosterFor('owner'))).toEqual([])
  })
})

/* =============================================================== reach == */

describe('who may read the roster at all', () => {
  it('gives the cleaner nothing', async () => {
    // A cleaner holds `task.view` and three siblings. `user.view` is not among
    // them, and the empty roster is the grant answering.
    expect(await rosterFor('housekeeping')).toEqual([])
  })

  it('gives the accountant nothing', async () => {
    // Read-and-export over money, and no authority over people. The two are
    // deliberately unrelated in the catalogue.
    expect(await rosterFor('accountant')).toEqual([])
  })

  it('gives the external agent nothing', async () => {
    expect(await rosterFor('sales-agent')).toEqual([])
  })

  it('gives the property manager the whole roster, and that is deliberate', async () => {
    // A property-scoped membership that holds `user.view` sees everybody,
    // because a person is not located in a property: `memberships_select`
    // carries no scope either. Asking the scope question here would return an
    // empty screen behind a menu entry that correctly offers this route.
    const members = await rosterFor('property-manager')
    expect(members).toHaveLength(seeded('memberships'))
  })
})

/* =========================================================== redaction == */

describe('what a reader may see of a colleague', () => {
  it('shows the owner the telephone numbers', async () => {
    const members = await rosterFor('owner')

    expect(members.every((member) => 'phone' in member)).toBe(true)
    expect(members.some((member) => typeof member.phone === 'string')).toBe(
      true,
    )
  })

  it('withholds them from a general manager, who may invite but not edit', async () => {
    // `general_manager` holds `user.view` and `user.invite` and neither
    // `user.edit` nor `role.assign` — written out in `roles.ts`, because
    // whoever runs the sellers must not be able to change an administrator's
    // membership. The roster is theirs; the contact details are not.
    const members = await rosterFor('general-manager')

    expect(members.length).toBeGreaterThan(0)
    for (const member of members) {
      expect('phone' in member).toBe(false)
      // Everything the screen needs to assign work is still there.
      expect(typeof member.fullName).toBe('string')
      expect(member.roles.length).toBeGreaterThan(0)
    }
  })

  it('deletes the key rather than blanking it', async () => {
    const [member] = await rosterFor('general-manager')

    expect(member).toBeDefined()
    expect(Object.hasOwn(member as object, 'phone')).toBe(false)
  })

  it('never carries an e-mail address, because no readable table has one', async () => {
    // `public.user_profiles` has no e-mail column — the address lives in
    // `auth.users`, which no customer-facing query may read. A screen printing
    // the persona e-mail from `DEMO_PERSONAS` would be printing a value that
    // exists in the demo switcher and in no database.
    for (const member of await rosterFor('owner')) {
      expect(Object.keys(member)).not.toContain('email')
    }
  })
})

/* ============================================================= choices == */

describe('the scope choices offered to an invitation', () => {
  it('offers the properties and teams this reader can actually read', async () => {
    const choices = await listScopeChoices(client(), ORGANIZATION)

    expect(choices.properties).toHaveLength(seeded('properties'))
    expect(choices.teams).toHaveLength(seeded('teams'))
    for (const choice of [...choices.properties, ...choices.teams]) {
      expect(typeof choice.id).toBe('string')
      expect(choice.name.length).toBeGreaterThan(0)
    }
  })
})
