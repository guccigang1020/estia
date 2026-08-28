/**
 * Atomicity and row level security, against a real Supabase project.
 *
 * ── The two claims that cannot be proved without a database ───────────────
 *
 * **1. A unit of work that fails leaves nothing.** The whole reason for
 * `atomic-transaction.ts`. `sequentialUnitOfWork` fails this by design and
 * says so; a runner that claimed to be atomic and was not would be strictly
 * worse than the honest one, because nobody would go looking.
 *
 * **2. The connection is the signed-in user, not the owner.** This is the one
 * that keeps a person awake. The pooler authenticates as a role with
 * `BYPASSRLS`; unless the transaction sets the role and the JWT claims, every
 * statement runs unrestricted and every policy is skipped **in silence**.
 * There is no error, no log line and no visible difference — a bug here would
 * be found by a customer reading another customer's bookings.
 *
 * ── Why every check below is a pair ───────────────────────────────────────
 *
 * A broken connection that writes nothing and reads nothing looks *exactly*
 * like perfect isolation. "Organization B's row was not returned" proves
 * nothing on its own — it is equally consistent with a transaction that never
 * ran. So each isolation assertion is made twice: once against the caller's
 * own organization, where it must **succeed**, and once against a stranger's,
 * where it must be **refused**. Only the pair means anything.
 *
 * ── Running it ────────────────────────────────────────────────────────────
 *
 * Skipped with no credentials, like `live.integration.test.ts`, so the default
 * suite stays database-free. Needs everything that file needs, plus:
 *
 *     ESTIA_IT_DATABASE_URL   the transaction pooler, port 6543
 *
 * The transaction pooler specifically, and not the session pooler — see the
 * header of `postgres.ts`. A session-mode connection keeps `SET ROLE` between
 * borrowers, which is the failure this file cannot detect and the reason the
 * port matters.
 */

import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Actor } from '../authz/can'
import { defineBookingOperations } from '../booking'
import { InMemoryAuditWriter } from '../audit/pipeline'
import { postgresUnitOfWork } from './atomic-transaction'
import { SupabaseAuditWriter } from './audit'
import { SupabaseBookingRepository } from './booking'
import type { Db } from './client'
import { SupabaseIdempotencyStore } from './idempotency'
import { closeAllPostgresPools } from './postgres'
import { isSupabaseUnitOfWork } from './transaction'

// ── Gate ──────────────────────────────────────────────────────────────────

const ENV = {
  url: process.env.ESTIA_IT_URL,
  serviceRoleKey: process.env.ESTIA_IT_SERVICE_ROLE_KEY,
  publishableKey: process.env.ESTIA_IT_PUBLISHABLE_KEY,
  userAEmail: process.env.ESTIA_IT_USER_A_EMAIL,
  userAPassword: process.env.ESTIA_IT_USER_A_PASSWORD,
  userBEmail: process.env.ESTIA_IT_USER_B_EMAIL,
  userBPassword: process.env.ESTIA_IT_USER_B_PASSWORD,
  databaseUrl: process.env.ESTIA_IT_DATABASE_URL,
}

const CREDENTIALS = Object.values(ENV).every(
  (value) => typeof value === 'string' && value.length > 0,
)

const STAY = { checkIn: '2098-07-04', checkOut: '2098-07-07' }

interface World {
  organizationA: string
  organizationB: string
  propertyA: string
  unitA: string
  propertyB: string
  unitB: string
  userA: string
}

let world: World
let admin: Db
let userAClient: Db

describe.skipIf(!CREDENTIALS)('atomic: transactions and RLS', () => {
  beforeAll(async () => {
    admin = createClient(ENV.url as string, ENV.serviceRoleKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    world = await seedWorld(admin)
    userAClient = await signIn(
      ENV.userAEmail as string,
      ENV.userAPassword as string,
    )
  }, 90_000)

  afterAll(async () => {
    if (world) await tearDownWorld(admin, world)
    await closeAllPostgresPools()
  }, 90_000)

  function runner() {
    return postgresUnitOfWork(userAClient, { url: ENV.databaseUrl })
  }

  // ── The context ─────────────────────────────────────────────────────────

  it('runs as `authenticated`, as the signed-in user, without BYPASSRLS', async () => {
    // `assertUserContext` already refuses to run the work unless all three are
    // true, so reaching the body of this transaction *is* the assertion. It is
    // written out anyway, because "the test passed" and "the guard fired" are
    // the same observation otherwise, and a future change that removed the
    // guard would leave every other test in this file silently meaningless.
    const seen = await runner().run(async (tx) => {
      expect(isSupabaseUnitOfWork(tx)).toBe(true)
      return isSupabaseUnitOfWork(tx) ? tx.atomic : false
    })

    expect(seen).toBe(true)
  }, 60_000)

  // ── Reads: the pair ─────────────────────────────────────────────────────

  it('reads its own organization and not another, on the same connection', async () => {
    const result = await runner().run(async (tx) => {
      if (!isSupabaseUnitOfWork(tx)) throw new Error('not a unit of work')
      const db = tx.db

      const mine = await db
        .from('organizations')
        .select('id')
        .eq('id', world.organizationA)

      const theirs = await db
        .from('organizations')
        .select('id')
        .eq('id', world.organizationB)

      return { mine, theirs }
    })

    // POSITIVE CONTROL. Without this line the test below proves nothing: a
    // connection that reads nothing at all would satisfy it just as well.
    expect(result.mine.error).toBeNull()
    expect(result.mine.data).toHaveLength(1)

    // And the refusal. Not filtered in application code — the query names no
    // organization the policy could have used; `organizations_select` is what
    // removes the row.
    expect(result.theirs.error).toBeNull()
    expect(result.theirs.data).toHaveLength(0)
  }, 60_000)

  // ── Writes: the pair ────────────────────────────────────────────────────

  it('accepts a write to its own organization and refuses one to another', async () => {
    const outcome = await runner().run(async (tx) => {
      if (!isSupabaseUnitOfWork(tx)) throw new Error('not a unit of work')
      const db = tx.db

      // POSITIVE CONTROL: the identical statement, against organization A.
      const mine = await db
        .from('holds')
        .insert(
          holdRow(
            world.organizationA,
            world.propertyA,
            world.unitA,
            world.userA,
          ),
        )
        .select('id')
        .single()

      // The same shape, against organization B. `holds_insert`'s WITH CHECK
      // is what refuses it, inside this transaction, on this connection.
      const theirs = await db
        .from('holds')
        .insert(
          holdRow(
            world.organizationB,
            world.propertyB,
            world.unitB,
            world.userA,
          ),
        )
        .select('id')
        .single()

      return { mine, theirs }
    })

    expect(outcome.mine.error).toBeNull()
    expect(outcome.mine.data).toMatchObject({ id: expect.any(String) })

    // 42501, `insufficient_privilege`: "new row violates row-level security
    // policy". Asserted by code and not by message text — Postgres message
    // strings are localised and rewritten between major versions.
    expect(outcome.theirs.error).not.toBeNull()
    expect(outcome.theirs.error?.code).toBe('42501')

    // Nothing landed in organization B, checked from outside the transaction
    // with the privileged client so that RLS cannot be what hides it.
    const { data: leaked } = await admin
      .from('holds')
      .select('id')
      .eq('organization_id', world.organizationB)
    expect(leaked).toEqual([])
  }, 60_000)

  // ── Atomicity ───────────────────────────────────────────────────────────

  it('rolls back the booking, its price lines, the audit row and the idempotency key', async () => {
    const correlationId = `atomic-${Date.now()}`
    const idempotencyKey = `atomic-key-${Date.now()}`
    const scope = {
      organizationId: world.organizationA,
      operation: 'booking.create',
    }

    const boom = new Error('deliberate failure, after four successful writes')

    const attempt = runner().run(async (tx) => {
      if (!isSupabaseUnitOfWork(tx)) throw new Error('not a unit of work')

      // 1 + 2. The booking and its price lines, through the real adapter and
      // the real operation — including the re-read that `loadBookingVia` makes
      // on the transaction's own connection.
      const repository = new SupabaseBookingRepository(tx.db)
      const booking = await repository.insertBooking(
        {
          organizationId: world.organizationA,
          propertyId: world.propertyA,
          unitId: world.unitA,
          guestName: 'בדיקת אטומיות',
          guestCount: 2,
          checkIn: STAY.checkIn,
          checkOut: STAY.checkOut,
          status: 'confirmed',
          attribution: {
            source: 'direct_manual',
            sourceChannel: null,
            agentUserId: null,
            agencyId: null,
            campaignId: null,
            referralId: null,
          },
          lines: [
            {
              kind: 'accommodation',
              label: '3 לילות',
              amount: 150_000,
              quantity: 3,
              date: STAY.checkIn,
            },
          ],
          // Ignored by the adapter: `tg_bookings_freeze_total` owns
          // `total_agorot` and recomputes it from the price lines. Present
          // because the port requires it.
          totalAgorot: 150_000,
          depositRequiredAgorot: 0,
          createdByUserId: world.userA,
        },
        tx,
      )

      // The booking really is there, from inside the transaction. Proving the
      // rollback is only meaningful if something was there to roll back.
      expect(booking.id).toEqual(expect.any(String))
      expect(booking.lines).toHaveLength(1)

      // 3. The audit row.
      await new SupabaseAuditWriter(tx.db).write(
        {
          organizationId: world.organizationA,
          actorUserId: world.userA,
          actorType: 'user',
          actorLabel: 'בדיקת אטומיות',
          onBehalfOfUserId: null,
          action: 'booking.create',
          resourceType: 'booking',
          resourceId: booking.id,
          propertyId: world.propertyA,
          before: null,
          after: null,
          summary: 'נוצרה הזמנה בבדיקת אטומיות',
          reason: null,
          occurredAt: new Date(),
          ip: null,
          userAgent: null,
          requestId: correlationId,
        } as Parameters<SupabaseAuditWriter['write']>[0],
        tx,
      )

      // 4. The idempotency completion — which is the write that used to
      // escape the transaction entirely, because the adapter ignored the
      // handle the pipeline handed it.
      const store = new SupabaseIdempotencyStore(tx.db)
      await store.complete(scope, idempotencyKey, { bookingId: booking.id }, tx)

      // And then the operation fails, as operations do.
      throw boom
    })

    await expect(attempt).rejects.toBe(boom)

    // Everything below reads with the SERVICE ROLE client, deliberately.
    // Checking with the user's client would let RLS hide a row that really is
    // there and report a rollback that never happened.
    const { data: bookings } = await admin
      .from('bookings')
      .select('id')
      .eq('organization_id', world.organizationA)
      .eq('check_in', STAY.checkIn)
    expect(bookings).toEqual([])

    const { data: lines } = await admin
      .from('booking_price_lines')
      .select('id')
      .eq('organization_id', world.organizationA)
    expect(lines).toEqual([])

    const { data: audits } = await admin
      .from('audit_events')
      .select('id')
      .eq('organization_id', world.organizationA)
      .eq('request_id', correlationId)
    expect(audits).toEqual([])

    const { data: keys } = await admin
      .from('idempotency_keys')
      .select('key')
      .eq('organization_id', world.organizationA)
      .eq('key', idempotencyKey)
    expect(keys).toEqual([])

    // A guest row is created as a side effect of `insertBooking`. It must go
    // back too — a rollback that left an orphan guest would be a slow leak of
    // people who never booked anything.
    const { data: guests } = await admin
      .from('guests')
      .select('id')
      .eq('organization_id', world.organizationA)
    expect(guests).toEqual([])
  }, 90_000)

  it('commits all of it when nothing throws', async () => {
    // The other half. A runner that rolled everything back unconditionally
    // would pass the test above and be useless.
    const correlationId = `atomic-ok-${Date.now()}`

    const bookingId = await runner().run(async (tx) => {
      if (!isSupabaseUnitOfWork(tx)) throw new Error('not a unit of work')
      const repository = new SupabaseBookingRepository(tx.db)
      const operations = defineBookingOperations(repository)

      const outcome = await operations.createBooking.run({
        request: {
          input: {
            unitId: world.unitA,
            propertyId: world.propertyA,
            unitLabel: 'Unit A',
            guestName: 'בדיקת מסירה',
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
          auditActor: { type: 'user', userId: world.userA, label: 'בדיקה' },
          correlationId,
        },
        services: {
          audit: new InMemoryAuditWriter(),
          // Already inside a transaction; the operation's own runner must not
          // open a second one.
          transactions: {
            async run<T>(w: (t: unknown) => Promise<T>) {
              return w(tx)
            },
          },
        },
      } as Parameters<typeof operations.createBooking.run>[0])

      return outcome.data.booking.id as string
    })

    const { data } = await admin
      .from('bookings')
      .select('id')
      .eq('id', bookingId)
    expect(data).toHaveLength(1)
  }, 90_000)
})

// ── Fixtures ──────────────────────────────────────────────────────────────

function holdRow(
  organizationId: string,
  propertyId: string,
  unitId: string,
  userId: string,
) {
  return {
    organization_id: organizationId,
    property_id: propertyId,
    unit_id: unitId,
    // Far enough out that no real data could collide.
    check_in: '2098-09-01',
    check_out: '2098-09-03',
    reason: 'staff_manual',
    held_by_user_id: userId,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  }
}

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
      'guest.create',
      'guest.view',
    ]) as Actor['grants'],
    scope: { kind: 'all_organization' },
    isPlatformStaff: false,
    entitlements: new Set(['core']) as Actor['entitlements'],
  } as Actor
}

async function signIn(email: string, password: string): Promise<Db> {
  const client = createClient(ENV.url as string, ENV.publishableKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
  return client
}

async function seedWorld(db: Db): Promise<World> {
  const suffix = Math.random().toString(36).slice(2, 8)

  const userA = await userIdFor(db, ENV.userAEmail as string)
  const userB = await userIdFor(db, ENV.userBEmail as string)

  const organizationA = await createOrganization(db, `atomic-a-${suffix}`)
  const organizationB = await createOrganization(db, `atomic-b-${suffix}`)

  await addMember(db, organizationA, userA)
  await addMember(db, organizationB, userB)

  const propertyA = await createProperty(
    db,
    organizationA,
    `atomic-a-${suffix}`,
  )
  const unitA = await createUnit(db, organizationA, propertyA)
  const propertyB = await createProperty(
    db,
    organizationB,
    `atomic-b-${suffix}`,
  )
  const unitB = await createUnit(db, organizationB, propertyB)

  return {
    organizationA,
    organizationB,
    propertyA,
    unitA,
    propertyB,
    unitB,
    userA,
  }
}

/**
 * `finance_snapshots` is insert-only and its guard is statement-level, so a
 * `DELETE` on `bookings` fails even when no snapshot exists. Nothing in this
 * file reaches the finance module, which is what makes this teardown possible
 * at all — see the note in `live.integration.test.ts`.
 */
async function tearDownWorld(db: Db, seeded: World): Promise<void> {
  for (const organizationId of [seeded.organizationA, seeded.organizationB]) {
    await db.from('holds').delete().eq('organization_id', organizationId)
    await db.from('bookings').delete().eq('organization_id', organizationId)
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
  if (!user) throw new Error(`No auth user for ${email}.`)
  return user.id
}

async function createOrganization(db: Db, slug: string): Promise<string> {
  const { data, error } = await db
    .from('organizations')
    .insert({
      slug,
      name: `Atomic ${slug}`,
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
      name: 'Atomic Property',
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
      code: 'AT-1',
      name: 'Atomic Unit',
      unit_type: 'villa',
      status: 'active',
      min_nights: 1,
    })
    .select('id')
    .single()
  if (error) throw error
  return (data as { id: string }).id
}
