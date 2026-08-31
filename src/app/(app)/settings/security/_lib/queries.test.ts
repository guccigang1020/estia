/**
 * The security reads, walked over the demo dataset.
 *
 * Two kinds of assertion here, and the second kind is the reason the file
 * exists.
 *
 * The ordinary kind checks that the panels return what they should per persona.
 * The other kind reads the *source of this module* and asserts that no
 * credential column is named in any query — because "we do not select the token"
 * is a promise a future edit breaks silently, and the only way to keep it is to
 * fail the build when somebody adds the column back.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import { holdsGrant, type Actor } from '@/lib/authz/can'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { DemoActorSource } from '@/lib/demo/session'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'

import { MEMBERSHIP_STATUS_LABEL, SECRET_COPY } from './labels'
import {
  listMemberSecurity,
  listOutstandingInvitations,
  loadAccountSecurity,
  loadSecretHoldings,
  mfaCoverage,
  type SecurityArgs,
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

async function argsFor(personaId: string): Promise<SecurityArgs> {
  return {
    db: client(),
    actor: await actorFor(personaId),
    organizationId: ORGANIZATION,
  }
}

/* ============================================== the promise, enforced === */

describe('no credential column is ever selected', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./queries.ts', import.meta.url)),
    'utf8',
  )

  it('never names a secret-bearing column in this module', () => {
    // The whole point of not masking is that the value never leaves the
    // database. A future edit that adds `token_hash` back to a select would be
    // invisible in review and catastrophic in a log line, so it fails here.
    //
    // The names appear in prose above the queries, so the check is against a
    // select-shaped occurrence rather than the bare word.
    const selects = [...source.matchAll(/\.select\(([\s\S]*?)\)\s*\n/g)].map(
      (match) => match[1],
    )
    expect(selects.length).toBeGreaterThan(0)

    for (const select of selects) {
      expect(select).not.toContain('token_hash')
      expect(select).not.toContain('guest_token')
      expect(select).not.toContain('password')
      expect(select).not.toContain('secret')
      // `select('*')` would sweep every column in, including the ones above.
      expect(select).not.toMatch(/['"`]\s*\*\s*['"`]/)
    }
  })

  it('reads nothing from the auth schema, which is not exposed anyway', () => {
    // Code-shaped occurrences only. The header above the queries discusses
    // `auth.sessions` at length precisely to explain why there is no session
    // list, and a bare substring check would fail on its own explanation.
    expect(source).not.toContain(".from('auth")
    expect(source).not.toContain('.schema(')
    expect(source).not.toMatch(/\.rpc\(\s*['"]/)
  })
})

/* =========================================================== the account == */

describe('the signed-in account', () => {
  it('reports the owner’s own membership and profile', async () => {
    const account = await loadAccountSecurity(await argsFor('owner'))

    expect(account).not.toBeNull()
    expect(account?.membershipStatus).toBe('active')
    expect(account?.joinedAt).not.toBeNull()
    expect(account?.lastActiveAt).not.toBeNull()
    expect(account?.fullName).not.toBeNull()
  })

  it('reports MFA as a policy fact and not as an account fact', async () => {
    const [owner, reception] = await Promise.all([
      loadAccountSecurity(await argsFor('owner')),
      loadAccountSecurity(await argsFor('reception')),
    ])

    // The dataset imposes a second factor on the owner and on nobody else, so
    // both readings are exercised.
    expect(owner?.mfaEnforcedAt).not.toBeNull()

    // `user_profiles.mfa_enforced_at`'s own column comment: null means the
    // requirement has not been imposed, NOT that MFA is absent. The screen
    // renders exactly that sentence, because the product genuinely does not
    // know whether a second factor exists — that lives with the auth provider.
    expect(reception?.mfaEnforcedAt).toBeNull()
  })

  it('answers for a cleaner too, since it is her own record', async () => {
    // No grant beyond membership is required to read your own membership row.
    const account = await loadAccountSecurity(await argsFor('housekeeping'))
    expect(account?.membershipStatus).toBe('active')
  })
})

/* ============================================================== the team == */

describe('who can act in the organization', () => {
  it('lists every membership for a reader holding user.view', async () => {
    const members = (await listMemberSecurity(await argsFor('owner'))) ?? []

    expect(members).toHaveLength(DEMO_DATASET.tables.memberships.length)
    for (const member of members) {
      expect(member.roles.length).toBeGreaterThan(0)
      expect(member.scopeKind).not.toBeNull()
      expect(
        MEMBERSHIP_STATUS_LABEL[
          member.status as keyof typeof MEMBERSHIP_STATUS_LABEL
        ],
      ).toBeDefined()
    }
  })

  it('names the scope each membership actually carries', async () => {
    const members = (await listMemberSecurity(await argsFor('owner'))) ?? []
    const kinds = new Set(members.map((member) => member.scopeKind))

    // The dataset narrows a property manager to properties and a cleaner to a
    // team, so a scope-blind screen would be demonstrably wrong here.
    expect(kinds).toContain('all_organization')
    expect(kinds).toContain('properties')
    expect(kinds).toContain('team')
  })

  it('counts MFA coverage over active memberships only', async () => {
    const members = (await listMemberSecurity(await argsFor('owner'))) ?? []
    const coverage = mfaCoverage(members)

    expect(coverage.active).toBe(
      DEMO_DATASET.tables.memberships.filter((row) => row.status === 'active')
        .length,
    )
    // The owner alone carries the requirement. "1 of 10" is a useful sentence
    // for somebody deciding whether to impose it more widely; "1" on its own
    // is not, which is why the pair is returned rather than a single count.
    expect(coverage.enforced).toBe(1)
    expect(coverage.enforced).toBeLessThan(coverage.active)
  })

  it('is withheld from reception, who may not read the team', async () => {
    const reception = await actorFor('reception')
    expect(holdsGrant(reception, 'user.view')).toBe(false)
    expect(await listMemberSecurity(await argsFor('reception'))).toBeNull()
  })

  it('is withheld from the cleaner', async () => {
    expect(await listMemberSecurity(await argsFor('housekeeping'))).toBeNull()
  })
})

/* ========================================================= invitations == */

describe('outstanding invitations', () => {
  it('is empty, and that is the table being empty rather than a refusal', async () => {
    // `DEMO_DATASET` seeds `invitations: []` — present and empty, which
    // `client.ts` is explicit is a different statement from a missing key.
    expect(DEMO_DATASET.tables.invitations).toEqual([])
    expect(await listOutstandingInvitations(await argsFor('owner'))).toEqual([])
  })

  it('is withheld without user.view, because it carries email addresses', async () => {
    expect(
      await listOutstandingInvitations(await argsFor('reception')),
    ).toBeNull()
  })
})

/* ============================================================= secrets == */

describe('what the product holds and will not show', () => {
  it('counts the credential-bearing rows without reading the credential', async () => {
    const holdings = await loadSecretHoldings(await argsFor('owner'))
    const byKey = new Map(holdings.map((entry) => [entry.key, entry]))

    // Every booking carries a guest-portal token by default, so the count of
    // bookings is the count of tokens.
    expect(byKey.get('guest_portal_token')?.count).toBe(
      DEMO_DATASET.tables.bookings.length,
    )
    expect(byKey.get('guest_portal_token')?.newestAt).not.toBeNull()

    expect(byKey.get('invitation_token')?.count).toBe(0)

    // Passwords and factors live in a schema PostgREST does not expose, so
    // there is nothing to count — and `0` would imply the product looked.
    expect(byKey.get('auth_credentials')?.count).toBeNull()
    expect(byKey.get('auth_credentials')?.newestAt).toBeNull()
  })

  it('returns no field that could carry a token value', async () => {
    const holdings = await loadSecretHoldings(await argsFor('owner'))
    for (const holding of holdings) {
      // The shape itself is the guarantee: a key, a count, a timestamp. There
      // is nowhere for a value to travel even if a query changed.
      expect(Object.keys(holding).sort()).toEqual(['count', 'key', 'newestAt'])
    }
  })

  it('has Hebrew copy for every credential it names', async () => {
    const holdings = await loadSecretHoldings(await argsFor('owner'))
    for (const holding of holdings) {
      const copy = SECRET_COPY[holding.key]
      expect(copy.title.length).toBeGreaterThan(0)
      expect(copy.body.length).toBeGreaterThan(0)
      expect(copy.column.length).toBeGreaterThan(0)
    }
  })
})
