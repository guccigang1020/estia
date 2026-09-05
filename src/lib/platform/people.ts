/**
 * EXECUTION CONTEXT — SERVER ONLY. Finding a person across organizations.
 *
 * ══ THIS IS THE READ MOST LIKELY TO LEAK, AND IT IS BUILT AROUND THAT ═════
 *
 * Every other console read starts from an organization. This one starts from a
 * person and deliberately crosses tenants, because the support call it exists
 * for begins "someone called, they say they cannot get in, they think their
 * company is called something like…". There is no version of that question
 * that stays inside one customer.
 *
 * Three rules follow, and all three are in the code rather than in a comment
 * somewhere else:
 *
 *   1. **A blank query returns nothing.** Not the first page of everybody —
 *      nothing. Listing the entire user base is not a support action and there
 *      is no screen state in which somebody meant to ask for it. `searchPeople`
 *      refuses a query shorter than two characters before touching the
 *      database.
 *
 *   2. **The result is capped, and says when it was capped.** A search that
 *      quietly truncates teaches its reader that the person is not in the
 *      system.
 *
 *   3. **The disclosure is name, phone and where they are a member.** Not
 *      their email — `auth.users` is not opened by 0041 and is not read here.
 *      Not anything they did: a person's bookings, payments and messages are
 *      their employer's business records and no policy in this database lets
 *      ESTIA staff near them.
 *
 * The justification for all of it is one thing and is checked in one place:
 * `has_platform_permission('platform.organization.view')`, in the policies
 * 0041 adds. There is no membership fallback anywhere in this file, and there
 * is nothing a customer could hold that would make any of these queries return
 * a row.
 */

import type { Db, Row } from '@/lib/persistence'
import {
  asEnum,
  asString,
  asStringOrNull,
  asTimestampOrNull,
  toRows,
} from '@/lib/persistence'
import { MEMBERSHIP_STATUSES, type MembershipStatus } from '@/lib/authz/can'

import { loadDisplayNames } from './organizations'

/* ----------------------------------------------------------------- types -- */

/** The shortest query worth running. Below this, nothing is read at all. */
export const MINIMUM_QUERY_LENGTH = 2

/** How many people one search may return before it is truncated. */
export const PEOPLE_PAGE_SIZE = 25

export interface PersonMembership {
  membershipId: string
  organizationId: string
  organizationName: string
  organizationSlug: string
  status: MembershipStatus
  /** Role names as displayed, never as decided upon. */
  roles: readonly string[]
  joinedAt: string | null
}

export interface Person {
  userId: string
  displayName: string | null
  phone: string | null
  /**
   * Every organization this person is a member of, in any status.
   *
   * Suspended and removed memberships are included on purpose: "I was removed
   * and nobody told me" is one of the two calls this screen answers, and a
   * list filtered to active memberships answers it with an empty result that
   * reads as "you were never here".
   */
  memberships: readonly PersonMembership[]
}

export type PeopleSearch =
  /** The query was too short to run. Nothing was read. */
  | { outcome: 'query_too_short' }
  | { outcome: 'results'; people: readonly Person[]; truncated: boolean }

/* ---------------------------------------------------------------- search -- */

/**
 * Find people by name or phone.
 *
 * The two columns are searched together because a support call supplies
 * whichever the caller remembers. `full_name` is matched anywhere in the
 * string, since Hebrew names arrive in either order and a prefix match finds
 * "דנה כהן" and misses "כהן דנה".
 */
export async function searchPeople(
  db: Db,
  query: string,
): Promise<PeopleSearch> {
  const term = query.trim()
  if (term.length < MINIMUM_QUERY_LENGTH) return { outcome: 'query_too_short' }

  // `%` and `,` are the two characters that change what a PostgREST `or`
  // filter means rather than what it matches. Removing them keeps a pasted
  // phone number or an accidental wildcard from widening the search into
  // "everybody".
  const safe = term.replace(/[%,()]/g, ' ').trim()
  if (safe.length < MINIMUM_QUERY_LENGTH) return { outcome: 'query_too_short' }

  const { data, error } = await db
    .from('user_profiles')
    .select('id, full_name, phone')
    .or(`full_name.ilike.%${safe}%,phone.ilike.%${safe}%`)
    .limit(PEOPLE_PAGE_SIZE + 1)

  if (error) throw new Error(error.message)

  const rows = toRows(data)
  const truncated = rows.length > PEOPLE_PAGE_SIZE
  const page = rows.slice(0, PEOPLE_PAGE_SIZE)

  const userIds = page.map((row) => asString(row, 'id'))
  const memberships = await loadMembershipsFor(db, userIds)

  return {
    outcome: 'results',
    truncated,
    people: page.map((row) => {
      const userId = asString(row, 'id')
      return {
        userId,
        displayName: asStringOrNull(row, 'full_name'),
        phone: asStringOrNull(row, 'phone'),
        memberships: memberships.get(userId) ?? [],
      }
    }),
  }
}

/**
 * Everybody in one organization, with the roles they hold.
 *
 * The organization-first half of the same disclosure, used by the account
 * screen. It reads the same three tables under the same single justification.
 */
export async function listOrganizationMembers(
  db: Db,
  organizationId: string,
): Promise<readonly Person[]> {
  const { data, error } = await db
    .from('memberships')
    .select('id, user_id, organization_id, status, joined_at')
    .eq('organization_id', organizationId)
    .order('joined_at', { ascending: true })
    .limit(200)

  if (error) throw new Error(error.message)

  const rows = toRows(data)
  const userIds = rows.map((row) => asString(row, 'user_id'))

  const [names, phones, roles, organizations] = await Promise.all([
    loadDisplayNames(db, userIds),
    loadPhones(db, userIds),
    loadRoleNames(
      db,
      rows.map((row) => asString(row, 'id')),
    ),
    loadOrganizationLabels(db, [organizationId]),
  ])

  const label = organizations.get(organizationId)

  return rows.map((row) => {
    const userId = asString(row, 'user_id')
    const membershipId = asString(row, 'id')

    return {
      userId,
      displayName: names.get(userId) ?? null,
      phone: phones.get(userId) ?? null,
      memberships: [
        {
          membershipId,
          organizationId,
          organizationName: label?.name ?? organizationId,
          organizationSlug: label?.slug ?? '',
          status: asEnum(row, 'status', MEMBERSHIP_STATUSES),
          roles: roles.get(membershipId) ?? [],
          joinedAt: asTimestampOrNull(row, 'joined_at'),
        },
      ],
    }
  })
}

/* ------------------------------------------------------------- internals -- */

async function loadMembershipsFor(
  db: Db,
  userIds: readonly string[],
): Promise<Map<string, PersonMembership[]>> {
  const result = new Map<string, PersonMembership[]>()
  if (userIds.length === 0) return result

  const { data, error } = await db
    .from('memberships')
    .select('id, user_id, organization_id, status, joined_at')
    .in('user_id', [...userIds])

  if (error) return result

  const rows = toRows(data)
  const [roles, organizations] = await Promise.all([
    loadRoleNames(
      db,
      rows.map((row) => asString(row, 'id')),
    ),
    loadOrganizationLabels(
      db,
      rows.map((row) => asString(row, 'organization_id')),
    ),
  ])

  for (const row of rows) {
    const userId = asString(row, 'user_id')
    const organizationId = asString(row, 'organization_id')
    const membershipId = asString(row, 'id')
    const label = organizations.get(organizationId)

    const entry: PersonMembership = {
      membershipId,
      organizationId,
      // Not "unknown organization". A membership whose organization did not
      // come back is a fact about a real tenant, and the id is the true answer
      // to which one.
      organizationName: label?.name ?? organizationId,
      organizationSlug: label?.slug ?? '',
      status: asEnum(row, 'status', MEMBERSHIP_STATUSES),
      roles: roles.get(membershipId) ?? [],
      joinedAt: asTimestampOrNull(row, 'joined_at'),
    }

    const existing = result.get(userId)
    if (existing) existing.push(entry)
    else result.set(userId, [entry])
  }

  return result
}

async function loadPhones(
  db: Db,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return result

  const { data, error } = await db
    .from('user_profiles')
    .select('id, phone')
    .in('id', unique)

  if (error) return result

  for (const row of toRows(data)) {
    const phone = asStringOrNull(row, 'phone')
    if (phone) result.set(asString(row, 'id'), phone)
  }

  return result
}

/**
 * Role names per membership.
 *
 * Names, for reading. The console never derives a decision from a role code —
 * that is what `role_permissions` is for, and the console does not evaluate a
 * customer's authorization on their behalf.
 */
async function loadRoleNames(
  db: Db,
  membershipIds: readonly string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  const unique = [...new Set(membershipIds)]
  if (unique.length === 0) return result

  const { data, error } = await db
    .from('membership_roles')
    .select('membership_id, roles!inner(name, sort_order)')
    .in('membership_id', unique)

  if (error) return result

  const rows = toRows(data).map((row) => ({
    membershipId: asString(row, 'membership_id'),
    role: (row as { roles?: { name?: unknown; sort_order?: unknown } | null })
      .roles,
  }))

  rows.sort((a, b) => {
    const left = typeof a.role?.sort_order === 'number' ? a.role.sort_order : 0
    const right = typeof b.role?.sort_order === 'number' ? b.role.sort_order : 0
    return left - right
  })

  for (const { membershipId, role } of rows) {
    if (typeof role?.name !== 'string') continue
    const existing = result.get(membershipId)
    if (existing) existing.push(role.name)
    else result.set(membershipId, [role.name])
  }

  return result
}

async function loadOrganizationLabels(
  db: Db,
  organizationIds: readonly string[],
): Promise<Map<string, { name: string; slug: string }>> {
  const result = new Map<string, { name: string; slug: string }>()
  const unique = [...new Set(organizationIds)]
  if (unique.length === 0) return result

  const { data, error } = await db
    .from('organizations')
    .select('id, name, slug')
    .in('id', unique)

  if (error) return result

  for (const row of toRows(data) as Row[]) {
    result.set(asString(row, 'id'), {
      name: asString(row, 'name'),
      slug: asString(row, 'slug'),
    })
  }

  return result
}
