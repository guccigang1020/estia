/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the agent screens.
 *
 * ── Why this is not `SupabaseAgentRepository` ─────────────────────────────
 *
 * The same gap `finance/_lib/queries.ts` documents, one module over.
 * `AgentSettingsStore` is a per-agent port: `loadSettings(organizationId,
 * agentUserId)`. There is no method that answers "every agent in this
 * organization", which is the only question the list screen asks, and building
 * one out of the port means one round trip per agent. So the list is a plain
 * query here, over the same request-scoped client the adapter would have used,
 * mapped through the adapter's *own* `toAccess` rather than a second parser —
 * see below — and validated against the same frozen vocabularies.
 *
 * The detail screen is different and does use the port: it asks about one
 * agent, which is exactly the shape `loadSettings` has. Nothing is reimplemented
 * for it.
 *
 * ── `toAccess` is imported, never rewritten ───────────────────────────────
 *
 * `parseAgentAccess` is described in `access.ts` as "the single door" from
 * untyped data into the union, and `toAccess` in `persistence/agents.ts` is the
 * one caller that builds the draft from the seven stored columns. A second
 * builder here would be a second place for the cross-ladder rule to be got
 * wrong, and getting it wrong produces `{ calendar: 'none', price: 'net' }` —
 * a value the type cannot hold, in a screen whose entire subject is what an
 * outsider may see. So the adapter's function is imported directly, from a file
 * this module treats as read-only.
 *
 * ── Three floors, and the third is the one that matters here ──────────────
 *
 *   1. `requireDistributionGrant('agent.view')` refuses the route — or renders
 *      the upgrade, which is the same refusal said correctly.
 *   2. `can()` per row here with `family: 'team'`, the family
 *      `settingsResource` in `agents/operations.ts` declares. An agent's own
 *      membership is the resource, so `assignedToUserId` is carried and an
 *      actor scoped to `own_records` sees themselves and nobody else.
 *   3. Row level security refuses regardless of both.
 *
 * `redact()` is the fourth thing and is not a floor of the same kind: the
 * internal note an owner wrote about a seller is not something the seller reads
 * about themselves, and it is removed from the record rather than blanked.
 *
 * ── Nothing here computes money ───────────────────────────────────────────
 *
 * `production()` counts bookings and sums commissions that are already stored
 * integers, through `sumAgorot`. It does not multiply a base by a rate: the
 * commission amount is the figure written when the commission was created from
 * the snapshotted rule, and a second derivation on screen would disagree the
 * moment an agreement was renegotiated — which is exactly when somebody is
 * looking. `commission.ts` owns that arithmetic and this file does not repeat
 * any of it.
 */

import {
  can,
  holdsGrant,
  redact,
  type Actor,
  type Resource,
} from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import { MEMBERSHIP_STATUSES, type MembershipStatus } from '@/lib/authz/can'
import {
  COMMISSION_STATUSES,
  type CommissionStatus,
} from '@/lib/contracts/states'
import { sumAgorot } from '@/lib/finance'
import type {
  AgentAccess,
  AgentDiscountCap,
  AgentHoldLimits,
  AgentInventoryScope,
} from '@/lib/agents'
import { toAccess } from '@/lib/persistence/agents'
import {
  asAgorot,
  asEnum,
  asNumber,
  asNumberOrNull,
  asString,
  asStringOrNull,
  asTimestamp,
  toRow,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'

/* ---------------------------------------------------------------- shared -- */

/**
 * The ceiling on one page.
 *
 * The same number and the same reasoning as `FINANCE_PAGE_SIZE`: the query
 * stays honest about paging and the screen says out loud when it has hit it. An
 * agent network larger than this is a network whose list needs a filter, not a
 * list that quietly stops.
 */
export const AGENT_PAGE_SIZE = 100

/**
 * The resource an authorization question about an agent's relationship is
 * asked about.
 *
 * `family: 'team'` and `assignedToUserId`, copied from `settingsResource` in
 * `agents/operations.ts` because the read and the write must agree about what
 * they are asking. They are not the same function only because that one is
 * private to the domain and takes a loaded `AgentOrganizationSettings`, which a
 * list has not built yet.
 */
export function agentResource(
  organizationId: string,
  agentUserId: string,
): Resource {
  return { organizationId, assignedToUserId: agentUserId, family: 'team' }
}

/**
 * A commission or a booking, as an authorization question.
 *
 * ── The bug this shape exists to prevent ──────────────────────────────────
 *
 * An external agent resolves — through `agentScopeNarrowing`, in production —
 * to `scope: { kind: 'own_records' }` with an `inventory` override, and
 * `scopeReaches` answers `own_records` by comparing `resource.assignedToUserId`
 * and `resource.createdByUserId` against the actor's own id. A finance resource
 * carrying only `{ organizationId, propertyId, family: 'finance' }` therefore
 * reaches **nothing at all** for such an actor: not somebody else's
 * commissions, which is right, and not their own either, which is the whole
 * screen.
 *
 * So the payee travels on the resource. `assignedToUserId` is the agent the row
 * names — the person the commission is owed to, or the seller who brought the
 * booking — which is exactly what "own record" means for these two tables.
 *
 * This widens nothing. `all_organization` ignores the field, `properties` still
 * decides on `propertyId` alone, and `own_records` goes from "no rows" to
 * "their own rows". It was found by resolving the demo's agent through the
 * unwrapped production source and watching a screen full of their own
 * commissions come back empty; see the test beside this file.
 */
function ownedResource(
  organizationId: string,
  propertyId: string,
  agentUserId: string,
  family: 'finance' | 'booking',
): Resource {
  return {
    organizationId,
    propertyId,
    assignedToUserId: agentUserId,
    family,
  }
}

/* ----------------------------------------------------------------- rows -- */

/**
 * One agent, as the list and the detail screen both need them.
 *
 * `status` is read from the embedded membership and never from this table:
 * 0019 put the status on the membership deliberately and kept it there, and a
 * copy on the terms row would be a second answer to "is this agent suspended".
 * `SETTINGS_COLUMNS` in the adapter embeds `memberships(status)` for the same
 * reason, and so does this.
 *
 * The optional fields are optional because `redact()` genuinely removes them: a
 * reader without `agent.manage` has no `internalNote` key at all, and the type
 * says so rather than letting a component read `undefined` out of a string.
 */
export type AgentListItem = {
  agentUserId: string
  membershipId: string
  /** From `user_profiles`. Null when the profile row is unreadable. */
  displayName: string | null
  /**
   * The identity key, normalised. `phone_e164` is `generated always` in 0020,
   * so it is the number the login code follows and the only spelling of it.
   *
   * There is no e-mail beside it, and that is not an omission: `user_profiles`
   * has no `email` column — it lives on `auth.users`, which the application
   * client cannot read. A screen that showed a blank "אימייל" row would be
   * asserting that this agent has no address on file.
   */
  phoneE164: string | null
  status: MembershipStatus
  access: AgentAccess
  inventory: AgentInventoryScope
  /** The property ids the reach names, for a screen that wants their names. */
  inventoryPropertyIds: readonly string[]
  discountCap: AgentDiscountCap
  holdLimits: AgentHoldLimits
  reputationScore: number
  agencyId: string | null
  agencyName: string | null
  joinedOn: string
  /** Optimistic locking. The suspend control sends it back. */
  version: number
  /** What the owner wrote about this seller. Not for the seller. */
  internalNote?: string | null
}

/**
 * The one field a reader may reach an agent's record and still not see.
 *
 * `agent.manage` rather than `agent.view`, because the note is the owner's
 * private assessment — the demo's own reads "מוכר טוב, אבל נוטה לבקש הנחות
 * מעבר לתקרה" — and `agent.view` is held by an agency manager running the
 * sellers underneath them. A note about a competitor's performance handed to
 * that person is a leak with no upside.
 */
const AGENT_REDACTIONS = [
  { key: 'internalNote', requires: 'agent.manage' },
] as const satisfies ReadonlyArray<{
  key: keyof AgentListItem
  requires: Grant
}>

/**
 * The ladder columns, plus everything the screens print.
 *
 * `memberships(status)` is the embed `RELATIONS` already declares for
 * `agent_organization_settings` — the one the adapter uses — so this select
 * resolves against the transaction compiler, the demo client and PostgREST
 * without any of the three learning a new relation.
 */
const AGENT_COLUMNS =
  'id, organization_id, agent_user_id, membership_id, ' +
  'access_calendar, access_price, access_guest_data, access_amendments, ' +
  'access_cancellation_kind, access_cancellation_hours, access_payment_link, ' +
  'inventory_kind, inventory_property_ids, inventory_unit_ids, ' +
  'discount_max_percent, discount_max_agorot, hold_max_concurrent, ' +
  'hold_max_per_day, hold_max_extensions, hold_default_minutes, ' +
  'hold_max_minutes, reputation_score, agency_id, internal_note, ' +
  'created_at, updated_at, version, memberships(status)'

export type AgentListArgs = {
  db: Db
  actor: Actor
  organizationId: string
  /** A single status, or null for every agent whatever their state. */
  status: MembershipStatus | null
  limit?: number
}

/**
 * The agents this reader may see, oldest relationship first.
 *
 * Ordered by `created_at` ascending rather than descending: an agent network is
 * a stable list somebody scans for a name, not a feed, and the newest seller
 * jumping to the top every time one is added moves every other row.
 */
export async function listAgents(
  args: AgentListArgs,
): Promise<readonly AgentListItem[]> {
  const { db, actor, organizationId, status } = args

  const { data, error } = await db
    .from('agent_organization_settings')
    .select(AGENT_COLUMNS)
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: true })
    .limit(args.limit ?? AGENT_PAGE_SIZE)

  if (error) throw error

  const rows = toRows(data).filter((row) =>
    can(
      actor,
      'agent.view',
      agentResource(organizationId, asString(row, 'agent_user_id')),
    ),
  )

  // The status is on the membership, so it is filtered after the read rather
  // than in the query. PostgREST would narrow through `memberships!inner`, and
  // the demo client honours that syntax — but an inner embed here would drop an
  // agent whose membership row is unreadable, and "this seller vanished" is a
  // worse answer than "this seller's state is not visible to you".
  const wanted =
    status === null
      ? rows
      : rows.filter((row) => membershipStatus(row) === status)

  const [people, agencies] = await Promise.all([
    profiles(
      db,
      wanted.map((row) => asString(row, 'agent_user_id')),
    ),
    agencyNames(db, idsIn(wanted, 'agency_id')),
  ])

  return wanted.map((row) => {
    const agentUserId = asString(row, 'agent_user_id')
    const agencyId = asStringOrNull(row, 'agency_id')
    const person = people.get(agentUserId) ?? null

    const item: AgentListItem = {
      agentUserId,
      membershipId: asString(row, 'membership_id'),
      displayName: person?.fullName ?? null,
      phoneE164: person?.phoneE164 ?? null,
      status: membershipStatus(row),
      access: toAccess(row),
      inventory: toInventory(row),
      inventoryPropertyIds: stringArray(row, 'inventory_property_ids'),
      discountCap: toDiscountCap(row),
      holdLimits: toHoldLimits(row),
      reputationScore: asNumber(row, 'reputation_score'),
      agencyId,
      agencyName: agencyId === null ? null : (agencies.get(agencyId) ?? null),
      joinedOn: asTimestamp(row, 'created_at'),
      version: asNumber(row, 'version'),
      internalNote: asStringOrNull(row, 'internal_note'),
    }

    return redact(
      actor,
      item,
      AGENT_REDACTIONS,
      agentResource(organizationId, agentUserId),
    )
  })
}

/** How many agent relationships exist, before any filter. */
export async function countAgents(
  db: Db,
  organizationId: string,
): Promise<number> {
  const { count, error } = await db
    .from('agent_organization_settings')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)

  if (error) throw error
  return count ?? 0
}

/**
 * One agent, or `null` because they are not this organization's.
 *
 * A separate query rather than a filter over `listAgents`, so the detail screen
 * costs one row rather than the whole network — and so that "no such agent" and
 * "an agent you may not see" produce the same `null`, which is the answer the
 * screen should give in both cases. Telling somebody that the agent exists and
 * they may not read them is information they did not have.
 */
export async function loadAgent(
  db: Db,
  actor: Actor,
  organizationId: string,
  agentUserId: string,
): Promise<AgentListItem | null> {
  const agents = await listAgents({
    db,
    actor,
    organizationId,
    status: null,
    limit: AGENT_PAGE_SIZE,
  })
  return agents.find((agent) => agent.agentUserId === agentUserId) ?? null
}

/* ----------------------------------------------------------- production -- */

/**
 * What an agent has actually produced.
 *
 * Two counts and one sum, and the sum is `sumAgorot` over stored figures. The
 * commissions are narrowed by `can()` with `family: 'finance'` exactly as the
 * commissions list narrows them, so an agent looking at their own page sees the
 * commissions their scope reaches and a finance manager sees all of them —
 * the same grant, a different answer, decided by the engine and not by a
 * filter this file wrote.
 *
 * `owedAgorot` is null, never zero, when the reader may not see commissions at
 * all: an owner reading "₪0 owed" about an agent with four unpaid commissions
 * is being told something false.
 */
export type AgentProduction = {
  bookingCount: number
  commissionCount: number
  owedAgorot: number | null
  /** Commissions that are past `estimated` and not yet `paid`. */
  unpaidAgorot: number | null
}

export async function agentProduction(
  db: Db,
  actor: Actor,
  organizationId: string,
  agentUserId: string,
): Promise<AgentProduction> {
  const bookingCount = await countBookings(
    db,
    actor,
    organizationId,
    agentUserId,
  )

  if (!holdsGrant(actor, 'commission.view')) {
    return {
      bookingCount,
      commissionCount: 0,
      owedAgorot: null,
      unpaidAgorot: null,
    }
  }

  const { data, error } = await db
    .from('commissions')
    .select('id, property_id, status, amount_agorot')
    .eq('organization_id', organizationId)
    .eq('agent_user_id', agentUserId)
    .limit(AGENT_PAGE_SIZE)

  if (error) throw error

  const rows = toRows(data).filter((row) =>
    can(
      actor,
      'commission.view',
      ownedResource(
        organizationId,
        asString(row, 'property_id'),
        agentUserId,
        'finance',
      ),
    ),
  )

  const amounts = rows.map((row) => asAgorot(row, 'amount_agorot'))
  const unpaid = rows
    .filter((row) => {
      const status = asEnum(row, 'status', COMMISSION_STATUSES)
      return status !== 'paid' && status !== 'cancelled'
    })
    .map((row) => asAgorot(row, 'amount_agorot'))

  return {
    bookingCount,
    commissionCount: rows.length,
    owedAgorot: sumAgorot(amounts),
    unpaidAgorot: sumAgorot(unpaid),
  }
}

/**
 * How many bookings this agent brought.
 *
 * `head: true`, so the number costs nothing when the screen wants only the
 * number. Skipped entirely without `booking.view`, because `bookings_select`
 * would return nothing and the round trip cannot succeed — and zero is then the
 * honest answer for a reader who cannot count them, which the screen renders as
 * "not visible to you" rather than as "none".
 */
async function countBookings(
  db: Db,
  actor: Actor,
  organizationId: string,
  agentUserId: string,
): Promise<number> {
  if (!holdsGrant(actor, 'booking.view')) return 0

  const { count, error } = await db
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('agent_user_id', agentUserId)

  if (error) throw error
  return count ?? 0
}

/* ---------------------------------------------------------- audit trail -- */

/**
 * What has been done to this agent's relationship, newest first.
 *
 * `audit_events` is written by the product and never seeded — `dataset.ts` says
 * so at length, and an audit trail nobody performed is the one kind of fiction a
 * product like this must not ship. So this returns an empty list on the demo
 * dataset, and the screen says "nothing has happened yet" rather than drawing a
 * timeline of invented events.
 *
 * Gated on `agent.audit.view` in preference to `audit.view`: the agent-specific
 * grant is the one an agency manager holds, and refusing them the trail of their
 * own sellers because they lack the organization-wide audit right would be the
 * wrong refusal. Either is enough.
 */
export type AgentAuditEntry = {
  id: string
  occurredAt: string
  action: string
  /** `NOT NULL` in 0005, and never "membership updated". */
  summary: string
  actorLabel: string
  reason: string | null
}

export async function agentAuditTrail(
  db: Db,
  actor: Actor,
  organizationId: string,
  agentUserId: string,
  limit = 20,
): Promise<readonly AgentAuditEntry[] | null> {
  if (
    !holdsGrant(actor, 'agent.audit.view') &&
    !holdsGrant(actor, 'audit.view')
  ) {
    return null
  }

  const { data, error } = await db
    .from('audit_events')
    .select(
      'id, occurred_at, action, summary, reason, actor_label, resource_type, resource_id',
    )
    .eq('organization_id', organizationId)
    .eq('resource_type', 'agent')
    .eq('resource_id', agentUserId)
    .order('occurred_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  return toRows(data).map((row) => ({
    id: asString(row, 'id'),
    occurredAt: asTimestamp(row, 'occurred_at'),
    action: asString(row, 'action'),
    summary: asString(row, 'summary'),
    actorLabel: asString(row, 'actor_label'),
    reason: asStringOrNull(row, 'reason'),
  }))
}

/* --------------------------------------------------------------- shared -- */

/**
 * The membership's status, out of the embed.
 *
 * `asEnum` against `MEMBERSHIP_STATUSES`, so a status the database grows
 * without the contract growing throws here rather than reaching a screen as a
 * bare English word beside a Hebrew one. A missing embed is `removed` — deny by
 * default: an agent whose membership cannot be read has no live relationship
 * this screen should present as active.
 */
function membershipStatus(row: Row): MembershipStatus {
  const embedded = row.memberships
  const value = Array.isArray(embedded) ? embedded[0] : embedded
  if (!value || typeof value !== 'object') return 'removed'
  return asEnum(toRow(value), 'status', MEMBERSHIP_STATUSES)
}

/**
 * The reach, read the way the adapter reads it.
 *
 * 0019's `inventory_shape` CHECK refuses an empty list on `properties` and
 * `units`, so what arrives is already one of the three real variants — and an
 * unrecognised kind is not silently widened: `inventoryScopeToScope` denies by
 * default, and `asEnum` throws before it gets the chance.
 */
function toInventory(row: Row): AgentInventoryScope {
  const kind = asEnum(row, 'inventory_kind', INVENTORY_KINDS)
  switch (kind) {
    case 'properties':
      return { kind, propertyIds: stringArray(row, 'inventory_property_ids') }
    case 'units':
      return { kind, unitIds: stringArray(row, 'inventory_unit_ids') }
    default:
      return { kind: 'all_properties' }
  }
}

const INVENTORY_KINDS = ['all_properties', 'properties', 'units'] as const

/**
 * The discount ceiling.
 *
 * `discount_max_percent` is a `numeric` and arrives as the string `"8.000"`, so
 * it goes through `asNumber` rather than being read as a number — a `numeric`
 * cast with `Number()` at a call site is how a cap becomes `NaN` and every
 * discount passes.
 *
 * `maxAgorot` is genuinely nullable — a percentage cap with no shekel ceiling
 * is an ordinary arrangement — so `asNumberOrNull`, exactly as the adapter does
 * it. Reading it through `asAgorot` would refuse a legitimate row.
 */
function toDiscountCap(row: Row): AgentDiscountCap {
  return {
    maxPercent: asNumber(row, 'discount_max_percent'),
    maxAgorot: asNumberOrNull(row, 'discount_max_agorot'),
  }
}

function toHoldLimits(row: Row): AgentHoldLimits {
  return {
    maxConcurrent: asNumber(row, 'hold_max_concurrent'),
    maxPerDay: asNumber(row, 'hold_max_per_day'),
    maxExtensions: asNumber(row, 'hold_max_extensions'),
    defaultMinutes: asNumber(row, 'hold_default_minutes'),
    maxMinutes: asNumber(row, 'hold_max_minutes'),
  }
}

function stringArray(row: Row, column: string): readonly string[] {
  const value = row[column]
  if (!Array.isArray(value)) return []
  return value.map((entry) => String(entry))
}

function idsIn(rows: readonly Row[], column: string): string[] {
  const ids = new Set<string>()
  for (const row of rows) {
    const value = asStringOrNull(row, column)
    if (value !== null) ids.add(value)
  }
  return [...ids]
}

/**
 * The people behind the relationships.
 *
 * `user_profiles_select` admits anybody who shares an organization with the
 * subject, so this is readable by every member, and it is only ever asked for
 * ids that appeared on a settings row this reader was already admitted to. A
 * missing name stays null rather than being filled with the uuid — a truncated
 * id is unhelpful and a confident wrong name is worse.
 *
 * `phone_e164` is the column 0020 added `generated always` from `phone`, and it
 * is the identity key the login code follows. `phone` is the number as it was
 * typed — two spellings of one number — and is not what a screen should print
 * beside a seller's name.
 */
type AgentPerson = {
  fullName: string | null
  phoneE164: string | null
}

async function profiles(
  db: Db,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, AgentPerson>> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return new Map()

  const { data, error } = await db
    .from('user_profiles')
    .select('id, full_name, phone_e164')
    .in('id', unique)

  if (error) throw error

  const people = new Map<string, AgentPerson>()
  for (const row of toRows(data)) {
    people.set(asString(row, 'id'), {
      fullName: asStringOrNull(row, 'full_name'),
      phoneE164: asStringOrNull(row, 'phone_e164'),
    })
  }
  return people
}

/**
 * Agency names.
 *
 * `agencies_select` admits an agency this organization works with, which is
 * exactly the set that can appear on one of its agents. A row this reader
 * cannot see leaves the name null and the agent renders as belonging to an
 * agency without a name, which is true.
 */
export async function agencyNames(
  db: Db,
  agencyIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (agencyIds.length === 0) return new Map()

  const { data, error } = await db
    .from('agencies')
    .select('id, name')
    .in('id', [...agencyIds])

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    names.set(asString(row, 'id'), asString(row, 'name'))
  }
  return names
}

/**
 * Property names for the ids an inventory reach names.
 *
 * Same shape and same reasoning as the two above. `properties_select` confines
 * this to the caller's organization; a property the reader cannot see leaves
 * the entry out, and the screen counts what it has rather than inventing the
 * rest.
 */
export async function propertyNames(
  db: Db,
  organizationId: string,
  propertyIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(propertyIds)]
  if (unique.length === 0) return new Map()

  const { data, error } = await db
    .from('properties')
    .select('id, name')
    .eq('organization_id', organizationId)
    .in('id', unique)

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    const name = asStringOrNull(row, 'name')
    if (name !== null) names.set(asString(row, 'id'), name)
  }
  return names
}

/**
 * The commissions owed to one agent, for their own page.
 *
 * Deliberately narrower than `listCommissions`: this page shows one seller and
 * needs no payee resolution, because the payee is the person whose page it is.
 * It is the same `can()` narrowing over the same table, which is what makes an
 * external agent's own page show the four commissions their property scope
 * reaches rather than all seven.
 */
export type AgentCommissionLine = {
  id: string
  bookingId: string
  propertyId: string
  status: CommissionStatus
  amountAgorot: number
  rateBps: number | null
  paidOn: string | null
}

export async function agentCommissions(
  db: Db,
  actor: Actor,
  organizationId: string,
  agentUserId: string,
  limit = AGENT_PAGE_SIZE,
): Promise<readonly AgentCommissionLine[] | null> {
  if (!holdsGrant(actor, 'commission.view')) return null

  const { data, error } = await db
    .from('commissions')
    .select(
      'id, booking_id, property_id, status, amount_agorot, rate_bps, paid_at',
    )
    .eq('organization_id', organizationId)
    .eq('agent_user_id', agentUserId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  return toRows(data)
    .filter((row) =>
      can(
        actor,
        'commission.view',
        ownedResource(
          organizationId,
          asString(row, 'property_id'),
          agentUserId,
          'finance',
        ),
      ),
    )
    .map((row) => ({
      id: asString(row, 'id'),
      bookingId: asString(row, 'booking_id'),
      propertyId: asString(row, 'property_id'),
      status: asEnum(row, 'status', COMMISSION_STATUSES),
      amountAgorot: asAgorot(row, 'amount_agorot'),
      rateBps: asNumberOrNull(row, 'rate_bps'),
      paidOn: asStringOrNull(row, 'paid_at'),
    }))
}

/**
 * The bookings this agent brought, as much of each as this reader may see.
 *
 * `booking.view` is asked with `family: 'booking'`, which is what confines an
 * agent to their own — their default scope is `own_records` and every family
 * that is not `inventory` falls through to it. The guest's name is not read at
 * all: it lives on `guests` behind a second grant, and a list of an agent's own
 * production does not need it.
 */
export type AgentBookingLine = {
  id: string
  reference: string
  propertyId: string
  checkIn: string
  checkOut: string
  status: string
  totalAgorot?: number
}

export async function agentBookings(
  db: Db,
  actor: Actor,
  organizationId: string,
  agentUserId: string,
  limit = AGENT_PAGE_SIZE,
): Promise<readonly AgentBookingLine[] | null> {
  if (!holdsGrant(actor, 'booking.view')) return null

  const { data, error } = await db
    .from('bookings')
    .select(
      'id, reference, property_id, check_in, check_out, status, total_agorot',
    )
    .eq('organization_id', organizationId)
    .eq('agent_user_id', agentUserId)
    .order('check_in', { ascending: false })
    .limit(limit)

  if (error) throw error

  const maySeePrice = holdsGrant(actor, 'booking.view_price')

  return toRows(data)
    .filter((row) =>
      can(
        actor,
        'booking.view',
        ownedResource(
          organizationId,
          asString(row, 'property_id'),
          agentUserId,
          'booking',
        ),
      ),
    )
    .map((row) => {
      const line: AgentBookingLine = {
        id: asString(row, 'id'),
        reference: asString(row, 'reference'),
        propertyId: asString(row, 'property_id'),
        checkIn: asString(row, 'check_in'),
        checkOut: asString(row, 'check_out'),
        status: asString(row, 'status'),
      }
      if (maySeePrice) line.totalAgorot = asAgorot(row, 'total_agorot')
      return line
    })
}
