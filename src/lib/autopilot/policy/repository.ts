/**
 * Reading the five configuration tables the safety engine stands on.
 *
 * A port and two implementations: one over PostgREST, one in memory for the
 * tests. The port exists so `rule()` and `buildPolicyContext()` can be
 * exercised without a database, and so the adapter for this module's own
 * tables lives beside the module that reads them rather than in
 * `src/lib/persistence/**`, which belongs to another owner. That is the same
 * argument `src/lib/notifications/repository.ts` makes, made the same way on
 * purpose.
 *
 * Every tenant read filters `organization_id` in the query as well as relying
 * on row level security. The policy is the enforcement; the filter is what
 * stops a mistake in this file from becoming a cross-tenant read the first
 * time somebody runs it as `service_role`.
 *
 * ── The one table with no organization filter, and why ────────────────────
 *
 * `autopilot_safety_rules` has no `organization_id` column. It is the ceiling
 * ESTIA sets and no tenant may raise, so there is nothing to scope it to and a
 * filter would be a lie about who owns it. It is the only read here without
 * one, and that is stated rather than left to be noticed.
 *
 * ── Nothing in this file writes ───────────────────────────────────────────
 *
 * Configuring Autopilot is a command with validation, permissions and audit,
 * and it is not this module's job. The safety engine reads; giving it a write
 * path would put a second way to change the matrix beside the settings screen,
 * and the two would eventually disagree about what a valid matrix is.
 */

import {
  asBoolean,
  asEnum,
  asNumber,
  asString,
  asStringOrNull,
  asTimestampOrNull,
  toRow,
  toRows,
  type Db,
  type Row,
} from '../../persistence'
import {
  ACTION_SAFETY_LEVELS,
  AUTOPILOT_BOOKING_HANDLING,
  AUTOPILOT_DISPOSITIONS,
  AUTOPILOT_LEVELS,
  AUTOPILOT_RUN_MODES,
} from '../../contracts/states'
import { isAutopilotActionKind, type AutopilotActionKind } from '../actions'

import type {
  AutopilotBookingOverrideRecord,
  AutopilotPolicyRecord,
  AutopilotPropertyLevelRecord,
  AutopilotSafetyRuleRecord,
  AutopilotSettingsRecord,
} from './context'

/* ------------------------------------------------------------------ port -- */

export interface AutopilotPolicyRepository {
  /** `null` when the organization has never saved a row. Not an error. */
  loadSettings(organizationId: string): Promise<AutopilotSettingsRecord | null>

  /** The property's own level, when it has been held below its organization. */
  loadPropertyLevel(
    organizationId: string,
    propertyId: string,
  ): Promise<AutopilotPropertyLevelRecord | null>

  loadBookingOverride(
    organizationId: string,
    bookingId: string,
  ): Promise<AutopilotBookingOverrideRecord | null>

  /**
   * The organization's cells plus this property's, in one read.
   *
   * Both are returned rather than resolved here: laying one over the other is
   * `buildDispositions`, which is pure and tested without a database.
   */
  listPolicies(
    organizationId: string,
    propertyId: string | null,
  ): Promise<readonly AutopilotPolicyRecord[]>

  /** The platform floor. Not scoped to a tenant — see the header. */
  listSafetyRules(): Promise<readonly AutopilotSafetyRuleRecord[]>
}

/* --------------------------------------------------------------- mapping -- */

const SETTINGS_COLUMNS =
  'organization_id, level, run_mode, enabled, paused_until, paused_reason, ' +
  'lookahead_hours'

const PROPERTY_COLUMNS = 'property_id, organization_id, level'

const OVERRIDE_COLUMNS = 'booking_id, organization_id, handling'

const POLICY_COLUMNS =
  'id, organization_id, property_id, action_kind, disposition'

const SAFETY_COLUMNS =
  'id, action_kind, max_safety_level, max_disposition, reason'

export function settingsFromRow(row: Row): AutopilotSettingsRecord {
  return {
    organizationId: asString(row, 'organization_id'),
    level: asEnum(row, 'level', AUTOPILOT_LEVELS),
    runMode: asEnum(row, 'run_mode', AUTOPILOT_RUN_MODES),
    enabled: asBoolean(row, 'enabled'),
    pausedUntil: asTimestampOrNull(row, 'paused_until'),
    pausedReason: asStringOrNull(row, 'paused_reason'),
    lookaheadHours: asNumber(row, 'lookahead_hours'),
  }
}

export function propertyLevelFromRow(row: Row): AutopilotPropertyLevelRecord {
  return {
    propertyId: asString(row, 'property_id'),
    organizationId: asString(row, 'organization_id'),
    level: asEnum(row, 'level', AUTOPILOT_LEVELS),
  }
}

export function bookingOverrideFromRow(
  row: Row,
): AutopilotBookingOverrideRecord {
  return {
    bookingId: asString(row, 'booking_id'),
    organizationId: asString(row, 'organization_id'),
    handling: asEnum(row, 'handling', AUTOPILOT_BOOKING_HANDLING),
  }
}

/**
 * One matrix cell, or `null` for a row naming an action the catalogue no
 * longer has.
 *
 * Dropped rather than thrown on. `action_kind` is text precisely so the
 * catalogue can grow in TypeScript without a migration, and the cost of that
 * is a row that outlives its action. A stale row is a stale row; refusing to
 * load the settings screen because of one would turn a tidy-up into an outage,
 * and `actionSpec` in the catalogue makes the same argument in the same words.
 */
export function policyFromRow(row: Row): AutopilotPolicyRecord | null {
  const kind = asString(row, 'action_kind')
  if (!isAutopilotActionKind(kind)) return null

  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asStringOrNull(row, 'property_id'),
    actionKind: kind,
    disposition: asEnum(row, 'disposition', AUTOPILOT_DISPOSITIONS),
  }
}

/**
 * One platform rule, or `null` for one naming an unknown action.
 *
 * A rule with a null `action_kind` is the blanket kind and always maps: it
 * names a safety level, and safety levels are an enum in both places.
 */
export function safetyRuleFromRow(row: Row): AutopilotSafetyRuleRecord | null {
  const kind = asStringOrNull(row, 'action_kind')
  let actionKind: AutopilotActionKind | null = null

  if (kind !== null) {
    if (!isAutopilotActionKind(kind)) return null
    actionKind = kind
  }

  return {
    id: asString(row, 'id'),
    actionKind,
    maxSafetyLevel: asEnum(row, 'max_safety_level', ACTION_SAFETY_LEVELS),
    maxDisposition: asEnum(row, 'max_disposition', AUTOPILOT_DISPOSITIONS),
    reason: asString(row, 'reason'),
  }
}

function definedRows<T>(rows: readonly (T | null)[]): readonly T[] {
  return rows.filter((row): row is T => row !== null)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A property id that is safe to put inside a PostgREST `or` expression.
 *
 * `or` takes a comma-separated filter string, so an identifier that reached
 * here from anywhere but a `uuid` column could add a clause of its own — the
 * one place in this file where a value is concatenated into a query rather
 * than passed as an operand. Every id this repository is given comes from a
 * `uuid` column, so this refuses rather than escapes: a value that is not a
 * UUID is a caller bug, and the useful response is a loud one.
 */
function assertUuid(value: string): string {
  if (!UUID.test(value)) {
    throw new Error(`Not a property id: ${value}`)
  }
  return value
}

/* --------------------------------------------------------------- adapter -- */

export class SupabaseAutopilotPolicyRepository implements AutopilotPolicyRepository {
  constructor(private readonly db: Db) {}

  async loadSettings(
    organizationId: string,
  ): Promise<AutopilotSettingsRecord | null> {
    const { data, error } = await this.db
      .from('autopilot_settings')
      .select(SETTINGS_COLUMNS)
      .eq('organization_id', organizationId)
      .maybeSingle()

    if (error) throw error
    return data ? settingsFromRow(toRow(data)) : null
  }

  async loadPropertyLevel(
    organizationId: string,
    propertyId: string,
  ): Promise<AutopilotPropertyLevelRecord | null> {
    const { data, error } = await this.db
      .from('autopilot_property_settings')
      .select(PROPERTY_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('property_id', propertyId)
      .maybeSingle()

    if (error) throw error
    return data ? propertyLevelFromRow(toRow(data)) : null
  }

  async loadBookingOverride(
    organizationId: string,
    bookingId: string,
  ): Promise<AutopilotBookingOverrideRecord | null> {
    const { data, error } = await this.db
      .from('autopilot_booking_overrides')
      .select(OVERRIDE_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('booking_id', bookingId)
      .maybeSingle()

    if (error) throw error
    return data ? bookingOverrideFromRow(toRow(data)) : null
  }

  async listPolicies(
    organizationId: string,
    propertyId: string | null,
  ): Promise<readonly AutopilotPolicyRecord[]> {
    const query = this.db
      .from('autopilot_policies')
      .select(POLICY_COLUMNS)
      .eq('organization_id', organizationId)

    // Organization-wide cells always; this property's cells as well, when
    // there is a property. Written as one read rather than two so the matrix
    // cannot be assembled from rows fetched a second apart.
    const scoped =
      propertyId === null
        ? query.is('property_id', null)
        : query.or(
            `property_id.is.null,property_id.eq.${assertUuid(propertyId)}`,
          )

    const { data, error } = await scoped

    if (error) throw error
    return definedRows(toRows(data).map(policyFromRow))
  }

  async listSafetyRules(): Promise<readonly AutopilotSafetyRuleRecord[]> {
    const { data, error } = await this.db
      .from('autopilot_safety_rules')
      .select(SAFETY_COLUMNS)

    if (error) throw error
    return definedRows(toRows(data).map(safetyRuleFromRow))
  }
}

/* ------------------------------------------------------------- in memory -- */

/**
 * The double the policy tests run against.
 *
 * It applies the tenant filter that the real adapter and row level security
 * both apply, so a test that forgets to set `organizationId` on a fixture
 * fails here rather than passing for the wrong reason and failing in
 * production.
 */
export class InMemoryAutopilotPolicyRepository implements AutopilotPolicyRepository {
  settings = new Map<string, AutopilotSettingsRecord>()
  propertyLevels: AutopilotPropertyLevelRecord[] = []
  bookingOverrides: AutopilotBookingOverrideRecord[] = []
  policies: AutopilotPolicyRecord[] = []
  safetyRules: AutopilotSafetyRuleRecord[] = []

  async loadSettings(
    organizationId: string,
  ): Promise<AutopilotSettingsRecord | null> {
    return this.settings.get(organizationId) ?? null
  }

  async loadPropertyLevel(
    organizationId: string,
    propertyId: string,
  ): Promise<AutopilotPropertyLevelRecord | null> {
    return (
      this.propertyLevels.find(
        (row) =>
          row.organizationId === organizationId &&
          row.propertyId === propertyId,
      ) ?? null
    )
  }

  async loadBookingOverride(
    organizationId: string,
    bookingId: string,
  ): Promise<AutopilotBookingOverrideRecord | null> {
    return (
      this.bookingOverrides.find(
        (row) =>
          row.organizationId === organizationId && row.bookingId === bookingId,
      ) ?? null
    )
  }

  async listPolicies(
    organizationId: string,
    propertyId: string | null,
  ): Promise<readonly AutopilotPolicyRecord[]> {
    return this.policies.filter(
      (row) =>
        row.organizationId === organizationId &&
        (row.propertyId === null ||
          (propertyId !== null && row.propertyId === propertyId)),
    )
  }

  async listSafetyRules(): Promise<readonly AutopilotSafetyRuleRecord[]> {
    return this.safetyRules
  }
}
