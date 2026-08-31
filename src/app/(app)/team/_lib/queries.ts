/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the team screen.
 *
 * ── This is the screen an over-broad read costs the most on ───────────────
 *
 * Everything here is about colleagues rather than customers, and the catalogue
 * has less to say about it than it does about guests. `SENSITIVE_FIELDS`
 * declares `guest.phone` and gates it on `guest.view_phone`; it declares
 * nothing at all for a *member's* telephone number, because the model was
 * written around the people a business sells to. That gap is real and is
 * reported rather than papered over: the honest options were to hand every
 * holder of `user.view` a phone list of the whole organization, or to gate it
 * on the nearest true grant and say which one and why.
 *
 * It is gated on `user.edit` — the authority that administers people. A
 * housekeeping supervisor holds `user.view`, needs the roster to assign work,
 * and has no business holding the contact details of everybody in the company;
 * an administrator holds `user.edit` and already changes those records. The
 * grant is an existing one from the catalogue, not a permission string
 * invented here that the engine would silently never match. When the catalogue
 * grows a `member.contact` field permission, this line changes and nothing
 * else does.
 *
 * ── What is deliberately not read ─────────────────────────────────────────
 *
 * E-mail addresses. `public.user_profiles` does not carry one — the address
 * lives in `auth.users`, which no customer-facing query may read — so there is
 * no column to select and nothing to show. A screen that printed the persona
 * e-mail from `DEMO_PERSONAS` would be printing a value that exists in the
 * demo's switcher and in no database, which is the exact class of fiction the
 * demo exists to prevent.
 *
 * ── Four queries, no join through `auth` ──────────────────────────────────
 *
 * Memberships, then the profiles, roles and scopes for exactly the memberships
 * that came back. Four round trips over a page of rows rather than one embed,
 * for the same reason `bookingReferences` in the finance queries is a separate
 * `in`: `memberships.user_profiles` is not a declared relation for PostgREST's
 * schema cache or for the demo client, and declaring one for two columns would
 * widen a surface both files keep deliberately narrow.
 *
 * ── Three floors, and the middle one is not a scope narrowing ─────────────
 *
 *   1. `requireGrant('user.view')` at the route.
 *   2. `holdsGrant(actor, 'user.view')` here, before a query is issued.
 *   3. `memberships_select` in the database refuses regardless of both.
 *
 * The second floor is a grant question and deliberately not a scope question,
 * which is the opposite of what every other list screen in this product does.
 * The reason is that a person is not *located* anywhere. A booking sits in a
 * property and a task sits in a unit, so `can(actor, …, { propertyId })`
 * genuinely narrows those; a membership carries `team_id` and
 * `default_property_id` and neither is where the person is — they are
 * preferences. `scopeReaches` denies by default for a resource that carries no
 * location, so asking the scope question about a colleague would return an
 * empty roster to a property manager who holds `user.view`, plainly, and whom
 * the menu correctly offers this screen to. An empty screen behind a menu
 * entry that promised otherwise is the failure this would have shipped.
 *
 * `memberships_select` agrees and is the check that matters: it is
 * `organization_id in (select my_organizations())` and carries no permission
 * and no scope at all. So the honest floor above it is "may this person read
 * the roster", asked once, and the narrowing that does happen per row is
 * `redact()` on the telephone number.
 */

import {
  MEMBERSHIP_STATUSES,
  holdsGrant,
  redact,
  type Actor,
  type MembershipStatus,
  type Scope,
} from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import type { Db } from '@/lib/persistence'
import {
  asEnum,
  asNumber,
  asString,
  asStringOrNull,
  asTimestampOrNull,
  toRow,
  toRows,
  type Row,
} from '@/lib/persistence'

/* ---------------------------------------------------------------- shape -- */

/** A role held, for display. The engine never sees a role name. */
export type MemberRole = {
  code: string
  /** The Hebrew name from `public.roles`, which is the catalogue's own. */
  name: string
}

/**
 * Where one membership's permissions apply, with the ids already named.
 *
 * The `Scope` union is the authoritative shape and it carries ids; a person
 * reading a roster needs names. So the union is kept — `kind` is what the
 * engine decides on — and the names travel beside it, resolved from rows this
 * reader was admitted to. A name that could not be resolved stays absent
 * rather than being replaced by its uuid.
 */
export type MemberScope = {
  scope: Scope
  /** Property, team or unit names for the ids in `scope`, in row order. */
  names: readonly string[]
  /** Ids whose row this reader could not read. Counted, never invented. */
  unresolvedCount: number
}

export type MemberListItem = {
  membershipId: string
  userId: string
  /** From `user_profiles`. Null when the profile row was not readable. */
  fullName: string | null
  status: MembershipStatus
  /** Null for every status except `active` — `memberships_joined_when_active`. */
  joinedAt: string | null
  lastActiveAt: string | null
  employmentType: string | null
  roles: readonly MemberRole[]
  scope: MemberScope
  teamName: string | null
  defaultPropertyName: string | null
  /** Who admitted them. Null for the founder, who was admitted by nobody. */
  invitedByName: string | null
  /**
   * When two-factor authentication was enforced on this account, or null.
   *
   * Not personal data and not decoration: it is the one column on a person's
   * record that says something about how hard their account is to take over,
   * and a buyer's reviewer looks for it. Shown to everybody holding
   * `user.view`, because a roster that hid it would hide the answer to
   * "is the owner's account protected".
   */
  mfaEnforcedAt: string | null
  /** Withheld without `user.edit`. See the header. */
  phone?: string | null
}

const MEMBER_REDACTIONS = [
  { key: 'phone', requires: 'user.edit' },
] as const satisfies ReadonlyArray<{
  key: keyof MemberListItem
  requires: Grant
}>

/**
 * `memberships` carries no soft delete, and that is load-bearing.
 *
 * The column comment in 0001 says it in as many words: removing a member sets
 * `status` to `removed` and never deletes the row, because their work must
 * stay attributed to them. So there is no `.is('deleted_at', null)` here, and
 * adding one would fail against a column that does not exist — which is the
 * good failure. The bad one would be filtering removed people out of a screen
 * whose whole job is to show that they were removed.
 */
const MEMBERSHIP_COLUMNS =
  'id, user_id, status, joined_at, last_active_at, employment_type, ' +
  'team_id, default_property_id, invited_by, created_at'

export type ListMembersArgs = {
  db: Db
  actor: Actor
  organizationId: string
}

/**
 * Everybody in this organization, however their membership stands.
 *
 * Ordered by status and then by name, so the four statuses that need somebody
 * to act — invited, pending, suspended, removed — do not sit interleaved with
 * ninety active employees. The ordering is applied in this file rather than in
 * the query because it is a display decision about a Hebrew enum, and Postgres
 * would order it by the enum's declaration order, which is a different list.
 */
export async function listMembers(
  args: ListMembersArgs,
): Promise<readonly MemberListItem[]> {
  const { db, actor, organizationId } = args

  // Asked before the round trip rather than after it. A reader without the
  // grant would be handed nothing by `memberships_select`'s application-side
  // counterpart anyway, and issuing a query that cannot legitimately return
  // anything is a request that only exists to be discarded.
  if (!holdsGrant(actor, 'user.view')) return []

  const { data, error } = await db
    .from('memberships')
    .select(MEMBERSHIP_COLUMNS)
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: true })

  if (error) throw error

  const rows = toRows(data)
  const membershipIds = rows.map((row) => asString(row, 'id'))
  const userIds = rows.flatMap((row) => [
    asString(row, 'user_id'),
    ...(asStringOrNull(row, 'invited_by') === null
      ? []
      : [asString(row, 'invited_by')]),
  ])

  const [profiles, roles, scopes, teams, properties] = await Promise.all([
    loadProfiles(db, userIds),
    loadRoles(db, organizationId, membershipIds),
    loadScopes(db, organizationId, membershipIds),
    loadNames(db, 'teams', organizationId),
    loadNames(db, 'properties', organizationId),
  ])

  const members = rows.map((row) => {
    const membershipId = asString(row, 'id')
    const userId = asString(row, 'user_id')
    const teamId = asStringOrNull(row, 'team_id')
    const invitedBy = asStringOrNull(row, 'invited_by')
    const defaultPropertyId = asStringOrNull(row, 'default_property_id')
    const profile = profiles.get(userId)

    const item: MemberListItem = {
      membershipId,
      userId,
      fullName: profile?.fullName ?? null,
      status: asEnum(row, 'status', MEMBERSHIP_STATUSES),
      joinedAt: asTimestampOrNull(row, 'joined_at'),
      lastActiveAt: asTimestampOrNull(row, 'last_active_at'),
      employmentType: asStringOrNull(row, 'employment_type'),
      roles: roles.get(membershipId) ?? [],
      scope: describeScope(scopes.get(membershipId) ?? null, teams, properties),
      teamName: teamId === null ? null : (teams.get(teamId) ?? null),
      defaultPropertyName:
        defaultPropertyId === null
          ? null
          : (properties.get(defaultPropertyId) ?? null),
      invitedByName:
        invitedBy === null ? null : (profiles.get(invitedBy)?.fullName ?? null),
      mfaEnforcedAt: profile?.mfaEnforcedAt ?? null,
      phone: profile?.phone ?? null,
    }

    // No resource: the field rule is about the grant alone, for the same
    // reason the row filter above is. A colleague's telephone number is not
    // located in a property either.
    return redact(actor, item, MEMBER_REDACTIONS)
  })

  return [...members].sort(byAttentionThenName)
}

/**
 * The statuses that mean somebody has to do something.
 *
 * `active` is the only status that needs nobody. The other four each name a
 * different unfinished piece of work — an invitation nobody accepted, a
 * request nobody approved, an account somebody locked, a person who left — and
 * the screen counts them so a roster of ninety does not hide the four.
 */
export function membersNeedingAttention(
  members: readonly MemberListItem[],
): readonly MemberListItem[] {
  return members.filter((member) => member.status !== 'active')
}

/**
 * The properties and teams an invitation can be scoped to.
 *
 * Read from the same tables the roster resolves names out of, and narrowed by
 * row level security in the same way — so the chooser cannot offer a property
 * the person doing the inviting cannot themselves reach. Offering one would
 * let somebody grant reach they do not hold, which is the widening
 * `clampScope` exists to refuse one layer down.
 */
export async function listScopeChoices(
  db: Db,
  organizationId: string,
): Promise<{
  properties: readonly { id: string; name: string }[]
  teams: readonly { id: string; name: string }[]
}> {
  const [properties, teams] = await Promise.all([
    loadNames(db, 'properties', organizationId),
    loadNames(db, 'teams', organizationId),
  ])

  const toChoices = (names: ReadonlyMap<string, string>) =>
    [...names]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'he'))

  return { properties: toChoices(properties), teams: toChoices(teams) }
}

/** How many memberships exist for this organization, before any narrowing. */
export async function countMembers(
  db: Db,
  organizationId: string,
): Promise<number> {
  const { count, error } = await db
    .from('memberships')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)

  if (error) throw error
  return count ?? 0
}

/* ------------------------------------------------------------ internals -- */

type Profile = {
  fullName: string | null
  phone: string | null
  mfaEnforcedAt: string | null
}

/**
 * Display names and telephone numbers for the people on this roster.
 *
 * `user_profiles_select` admits anybody who shares an organization with the
 * subject, so this is readable by every member — and it is only ever asked for
 * ids that appeared on a membership row this reader was already admitted to.
 * A missing profile leaves the name null rather than filling it with the uuid.
 */
async function loadProfiles(
  db: Db,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, Profile>> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return new Map()

  const { data, error } = await db
    .from('user_profiles')
    .select('id, full_name, phone, mfa_enforced_at')
    .in('id', unique)

  if (error) throw error

  const profiles = new Map<string, Profile>()
  for (const row of toRows(data)) {
    profiles.set(asString(row, 'id'), {
      fullName: asStringOrNull(row, 'full_name'),
      phone: asStringOrNull(row, 'phone'),
      mfaEnforcedAt: asTimestampOrNull(row, 'mfa_enforced_at'),
    })
  }
  return profiles
}

/**
 * The roles each membership holds, in the catalogue's own order.
 *
 * `roles.sort_order` is the order the migrations seeded and the order the
 * shell's role badges already use. Sorting alphabetically here would put the
 * same two roles in a different order on two screens of one product.
 */
async function loadRoles(
  db: Db,
  organizationId: string,
  membershipIds: readonly string[],
): Promise<ReadonlyMap<string, MemberRole[]>> {
  const { data, error } = await db
    .from('membership_roles')
    .select('membership_id, roles!inner(code, name, sort_order)')
    .eq('organization_id', organizationId)
    .in('membership_id', [...membershipIds])

  if (error) throw error

  const held = new Map<string, { role: MemberRole; order: number }[]>()

  for (const row of toRows(data)) {
    const embedded = row.roles
    if (
      embedded === null ||
      embedded === undefined ||
      Array.isArray(embedded)
    ) {
      continue
    }
    const role = toRow(embedded)
    const membershipId = asString(row, 'membership_id')
    const entries = held.get(membershipId) ?? []
    entries.push({
      role: { code: asString(role, 'code'), name: asString(role, 'name') },
      order: asNumber(role, 'sort_order'),
    })
    held.set(membershipId, entries)
  }

  const sorted = new Map<string, MemberRole[]>()
  for (const [membershipId, entries] of held) {
    sorted.set(
      membershipId,
      entries.sort((a, b) => a.order - b.order).map((entry) => entry.role),
    )
  }
  return sorted
}

/**
 * The scope row behind each membership, in the union shape the engine reads.
 *
 * A membership with no scope row is `null`, and stays `null` — `resolve.ts` is
 * explicit that this means "nothing", not "everything", and a screen that
 * rendered a missing row as "כל הארגון" would be showing the opposite of what
 * the engine will decide.
 */
async function loadScopes(
  db: Db,
  organizationId: string,
  membershipIds: readonly string[],
): Promise<ReadonlyMap<string, Scope>> {
  const { data, error } = await db
    .from('membership_scopes')
    .select('membership_id, kind, property_ids, unit_ids, team_ids')
    .eq('organization_id', organizationId)
    .in('membership_id', [...membershipIds])

  if (error) throw error

  const scopes = new Map<string, Scope>()
  for (const row of toRows(data)) {
    scopes.set(asString(row, 'membership_id'), toScope(row))
  }
  return scopes
}

function toScope(row: Row): Scope {
  const kind = asString(row, 'kind')
  switch (kind) {
    case 'all_organization':
      return { kind: 'all_organization' }
    case 'properties':
      return { kind: 'properties', propertyIds: idArray(row, 'property_ids') }
    case 'units':
      return { kind: 'units', unitIds: idArray(row, 'unit_ids') }
    case 'team':
      return { kind: 'team', teamIds: idArray(row, 'team_ids') }
    default:
      // `own_records`, and anything the enum grows that this file has not been
      // taught. Deny by default is the engine's rule and it is also the right
      // rendering rule: the narrowest true statement.
      return { kind: 'own_records' }
  }
}

function idArray(row: Row, column: string): string[] {
  const value = row[column]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** `id → name` for a table this reader may read. Used for teams and properties. */
async function loadNames(
  db: Db,
  table: 'teams' | 'properties',
  organizationId: string,
): Promise<ReadonlyMap<string, string>> {
  const { data, error } = await db
    .from(table)
    .select('id, name')
    .eq('organization_id', organizationId)
    .is('deleted_at', null)

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    names.set(asString(row, 'id'), asString(row, 'name'))
  }
  return names
}

/**
 * Turn a scope into something a person can read, without inventing anything.
 *
 * Unit ids are deliberately not resolved to names. A `units` scope is rare,
 * and reading the whole `units` table to label one would be a query issued for
 * a caption; the count is stated instead, which is true and cheap. Ids of any
 * kind that could not be named are counted rather than printed, because a
 * truncated uuid on a roster tells the reader nothing except that something
 * went wrong.
 */
function describeScope(
  scope: Scope | null,
  teams: ReadonlyMap<string, string>,
  properties: ReadonlyMap<string, string>,
): MemberScope {
  if (scope === null) {
    return { scope: { kind: 'own_records' }, names: [], unresolvedCount: 0 }
  }

  const resolve = (
    ids: readonly string[],
    names: ReadonlyMap<string, string>,
  ): MemberScope => {
    const found = ids
      .map((id) => names.get(id))
      .filter((name): name is string => name !== undefined)
    return { scope, names: found, unresolvedCount: ids.length - found.length }
  }

  switch (scope.kind) {
    case 'properties':
      return resolve(scope.propertyIds, properties)
    case 'team':
      return resolve(scope.teamIds, teams)
    case 'units':
      return { scope, names: [], unresolvedCount: scope.unitIds.length }
    default:
      return { scope, names: [], unresolvedCount: 0 }
  }
}

/** Anything that is not `active` first, then by name in Hebrew collation. */
function byAttentionThenName(a: MemberListItem, b: MemberListItem): number {
  const aNeeds = a.status === 'active' ? 1 : 0
  const bNeeds = b.status === 'active' ? 1 : 0
  if (aNeeds !== bNeeds) return aNeeds - bNeeds
  return (a.fullName ?? '').localeCompare(b.fullName ?? '', 'he')
}
