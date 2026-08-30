/**
 * `ActorSource`, backed by Supabase.
 *
 * The reference implementation is `src/lib/actor/memory-source.ts`, and its
 * header asks whoever writes this file to read it first and answer
 * identically. This does. Every behaviour below was taken from there rather
 * than invented:
 *
 *   · a membership that does not exist is `null`, never a throw;
 *   · a membership with no roles is `[]`, which is legitimate;
 *   · a membership with no scope row is `null`, which `resolve.ts` treats as
 *     "nothing", not as "everything";
 *   · an organization with no live subscription is `null`.
 *
 * ── Four queries, and no join ─────────────────────────────────────────────
 *
 * They are separate because `resolveActor` calls them separately and stops
 * early: a suspended membership is refused before roles, scope or plan are
 * read, and `InMemoryActorSource` counts calls specifically so a test can
 * prove that nothing was touched. Folding them into one embedded select would
 * make that guarantee untestable and would read four tables to answer a
 * question settled by the first.
 *
 * ── `kind`, and why the catalogue wins for system roles ───────────────────
 *
 * `roles.is_system` and `roles.is_platform` decide the `RoleKind`. For a
 * `system` role the grants are *not* read from `role_permissions`, and the
 * `grants` field is left `undefined` rather than set to `[]` — `source.ts` is
 * explicit that a system role's grants are the catalogue's answer in code, so
 * a permission added next year reaches every owner without a data migration.
 * An empty array would read as "this role grants nothing", which is the exact
 * opposite of the intent, and `undefined` cannot be misread that way.
 *
 * ── The exception: the four agent presets ─────────────────────────────────
 *
 * "The catalogue wins for system roles" is exactly wrong for an agent, and it
 * was the whole of a real defect. An owner narrows an agent's calendar, price
 * or guest-data level on the agent settings screen; that writes
 * `agent_organization_settings`; and a system role re-resolved from the
 * catalogue on the next request hands back the grants the preset seeded on day
 * one. The settings screen lied, in the direction that matters — an intended
 * narrowing that never took effect.
 *
 * So `loadRoles` treats a seeded agent preset as a *pointer to the stored
 * ladders* rather than as an answer, and replaces it with the custom
 * assignment `agentActorRoleAssignments` computes from them. Nothing is
 * cached: the terms are read on the request, so narrowing them narrows the
 * request already in flight behind the owner's click.
 *
 * The replacement is partial on purpose — the preset's non-ladder rights, such
 * as an agency manager's own `agent.view` and `agent.invite`, are kept.
 * `agentRoleAssignment` in `src/lib/agents/access.ts` states the split.
 *
 * ── What is deliberately *not* projected: the inventory reach ─────────────
 *
 * `agentScopes` in `src/lib/agents/lifecycle.ts` computes the other half of an
 * agent's resolution — `scope: own_records` plus an `inventory` override for
 * the properties they may sell — and nothing here reads it. That looks like
 * the same defect as the one above, and it is not the same fix.
 *
 * `scopeFor` in `authz/can.ts` **replaces** the default scope with the
 * override for that family; it does not intersect them. An agent membership is
 * written by `attachExistingUser` without a `membership_scopes` row at all, so
 * every agent in the product resolves to the `own_records` fallback — which
 * reaches no property and no unit, because neither carries an assignee.
 * Writing the stored inventory reach into `scopeOverrides.inventory` would
 * therefore *widen* every agent, from nothing to whatever the settings name,
 * and `all_properties` converts to `all_organization`.
 *
 * That widening is the feature's stated intent, and it is still a widening: it
 * makes the agent settings screen the place where inventory reach is decided,
 * without any membership scope having granted it first. Closing it belongs
 * with whoever gives agent memberships a real scope row — not with a one-line
 * projection here, which is why this file leaves `Actor.scopeOverrides`
 * undefined and every agent fails closed on inventory instead.
 */

import { loadAgentAccessForMembership } from './agents'
import { asAgentPresetRole } from '../agents/access'
import { agentActorRoleAssignments } from '../agents/lifecycle'
import { MEMBERSHIP_STATUSES } from '../authz/can'
import type {
  ActorSource,
  MembershipRow,
  MembershipScopeRow,
  RoleAssignment,
} from '../actor/source'
import type { SystemRole } from '../authz/roles'
import type { Grant } from '../authz/permissions'
import type { Entitlement, PlanLimits } from '../plans/entitlements'
import type {
  BillingInterval,
  EffectivePlan,
  Plan,
  Subscription,
  SubscriptionStatus,
} from '../plans/plan'
import type { Db, Row } from './client'
import {
  asBoolean,
  asDateOrNull,
  asEnum,
  asJsonRecord,
  asNumber,
  asString,
  asStringArray,
  toRow,
  toRows,
} from './mapping'

/**
 * The five, re-exported from where they are now declared.
 *
 * They used to be defined here, which made a persistence adapter the source of
 * truth for a decision belonging to authorization — and made `agents.ts`
 * import from this file, which is the cycle `loadRoles` would close now that
 * it reads an agent's stored ladders. `authz/can.ts` declares them beside
 * `MembershipStatus`; this export stays so no caller had to move.
 */
export { MEMBERSHIP_STATUSES }

const SCOPE_KINDS: readonly MembershipScopeRow['kind'][] = [
  'all_organization',
  'properties',
  'units',
  'team',
  'own_records',
]

const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'trialing',
  'active',
  'past_due',
  'paused',
  'cancelled',
]

const BILLING_INTERVALS: readonly BillingInterval[] = ['monthly', 'yearly']

export class SupabaseActorSource implements ActorSource {
  constructor(private readonly db: Db) {}

  async loadMembership(
    userId: string,
    organizationId: string,
  ): Promise<MembershipRow | null> {
    const { data, error } = await this.db
      .from('memberships')
      .select('id, user_id, organization_id, status')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      // `maybeSingle`, not `single`: `single` reports "no rows" as an error,
      // and absence is an answer here rather than a fault. The unique
      // constraint `memberships_user_organization_key` guarantees at most one.
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    const row = toRow(data)
    return {
      id: asString(row, 'id'),
      userId: asString(row, 'user_id'),
      organizationId: asString(row, 'organization_id'),
      status: asEnum(row, 'status', MEMBERSHIP_STATUSES),
    }
  }

  async loadRoles(membershipId: string): Promise<readonly RoleAssignment[]> {
    // One round trip with an embedded resource rather than three. The
    // relationship is `membership_roles → roles → role_permissions`, and
    // PostgREST resolves it through the declared foreign keys.
    const { data, error } = await this.db
      .from('membership_roles')
      .select(
        'roles!inner(code, is_system, is_platform, role_permissions(permission_code))',
      )
      .eq('membership_id', membershipId)

    if (error) throw error
    if (!data) return []

    const assignments: RoleAssignment[] = []

    for (const entry of toRows(data)) {
      // PostgREST renders a to-one embed as an object, but has historically
      // rendered it as a single-element array; both are handled so a client
      // upgrade cannot silently produce an actor with no roles at all.
      const role = firstEmbedded(entry.roles)
      if (!role) continue

      const isPlatform = asBoolean(role, 'is_platform')
      const isSystem = asBoolean(role, 'is_system')

      if (isPlatform) {
        assignments.push({
          code: asString(role, 'code'),
          kind: 'platform',
          grants: readGrants(role),
        })
      } else if (isSystem) {
        // No `grants` key at all. See the header: the catalogue answers this,
        // and `undefined` is the only value that cannot be misread as "none".
        assignments.push({ code: asString(role, 'code'), kind: 'system' })
      } else {
        assignments.push({
          code: asString(role, 'code'),
          kind: 'custom',
          grants: readGrants(role),
        })
      }
    }

    return this.projectAgentAccess(membershipId, assignments)
  }

  /**
   * Replace a seeded agent preset with what the stored ladders say today.
   *
   * ── The second query, and when it is not made ─────────────────────────
   *
   * Only when one of the four preset codes is actually on the membership. An
   * employee — the overwhelming majority of resolutions — costs nothing, and
   * the header's "four queries, and no join" still holds for them. An agent
   * costs one more read, on a `UNIQUE` column, once per request. That is the
   * price of the guarantee, and it is paid only by the memberships that need
   * it.
   *
   * ── The two answers that are not a projection ─────────────────────────
   *
   * **No terms row** leaves the seeded role exactly as it was. The membership
   * and its role are written before the terms in `attachExistingUser`, so this
   * state is reachable mid-transaction and on any membership assembled by
   * another path; treating it as "narrowed to nothing" would lock an agent out
   * of the product over a row that was never written, and the seeded role is
   * the position the catalogue does describe.
   *
   * **An incoherent terms row** is not absorbed: `toAccess` throws, and this
   * does not catch it. A row the union cannot hold is a disagreement about
   * what an outsider may see, and the safe reading of that is to refuse the
   * request rather than to guess a rung.
   */
  private async projectAgentAccess(
    membershipId: string,
    assignments: readonly RoleAssignment[],
  ): Promise<readonly RoleAssignment[]> {
    const seeded: SystemRole[] = []
    const others: RoleAssignment[] = []

    for (const assignment of assignments) {
      const preset =
        assignment.kind === 'system' ? asAgentPresetRole(assignment.code) : null
      if (preset) seeded.push(preset)
      else others.push(assignment)
    }

    if (seeded.length === 0) return assignments

    const access = await loadAgentAccessForMembership(this.db, membershipId)
    if (access === null) return assignments

    return [...others, ...agentActorRoleAssignments(access, seeded)]
  }

  async loadScope(membershipId: string): Promise<MembershipScopeRow | null> {
    const { data, error } = await this.db
      .from('membership_scopes')
      .select('kind, property_ids, unit_ids, team_ids')
      .eq('membership_id', membershipId)
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    const row = toRow(data)
    // All three arrays are carried, flat, exactly as the table stores them.
    // `source.ts` says `resolve.ts` reads only the one belonging to `kind` and
    // does not rely on the check constraint to have emptied the others —
    // so narrowing here would be this file quietly taking that decision back.
    return {
      kind: asEnum(row, 'kind', SCOPE_KINDS),
      propertyIds: asStringArray(row, 'property_ids'),
      unitIds: asStringArray(row, 'unit_ids'),
      teamIds: asStringArray(row, 'team_ids'),
    }
  }

  async loadPlan(organizationId: string): Promise<EffectivePlan | null> {
    const { data, error } = await this.db
      .from('organization_subscriptions')
      .select(
        'id, organization_id, plan_id, status, billing_interval, ' +
          'agreed_monthly_price_agorot, agreed_yearly_price_agorot, ' +
          'trial_ends_at, current_period_end, limit_overrides, ' +
          'entitlement_grants, entitlement_revocations, ' +
          'plans!inner(id, code, name, description, monthly_price_agorot, ' +
          'yearly_price_agorot, limits, entitlements, is_public, sort_order)',
      )
      .eq('organization_id', organizationId)
      // A cancelled subscription is history, and the soft-deleted row is not a
      // subscription at all. Both are excluded here rather than downstream:
      // `loadPlan` promises "the organization's *live* subscription".
      .is('deleted_at', null)
      .neq('status', 'cancelled')
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    const row = toRow(data)
    const planRow = firstEmbedded(row.plans)
    // A subscription pointing at a plan that cannot be read is not a plan the
    // caller can be given. `plans_select` hides non-public plans from anyone
    // without a subscription to them, so this is reachable, and answering
    // `null` is the same "no live plan" the in-memory source gives.
    if (!planRow) return null

    const plan: Plan = {
      id: asString(planRow, 'id'),
      code: asString(planRow, 'code'),
      name: asString(planRow, 'name'),
      description: asString(planRow, 'description'),
      monthlyPrice: asNumber(planRow, 'monthly_price_agorot'),
      yearlyPrice: asNumber(planRow, 'yearly_price_agorot'),
      limits: readLimits(asJsonRecord(planRow, 'limits')),
      entitlements: asStringArray(planRow, 'entitlements') as Entitlement[],
      isPublic: asBoolean(planRow, 'is_public'),
      sortOrder: asNumber(planRow, 'sort_order'),
    }

    const subscription: Subscription = {
      id: asString(row, 'id'),
      organizationId: asString(row, 'organization_id'),
      planId: asString(row, 'plan_id'),
      status: asEnum(row, 'status', SUBSCRIPTION_STATUSES),
      interval: asEnum(row, 'billing_interval', BILLING_INTERVALS),
      agreedMonthlyPrice: asNumber(row, 'agreed_monthly_price_agorot'),
      agreedYearlyPrice: asNumber(row, 'agreed_yearly_price_agorot'),
      trialEndsAt: asDateOrNull(row, 'trial_ends_at'),
      currentPeriodEnd: asDateOrNull(row, 'current_period_end'),
      limitOverrides: readPartialLimits(asJsonRecord(row, 'limit_overrides')),
      entitlementGrants: asStringArray(
        row,
        'entitlement_grants',
      ) as Entitlement[],
      entitlementRevocations: asStringArray(
        row,
        'entitlement_revocations',
      ) as Entitlement[],
    }

    return { plan, subscription }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** A to-one embed, whichever of the two shapes PostgREST chose. */
function firstEmbedded(value: unknown): Row | null {
  if (Array.isArray(value)) return (value[0] as Row | undefined) ?? null
  if (value && typeof value === 'object') return value as Row
  return null
}

function readGrants(role: Row): readonly Grant[] {
  const permissions = role.role_permissions
  if (!Array.isArray(permissions)) return []
  return permissions.map(
    (entry) => asString(toRow(entry), 'permission_code') as Grant,
  )
}

/**
 * `plans.limits` is `jsonb`, so it is not type-checked by the column.
 *
 * `null` in a limit means unbounded and is a real value — `PlanLimits` types
 * every field as `number | null` for exactly that reason. A missing key,
 * though, means the JSON is not the shape the domain expects, and reading it
 * as unbounded would silently grant an infinite allowance. So a missing key
 * becomes `null` only because the domain has no third state to express it in,
 * and the parse is written out rather than cast so that is a visible choice.
 */
function readLimits(json: Record<string, unknown>): PlanLimits {
  return {
    properties: readLimit(json.properties),
    units: readLimit(json.units),
    members: readLimit(json.members),
    storageGb: readLimit(json.storageGb ?? json.storage_gb),
  }
}

function readPartialLimits(json: Record<string, unknown>): Partial<PlanLimits> {
  const limits: Partial<PlanLimits> = {}
  // Only keys that are actually present. An override object is a set of
  // *deviations*; filling absent keys with `null` would turn "no override on
  // units" into "unlimited units", which is a free upgrade for everyone.
  if ('properties' in json) limits.properties = readLimit(json.properties)
  if ('units' in json) limits.units = readLimit(json.units)
  if ('members' in json) limits.members = readLimit(json.members)
  if ('storageGb' in json) limits.storageGb = readLimit(json.storageGb)
  else if ('storage_gb' in json) limits.storageGb = readLimit(json.storage_gb)
  return limits
}

function readLimit(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return null
}
