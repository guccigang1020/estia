/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Assembling the one record the safety engine reads.
 *
 * ── This file gathers; it does not narrow ─────────────────────────────────
 *
 * `policy/context.ts` already resolves the property narrowing, lays the
 * property's matrix cells over the organization's, and expands the platform
 * floor into a map by safety level and a map by action. All of that is pure and
 * tested without a database, and none of it is repeated here — this reads the
 * five tables through `policy/repository.ts` and hands the rows over.
 *
 * ── `holdsGrant` closes over the real actor, and that is the point ────────
 *
 * The safety engine asks "does the acting identity hold this action's grant"
 * and it asks it through exactly the same authorization engine a person's click
 * goes through. An automation is not a way around it. So the closure calls
 * `can(actor, …)` on the resolved actor Autopilot is running as, and a grant
 * name the catalogue does not know answers `false` — fail closed, because the
 * alternative is an unrecognised string being treated as permission.
 */

import { can, type Actor } from '@/lib/authz/can'
import {
  FIELD_PERMISSIONS,
  isPermission,
  type Grant,
} from '@/lib/authz/permissions'

import {
  buildPolicyContext,
  settingsOrDefaults,
  type AutopilotSettingsRecord,
} from '../policy/context'
import { inQuietHours, type QuietWindow } from '../policy/quiet-hours'
import { SupabaseAutopilotPolicyRepository } from '../policy/repository'
import type { AutopilotPolicyRepository } from '../policy/repository'
import type { PolicyContext } from '../types'

export { SupabaseAutopilotPolicyRepository }

/* ---------------------------------------------------------------- grant -- */

const FIELD_GRANTS: ReadonlySet<string> = new Set<string>(FIELD_PERMISSIONS)

/** A grant name the catalogue knows, or nothing. */
function asGrant(value: string): Grant | null {
  if (isPermission(value)) return value
  return FIELD_GRANTS.has(value) ? (value as Grant) : null
}

/**
 * Whether this identity holds a named grant, asked exactly as a click asks.
 *
 * No resource is passed, and that is deliberate rather than an omission: the
 * scope question — may this person reach THIS property — is answered by the
 * domain command's own `loadResource` and second `assertCan`, on the row it
 * actually loaded. Answering it here as well from a property id the planner
 * supplied would be a second opinion about scope, and the day the two disagree
 * nobody knows which one the customer is living in.
 */
export function grantsOf(actor: Actor): (grant: string) => boolean {
  return (grant) => {
    const known = asGrant(grant)
    return known === null ? false : can(actor, known)
  }
}

/* -------------------------------------------------------------- gather --- */

export interface PolicyContextRequest {
  organizationId: string
  propertyId: string | null
  bookingId: string | null
  actor: Actor
  /** From `notification_settings`, through `ports.ts`. One quiet window. */
  quietWindow: QuietWindow
  now: Date
}

export interface GatheredPolicy {
  context: PolicyContext
  /** The organization's own row, for the lookahead the pass runs over. */
  settings: AutopilotSettingsRecord
}

/**
 * Everything the safety engine needs, in one read of five tables.
 *
 * A property row belonging to another organization is dropped by
 * `buildPolicyContext` rather than applied, so a mistake in a caller fails as
 * "no narrowing" instead of as one tenant's property governing another's.
 */
export async function gatherPolicyContext(
  repository: AutopilotPolicyRepository,
  request: PolicyContextRequest,
): Promise<GatheredPolicy> {
  const { organizationId, propertyId, bookingId } = request

  const [saved, propertyLevel, bookingOverride, policies, safetyRules] =
    await Promise.all([
      repository.loadSettings(organizationId),
      propertyId === null
        ? Promise.resolve(null)
        : repository.loadPropertyLevel(organizationId, propertyId),
      bookingId === null
        ? Promise.resolve(null)
        : repository.loadBookingOverride(organizationId, bookingId),
      repository.listPolicies(organizationId, propertyId),
      repository.listSafetyRules(),
    ])

  const settings = settingsOrDefaults(organizationId, saved)

  return {
    settings,
    context: buildPolicyContext({
      organizationId,
      propertyId,
      bookingId,
      settings: saved,
      propertyLevel,
      bookingOverride,
      policies,
      safetyRules,
      // What the customer bought, as the authorization engine already resolved
      // it. Read off the actor rather than the plan table, so there is one
      // answer to "what does this package include" rather than two.
      entitlements: [...request.actor.entitlements],
      holdsGrant: grantsOf(request.actor),
      // Already answered — the engine reads a boolean, and the reason it does
      // is argued at the top of `policy/quiet-hours.ts`.
      inQuietHours: inQuietHours(request.quietWindow, request.now),
      now: request.now,
    }),
  }
}
