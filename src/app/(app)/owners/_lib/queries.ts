/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the owner portal.
 *
 * ══ THE TABLES DO NOT EXIST YET, AND THIS FILE TREATS THAT AS A STATE ══════
 *
 * Zero owner tables exist in this database. `src/lib/owners/repository.ts` is
 * written against the schema this module's report proposes, and every read here
 * goes through `orNotProvisioned`, so "relation does not exist" becomes
 * `kind: 'not_provisioned'` rather than a 500.
 *
 * That is not a workaround, it is the honest state, and it goes away by itself
 * the moment the migration runs with no change to this file and none to the
 * screens. The alternative — a hard-coded "coming soon" — is a claim about the
 * product that goes stale on the day it stops being true.
 *
 * ── Three floors, and the menu is none of them ────────────────────────────
 *
 *   1. `requireOwnerGrant('owner_statement.view')` refuses the route, and tells
 *      "your package does not include this" apart from "you may not do this".
 *   2. **Every row that survives the query is checked again** in the domain.
 *      Statements go through `ownerStatementView`, which asks `can()` against
 *      the property the row names, asks whether the reader is the owner the row
 *      is addressed to, and redacts. A query built wrong therefore returns
 *      short rather than wide, which is the failure direction that matters.
 *   3. Row level security refuses regardless of both. The policies the
 *      migration must carry are stated in this module's report; every one of
 *      them checks `has_permission(organization_id, 'owner_statement.view')`
 *      plus `property_in_scope`, and the owner-facing ones additionally check
 *      that the row's owner is the caller.
 *
 * ── What is deliberately not read ─────────────────────────────────────────
 *
 * No guest, no booking, no agent, and no channel. Not "not selected" — not
 * queried. A column that is never fetched cannot leak through a mapping
 * mistake, and the whole point of `visibility.ts` is that there is no path from
 * a guest to an owner's screen; leaving one open at the query and closing it in
 * the projection would make that a claim about care rather than about shape.
 */

import { can, holdsGrant, type Actor } from '@/lib/authz/can'
import {
  isAwaitingOwner,
  ownerStatementViews,
  tallyOwnerApprovals,
  visibleOwnerships,
  type OwnerApproval,
  type OwnerPayout,
  type OwnerStatement,
  type OwnerSummary,
  type PropertyOwner,
  type PropertyOwnership,
} from '@/lib/owners'
import {
  SupabaseOwnerRepository,
  orNotProvisioned,
} from '@/lib/owners/repository'
import { createClient } from '@/lib/supabase/server'

/** The tables the owner portal needs. Named for the screens' gap notice. */
export const OWNER_TABLES = [
  'property_owners',
  'property_ownerships',
  'owner_statements',
  'owner_statement_lines',
  'owner_payouts',
] as const

export type OwnerListState =
  /** The migration has not run here. Not an error, and not "coming soon". */
  | { kind: 'not_provisioned' }
  /** Holds the plan, not the grant. A different sentence from the plan lock. */
  | { kind: 'not_readable' }
  | {
      kind: 'ready'
      owners: readonly OwnerSummary[]
      /** Property names, for rows whose property this reader may name. */
      propertyNames: ReadonlyMap<string, string>
    }

export type OwnerDetailState =
  | { kind: 'not_provisioned' }
  | { kind: 'not_readable' }
  | { kind: 'not_found' }
  | {
      kind: 'ready'
      owner: PropertyOwner
      ownerships: readonly PropertyOwnership[]
      statements: readonly OwnerStatement[]
      payouts: readonly OwnerPayout[]
      approvals: readonly OwnerApproval[]
      tally: ReturnType<typeof tallyOwnerApprovals>
      propertyNames: ReadonlyMap<string, string>
    }

export type StatementState =
  | { kind: 'not_provisioned' }
  | { kind: 'not_readable' }
  | { kind: 'not_found' }
  | {
      kind: 'ready'
      owner: PropertyOwner
      statement: OwnerStatement
      propertyName: string | null
    }

async function repository(): Promise<SupabaseOwnerRepository> {
  return new SupabaseOwnerRepository(await createClient())
}

/**
 * Property names for the ids on screen, checked one by one.
 *
 * The `properties` table exists, so this read is not wrapped in
 * `orNotProvisioned` — a failure here is a real failure. `can()` is asked per
 * row because a name is information: which villas a business manages is not
 * something an owner of one of them is entitled to enumerate.
 */
async function propertyNames(
  actor: Actor,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const names = new Map<string, string>()
  const unique = [...new Set(ids)]
  if (unique.length === 0) return names

  const db = await createClient()
  const { data, error } = await db
    .from('properties')
    .select('id, name')
    .eq('organization_id', actor.organizationId)
    .in('id', unique)

  if (error) throw error

  for (const row of data ?? []) {
    const id = String((row as { id: unknown }).id)
    const name = (row as { name: unknown }).name
    const allowed = can(actor, 'property.view', {
      organizationId: actor.organizationId,
      propertyId: id,
      family: 'inventory',
    })
    if (allowed && typeof name === 'string') names.set(id, name)
  }

  return names
}

/**
 * Every owner this reader may see, with what they are owed.
 *
 * An external owner reading this screen sees exactly one row — their own —
 * because `visibleOwnerships` and `ownerStatementViews` refuse the rest. The
 * list is not a different query for them; it is the same query answered
 * differently by the domain, which is what makes the two impossible to drift
 * apart.
 */
export async function ownerList(actor: Actor): Promise<OwnerListState> {
  if (!holdsGrant(actor, 'owner_statement.view')) {
    return { kind: 'not_readable' }
  }

  const repo = await repository()
  const loaded = await orNotProvisioned(async () => {
    const owners = await repo.listOwners(actor.organizationId)
    const ownerships = await repo.listOwnerships(actor.organizationId)
    const statements = await repo.listStatements(actor.organizationId)
    const approvals = await repo.listOwnerApprovals(actor.organizationId)
    return { owners, ownerships, statements, approvals }
  })

  if (!loaded.ok) return { kind: 'not_provisioned' }

  const now = new Date()
  const summaries: OwnerSummary[] = []

  for (const owner of loaded.value.owners) {
    const links = visibleOwnerships(actor, owner, loaded.value.ownerships)
    const mine = ownerStatementViews(
      actor,
      owner,
      loaded.value.statements.filter(
        (statement) => statement.ownerId === owner.id,
      ),
    )

    // An owner with nothing this reader may see is not listed at all. Showing
    // the name and withholding the figures would still disclose who else the
    // business manages for, which is exactly what an owner may not learn.
    if (links.length === 0 && mine.length === 0) continue

    const newest = [...mine].sort((a, b) =>
      a.periodEnd < b.periodEnd ? 1 : -1,
    )[0]

    summaries.push({
      owner,
      ownerships: links,
      statementCount: mine.length,
      balanceAgorot: newest?.closingBalanceAgorot ?? 0,
      pendingApprovals: loaded.value.approvals.filter(
        (approval) =>
          approval.ownerId === owner.id && isAwaitingOwner(approval, now),
      ).length,
    })
  }

  return {
    kind: 'ready',
    owners: summaries,
    propertyNames: await propertyNames(
      actor,
      summaries.flatMap((summary) =>
        summary.ownerships.map((link) => link.propertyId),
      ),
    ),
  }
}

/** One owner: their properties, their statements, their account, their asks. */
export async function ownerDetail(
  actor: Actor,
  ownerId: string,
): Promise<OwnerDetailState> {
  if (!holdsGrant(actor, 'owner_statement.view')) {
    return { kind: 'not_readable' }
  }

  const repo = await repository()
  const loaded = await orNotProvisioned(async () => {
    const owner = await repo.loadOwner(actor.organizationId, ownerId)
    if (!owner) return null
    const [ownerships, statements, payouts, approvals] = await Promise.all([
      repo.listOwnerships(actor.organizationId, { ownerId }),
      repo.listStatements(actor.organizationId, { ownerId }),
      repo.listPayouts(actor.organizationId, { ownerId }),
      repo.listOwnerApprovals(actor.organizationId, { ownerId }),
    ])
    return { owner, ownerships, statements, payouts, approvals }
  })

  if (!loaded.ok) return { kind: 'not_provisioned' }
  if (loaded.value === null) return { kind: 'not_found' }

  const { owner } = loaded.value
  const ownerships = visibleOwnerships(actor, owner, loaded.value.ownerships)
  const statements = ownerStatementViews(actor, owner, loaded.value.statements)

  // Nothing visible is `not_found` rather than an empty owner page: telling an
  // outsider that an owner exists whose records they may not read is itself the
  // disclosure.
  if (ownerships.length === 0 && statements.length === 0) {
    return { kind: 'not_found' }
  }

  const reachable = new Set(ownerships.map((link) => link.propertyId))

  return {
    kind: 'ready',
    owner,
    ownerships,
    statements,
    // Movements are shown only for properties this reader reaches, and a
    // portfolio-wide settlement (`propertyId === null`) only to an insider.
    payouts: loaded.value.payouts.filter((payout) =>
      payout.propertyId === null
        ? holdsGrant(actor, 'owner.view')
        : reachable.has(payout.propertyId),
    ),
    approvals: loaded.value.approvals.filter((approval) =>
      reachable.has(approval.propertyId),
    ),
    tally: tallyOwnerApprovals(
      loaded.value.approvals.filter((approval) =>
        reachable.has(approval.propertyId),
      ),
      new Date(),
    ),
    propertyNames: await propertyNames(actor, [...reachable]),
  }
}

/** One statement, through the one door that shapes it for this reader. */
export async function ownerStatement(
  actor: Actor,
  ownerId: string,
  statementId: string,
): Promise<StatementState> {
  if (!holdsGrant(actor, 'owner_statement.view')) {
    return { kind: 'not_readable' }
  }

  const repo = await repository()
  const loaded = await orNotProvisioned(async () => {
    const owner = await repo.loadOwner(actor.organizationId, ownerId)
    if (!owner) return null
    const statement = await repo.loadStatement(
      actor.organizationId,
      statementId,
    )
    return statement ? { owner, statement } : null
  })

  if (!loaded.ok) return { kind: 'not_provisioned' }
  if (loaded.value === null) return { kind: 'not_found' }

  const { owner, statement } = loaded.value

  // The row was fetched by id, so the URL is the only thing that chose it. The
  // domain decides whether this reader may have it — including whether it is
  // addressed to them — and a refusal is `not_found`, not `not_readable`:
  // "this exists and is not yours" is more than the reader is owed.
  const views = ownerStatementViews(actor, owner, [statement])
  if (views.length === 0 || statement.ownerId !== ownerId) {
    return { kind: 'not_found' }
  }

  const names = await propertyNames(actor, [statement.propertyId])

  return {
    kind: 'ready',
    owner,
    statement: views[0],
    propertyName: names.get(statement.propertyId) ?? null,
  }
}
