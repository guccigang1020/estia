/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Who is signed in, which organization they are acting in, and which property
 * they are looking at. Everything the shell renders comes from here, and it is
 * resolved once per request.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE. The stored context is a PREFERENCE,
 * never an authorization input. A cookie saying "organization X" is a request
 * to act there, and it is checked against the memberships the database will
 * actually admit — every request, not once at sign-in. A cookie that names an
 * organization the person was removed from resolves to their first real
 * workspace instead, and a cookie naming a property outside their scope
 * resolves to "all properties". Trusting either would turn a value the browser
 * holds into a tenant selector, which is the whole attack.
 *
 * The charter's human-error rule is the second half of the same idea: whatever
 * this resolves to must be visible on screen at all times, because a booking
 * created against the wrong property is expensive and nobody notices until the
 * guest arrives.
 */

import { cache } from 'react'

import { cookies } from 'next/headers'
import type { User } from '@supabase/supabase-js'

import { resolveActor } from '@/lib/actor'
import type { Actor, MembershipStatus, Scope } from '@/lib/authz/can'
import { createClient, getCurrentUser } from '@/lib/supabase/server'

import { SupabaseActorSource } from './actor-source'

/* ----------------------------------------------------------------- names -- */

/** The organization being acted in. */
export const WORKSPACE_COOKIE = 'estia.workspace'

/** `all`, or one property id. */
export const PROPERTY_COOKIE = 'estia.property'

/** The value meaning "do not narrow to a single property". */
export const ALL_PROPERTIES = 'all'

/* ----------------------------------------------------------------- types -- */

export type Workspace = {
  organizationId: string
  name: string
  slug: string
}

/**
 * A property the person may select.
 *
 * `name` stays nullable even though the `properties` table now supplies it,
 * because the read can fail and the fallback is the id. Inventing "וילה 1" to
 * fill the gap would be fabricated data on the one control whose entire job is
 * to prevent a mistake about which property is selected — a truncated id is
 * unhelpful, a confident wrong name is worse.
 */
export type PropertyOption = {
  id: string
  name: string | null
}

/** Display only. The authorization engine never sees a role name. */
export type RoleBadge = {
  code: string
  name: string
}

export type ShellContext =
  | {
      status: 'ready'
      user: User
      workspaces: readonly Workspace[]
      workspace: Workspace
      actor: Actor
      membershipId: string
      roles: readonly RoleBadge[]
      properties: readonly PropertyOption[]
      /** `ALL_PROPERTIES` or a property id that is genuinely in scope. */
      selectedPropertyId: string
    }
  | { status: 'no_workspace'; user: User }
  | {
      status: 'membership_not_active'
      user: User
      workspace: Workspace
      membershipStatus: MembershipStatus
    }
  | { status: 'no_subscription'; user: User; workspace: Workspace }

/* -------------------------------------------------------------- loading --- */

/**
 * The organizations this person may act in.
 *
 * Row level security answers this on its own terms: `my_organizations()`
 * returns only ACTIVE memberships, so an invited, suspended or removed person
 * cannot read the organization row at all and simply has no workspace here.
 * The application does not re-filter by status, because a second copy of that
 * rule is a second place for it to be wrong.
 */
export async function loadWorkspaces(userId: string): Promise<Workspace[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('memberships')
    .select('organization_id, organizations!inner(id, name, slug)')
    .eq('user_id', userId)
    .eq('status', 'active')

  if (error || !data) return []

  const rows = data as unknown as {
    organizations: { id: string; name: string; slug: string } | null
  }[]

  return rows
    .filter((row) => row.organizations !== null)
    .map((row) => ({
      organizationId: row.organizations!.id,
      name: row.organizations!.name,
      slug: row.organizations!.slug,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'he'))
}

/**
 * The role names held, for display beside the person's name.
 *
 * Deliberately separate from actor resolution. `Actor` has no `role` field —
 * roles are flattened into grants before authorization sees them — and this
 * query exists so a screen can say "מנהל כללי" without any code being tempted
 * to decide something from it.
 */
async function loadRoleBadges(membershipId: string): Promise<RoleBadge[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('membership_roles')
    .select('roles!inner(code, name, sort_order)')
    .eq('membership_id', membershipId)

  if (error || !data) return []

  const rows = data as unknown as {
    roles: { code: string; name: string; sort_order: number } | null
  }[]

  return rows
    .filter((row) => row.roles !== null)
    .sort((a, b) => a.roles!.sort_order - b.roles!.sort_order)
    .map((row) => ({ code: row.roles!.code, name: row.roles!.name }))
}

/**
 * The properties this person may narrow to.
 *
 * This once derived the list from the actor's scope alone, because the
 * `properties` table did not exist. It does now, and the comment saying
 * otherwise outlived the fact by several migrations — so an organization-wide
 * scope listed nothing at all, and a property-scoped one rendered truncated
 * UUIDs where names belong.
 *
 * Row level security already confines this to the caller's organization, so
 * the query asks broadly and lets the database do the narrowing; a
 * property-scoped membership then filters further.
 */
async function propertiesInScope(scope: Scope): Promise<PropertyOption[]> {
  const supabase = await createClient()
  const query = supabase
    .from('properties')
    .select('id, name')
    .is('deleted_at', null)
    .order('name')

  const { data, error } =
    scope.kind === 'properties'
      ? await query.in('id', [...scope.propertyIds])
      : await query

  // A switcher that cannot label itself is an inconvenience; a shell that
  // refuses to render is an outage. Fall back to the ids we already hold,
  // which keeps the chooser usable, rather than failing the page over a label.
  if (error || !data) {
    return scope.kind === 'properties'
      ? scope.propertyIds.map((id) => ({ id, name: null }))
      : []
  }

  return data.map((row) => ({
    id: row.id as string,
    name: (row.name as string | null) ?? null,
  }))
}

/* ------------------------------------------------------------ resolution -- */

/**
 * Pick the organization to act in.
 *
 * The cookie is honoured only when it names a workspace the database has just
 * confirmed. Otherwise the first workspace wins — a deterministic fallback
 * rather than an error page, because "your saved choice is no longer valid" is
 * not something to interrupt someone's morning with.
 */
function chooseWorkspace(
  workspaces: readonly Workspace[],
  requested: string | undefined,
): Workspace | null {
  if (workspaces.length === 0) return null

  const match = workspaces.find((w) => w.organizationId === requested)
  return match ?? workspaces[0]
}

/**
 * Pick the property to look at.
 *
 * Same rule, one level down: a stored id that is not in the person's scope
 * resolves to "all properties" rather than being trusted. `all` is also what a
 * person with an organization-wide scope always gets, because narrowing to a
 * property nobody has defined yet is not a thing that can be meant.
 */
function chooseProperty(
  properties: readonly PropertyOption[],
  requested: string | undefined,
): string {
  if (!requested || requested === ALL_PROPERTIES) return ALL_PROPERTIES
  return properties.some((property) => property.id === requested)
    ? requested
    : ALL_PROPERTIES
}

/**
 * The whole context for this request.
 *
 * Wrapped in React `cache` so the layout, the page and anything else in the
 * same render share one resolution — and, more importantly, so they cannot
 * disagree about which organization is active halfway down the tree.
 */
export const shellContext = cache(async (): Promise<ShellContext | null> => {
  const user = await getCurrentUser()
  if (!user) return null

  const store = await cookies()
  const workspaces = await loadWorkspaces(user.id)

  const workspace = chooseWorkspace(
    workspaces,
    store.get(WORKSPACE_COOKIE)?.value,
  )

  if (!workspace) return { status: 'no_workspace', user }

  const resolution = await resolveActor(
    new SupabaseActorSource(),
    user.id,
    workspace.organizationId,
  )

  if (!resolution.ok) {
    switch (resolution.reason) {
      case 'no_membership':
        // The membership vanished between listing the workspaces and resolving
        // the actor. Treat it as having none rather than as a broken state.
        return { status: 'no_workspace', user }
      case 'membership_not_active':
        return {
          status: 'membership_not_active',
          user,
          workspace,
          membershipStatus: resolution.status,
        }
      case 'no_subscription':
        return { status: 'no_subscription', user, workspace }
    }
  }

  const properties = await propertiesInScope(resolution.actor.scope)

  return {
    status: 'ready',
    user,
    workspaces,
    workspace,
    actor: resolution.actor,
    membershipId: resolution.membershipId,
    roles: await loadRoleBadges(resolution.membershipId),
    properties,
    selectedPropertyId: chooseProperty(
      properties,
      store.get(PROPERTY_COOKIE)?.value,
    ),
  }
})
