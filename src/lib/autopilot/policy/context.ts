/**
 * Turning rows into the one record `rule()` reads.
 *
 * Pure functions over already-fetched rows, and no database client anywhere in
 * the file. That is what lets the safety engine be exercised over a hundred
 * combinations of level, matrix, package and platform floor in a suite that
 * runs with no Supabase project — and it is the same argument `rule.ts` makes
 * about `PolicyContext` being a record rather than a set of callbacks.
 *
 * ── The narrowings are resolved here, not in the engine ───────────────────
 *
 * A property that sits below its organization and a safety rule that covers
 * every action at or above a level are both *shapes of data*, not decisions.
 * Resolving them here means `rule()` reads one level and two ceiling maps —
 * the platform floor by safety level, and the platform floor for the actions a
 * rule names by name — and has no opinion about where any of them came from,
 * which is why its eleven floors stay readable as a list.
 */

import {
  ACTION_SAFETY_LEVELS,
  AUTOPILOT_DISPOSITIONS,
  AUTOPILOT_LADDER,
  type ActionSafetyLevel,
  type AutopilotBookingHandling,
  type AutopilotDisposition,
  type AutopilotLevel,
  type AutopilotRunMode,
} from '../../contracts/states'
import type { Entitlement } from '../../plans/entitlements'
import type { AutopilotActionKind } from '../actions'
import type { PolicyContext } from '../types'

/* --------------------------------------------------------------- records -- */

/** `autopilot_settings`, mapped. */
export interface AutopilotSettingsRecord {
  organizationId: string
  level: AutopilotLevel
  runMode: AutopilotRunMode
  enabled: boolean
  /** ISO 8601. In the future means paused; in the past means nothing. */
  pausedUntil: string | null
  pausedReason: string | null
  lookaheadHours: number
}

/** `autopilot_property_settings`, mapped. Never `custom` — 0046 forbids it. */
export interface AutopilotPropertyLevelRecord {
  propertyId: string
  organizationId: string
  level: AutopilotLevel
}

/** `autopilot_booking_overrides`, mapped. */
export interface AutopilotBookingOverrideRecord {
  bookingId: string
  organizationId: string
  handling: AutopilotBookingHandling
}

/** One cell of the matrix. `propertyId` set means it narrows one property. */
export interface AutopilotPolicyRecord {
  id: string
  organizationId: string
  propertyId: string | null
  actionKind: AutopilotActionKind
  disposition: AutopilotDisposition
}

/** `autopilot_safety_rules`. Platform-owned; no organization, deliberately. */
export interface AutopilotSafetyRuleRecord {
  id: string
  /** `null` means every action at or above `maxSafetyLevel`. */
  actionKind: AutopilotActionKind | null
  maxSafetyLevel: ActionSafetyLevel
  maxDisposition: AutopilotDisposition
  reason: string
}

/* -------------------------------------------------------------- defaults -- */

/**
 * What an organization that has never saved a row is living in.
 *
 * Off, and simulating. A customer whose entitlement was granted this morning
 * must not wake up to messages having been sent overnight, so "no row" is a
 * complete and deliberately timid configuration rather than a missing one.
 * The same sentence is a comment on the table in 0046; it is repeated here
 * because this is the code that would have to be wrong for it to stop being
 * true.
 */
export function settingsOrDefaults(
  organizationId: string,
  saved: AutopilotSettingsRecord | null,
): AutopilotSettingsRecord {
  return (
    saved ?? {
      organizationId,
      level: 'off',
      runMode: 'simulation',
      enabled: true,
      pausedUntil: null,
      pausedReason: null,
      lookaheadHours: 72,
    }
  )
}

/* ----------------------------------------------------------------- level -- */

function ladderRank(level: AutopilotLevel): number {
  return (AUTOPILOT_LADDER as readonly string[]).indexOf(level)
}

/**
 * The level that actually applies here: the lower of the organization's and
 * the property's.
 *
 * A property narrows and never widens. The asymmetry is the point — a business
 * rolling this out moves one villa UP by moving the ORGANIZATION up and
 * holding the others down, so that raising the ceiling is always a decision
 * made in one place and visible on one screen.
 *
 * Three cases are not a plain comparison, and each is here rather than in a
 * caller that would get one of them wrong:
 *
 *   · The organization is `off`. Nothing a property row says can start it.
 *   · The organization is `custom`. `custom` is off the ladder, so it cannot
 *     be compared to `assisted` — but a property row is still a narrowing, and
 *     returning it is right: the matrix is consulted either way, one floor
 *     further down, so the property's ladder position is pure subtraction.
 *   · The property is `custom`. 0046 has a CHECK forbidding this, so a row
 *     that says it bypassed the schema. It is not trusted and not treated as
 *     a second matrix; it collapses to `advisory`, the lowest level that still
 *     watches and reports. Failing to `off` would blind a business because of
 *     one bad row, and honouring it would be inventing a per-property matrix
 *     the product deliberately does not have.
 */
export function resolveLevel(
  orgLevel: AutopilotLevel,
  propertyLevel: AutopilotLevel | null,
): AutopilotLevel {
  if (propertyLevel === null) return orgLevel
  if (orgLevel === 'off') return 'off'
  if (propertyLevel === 'custom') return 'advisory'
  if (orgLevel === 'custom') return propertyLevel

  return ladderRank(propertyLevel) < ladderRank(orgLevel)
    ? propertyLevel
    : orgLevel
}

/* ---------------------------------------------------------------- matrix -- */

/**
 * The matrix as one lookup, with the property's cells laid over the
 * organization's.
 *
 * A property row for an action replaces the organization's row for that action
 * rather than being combined with it — the unique indexes in 0046 are
 * `(organization_id, action_kind) where property_id is null` and
 * `(property_id, action_kind)`, so at most one of each exists and "replaces"
 * is the only reading the schema supports. Whether the replacement is a
 * narrowing is not this function's business: `rule()` applies the platform
 * ceiling afterwards, and every floor below only subtracts.
 */
export function buildDispositions(
  policies: readonly AutopilotPolicyRecord[],
  propertyId: string | null,
): Readonly<Partial<Record<AutopilotActionKind, AutopilotDisposition>>> {
  const matrix: Partial<Record<AutopilotActionKind, AutopilotDisposition>> = {}

  for (const policy of policies) {
    if (policy.propertyId === null)
      matrix[policy.actionKind] = policy.disposition
  }

  if (propertyId !== null) {
    for (const policy of policies) {
      if (policy.propertyId === propertyId) {
        matrix[policy.actionKind] = policy.disposition
      }
    }
  }

  return matrix
}

/* --------------------------------------------------------------- ceiling -- */

/**
 * The platform floor, expanded from the BLANKET rules into a value per safety
 * level.
 *
 * A rule with a null `action_kind` covers every action **at or above** its
 * `max_safety_level`, which is the rule that actually matters and would
 * otherwise have to be written once per action name. So one seeded row capping
 * `business_impact` at `ask_approval` caps `money_access_cancellation` too,
 * and the engine reads a flat map instead of re-deriving that ordering.
 *
 * A rule that names one action is not folded in here at all — see
 * `buildSafetyCeilingByAction`, and the paragraph there about why folding it
 * in at that action's safety level was quietly wrong.
 *
 * Strictest wins wherever two rules reach the same level. Two platform rules
 * disagreeing is a platform mistake, and the safe reading of a mistake about
 * money is the smaller number.
 */
export function buildSafetyCeiling(
  rules: readonly AutopilotSafetyRuleRecord[],
): Readonly<Partial<Record<ActionSafetyLevel, AutopilotDisposition>>> {
  const ceiling: Partial<Record<ActionSafetyLevel, AutopilotDisposition>> = {}

  for (const rule of rules) {
    if (rule.actionKind !== null) continue

    const from = ACTION_SAFETY_LEVELS.indexOf(rule.maxSafetyLevel)
    if (from < 0) continue

    // "At or above" is what the table means, so a blanket rule climbs.
    for (const level of ACTION_SAFETY_LEVELS.slice(from)) {
      const existing = ceiling[level]
      const stricter =
        existing === undefined ||
        AUTOPILOT_DISPOSITIONS.indexOf(rule.maxDisposition) <
          AUTOPILOT_DISPOSITIONS.indexOf(existing)
      if (stricter) ceiling[level] = rule.maxDisposition
    }
  }

  return ceiling
}

/**
 * The platform floor for the actions a rule names one at a time.
 *
 * `autopilot_safety_rules.action_kind` is nullable precisely so ESTIA can cap
 * ONE action without capping its whole safety level — the shape a rule takes
 * after an incident with one specific thing, where capping the level would
 * silently make four unrelated actions timid.
 *
 * ── Why this is a second map and not a fold ───────────────────────────────
 *
 * The previous shape folded such a rule into the level map at the action's own
 * safety level, given the action being ruled on. That is correct only for a
 * context built to answer ONE question. A context is gathered once per
 * organization and then ruled on for many actions in the same pass, and in
 * that shape the fold made every sibling at that level inherit a cap that was
 * never about them — a rule about `guest.request_review` quietly holding back
 * `cleaner.escalate`. Keyed by action, it can only ever reach the action it
 * names.
 *
 * `max_safety_level` is not consulted here. On a row that names an action, the
 * action already says which safety level it lives at, and honouring the column
 * as well would mean a row whose two halves disagree does nothing at all —
 * the one outcome a rule written after an incident must not have.
 *
 * Strictest wins, for the same reason it does at the level: two platform rules
 * disagreeing is a platform mistake, and the safe reading of a mistake is the
 * smaller number.
 */
export function buildSafetyCeilingByAction(
  rules: readonly AutopilotSafetyRuleRecord[],
): Readonly<Partial<Record<AutopilotActionKind, AutopilotDisposition>>> {
  const ceiling: Partial<Record<AutopilotActionKind, AutopilotDisposition>> = {}

  for (const rule of rules) {
    const kind = rule.actionKind
    if (kind === null) continue

    const existing = ceiling[kind]
    const stricter =
      existing === undefined ||
      AUTOPILOT_DISPOSITIONS.indexOf(rule.maxDisposition) <
        AUTOPILOT_DISPOSITIONS.indexOf(existing)
    if (stricter) ceiling[kind] = rule.maxDisposition
  }

  return ceiling
}

/* --------------------------------------------------------------- context -- */

export interface PolicyContextInput {
  organizationId: string
  propertyId: string | null
  bookingId: string | null
  /** `null` when the organization has never saved a row. Not an error. */
  settings: AutopilotSettingsRecord | null
  propertyLevel: AutopilotPropertyLevelRecord | null
  bookingOverride: AutopilotBookingOverrideRecord | null
  policies: readonly AutopilotPolicyRecord[]
  safetyRules: readonly AutopilotSafetyRuleRecord[]
  entitlements: readonly Entitlement[]
  holdsGrant: (grant: string) => boolean
  /** Already answered — see `quiet-hours.ts` for why it is a boolean here. */
  inQuietHours: boolean
  now: Date
}

/**
 * Everything the safety engine needs, gathered once.
 *
 * A property row belonging to a different organization, or a booking override
 * belonging to one, is ignored rather than applied. Row level security already
 * refuses to hand either of them over; this makes a mistake in a caller fail
 * as "no narrowing" instead of as one tenant's booking quietly governing
 * another tenant's action, which is the shape of bug nobody would see until it
 * mattered.
 */
export function buildPolicyContext(input: PolicyContextInput): PolicyContext {
  const settings = settingsOrDefaults(input.organizationId, input.settings)

  const propertyRow =
    input.propertyLevel !== null &&
    input.propertyLevel.organizationId === input.organizationId &&
    input.propertyLevel.propertyId === input.propertyId
      ? input.propertyLevel
      : null

  const overrideRow =
    input.bookingOverride !== null &&
    input.bookingOverride.organizationId === input.organizationId &&
    input.bookingOverride.bookingId === input.bookingId
      ? input.bookingOverride
      : null

  return {
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    bookingId: input.bookingId,
    level: resolveLevel(settings.level, propertyRow?.level ?? null),
    runMode: settings.runMode,
    enabled: settings.enabled,
    pausedUntil: settings.pausedUntil,
    bookingHandling: overrideRow?.handling ?? 'normal',
    dispositions: buildDispositions(input.policies, input.propertyId),
    safetyCeiling: buildSafetyCeiling(input.safetyRules),
    safetyCeilingByAction: buildSafetyCeilingByAction(input.safetyRules),
    entitlements: input.entitlements,
    holdsGrant: input.holdsGrant,
    inQuietHours: input.inQuietHours,
    now: input.now,
  }
}
