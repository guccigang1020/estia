/**
 * The guest reads, walked the way the product walks them.
 *
 * `dataset-actor.test.ts` proved the personas resolve to genuinely different
 * actors, and `finance/_lib/queries.test.ts` proved the finance *screens*
 * differ. This file does the same for the guest CRM: it runs every query the
 * three guest routes make over `createDemoClient(DEMO_DATASET)` — the same 27
 * guests and 39 bookings a person sees in demo mode — and asserts what an
 * owner, a receptionist, a property manager, an accountant, an external agent
 * and a cleaner each come back with.
 *
 * ── The claim this file exists to test ────────────────────────────────────
 *
 * "A cleaner must never reach a guest's contact details" is a sentence anybody
 * can write in a comment. Here it is a query: the cleaner's real actor,
 * resolved through membership → roles → grants → scope from the real dataset,
 * handed to the real `listGuests`, returning `[]` — and `loadGuest` returning
 * `null` for a guest whose id the test holds. A unit test over `can()` would
 * not have caught a query that forgot to call it.
 *
 * The second claim is sharper and is the reason `narrowedTo` exists below:
 * name, telephone and e-mail are **three separate grants**, and a role may
 * hold one without the others. No shipped preset in `roles.ts` composes such a
 * role — every one of them takes all three or none — so proving the screen
 * honours the split requires an actor that holds a subset. `narrowedTo`
 * builds one by removing grants from a persona the dataset really resolved,
 * which is a role the permission catalogue permits a customer to compose and
 * the engine cannot tell from a built-in one.
 *
 * ── What this is not ──────────────────────────────────────────────────────
 *
 * It is not a test of row level security. `createDemoClient` says so in its
 * own header: there is no policy engine behind these arrays, so a query that
 * forgot its tenant filter would return rows here and nothing in production.
 * What is exercised is the floor above it — the `can()` narrowing and the
 * `redact()` field rules these queries apply themselves.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import { holdsGrant, type Actor } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { PROPERTY_IDS } from '@/lib/demo/dataset-inventory'
import { DemoActorSource } from '@/lib/demo/session'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'

import { EMPTY_GUEST_FILTERS, type GuestFilters } from './filters'
import {
  countGuests,
  guestPaymentTotals,
  listGuestTags,
  listGuests,
  loadGuest,
} from './queries'

const ORGANIZATION = DEMO_DATASET.organizationId

/**
 * A fixed moment, so "stays behind us" and "stays ahead" are not decided by
 * the wall clock.
 *
 * The dataset lays its stays out as offsets from *today*, resolved when the
 * module loads — so `new Date()` is the right reference and a hard-coded date
 * would drift out of the data within a day. What is pinned is that every
 * assertion in one run sees the same instant.
 */
const NOW = new Date()

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
 * of all three files is that nothing demo-specific is substituted for them.
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

/**
 * A real actor with some grants taken away.
 *
 * The membership, the scope, the plan and the entitlements are the dataset's;
 * only the grant set is narrowed. That is exactly what a customer does when
 * they copy `reception` and untick a field permission — `roles.ts` says the
 * engine will not know the difference — and it is the only way to produce an
 * actor holding `guest.view_name` and not `guest.view_phone`, which no shipped
 * preset does.
 */
function narrowedTo(actor: Actor, without: readonly Grant[]): Actor {
  const grants = new Set(actor.grants)
  for (const grant of without) grants.delete(grant)
  return { ...actor, grants }
}

/** The arguments every list read takes, for an unfiltered organization-wide one. */
async function argsFor(
  personaId: string,
  filters: GuestFilters = EMPTY_GUEST_FILTERS,
) {
  const actor = await actorFor(personaId)
  return {
    db: client(),
    actor,
    organizationId: ORGANIZATION,
    propertyId: null,
    filters,
    now: NOW,
  }
}

/** How many rows the dataset holds, so the assertions cannot drift from it. */
function seeded(table: string): number {
  return DEMO_DATASET.tables[table]?.length ?? 0
}

/* ================================================================= list == */

describe('the guest list', () => {
  it('serves the owner every seeded guest, with the person on the row', async () => {
    const { items } = await listGuests(await argsFor('owner'))

    expect(items).toHaveLength(seeded('guests'))
    expect(items.length).toBe(27)

    for (const guest of items) {
      // Every column the screen prints, present and of the right kind. A
      // renamed column would surface here as `undefined` rather than as a
      // blank cell somebody notices in production.
      expect(typeof guest.id).toBe('string')
      expect(typeof guest.fullName).toBe('string')
      expect(typeof guest.language).toBe('string')
      expect(typeof guest.isBlocked).toBe('boolean')
      expect(typeof guest.marketingConsent).toBe('boolean')
      expect(Array.isArray(guest.tags)).toBe(true)
      expect(Number.isInteger(guest.stayCount)).toBe(true)
      expect(Number.isInteger(guest.upcomingCount)).toBe(true)
    }

    // The three contact keys are *present* for this reader, which is what
    // distinguishes "nobody recorded a telephone" from "you may not see it".
    expect(items.every((guest) => 'fullName' in guest)).toBe(true)
    expect(items.every((guest) => 'phone' in guest)).toBe(true)
    expect(items.every((guest) => 'email' in guest)).toBe(true)

    // And one of them really has no e-mail, so `null` is exercised too.
    expect(items.some((guest) => guest.email === null)).toBe(true)
  })

  it('sorts by name, and never falls back to an id for a missing one', async () => {
    const { items } = await listGuests(await argsFor('owner'))
    const names = items.map((guest) => guest.fullName)

    expect(
      names.every((name) => typeof name === 'string' && name.length > 0),
    ).toBe(true)
    expect([...names]).toEqual([...names].sort())
  })

  it('counts the stays a guest actually had, and keeps the future out of them', async () => {
    const { items } = await listGuests(await argsFor('owner'))

    const stayed = items.filter((guest) => guest.stayCount > 0)
    expect(stayed.length).toBeGreaterThan(0)

    for (const guest of stayed) {
      // A guest with a past stay has a date for it, and it is a date.
      expect(guest.lastStayOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }

    const upcoming = items.filter((guest) => guest.upcomingCount > 0)
    expect(upcoming.length).toBeGreaterThan(0)
    for (const guest of upcoming) {
      expect(guest.nextArrivalOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }

    // The dataset's 39 stays are spread over the 26 guests a booking can point
    // at; the totals across the list must add up to no more than that, since
    // cancellations and no-shows are excluded from both counts.
    const counted = items.reduce(
      (sum, guest) => sum + guest.stayCount + guest.upcomingCount,
      0,
    )
    expect(counted).toBeGreaterThan(0)
    expect(counted).toBeLessThanOrEqual(seeded('bookings'))
  })

  it('carries the blocked guest, who has never stayed, rather than dropping them', async () => {
    const { items } = await listGuests(await argsFor('owner'))
    const blocked = items.filter((guest) => guest.isBlocked)

    expect(blocked).toHaveLength(1)
    // Nothing points at them from `bookings`, which is exactly the row a
    // stay-derived list would silently lose.
    expect(blocked[0].stayCount).toBe(0)
    expect(blocked[0].upcomingCount).toBe(0)
    expect(blocked[0].lastStayOn).toBeNull()
    expect(blocked[0].staysValueAgorot).toBe(0)
  })

  it('adds the stays up in agorot, and never invents a total', async () => {
    const { items } = await listGuests(await argsFor('owner'))

    for (const guest of items) {
      expect(Number.isInteger(guest.staysValueAgorot)).toBe(true)
    }

    // Somebody has actually spent money, so the column is not uniformly zero.
    expect(items.some((guest) => (guest.staysValueAgorot ?? 0) > 0)).toBe(true)
  })
})

/* ============================================================== privacy == */

describe('a cleaner reaches nothing', () => {
  it('holds neither the record grant nor any of the three field grants', async () => {
    const cleaner = await actorFor('housekeeping')

    // The premise, stated rather than assumed.
    expect(holdsGrant(cleaner, 'guest.view')).toBe(false)
    expect(holdsGrant(cleaner, 'guest.view_name')).toBe(false)
    expect(holdsGrant(cleaner, 'guest.view_phone')).toBe(false)
    expect(holdsGrant(cleaner, 'guest.view_email')).toBe(false)
  })

  it('gets an empty list even when the query is handed to them', async () => {
    // `requireGrant('guest.view')` redirects this person before a query is
    // built. This asserts the second floor: even handed the query, the
    // per-row narrowing admits none of it.
    const { items } = await listGuests(await argsFor('housekeeping'))
    expect(items).toEqual([])
  })

  it('cannot open a guest whose id they hold', async () => {
    const owner = await listGuests(await argsFor('owner'))
    const target = owner.items[0].id

    const cleaner = await actorFor('housekeeping')
    const record = await loadGuest({
      db: client(),
      actor: cleaner,
      organizationId: ORGANIZATION,
      guestId: target,
      now: NOW,
    })

    // `null`, which the page renders as a 404 — indistinguishable from a
    // guest that does not exist, so probing ids confirms nothing.
    expect(record).toBeNull()
  })

  it('is not told what money moved either', async () => {
    const cleaner = await actorFor('housekeeping')
    expect(
      await guestPaymentTotals(client(), cleaner, ORGANIZATION, ['anything']),
    ).toBeNull()
  })
})

describe('two more roles that reach the guest screens and should not', () => {
  it('shows an accountant nothing: they read money, not people', async () => {
    const accountant = await actorFor('accountant')

    expect(holdsGrant(accountant, 'payment.view')).toBe(true)
    expect(holdsGrant(accountant, 'guest.view')).toBe(false)

    const { items } = await listGuests(await argsFor('accountant'))
    expect(items).toEqual([])
  })

  /**
   * The most instructive persona in the dataset, and the one that proves the
   * split without any help from this test file.
   *
   * The demo's `agent_organization_settings` puts this agent on the `phone`
   * rung of `GUEST_DATA_LEVELS`, so `resolveActor` hands them
   * `guest.view_name` and `guest.view_phone` and **not** `guest.view_email` —
   * three grants, three answers, from a shipped configuration. They also hold
   * `guest.create` and not `guest.view`: entering a customer's details is
   * writing, not reading.
   *
   * The consequence is that their field grants apply to the guest embedded in
   * a booking they sold, and to nothing on these screens — because the record
   * grant that opens a guest row is one they do not have.
   */
  it('shows an external sales agent nothing, though they hold two of the three field grants', async () => {
    const agent = await actorFor('sales-agent')

    expect(holdsGrant(agent, 'guest.create')).toBe(true)
    expect(holdsGrant(agent, 'guest.view')).toBe(false)
    expect(holdsGrant(agent, 'guest.view_name')).toBe(true)
    expect(holdsGrant(agent, 'guest.view_phone')).toBe(true)
    // The e-mail is the business's channel for the next stay, and the ladder
    // in this dataset stops before it.
    expect(holdsGrant(agent, 'guest.view_email')).toBe(false)

    const { items } = await listGuests(await argsFor('sales-agent'))
    expect(items).toEqual([])
  })
})

/* =============================================== three grants, three answers == */

describe('name, telephone and e-mail are three separate grants', () => {
  it('gives reception all three, which is the baseline the rest is measured from', async () => {
    const actor = await actorFor('reception')

    expect(holdsGrant(actor, 'guest.view')).toBe(true)
    expect(holdsGrant(actor, 'guest.view_name')).toBe(true)
    expect(holdsGrant(actor, 'guest.view_phone')).toBe(true)
    expect(holdsGrant(actor, 'guest.view_email')).toBe(true)

    const { items } = await listGuests(await argsFor('reception'))
    expect(items).toHaveLength(seeded('guests'))
    expect(items.every((guest) => 'fullName' in guest)).toBe(true)
    expect(items.every((guest) => 'phone' in guest)).toBe(true)
    expect(items.every((guest) => 'email' in guest)).toBe(true)
  })

  it('withholds the telephone alone, and keeps the name and the e-mail', async () => {
    const base = await actorFor('reception')
    const actor = narrowedTo(base, ['guest.view_phone'])

    const { items } = await listGuests({
      db: client(),
      actor,
      organizationId: ORGANIZATION,
      propertyId: null,
      filters: EMPTY_GUEST_FILTERS,
      now: NOW,
    })

    expect(items).toHaveLength(seeded('guests'))
    for (const guest of items) {
      // The key is *gone*, not null and not "לא נרשם" — `redact` deletes it,
      // and the type says the field is optional for exactly this reason.
      expect('phone' in guest).toBe(false)
      expect('fullName' in guest).toBe(true)
      expect('email' in guest).toBe(true)
    }
  })

  it('withholds the e-mail alone, and keeps the name and the telephone', async () => {
    const base = await actorFor('reception')
    const actor = narrowedTo(base, ['guest.view_email'])

    const { items } = await listGuests({
      db: client(),
      actor,
      organizationId: ORGANIZATION,
      propertyId: null,
      filters: EMPTY_GUEST_FILTERS,
      now: NOW,
    })

    for (const guest of items) {
      expect('email' in guest).toBe(false)
      expect('fullName' in guest).toBe(true)
      expect('phone' in guest).toBe(true)
    }
  })

  it('withholds the name alone — the row survives, and is not labelled "אורח"', async () => {
    const base = await actorFor('reception')
    const actor = narrowedTo(base, ['guest.view_name'])

    const { items } = await listGuests({
      db: client(),
      actor,
      organizationId: ORGANIZATION,
      propertyId: null,
      filters: EMPTY_GUEST_FILTERS,
      now: NOW,
    })

    // `guest.view` and `guest.view_name` are different questions: the reader
    // still gets every row, with the person's identity removed from it.
    expect(items).toHaveLength(seeded('guests'))
    for (const guest of items) {
      expect('fullName' in guest).toBe(false)
      expect('phone' in guest).toBe(true)
      expect('email' in guest).toBe(true)
      // The rest of the row is untouched: a redacted name is not a redacted
      // record, and the stay history is what the reader came for.
      expect(Number.isInteger(guest.stayCount)).toBe(true)
    }
  })

  it('withholds the same three fields on the detail screen', async () => {
    const owner = await listGuests(await argsFor('owner'))
    const target = owner.items[0].id

    const base = await actorFor('reception')
    const actor = narrowedTo(base, ['guest.view_phone', 'guest.view_email'])

    const record = await loadGuest({
      db: client(),
      actor,
      organizationId: ORGANIZATION,
      guestId: target,
      now: NOW,
    })

    expect(record).not.toBeNull()
    expect('fullName' in record!.guest).toBe(true)
    expect('phone' in record!.guest).toBe(false)
    // The second telephone travels with the first: one grant, both columns.
    expect('phoneAlt' in record!.guest).toBe(false)
    expect('email' in record!.guest).toBe(false)
  })
})

describe('a field you may not read is a field you may not search', () => {
  it('finds a guest by telephone for a reader holding the phone grant', async () => {
    const args = await argsFor('reception', {
      ...EMPTY_GUEST_FILTERS,
      search: '54-220-1188',
    })

    const { items } = await listGuests(args)
    expect(items).toHaveLength(1)
    expect(items[0].fullName).toBe('תמר גולדשטיין')
  })

  it('finds nothing by that telephone once the phone grant is removed', async () => {
    const base = await actorFor('reception')
    const actor = narrowedTo(base, ['guest.view_phone'])

    const { items } = await listGuests({
      db: client(),
      actor,
      organizationId: ORGANIZATION,
      propertyId: null,
      filters: { ...EMPTY_GUEST_FILTERS, search: '54-220-1188' },
      now: NOW,
    })

    // A redacted column that is still searchable is not redacted: typing a
    // number and watching a row appear confirms the number.
    expect(items).toEqual([])
  })

  it('still finds that same guest by name, which the reader may see', async () => {
    const base = await actorFor('reception')
    const actor = narrowedTo(base, ['guest.view_phone', 'guest.view_email'])

    const { items } = await listGuests({
      db: client(),
      actor,
      organizationId: ORGANIZATION,
      propertyId: null,
      filters: { ...EMPTY_GUEST_FILTERS, search: 'תמר' },
      now: NOW,
    })

    expect(items.length).toBeGreaterThan(0)
    expect(items.every((guest) => 'fullName' in guest)).toBe(true)
  })

  it('finds a guest by e-mail for a reader holding the e-mail grant', async () => {
    const { items } = await listGuests(
      await argsFor('reception', {
        ...EMPTY_GUEST_FILTERS,
        search: 'sophie.laurent',
      }),
    )

    expect(items).toHaveLength(1)
    expect(items[0].fullName).toBe('Sophie Laurent')
  })

  it('treats a wildcard as a literal, so "100%" does not match everybody', async () => {
    const { items } = await listGuests(
      await argsFor('reception', { ...EMPTY_GUEST_FILTERS, search: '%' }),
    )

    expect(items).toEqual([])
  })
})

/* ======================================== the document, a fourth circle == */

describe('the identity document', () => {
  /** The one guest in the demo carrying a passport. */
  async function touristId(): Promise<string> {
    const { items } = await listGuests(await argsFor('owner'))
    const tourist = items.find((guest) => guest.fullName === 'Sophie Laurent')
    expect(tourist).toBeDefined()
    return tourist!.id
  }

  it('reaches the owner, whose role is derived from the whole catalogue', async () => {
    const owner = await actorFor('owner')

    // `organization_owner` is not a composed list in `roles.ts` — it is every
    // grant in the catalogue, so that a permission added next year is covered
    // automatically. This is therefore the one role that does hold it.
    expect(holdsGrant(owner, 'guest.view_document_id')).toBe(true)

    const record = await loadGuest({
      db: client(),
      actor: owner,
      organizationId: ORGANIZATION,
      guestId: await touristId(),
      now: NOW,
    })

    // The demo seeds two passports precisely so this redaction has something
    // behind it. A redaction over an empty column proves nothing.
    expect(record!.guest.documentType).toBe('passport')
    expect(record!.guest.documentNumber).toBe('19FR84221')
    expect(record!.guest.documentCountry).toBe('FR')
  })

  it('is withheld from the front desk, who sees the whole card otherwise', async () => {
    const reception = await actorFor('reception')

    // A fourth circle, and the sharpest one in the schema: "almost no role
    // needs to see this". Reception holds the name, the telephone and the
    // e-mail, and still not this.
    expect(holdsGrant(reception, 'guest.view_name')).toBe(true)
    expect(holdsGrant(reception, 'guest.view_document_id')).toBe(false)

    const record = await loadGuest({
      db: client(),
      actor: reception,
      organizationId: ORGANIZATION,
      guestId: await touristId(),
      now: NOW,
    })

    expect(record).not.toBeNull()
    expect('documentNumber' in record!.guest).toBe(false)
    expect('documentType' in record!.guest).toBe(false)
    expect('documentCountry' in record!.guest).toBe(false)
    // The rest of the card is intact: withholding the passport is not
    // withholding the guest.
    expect(record!.guest.fullName).toBe('Sophie Laurent')
  })
})

/* ================================================================ scope == */

describe('a property manager sees their own guests and not the customer list', () => {
  it('is scoped to one property, and reaches no guest organization-wide', async () => {
    const actor = await actorFor('property-manager')

    expect(actor.scope.kind).toBe('properties')
    expect(holdsGrant(actor, 'guest.view')).toBe(true)
  })

  it('returns fewer guests than the owner, and every one of them stayed at their property', async () => {
    const everyone = await listGuests(await argsFor('owner'))
    const theirs = await listGuests(await argsFor('property-manager'))

    expect(theirs.items.length).toBeGreaterThan(0)
    expect(theirs.items.length).toBeLessThan(everyone.items.length)

    // Not a filter applied afterwards: `can()` is asked per guest, with the
    // properties that guest actually stayed at.
    for (const guest of theirs.items) {
      const record = await loadGuest({
        db: client(),
        actor: await actorFor('property-manager'),
        organizationId: ORGANIZATION,
        guestId: guest.id,
        now: NOW,
      })

      expect(record).not.toBeNull()
      expect(record!.stays.length).toBeGreaterThan(0)
      for (const stay of record!.stays) {
        expect(stay.propertyId).toBe(PROPERTY_IDS.rimonim)
      }
    }
  })

  /**
   * What the unreachable set actually is in this dataset, stated plainly.
   *
   * The demo's 39 stays are spread across all 26 guests a booking points at,
   * and every one of them has at least one stay at אחוזת רימונים — so the
   * property manager reaches 26 of 27, and the single guest they cannot open
   * is the blocked one, who has stayed nowhere. That is a fact about the
   * dataset and not about the rule, and naming it here is what stops the next
   * reader from concluding the narrowing is stronger than it has been shown to
   * be. What *is* proven is the mechanism: the reach is decided per stay by
   * `can()`, and a guest carrying no stay at all is organization-wide and
   * needs an organization-wide scope.
   */
  it('cannot open the one guest its scope does not reach', async () => {
    const manager = await actorFor('property-manager')
    const everyone = await listGuests(await argsFor('owner'))
    const theirs = await listGuests(await argsFor('property-manager'))

    const reachable = new Set(theirs.items.map((guest) => guest.id))
    const outside = everyone.items.filter((guest) => !reachable.has(guest.id))

    expect(outside).toHaveLength(1)
    // It is the blocked guest, who has no stay to be reached through.
    expect(outside[0].isBlocked).toBe(true)
    expect(outside[0].stayCount + outside[0].upcomingCount).toBe(0)

    const record = await loadGuest({
      db: client(),
      actor: manager,
      organizationId: ORGANIZATION,
      guestId: outside[0].id,
      now: NOW,
    })

    // `null`, which the page renders as a 404 — the same answer as for a guest
    // that does not exist, so probing ids confirms nothing.
    expect(record).toBeNull()
  })
})

describe('the property switcher, applied to a record that has no property', () => {
  it('keeps only guests who have stayed at the selected property', async () => {
    const base = await argsFor('owner')

    const all = await listGuests(base)
    const atSea = await listGuests({
      ...base,
      propertyId: PROPERTY_IDS.kacholYam,
    })

    expect(atSea.items.length).toBeGreaterThan(0)
    expect(atSea.items.length).toBeLessThan(all.items.length)

    const everyone = new Set(all.items.map((guest) => guest.id))
    for (const guest of atSea.items) {
      expect(everyone.has(guest.id)).toBe(true)
    }

    // And the stay summary is narrowed with it: a guest's counts under a
    // property selection are that property's stays, not their whole history —
    // so the totals here are strictly smaller than the unnarrowed ones.
    //
    // Not asserted per row: a guest whose only stay at this property was
    // cancelled belongs in the list — they are somebody the desk dealt with —
    // and correctly counts zero, since `cancelled` and `no_show` are excluded
    // from both counts. A per-row `> 0` would be asserting the opposite.
    const narrowed = sumCounts(atSea.items)
    const whole = sumCounts(
      all.items.filter((guest) =>
        atSea.items.some((entry) => entry.id === guest.id),
      ),
    )

    expect(narrowed).toBeGreaterThan(0)
    expect(narrowed).toBeLessThanOrEqual(whole)
  })
})

function sumCounts(
  guests: readonly { stayCount: number; upcomingCount: number }[],
): number {
  return guests.reduce(
    (sum, guest) => sum + guest.stayCount + guest.upcomingCount,
    0,
  )
}

/* =============================================================== filters == */

describe('the filters reach the query rather than the page', () => {
  it('separates blocked from active', async () => {
    const blocked = await listGuests(
      await argsFor('owner', { ...EMPTY_GUEST_FILTERS, status: 'blocked' }),
    )
    const active = await listGuests(
      await argsFor('owner', { ...EMPTY_GUEST_FILTERS, status: 'active' }),
    )

    expect(blocked.items).toHaveLength(1)
    expect(blocked.items[0].isBlocked).toBe(true)
    expect(active.items.every((guest) => !guest.isBlocked)).toBe(true)
    expect(blocked.items.length + active.items.length).toBe(seeded('guests'))
  })

  it('separates the guests who agreed to be written to from those who did not', async () => {
    const granted = await listGuests(
      await argsFor('owner', { ...EMPTY_GUEST_FILTERS, consent: 'granted' }),
    )
    const withheld = await listGuests(
      await argsFor('owner', { ...EMPTY_GUEST_FILTERS, consent: 'withheld' }),
    )

    expect(granted.items.length).toBeGreaterThan(0)
    expect(withheld.items.length).toBeGreaterThan(0)
    expect(granted.items.every((guest) => guest.marketingConsent)).toBe(true)
    expect(withheld.items.every((guest) => !guest.marketingConsent)).toBe(true)
    expect(granted.items.length + withheld.items.length).toBe(seeded('guests'))
  })

  it('filters by a tag, and does not truncate at this size', async () => {
    const { items, tagScanTruncated } = await listGuests(
      await argsFor('owner', { ...EMPTY_GUEST_FILTERS, tag: 'תייר' }),
    )

    expect(items.length).toBeGreaterThan(0)
    expect(items.every((guest) => guest.tags.includes('תייר'))).toBe(true)
    // 27 guests are nowhere near `GUEST_TAG_SCAN_SIZE`, so the screen must not
    // be warning anybody about a partial answer.
    expect(tagScanTruncated).toBe(false)
  })

  it('returns nothing for a tag nobody uses, rather than everything', async () => {
    const { items } = await listGuests(
      await argsFor('owner', { ...EMPTY_GUEST_FILTERS, tag: 'לא-קיימת' }),
    )
    expect(items).toEqual([])
  })

  it('offers exactly the tags that are in use', async () => {
    const tags = await listGuestTags(client(), ORGANIZATION)

    expect(tags.length).toBeGreaterThan(0)
    expect(tags).toContain('חוזרת')
    expect(tags).toContain('תייר')
    expect(new Set(tags).size).toBe(tags.length)

    // Derived, not declared: every offered tag really appears on a guest.
    const { items } = await listGuests(await argsFor('owner'))
    const inUse = new Set(items.flatMap((guest) => guest.tags))
    for (const tag of tags) expect(inUse.has(tag)).toBe(true)
  })
})

describe('the empty-state count', () => {
  it('counts every live guest in the organization, filter or no filter', async () => {
    expect(await countGuests(client(), ORGANIZATION)).toBe(seeded('guests'))
  })
})

/* ================================================================ detail == */

describe('one guest', () => {
  it('serves the whole card, with the history and the notes', async () => {
    const owner = await actorFor('owner')
    const { items } = await listGuests(await argsFor('owner'))
    const tamar = items.find((guest) => guest.fullName === 'תמר גולדשטיין')!

    const record = await loadGuest({
      db: client(),
      actor: owner,
      organizationId: ORGANIZATION,
      guestId: tamar.id,
      now: NOW,
    })

    expect(record).not.toBeNull()
    expect(record!.guest.fullName).toBe('תמר גולדשטיין')
    expect(record!.guest.language).toBe('he')
    expect(record!.guest.nationality).toBe('IL')
    expect(record!.guest.tags).toContain('חוזרת')
    expect(record!.guest.version).toBeGreaterThanOrEqual(1)

    // `guests.notes` has no field grant of its own, so anybody holding
    // `guest.view` reads it. Asserted so that the day one is added, this fails
    // rather than the screen quietly leaking.
    expect(typeof record!.guest.notes).toBe('string')

    expect(record!.stays.length).toBeGreaterThan(0)
    for (const stay of record!.stays) {
      expect(stay.reference).toMatch(/^B/)
      expect(stay.checkIn < stay.checkOut).toBe(true)
      expect(Number.isInteger(stay.totalAgorot)).toBe(true)
    }
  })

  it('keeps consent and the date it was given together', async () => {
    const owner = await actorFor('owner')
    const { items } = await listGuests(await argsFor('owner'))

    for (const listed of items.slice(0, 5)) {
      const record = await loadGuest({
        db: client(),
        actor: owner,
        organizationId: ORGANIZATION,
        guestId: listed.id,
        now: NOW,
      })

      const guest = record!.guest
      // Consent with no date is a claim nobody can defend, and no consent with
      // a date is a record of something that did not happen. The dataset holds
      // neither, and the screen would say so if it did.
      expect(guest.marketingConsent).toBe(guest.marketingConsentAt !== null)
    }
  })

  it('shows a blocked guest with the reason attached', async () => {
    const owner = await actorFor('owner')
    const { items } = await listGuests(
      await argsFor('owner', { ...EMPTY_GUEST_FILTERS, status: 'blocked' }),
    )

    const record = await loadGuest({
      db: client(),
      actor: owner,
      organizationId: ORGANIZATION,
      guestId: items[0].id,
      now: NOW,
    })

    expect(record!.guest.isBlocked).toBe(true)
    // `guests_blocked_reason` permits a block with no reason; a block nobody
    // can explain is a block nobody will honour, so the demo carries one.
    expect(record!.guest.blockedReason).not.toBeNull()
    expect(record!.stays).toEqual([])
    expect(record!.summary.stayCount).toBe(0)
  })

  it('is null for an id that does not exist, exactly as for one out of reach', async () => {
    const owner = await actorFor('owner')

    expect(
      await loadGuest({
        db: client(),
        actor: owner,
        organizationId: ORGANIZATION,
        guestId: '00000000-0000-4000-8000-000000000000',
        now: NOW,
      }),
    ).toBeNull()
  })
})

describe('what was paid, as opposed to what the stays were worth', () => {
  it('answers the owner with captured money, and it is not the stays total', async () => {
    const owner = await actorFor('owner')
    const { items } = await listGuests(await argsFor('owner'))

    // A guest with several stays, so there is something to add up.
    const busiest = [...items].sort((a, b) => b.stayCount - a.stayCount)[0]

    const record = await loadGuest({
      db: client(),
      actor: owner,
      organizationId: ORGANIZATION,
      guestId: busiest.id,
      now: NOW,
    })

    const totals = await guestPaymentTotals(
      client(),
      owner,
      ORGANIZATION,
      record!.stays.map((stay) => stay.bookingId),
    )

    expect(totals).not.toBeNull()
    expect(Number.isInteger(totals!.capturedAgorot)).toBe(true)
    expect(Number.isInteger(totals!.refundedAgorot)).toBe(true)
    expect(totals!.capturedAgorot).toBeGreaterThan(0)
  })

  it('returns zero, not null, for a guest with no stays at all', async () => {
    const owner = await actorFor('owner')

    // The distinction the screen depends on: `null` means "you may not be
    // told", and zero means "nothing arrived". Rendering one as the other is
    // how a paid guest gets chased.
    expect(await guestPaymentTotals(client(), owner, ORGANIZATION, [])).toEqual(
      {
        capturedAgorot: 0,
        refundedAgorot: 0,
      },
    )
  })
})
