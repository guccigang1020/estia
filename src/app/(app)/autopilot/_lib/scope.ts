/**
 * EXECUTION CONTEXT — SERVER ONLY. Turning a membership's scope into a filter.
 *
 * ── Why this is not `scopeNarrowings` ────────────────────────────────────
 *
 * The preparation board's helper is right for `tasks`, and it is wrong here in
 * a way that fails loudly and then, worse, quietly. Its `own_records` branch
 * narrows on `assigned_to_user_id` and `created_by`; `autopilot_exceptions`
 * has neither column — it has `owner_user_id` — so the query would be a
 * PostgREST error rather than a narrowing. And its `units` and `team` branches
 * name `unit_id` and `team_id`, which no Autopilot table carries at all.
 *
 * A shared helper that silently filters on a column that does not exist is the
 * failure direction that matters: it either errors, or, against a client that
 * ignores unknown columns, returns every row in the organization.
 *
 * ── The rule, and it matches the RLS policy deliberately ─────────────────
 *
 * Every Autopilot table locates a row with a nullable `property_id`, and
 * `autopilot_exceptions_select` reads:
 *
 *     organization_id in (select my_organizations())
 *     and (property_id is null or property_in_scope(property_id, organization_id))
 *     and has_permission(organization_id, 'autopilot.view')
 *
 * So a row with no property is organization-wide. `can.ts` is explicit about
 * what that means for the application floor — "a resource that carries no
 * location is organization-wide and is therefore only reachable by an
 * organization-wide scope" — and this file follows that doctrine rather than
 * inventing a softer one for Autopilot. A property-scoped manager therefore
 * gets their properties' rows and not the organization-wide ones.
 *
 * That is narrower than RLS would allow, and narrow is the correct direction:
 * a query built wrong returns short rather than wide. It is written down here
 * rather than left as a surprising absence, because somebody will one day ask
 * why a property manager cannot see an organization-wide exception, and the
 * answer is `scopeReaches`, not a bug.
 *
 * ── Anything that is not `all_organization` or `properties` reaches nothing ──
 *
 * A unit-, team- or own-records-scoped membership has no property list, so
 * there is no honest narrowing to push into the query — and `can()` would drop
 * every row it returned anyway, because a property resource is outside all
 * three of those scopes. Returning `nothing` makes the round trip not happen.
 * In practice nobody is in this branch: `autopilot.*` sits in the governance
 * category and is held by owners and managers.
 */

import { scopeFor, type Actor, type Resource } from '@/lib/authz/can'

/**
 * The family Autopilot rows belong to.
 *
 * `operations` and not `settings`: an exception is about a task, a laundry
 * order, a unit or a booking's preparation, and a membership that narrowed its
 * operational reach meant to narrow this too. `RESOURCE_FAMILIES` has no
 * `autopilot` member and adding one is the authz owner's call, not this
 * screen's — noted rather than worked around.
 */
export const AUTOPILOT_FAMILY = 'operations' as const

export type AutopilotNarrowing =
  /** Every row in the organization. */
  | { kind: 'none' }
  /** Only these properties. Organization-wide rows are excluded — see header. */
  | { kind: 'property_in'; values: readonly string[] }
  /** Nothing is reachable. The caller must not issue the query. */
  | { kind: 'nothing' }

export function autopilotNarrowing(actor: Actor): AutopilotNarrowing {
  // Platform staff act across an organization once inside it, exactly as
  // `isWithinScope` allows, and every such view is audited by the caller.
  if (actor.isPlatformStaff === true) return { kind: 'none' }

  const scope = scopeFor(actor, {
    organizationId: actor.organizationId,
    family: AUTOPILOT_FAMILY,
  })

  switch (scope.kind) {
    case 'all_organization':
      return { kind: 'none' }
    case 'properties':
      return scope.propertyIds.length === 0
        ? { kind: 'nothing' }
        : { kind: 'property_in', values: scope.propertyIds }
    default:
      return { kind: 'nothing' }
  }
}

/**
 * The resource one Autopilot row names, for the `can()` re-check.
 *
 * `propertyId` is set only when the row carries one. Leaving it undefined for
 * an organization-wide row is what makes the second floor agree with the
 * first: both then require an organization-wide scope for it.
 */
export function autopilotResource(
  organizationId: string,
  propertyId: string | null,
): Resource {
  const resource: Resource = { organizationId, family: AUTOPILOT_FAMILY }
  if (propertyId !== null) resource.propertyId = propertyId
  return resource
}
