/**
 * The agent mapping, and the two stores that have nowhere to write.
 *
 * The interesting assertions here are the ones about *scope*: an agent reading
 * or extending a hold must be confined to their own, and a store with no table
 * must fail loudly rather than answer `null`.
 */

import { describe, expect, it } from 'vitest'

import { SupabaseAgentRepository } from './agents'
import { SchemaNotProvisionedError } from './errors'
import { FakeSupabaseClient, hasFilter } from './fake-client'
import type { AgentHoldLedgerEntry } from '../agents/holds'

const HOLD_ROW = {
  id: 'hold-1',
  organization_id: 'org-a',
  held_by_user_id: 'agent-1',
  created_at: '2026-05-01T09:00:00+00:00',
  extension_count: 2,
}

function entry(
  overrides: Partial<AgentHoldLedgerEntry> = {},
): AgentHoldLedgerEntry {
  return {
    holdId: 'hold-1',
    organizationId: 'org-a',
    agentUserId: 'agent-1',
    createdAt: '2026-05-01T09:00:00.000Z',
    extensionCount: 0,
    ...overrides,
  }
}

describe('the hold ledger is public.holds', () => {
  it('reads it from holds, scoped to the agent, without a second table', async () => {
    // 0015 folded the ledger into `holds.extension_count` precisely to delete
    // the parallel table. A second one would be a second answer to "how many
    // times has this been extended".
    const client = new FakeSupabaseClient({
      responses: { holds: { data: [HOLD_ROW] } },
    })

    const ledger = await new SupabaseAgentRepository(
      client.asDb(),
    ).loadHoldLedger('org-a', 'agent-1')

    expect(ledger).toEqual([
      {
        holdId: 'hold-1',
        organizationId: 'org-a',
        agentUserId: 'agent-1',
        createdAt: '2026-05-01T09:00:00.000Z',
        extensionCount: 2,
      },
    ])

    const read = client.queriesFor('holds')[0]
    expect(hasFilter(read, 'eq', 'held_by_user_id', 'agent-1')).toBe(true)
    expect(hasFilter(read, 'eq', 'organization_id', 'org-a')).toBe(true)
  })

  it('does not filter released or expired holds out of the ledger', async () => {
    // Deliberate, and the port says why: liveness is decided in the domain
    // against the clock, and the daily cap counts holds *started* today — a
    // hold released an hour later still happened. A `released_at is null`
    // filter here would let an agent reset their own allowance by releasing.
    const client = new FakeSupabaseClient({
      responses: { holds: { data: [] } },
    })

    await new SupabaseAgentRepository(client.asDb()).loadHoldLedger(
      'org-a',
      'agent-1',
    )

    const read = client.queriesFor('holds')[0]
    expect(hasFilter(read, 'is', 'released_at')).toBe(false)
    expect(hasFilter(read, 'gt', 'expires_at')).toBe(false)
  })

  it('names the agent when claiming a hold, so one cannot adopt another’s', async () => {
    const client = new FakeSupabaseClient({
      responses: { holds: { data: [{ ...HOLD_ROW, extension_count: 0 }] } },
    })

    await new SupabaseAgentRepository(client.asDb()).insertLedgerEntry(
      entry(),
      undefined,
    )

    const write = client.queriesFor('holds')[0]
    expect(hasFilter(write, 'eq', 'held_by_user_id', 'agent-1')).toBe(true)
  })

  it('records an extension conditionally on the count it was granted against', async () => {
    // `recordExtension` increments in memory, so the stored row is one behind
    // — the same shape as an optimistic version. Without the predicate two
    // extensions in the same second both read the old count, both pass the
    // cap in the domain and both write, and the cap becomes advisory.
    const client = new FakeSupabaseClient({
      responses: { holds: { data: [{ ...HOLD_ROW, extension_count: 3 }] } },
    })

    await new SupabaseAgentRepository(client.asDb()).saveLedgerEntry(
      entry({ extensionCount: 3 }),
      undefined,
    )

    const write = client.queriesFor('holds')[0]
    expect(hasFilter(write, 'eq', 'extension_count', 2)).toBe(true)
  })

  it('conflicts rather than silently doing nothing when the count moved', async () => {
    const client = new FakeSupabaseClient({
      responses: { holds: { data: [] } },
    })

    await expect(
      new SupabaseAgentRepository(client.asDb()).saveLedgerEntry(
        entry({ extensionCount: 3 }),
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'version_conflict' })
  })

  it('reports a hold that is not this agent’s as not found', async () => {
    // `NotFoundError` and not an authorization refusal: telling an agent that
    // a hold exists but is somebody else's is information they did not have.
    const client = new FakeSupabaseClient({
      responses: { holds: { data: [] } },
    })

    await expect(
      new SupabaseAgentRepository(client.asDb()).insertLedgerEntry(
        entry(),
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('what the schema cannot hold', () => {
  it('refuses agent settings loudly instead of answering null', async () => {
    // `null` would read as "this agent has no settings configured", which is
    // an ordinary state with an ordinary remedy. "This deployment cannot
    // store agent settings" is a migration, and the two must not look alike.
    const repository = new SupabaseAgentRepository(
      new FakeSupabaseClient().asDb(),
    )

    await expect(repository.loadSettings()).rejects.toBeInstanceOf(
      SchemaNotProvisionedError,
    )
    await expect(repository.saveSettings()).rejects.toBeInstanceOf(
      SchemaNotProvisionedError,
    )
    await expect(repository.attachExistingUser()).rejects.toBeInstanceOf(
      SchemaNotProvisionedError,
    )
    await expect(repository.insertInvitation()).rejects.toBeInstanceOf(
      SchemaNotProvisionedError,
    )
  })

  it('refuses a phone lookup rather than answering "no such user"', async () => {
    // The dangerous one. A wrong `null` here sends identity.ts down the
    // `invite_new_user` branch and creates a second identity for a person who
    // already has one — the exact failure that whole module exists to prevent.
    const repository = new SupabaseAgentRepository(
      new FakeSupabaseClient().asDb(),
    )

    const failure = await caught(repository.findUserByPhone())

    expect(failure).toBeInstanceOf(SchemaNotProvisionedError)
    expect(failure.message).toContain('user_profiles.phone')
  })

  it('does not read public.invitations as if it were an agent invitation', async () => {
    // Same name, different thing: email and a role, not a phone and two
    // permission ladders. Reading one as the other would seat an agent with
    // an access ladder nobody granted.
    const repository = new SupabaseAgentRepository(
      new FakeSupabaseClient().asDb(),
    )

    await expect(repository.findPendingInvitation()).rejects.toBeInstanceOf(
      SchemaNotProvisionedError,
    )
  })

  it('refuses to write a commission base the enum cannot hold', async () => {
    // `stay_total` is a member of COMMISSION_BASES and is not a member of
    // `public.commission_base`. Caught here, so it names the migration rather
    // than surfacing as a raw 22P02 from inside a write.
    const repository = new SupabaseAgentRepository(
      new FakeSupabaseClient().asDb(),
    )

    const failure = await caught(
      repository.saveCommission(
        { base: 'stay_total' } as Parameters<
          typeof repository.saveCommission
        >[0],
        1,
        undefined,
      ),
    )

    expect(failure).toBeInstanceOf(SchemaNotProvisionedError)
    expect(failure.message).toContain('stay_total')
  })
})

/**
 * The error a promise rejected with.
 *
 * A plain `.catch(e => e)` types as `T | unknown` and every assertion after it
 * needs a cast; this says once that the promise is expected to reject, and
 * fails the test with a useful sentence when it does not.
 */
async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('Expected the call to reject, and it resolved.')
}
