/**
 * Where an actor's facts come from.
 *
 * This is an interface and not a Supabase query on purpose. Resolving an actor
 * is the single most security-critical computation in the product — it decides
 * which grants a person holds and where they apply — and a function that opens
 * a database connection cannot be exercised the way that deserves.
 *
 * So the fetching is injected. `resolveActor` becomes pure: rows in, `Actor`
 * out, no I/O, no clock, no environment. Its tests run in CI in milliseconds
 * against every combination of status, role, scope and plan, and they run on a
 * laptop with no database at all.
 *
 * The row shapes below mirror the real tables — `memberships`,
 * `membership_roles`, `membership_scopes`, `organization_subscriptions` — so
 * the eventual Supabase implementation is a mapping and nothing more. It is
 * deliberately *not* the `Scope` union or the `Actor`: converting the flat
 * database shape into the domain shape is a decision, and decisions belong in
 * `resolve.ts` where they are tested.
 */

import type { MembershipStatus, ResourceFamily, Scope } from '../authz/can'
import type { Grant } from '../authz/permissions'
import type { EffectivePlan } from '../plans/plan'

/** A row of `public.memberships`, narrowed to what authorization needs. */
export interface MembershipRow {
  id: string
  userId: string
  organizationId: string
  status: MembershipStatus
}

/**
 * How a role reaches a membership.
 *
 * Three kinds, because `grantsForRoles()` only understands the first:
 *
 *   `system`   — one of `SYSTEM_ROLES`. Resolved from the catalogue in code,
 *                so a permission added next year reaches owners and
 *                administrators without a data migration.
 *   `custom`   — a role a customer composed. Its grants come from
 *                `role_permissions` and are carried on the row.
 *   `platform` — ESTIA staff. Also carries its grants, and additionally marks
 *                the actor as platform staff.
 */
export type RoleKind = 'system' | 'custom' | 'platform'

export interface RoleAssignment {
  /** `roles.code`. For `system`, one of `SYSTEM_ROLES`. */
  code: string
  kind: RoleKind
  /**
   * The role's grants, read from `role_permissions`.
   * Required for `custom` and `platform`; ignored for `system`, whose grants
   * are the catalogue's answer and not the database's.
   */
  grants?: readonly Grant[]
}

/**
 * A row of `public.membership_scopes`.
 *
 * Flat, with three arrays, exactly as the table stores it. The check
 * constraint there guarantees only the array belonging to `kind` is populated;
 * `resolve.ts` does not rely on that and reads only the one it needs.
 */
export interface MembershipScopeRow {
  kind: 'all_organization' | 'properties' | 'units' | 'team' | 'own_records'
  propertyIds?: readonly string[]
  unitIds?: readonly string[]
  teamIds?: readonly string[]
}

/**
 * A membership whose reach genuinely differs by what is being reached for.
 *
 * One `membership_scopes` row cannot say two things, and an external sales
 * agent needs it to: *these properties* to see what is free to sell, and *only
 * their own records* for the bookings, commissions and leads inside them. So
 * the row grants the breadth, and this says which family may spend it.
 *
 * It is a **request**, not an answer. `resolve.ts` clamps every value here
 * against the scope the row actually granted — see `clampScope` in
 * `authz/can.ts` — so a source that asked for more than the membership holds
 * gets the membership's answer and not its own. That is what lets this be
 * populated from a settings screen without the settings screen becoming the
 * place inventory reach is decided.
 *
 * Absent for almost every membership. An employee has one scope, `loadScopeNarrowing`
 * answers `null`, and nothing about their resolution changes.
 */
export interface ScopeNarrowing {
  /** Applies wherever no family below names something else. */
  scope: Scope
  /** Per-family requests, each clamped to the granted scope by `resolve.ts`. */
  families: Partial<Record<ResourceFamily, Scope>>
}

/**
 * The data-access contract.
 *
 * Every method returns plain data or `null`. None of them throw for "absent" —
 * absence is an answer that `resolveActor` has to handle explicitly, and an
 * exception would let it be handled by accident.
 */
export interface ActorSource {
  /** The membership joining this user to this organization, or `null`. */
  loadMembership(
    userId: string,
    organizationId: string,
  ): Promise<MembershipRow | null>

  /** Every role held by the membership. An empty list is legitimate. */
  loadRoles(membershipId: string): Promise<readonly RoleAssignment[]>

  /**
   * The membership's scope row, or `null` when none was written.
   * A missing scope is not treated as "everything" — see `resolve.ts`.
   */
  loadScope(membershipId: string): Promise<MembershipScopeRow | null>

  /**
   * The per-family narrowing this membership carries, or `null` for the
   * overwhelming majority that carry none.
   *
   * Optional on the interface so that a source written before this existed
   * still satisfies it and still resolves exactly as it did. `resolveActor`
   * treats a source without the method and a source answering `null`
   * identically: `Actor.scopeOverrides` is left undefined and every resource
   * uses the membership's one scope, which is the behaviour every call site
   * was written against.
   */
  loadScopeNarrowing?(membershipId: string): Promise<ScopeNarrowing | null>

  /** The organization's live subscription and the plan it points at. */
  loadPlan(organizationId: string): Promise<EffectivePlan | null>
}
