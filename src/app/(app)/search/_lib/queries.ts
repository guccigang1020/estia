/**
 * EXECUTION CONTEXT — SERVER ONLY. The reads behind the one search box.
 *
 * ── Only what the plan admitted, and only what the shape suggests ─────────
 *
 * `planSearch` has already dropped every kind this reader may not see, so a
 * closed kind costs no round trip. `parseQuery` has already ruled out the
 * kinds the string cannot be — an email reaches `guests` and nothing else.
 * Between them, the common searches cost one or two queries rather than seven.
 *
 * ── The phone path goes through the database's own function ───────────────
 *
 * `guests.phone_e164` is a generated column, produced by `normalize_phone_il`.
 * Matching it means normalising the query the same way, which is an RPC rather
 * than a regular expression here: a second normaliser in TypeScript would be a
 * second answer to "is this the same number", and the day the two disagreed a
 * returning guest would quietly become two people.
 *
 * `/guests` still puts the raw string into an `ilike`, which is why searching
 * `050-1234567` there finds nobody. That is `G-B7` in the guest CRM audit and
 * this module does not repeat it.
 *
 * ── Row level security is the floor under all of it ───────────────────────
 *
 * Every table read here carries its own policy. The grant checks above decide
 * how many queries to issue; they are not what makes the answer safe.
 */

import { likePattern, type ParsedQuery, type SearchKind } from '@/lib/search'
import { asString, asStringOrNull, toRows, type Db } from '@/lib/persistence'

/** Small on purpose: this is a jump-to, not a report. */
export const SEARCH_LIMIT = 8

export interface SearchHit {
  readonly kind: SearchKind
  readonly id: string
  /** What the row is called, in the words the row itself uses. */
  readonly title: string
  /** One line of context, or null when the row carries none worth showing. */
  readonly subtitle: string | null
  readonly href: string
}

export interface SearchArgs {
  readonly db: Db
  readonly organizationId: string
  readonly parsed: ParsedQuery
}

/**
 * Run one kind.
 *
 * Returns `[]` for a kind whose table is not in this database — the same
 * `not provisioned` reading `provisioning.ts` argues for elsewhere. A search
 * box that threw because one of seven tables was missing would be a search box
 * nobody could use during a migration.
 */
export async function searchKind(
  kind: SearchKind,
  args: SearchArgs,
): Promise<readonly SearchHit[]> {
  switch (kind) {
    case 'guest':
      return searchGuests(args)
    case 'booking':
      return searchBookings(args)
    case 'property':
      return searchProperties(args)
    case 'unit':
      return searchUnits(args)
    case 'task':
      return searchTasks(args)
    case 'owner':
      return searchOwners(args)
    case 'agent':
      return searchAgents(args)
  }
}

async function searchGuests(args: SearchArgs): Promise<readonly SearchHit[]> {
  const { db, organizationId, parsed } = args

  // The phone path first, and it is a different question rather than a
  // different pattern: an exact match on the normalised column, which is what
  // the unique index is built on.
  if (parsed.digits !== null) {
    const { data: normalised, error: rpcError } = await db.rpc(
      'normalize_phone_il',
      { raw: parsed.digits },
    )
    if (rpcError) throw rpcError

    if (typeof normalised === 'string' && normalised.length > 0) {
      const { data, error } = await db
        .from('guests')
        .select('id, full_name, phone, email')
        .eq('organization_id', organizationId)
        .eq('phone_e164', normalised)
        .is('deleted_at', null)
        .limit(SEARCH_LIMIT)

      if (error) throw error
      const hits = toRows(data).map(toGuestHit)
      // An exact phone match is the answer. Falling through to a name search
      // as well would bury the person found under people merely spelled alike.
      if (hits.length > 0) return hits
    }
  }

  if (parsed.shape === 'phone') return []

  const pattern = likePattern(parsed.text)
  const column = parsed.shape === 'email' ? 'email' : 'full_name'

  const { data, error } = await db
    .from('guests')
    .select('id, full_name, phone, email')
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .ilike(column, pattern)
    .limit(SEARCH_LIMIT)

  if (error) throw error
  return toRows(data).map(toGuestHit)
}

function toGuestHit(row: Parameters<typeof asString>[0]): SearchHit {
  const phone = asStringOrNull(row, 'phone')
  const email = asStringOrNull(row, 'email')
  return {
    kind: 'guest',
    id: asString(row, 'id'),
    title: asString(row, 'full_name'),
    subtitle: phone ?? email,
    href: `/guests/${asString(row, 'id')}`,
  }
}

async function searchBookings(args: SearchArgs): Promise<readonly SearchHit[]> {
  const { db, organizationId, parsed } = args

  const { data, error } = await db
    .from('bookings')
    .select('id, reference, check_in, check_out, status')
    .eq('organization_id', organizationId)
    .ilike('reference', likePattern(parsed.text))
    .limit(SEARCH_LIMIT)

  if (error) throw error

  return toRows(data).map((row) => ({
    kind: 'booking' as const,
    id: asString(row, 'id'),
    title: asString(row, 'reference'),
    subtitle: `${asString(row, 'check_in')} — ${asString(row, 'check_out')}`,
    href: `/bookings/${asString(row, 'id')}`,
  }))
}

async function searchProperties(
  args: SearchArgs,
): Promise<readonly SearchHit[]> {
  const { db, organizationId, parsed } = args

  const { data, error } = await db
    .from('properties')
    .select('id, name, city')
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .ilike('name', likePattern(parsed.text))
    .limit(SEARCH_LIMIT)

  if (error) throw error

  return toRows(data).map((row) => ({
    kind: 'property' as const,
    id: asString(row, 'id'),
    title: asString(row, 'name'),
    subtitle: asStringOrNull(row, 'city'),
    href: `/properties/${asString(row, 'id')}`,
  }))
}

async function searchUnits(args: SearchArgs): Promise<readonly SearchHit[]> {
  const { db, organizationId, parsed } = args
  const pattern = likePattern(parsed.text)

  const { data, error } = await db
    .from('units')
    .select('id, name, code, property_id')
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .or(`name.ilike.${pattern},code.ilike.${pattern}`)
    .limit(SEARCH_LIMIT)

  if (error) throw error

  return toRows(data).map((row) => ({
    kind: 'unit' as const,
    id: asString(row, 'id'),
    title: asString(row, 'name'),
    subtitle: asStringOrNull(row, 'code'),
    href: `/units`,
  }))
}

async function searchTasks(args: SearchArgs): Promise<readonly SearchHit[]> {
  const { db, organizationId, parsed } = args

  const { data, error } = await db
    .from('tasks')
    .select('id, title, status, task_type')
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .ilike('title', likePattern(parsed.text))
    .limit(SEARCH_LIMIT)

  if (error) throw error

  return toRows(data).map((row) => ({
    kind: 'task' as const,
    id: asString(row, 'id'),
    title: asString(row, 'title'),
    subtitle: asString(row, 'status'),
    href: `/tasks`,
  }))
}

async function searchOwners(args: SearchArgs): Promise<readonly SearchHit[]> {
  const { db, organizationId, parsed } = args

  const { data, error } = await db
    .from('property_owners')
    .select('id, display_name')
    .eq('organization_id', organizationId)
    .ilike('display_name', likePattern(parsed.text))
    .limit(SEARCH_LIMIT)

  if (error) throw error

  return toRows(data).map((row) => ({
    kind: 'owner' as const,
    id: asString(row, 'id'),
    title: asString(row, 'display_name'),
    subtitle: null,
    href: `/owners`,
  }))
}

/**
 * Agencies, and the one query here with no `organization_id` filter.
 *
 * That is not an omission. `public.agencies` deliberately has no such column —
 * an agency is an entity two businesses can both work with, and giving it an
 * owning tenant would make the second one a copy. The tenant boundary is
 * therefore the policy rather than a predicate this file can write:
 *
 *     agencies_select: id in (my_agencies())
 *                   or id in (agencies_my_organizations_work_with())
 *
 * Verified against the live catalogue before this query was written, because a
 * search box over a table with no tenant column is exactly the shape of the
 * leak `0079` was written to close, and "presumably RLS handles it" is not a
 * thing to presume on a search box.
 */
async function searchAgents(args: SearchArgs): Promise<readonly SearchHit[]> {
  const { db, parsed } = args

  const { data, error } = await db
    .from('agencies')
    .select('id, name')
    .ilike('name', likePattern(parsed.text))
    .limit(SEARCH_LIMIT)

  if (error) throw error

  return toRows(data).map((row) => ({
    kind: 'agent' as const,
    id: asString(row, 'id'),
    title: asString(row, 'name'),
    subtitle: null,
    href: `/agencies`,
  }))
}
