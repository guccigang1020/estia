/**
 * The adapters, against a real Supabase project.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * `booking.test.ts` and `adapters.test.ts` prove the mapping with a fake
 * client, and they cannot prove more than that. A select naming a column that
 * does not exist, an embed whose foreign key PostgREST cannot resolve, a
 * policy that silently returns nothing — every one of those compiles, passes
 * the unit suite, and fails on the first real request. Only a database can
 * catch them.
 *
 * ── It does not run by default ────────────────────────────────────────────
 *
 * The main suite is deliberately database-free — `vitest.config.mts` says so
 * at length — and nothing here changes that. Every block below is
 * `describe.skipIf(!CREDENTIALS)`, so with no credentials in the environment
 * the file loads, registers as skipped, touches no network and reads no
 * secret. CI stays green with no Supabase project.
 *
 * To run it, set:
 *
 *     ESTIA_IT_URL                   the project URL
 *     ESTIA_IT_SERVICE_ROLE_KEY      for fixtures only — see below
 *     ESTIA_IT_PUBLISHABLE_KEY       the key the adapters actually use
 *     ESTIA_IT_USER_A_EMAIL/PASSWORD a member of organization A
 *     ESTIA_IT_USER_B_EMAIL/PASSWORD a member of organization B
 *
 * The service-role key is used for **fixture setup and teardown only** —
 * creating the two organizations, their properties and units, and deleting
 * them afterwards. Every assertion below runs through a client signed in as a
 * real user, under row level security, because a test that used the admin
 * client to make its queries work would prove nothing about the queries the
 * product actually issues. That distinction is the point of the last test in
 * particular: if the reads were privileged, organization B would see
 * organization A's booking and the test would pass for the wrong reason.
 *
 * ── What it proves ────────────────────────────────────────────────────────
 *
 *   1. A booking created through the real `booking.create` operation and the
 *      real adapter lands in the database.
 *   2. A second, overlapping booking is refused — by the constraint, not by
 *      the application — and surfaces as a domain `ConflictError`.
 *   3. A same-day turnaround succeeds, because the range is half-open.
 *   4. An update against a stale version raises `ConflictError` and changes
 *      nothing.
 *   5. A user of another organization cannot read the booking at all.
 */

import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { defineBookingOperations } from '../booking'
import type { Actor } from '../authz/can'
import { ConflictError } from '../errors'
import { InMemoryAuditWriter } from '../audit/pipeline'
import { SupabaseBookingRepository } from './booking'
import type { Db } from './client'
import { sequentialUnitOfWork } from './transaction'

// ── Gate ──────────────────────────────────────────────────────────────────

const ENV = {
  url: process.env.ESTIA_IT_URL,
  serviceRoleKey: process.env.ESTIA_IT_SERVICE_ROLE_KEY,
  publishableKey: process.env.ESTIA_IT_PUBLISHABLE_KEY,
  userAEmail: process.env.ESTIA_IT_USER_A_EMAIL,
  userAPassword: process.env.ESTIA_IT_USER_A_PASSWORD,
  userBEmail: process.env.ESTIA_IT_USER_B_EMAIL,
  userBPassword: process.env.ESTIA_IT_USER_B_PASSWORD,
}

const CREDENTIALS = Object.values(ENV).every(
  (value) => typeof value === 'string' && value.length > 0,
)

// ── Fixtures ──────────────────────────────────────────────────────────────

/** A stay far enough out that no real data could collide with it. */
const STAY = { checkIn: '2099-03-10', checkOut: '2099-03-13' }
/** Begins the morning the first one ends. Must be accepted. */
const TURNAROUND = { checkIn: '2099-03-13', checkOut: '2099-03-15' }
/** Overlaps the first by two nights. Must be refused. */
const OVERLAP = { checkIn: '2099-03-11', checkOut: '2099-03-14' }

interface World {
  organizationA: string
  organizationB: string
  propertyA: string
  unitA: string
  userA: string
  userB: string
}

let world: World
let admin: Db

async function signIn(email: string, password: string) {
  const client = createClient(ENV.url as string, ENV.publishableKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
  return client
}

/**
 * An actor with everything, so the test measures the database rather than the
 * permission engine.
 *
 * `authz` has its own suite and proves refusals far better than this file
 * could. What is under test here is whether the query is right, and an actor
 * missing a grant would fail before the query ever ran — for the wrong reason.
 */
function actorFor(organizationId: string, userId: string): Actor {
  return {
    userId,
    organizationId,
    membershipStatus: 'active',
    grants: new Set([
      'booking.create',
      'booking.view',
      'booking.view_price',
      'booking.update',
      'booking.cancel',
      'guest.create',
      'guest.view',
    ]) as Actor['grants'],
    scope: { kind: 'all_organization' },
    isPlatformStaff: false,
    entitlements: new Set(['core']) as Actor['entitlements'],
  } as Actor
}

describe.skipIf(!CREDENTIALS)('live: booking persistence', () => {
  beforeAll(async () => {
    admin = createClient(ENV.url as string, ENV.serviceRoleKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    world = await seedWorld(admin, ENV)
  }, 60_000)

  afterAll(async () => {
    if (world) await tearDownWorld(admin, world)
  }, 60_000)

  it('creates a booking that actually lands in the database', async () => {
    const db = await signIn(
      ENV.userAEmail as string,
      ENV.userAPassword as string,
    )
    const repository = new SupabaseBookingRepository(db)
    const operations = defineBookingOperations(repository)

    const outcome = await operations.createBooking.run({
      request: {
        input: {
          unitId: world.unitA,
          propertyId: world.propertyA,
          unitLabel: 'Unit A',
          guestName: 'דנה לוי',
          guestCount: 2,
          checkIn: STAY.checkIn,
          checkOut: STAY.checkOut,
          status: 'confirmed',
          source: 'direct_manual',
          pricing: { baseNightlyAgorot: 50_000 },
        },
      },
      context: {
        actor: actorFor(world.organizationA, world.userA),
        auditActor: { type: 'user', userId: world.userA, label: 'דנה לוי' },
        correlationId: 'it-create-1',
      },
      services: {
        audit: new InMemoryAuditWriter(),
        transactions: sequentialUnitOfWork(db),
      },
    })

    expect(outcome.ok).toBe(true)
    const booking = outcome.data.booking

    // Not "the operation returned something" — the row is really there, read
    // back by a second client with its own session.
    const verifier = await signIn(
      ENV.userAEmail as string,
      ENV.userAPassword as string,
    )
    const { data } = await verifier
      .from('bookings')
      .select('id, status, check_in, check_out, total_agorot')
      .eq('id', booking.id)
      .single()

    expect(data).toMatchObject({
      status: 'confirmed',
      check_in: STAY.checkIn,
      check_out: STAY.checkOut,
    })
    // The total came from the price-line trigger, not from the draft.
    expect((data as { total_agorot: number }).total_agorot).toBe(
      booking.totalAgorot,
    )
    expect(booking.totalAgorot).toBeGreaterThan(0)
  }, 60_000)

  it('refuses a second overlapping booking, at the constraint', async () => {
    const db = await signIn(
      ENV.userAEmail as string,
      ENV.userAPassword as string,
    )
    const operations = defineBookingOperations(
      new SupabaseBookingRepository(db),
    )

    // `overrideAvailability` is set deliberately. Without it the availability
    // engine refuses first, and the test would prove that the *application*
    // caught the clash — which is not the guarantee under test. Skipping the
    // advisory check is what makes the write reach the database and the GiST
    // exclusion constraint decide.
    const attempt = operations.createBooking.run({
      request: {
        input: {
          unitId: world.unitA,
          propertyId: world.propertyA,
          unitLabel: 'Unit A',
          guestName: 'אורח שני',
          guestCount: 2,
          checkIn: OVERLAP.checkIn,
          checkOut: OVERLAP.checkOut,
          status: 'confirmed',
          source: 'direct_manual',
          overrideAvailability: true,
          pricing: { baseNightlyAgorot: 50_000 },
        },
      },
      context: {
        actor: actorFor(world.organizationA, world.userA),
        auditActor: { type: 'user', userId: world.userA, label: 'דנה לוי' },
        correlationId: 'it-overlap-1',
        reason: 'integration test: forcing the write to reach the constraint',
      },
      services: {
        audit: new InMemoryAuditWriter(),
        transactions: sequentialUnitOfWork(db),
      },
    })

    await expect(attempt).rejects.toBeInstanceOf(ConflictError)
  }, 60_000)

  it('accepts a same-day turnaround', async () => {
    const db = await signIn(
      ENV.userAEmail as string,
      ENV.userAPassword as string,
    )
    const operations = defineBookingOperations(
      new SupabaseBookingRepository(db),
    )

    // One guest leaves on the 13th and the next arrives that afternoon. A
    // closed range would lose a night per turnaround across the calendar; the
    // exclusion constraint uses `daterange(check_in, check_out, '[)')`, which
    // is the same half-open convention the domain uses.
    const outcome = await operations.createBooking.run({
      request: {
        input: {
          unitId: world.unitA,
          propertyId: world.propertyA,
          unitLabel: 'Unit A',
          guestName: 'אורח שלישי',
          guestCount: 2,
          checkIn: TURNAROUND.checkIn,
          checkOut: TURNAROUND.checkOut,
          status: 'confirmed',
          source: 'direct_manual',
          pricing: { baseNightlyAgorot: 50_000 },
        },
      },
      context: {
        actor: actorFor(world.organizationA, world.userA),
        auditActor: { type: 'user', userId: world.userA, label: 'דנה לוי' },
        correlationId: 'it-turnaround-1',
      },
      services: {
        audit: new InMemoryAuditWriter(),
        transactions: sequentialUnitOfWork(db),
      },
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.data.booking.checkIn).toBe(TURNAROUND.checkIn)
  }, 60_000)

  it('raises a conflict for a stale version, and changes nothing', async () => {
    const db = await signIn(
      ENV.userAEmail as string,
      ENV.userAPassword as string,
    )
    const repository = new SupabaseBookingRepository(db)

    const { data: rows } = await db
      .from('bookings')
      .select('id, status, version')
      .eq('organization_id', world.organizationA)
      .eq('check_in', STAY.checkIn)
      .limit(1)

    const target = (rows ?? [])[0] as {
      id: string
      status: string
      version: number
    }
    expect(target).toBeDefined()

    const failure = await repository
      .updateBooking({
        bookingId: target.id,
        patch: { status: 'cancelled' },
        // Deliberately behind. Somebody else wrote first.
        expectedVersion: target.version - 1,
        tx: undefined,
      })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ConflictError)

    // The half that matters more: nothing moved. A conditional update that
    // matched no rows and was reported as success would be a lost update.
    const after = await repository.loadBooking(world.organizationA, target.id)
    expect(after?.status).toBe(target.status)
    expect(after?.version).toBe(target.version)
  }, 60_000)

  it('hides the booking from a user of another organization', async () => {
    const dbA = await signIn(
      ENV.userAEmail as string,
      ENV.userAPassword as string,
    )
    const { data: rows } = await dbA
      .from('bookings')
      .select('id')
      .eq('organization_id', world.organizationA)
      .limit(1)
    const bookingId = ((rows ?? [])[0] as { id: string }).id

    // A real session for a real member of a different organization. Not the
    // admin client, and not a filter applied afterwards: the policy is what is
    // under test, and the query deliberately does not name an organization.
    const dbB = await signIn(
      ENV.userBEmail as string,
      ENV.userBPassword as string,
    )
    const { data, error } = await dbB
      .from('bookings')
      .select('id')
      .eq('id', bookingId)

    expect(error).toBeNull()
    expect(data).toEqual([])

    // And through the adapter, which is how the product would ask.
    const throughAdapter = await new SupabaseBookingRepository(dbB).loadBooking(
      world.organizationB,
      bookingId,
    )
    expect(throughAdapter).toBeNull()
  }, 60_000)
})

// ── Fixture plumbing ──────────────────────────────────────────────────────

/**
 * Two organizations, each with one member, one property and one unit.
 *
 * Built with the service-role client because there is no signed-in user who
 * could create an organization they are not yet a member of — the bootstrap
 * problem every multi-tenant system has. Nothing else in this file uses it.
 */
async function seedWorld(db: Db, env: typeof ENV): Promise<World> {
  const suffix = Math.random().toString(36).slice(2, 8)

  const userA = await userIdFor(db, env.userAEmail as string)
  const userB = await userIdFor(db, env.userBEmail as string)

  const organizationA = await createOrganization(db, `it-a-${suffix}`)
  const organizationB = await createOrganization(db, `it-b-${suffix}`)

  await addMember(db, organizationA, userA)
  await addMember(db, organizationB, userB)

  const propertyA = await createProperty(db, organizationA, `it-a-${suffix}`)
  const unitA = await createUnit(db, organizationA, propertyA)

  return { organizationA, organizationB, propertyA, unitA, userA, userB }
}

/**
 * Remove everything the fixtures created.
 *
 * Two live discoveries are baked into the order and the caveat below.
 *
 * `booking_status_history` is append-only and refuses a direct `DELETE`, so it
 * has to go with its parent booking's cascade rather than first.
 *
 * `finance_snapshots` is *insert-only* and its guard is a statement-level
 * trigger, which means deleting a booking fails even when the booking has no
 * snapshot — the cascade attempts the delete and the trigger refuses it. So
 * this teardown works only for bookings that never reached the finance module.
 * A future test that commits a finance snapshot cannot clean up after itself
 * at all, and will need a dedicated fixture organization that is dropped
 * wholesale.
 */
async function tearDownWorld(db: Db, seeded: World): Promise<void> {
  for (const organizationId of [seeded.organizationA, seeded.organizationB]) {
    await db.from('bookings').delete().eq('organization_id', organizationId)
    await db.from('holds').delete().eq('organization_id', organizationId)
    await db.from('guests').delete().eq('organization_id', organizationId)
    await db.from('units').delete().eq('organization_id', organizationId)
    await db.from('properties').delete().eq('organization_id', organizationId)
    await db.from('memberships').delete().eq('organization_id', organizationId)
    await db.from('organizations').delete().eq('id', organizationId)
  }
}

async function userIdFor(db: Db, email: string): Promise<string> {
  const { data, error } = await db.auth.admin.listUsers()
  if (error) throw error
  const user = data.users.find((candidate) => candidate.email === email)
  if (!user) {
    throw new Error(
      `No auth user for ${email}. The integration fixtures attach memberships ` +
        `to users that already exist; they never create accounts.`,
    )
  }
  return user.id
}

async function createOrganization(db: Db, slug: string): Promise<string> {
  const { data, error } = await db
    .from('organizations')
    .insert({
      slug,
      name: `Integration ${slug}`,
      business_type: 'villa',
      country: 'IL',
      timezone: 'Asia/Jerusalem',
      currency: 'ILS',
      locale: 'he',
      status: 'active',
    })
    .select('id')
    .single()
  if (error) throw error
  return (data as { id: string }).id
}

async function addMember(
  db: Db,
  organizationId: string,
  userId: string,
): Promise<void> {
  const { data, error } = await db
    .from('memberships')
    .insert({
      organization_id: organizationId,
      user_id: userId,
      status: 'active',
      // Required. `memberships_joined_when_active` refuses an active membership
      // with no join date — found by hitting it against the live project, not
      // by reading the migration.
      joined_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (error) throw error

  const { data: role, error: roleError } = await db
    .from('roles')
    .select('id')
    .eq('code', 'organization_owner')
    .is('organization_id', null)
    .single()
  if (roleError) throw roleError

  // Owner, and scoped to the whole organization. The permission engine is
  // tested elsewhere; here it must simply not be the thing that fails.
  const membershipId = (data as { id: string }).id
  await db.from('membership_roles').insert({
    membership_id: membershipId,
    organization_id: organizationId,
    role_id: (role as { id: string }).id,
  })
  await db.from('membership_scopes').insert({
    membership_id: membershipId,
    organization_id: organizationId,
    kind: 'all_organization',
  })
}

async function createProperty(
  db: Db,
  organizationId: string,
  slug: string,
): Promise<string> {
  const { data, error } = await db
    .from('properties')
    .insert({
      organization_id: organizationId,
      slug,
      name: 'Integration Property',
      property_type: 'villa',
      status: 'active',
      country: 'IL',
      timezone: 'Asia/Jerusalem',
      currency: 'ILS',
    })
    .select('id')
    .single()
  if (error) throw error
  return (data as { id: string }).id
}

async function createUnit(
  db: Db,
  organizationId: string,
  propertyId: string,
): Promise<string> {
  const { data, error } = await db
    .from('units')
    .insert({
      organization_id: organizationId,
      property_id: propertyId,
      code: 'IT-1',
      name: 'Integration Unit',
      unit_type: 'villa',
      // `active`, because `loadRules` returns null for anything else and the
      // availability engine then refuses to vouch for the unit at all.
      status: 'active',
      min_nights: 1,
    })
    .select('id')
    .single()
  if (error) throw error
  return (data as { id: string }).id
}
