/**
 * EXECUTION CONTEXT — SERVER ONLY. Reading the rate card out of Postgres.
 *
 * Row level security answers every query here, so a manager scoped to one
 * property gets that property's rows and no others — refused by the row rather
 * than filtered from the result, which is what makes the rule hold in an
 * export and a report as well as on a screen.
 *
 * ══ `not_provisioned` IS A REAL ANSWER ══════════════════════════════════════
 *
 * `0072_pricing.sql` may not have been applied to the database this is talking
 * to. PostgREST answers `42P01` for a missing relation, and every read here
 * turns that into `null` rather than throwing — so the screen can say "the
 * pricing tables are not in this database" in Hebrew instead of showing a
 * stack trace. The same shape `reviews` and `listing-quality` use, for the
 * same reason: a deployment that is behind on migrations is a state, not a
 * crash.
 *
 * ══ MONEY ═══════════════════════════════════════════════════════════════════
 *
 * `asAgorot` on every amount, so a column that arrives as a string from
 * PostgREST is an integer here or a `RowShapeError`. Nothing in this file
 * divides, multiplies or rounds — reading is not the place where money changes
 * shape.
 */

import {
  asAgorot,
  asBoolean,
  asEnum,
  asIsoDate,
  asJsonRecord,
  asNumber,
  asNumberOrNull,
  asString,
  asStringOrNull,
  asTimestampOrNull,
  toRow,
  toRows,
  type Db,
  type Row,
} from '../persistence'
import {
  RATE_CALENDAR_SOURCES,
  RATE_MODIFIER_KINDS,
  RATE_PLAN_KINDS,
  RATE_SCOPES,
  RATE_SUGGESTION_STATUSES,
  type DynamicPricingPolicy,
  type ModifierTrigger,
  type RateCalendarEntry,
  type RateModifier,
  type RatePlan,
  type RateSuggestion,
} from './types'
import type { BookingSource } from '../booking/types'
import type { SpecialDayKind } from '../hebrew-calendar'
import type { EventType } from '../preparation/types'
import type { RateRuleWithProperty } from './operations'

/** PostgREST's code for "that relation does not exist". */
const UNDEFINED_TABLE = '42P01'

function isMissingTable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === UNDEFINED_TABLE
}

const PLAN_COLUMNS =
  'id, organization_id, property_id, code, name, kind, channel_scope, ' +
  'requires_grant, derivation, min_nights, max_nights, advance_days_min, ' +
  'advance_days_max, cancellation_policy, floor_agorot, ceiling_agorot, ' +
  'priority, is_active, effective_from, effective_to, version'

const RULE_COLUMNS =
  'id, property_id, rate_plan_id, scope_kind, scope_id, specificity, ' +
  'date_from, date_to, weekdays, nightly_agorot, min_nights, priority, ' +
  'label, effective_from, effective_to'

const CALENDAR_COLUMNS =
  'id, property_id, unit_id, rate_plan_id, date, nightly_agorot, source, ' +
  'suggestion_id, approved_by, version'

const MODIFIER_COLUMNS =
  'id, kind, scope_kind, scope_id, rate_plan_id, trigger_config, ' +
  'adjust_kind, adjust_value, priority, is_active'

const SUGGESTION_COLUMNS =
  'id, property_id, unit_id, rate_plan_id, date, deterministic_agorot, ' +
  'suggested_agorot, confidence_bps, rationale, inputs_hash, status, ' +
  'expires_at, decided_by, decided_at, decision_reason'

export function toRatePlan(row: Row): RatePlan {
  const derivation = row.derivation

  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asStringOrNull(row, 'property_id'),
    code: asString(row, 'code'),
    name: asString(row, 'name'),
    kind: asEnum(row, 'kind', RATE_PLAN_KINDS),
    // Postgres hands back a text[]; an absent array and an empty one both mean
    // "every channel", so they collapse here rather than at four call sites.
    channelScope: Array.isArray(row.channel_scope)
      ? (row.channel_scope as BookingSource[])
      : [],
    requiresGrant: asStringOrNull(row, 'requires_grant'),
    derivation:
      derivation === null || derivation === undefined
        ? null
        : {
            fromRatePlanId: String(
              (derivation as Record<string, unknown>).from_rate_plan_id,
            ),
            adjust: (derivation as Record<string, unknown>).adjust as {
              kind: 'percent' | 'fixed'
              value: number
            },
          },
    minNights: asNumberOrNull(row, 'min_nights'),
    maxNights: asNumberOrNull(row, 'max_nights'),
    advanceDaysMin: asNumberOrNull(row, 'advance_days_min'),
    advanceDaysMax: asNumberOrNull(row, 'advance_days_max'),
    cancellationPolicy: asJsonRecord(row, 'cancellation_policy'),
    floorAgorot: asNumberOrNull(row, 'floor_agorot'),
    ceilingAgorot: asNumberOrNull(row, 'ceiling_agorot'),
    priority: asNumber(row, 'priority'),
    isActive: asBoolean(row, 'is_active'),
    effectiveFrom: asIsoDate(row, 'effective_from'),
    effectiveTo: asStringOrNull(row, 'effective_to'),
    version: asNumber(row, 'version'),
  }
}

export function toRateRule(row: Row): RateRuleWithProperty {
  return {
    id: asString(row, 'id'),
    propertyId: asString(row, 'property_id'),
    ratePlanId: asString(row, 'rate_plan_id'),
    scopeKind: asEnum(row, 'scope_kind', RATE_SCOPES),
    scopeId: asString(row, 'scope_id'),
    specificity: asNumber(row, 'specificity'),
    dateFrom: asIsoDate(row, 'date_from'),
    dateTo: asIsoDate(row, 'date_to'),
    weekdays: Array.isArray(row.weekdays) ? (row.weekdays as number[]) : [],
    nightlyAgorot: asAgorot(row, 'nightly_agorot'),
    minNights: asNumberOrNull(row, 'min_nights'),
    priority: asNumber(row, 'priority'),
    label: asStringOrNull(row, 'label'),
    effectiveFrom: asIsoDate(row, 'effective_from'),
    effectiveTo: asStringOrNull(row, 'effective_to'),
  }
}

export function toCalendarEntry(
  row: Row,
): RateCalendarEntry & { propertyId: string } {
  return {
    id: asString(row, 'id'),
    propertyId: asString(row, 'property_id'),
    unitId: asString(row, 'unit_id'),
    ratePlanId: asString(row, 'rate_plan_id'),
    date: asIsoDate(row, 'date'),
    nightlyAgorot: asAgorot(row, 'nightly_agorot'),
    source: asEnum(row, 'source', RATE_CALENDAR_SOURCES),
    suggestionId: asStringOrNull(row, 'suggestion_id'),
    approvedBy: asStringOrNull(row, 'approved_by'),
    version: asNumber(row, 'version'),
  }
}

export function toRateModifier(row: Row): RateModifier {
  const kind = asEnum(row, 'kind', RATE_MODIFIER_KINDS)
  const config = asJsonRecord(row, 'trigger_config')

  return {
    id: asString(row, 'id'),
    kind,
    scopeKind: asEnum(row, 'scope_kind', RATE_SCOPES),
    scopeId: asString(row, 'scope_id'),
    ratePlanId: asStringOrNull(row, 'rate_plan_id'),
    trigger: toTrigger(kind, config),
    adjustKind: asString(row, 'adjust_kind') === 'fixed' ? 'fixed' : 'percent',
    adjustValue: asNumber(row, 'adjust_value'),
    priority: asNumber(row, 'priority'),
    isActive: asBoolean(row, 'is_active'),
  }
}

/**
 * The stored condition, narrowed to the closed shape for its kind.
 *
 * A missing or malformed field becomes the neutral value rather than throwing,
 * and the neutral value is always the one that MATCHES NOTHING: an empty
 * weekday set, a tier from 0 to 0, an empty event list. A modifier whose
 * condition cannot be read must not silently apply to every night — the
 * conservative direction is the one that leaves the price alone.
 */
function toTrigger(
  kind: RateModifier['kind'],
  config: Readonly<Record<string, unknown>>,
): ModifierTrigger {
  const numbers = (key: string): number =>
    typeof config[key] === 'number' ? (config[key] as number) : 0
  const list = (key: string): string[] =>
    Array.isArray(config[key]) ? (config[key] as string[]) : []

  switch (kind) {
    case 'weekend':
      return {
        kind: 'weekend',
        weekdays: Array.isArray(config.weekdays)
          ? (config.weekdays as number[])
          : [],
      }
    case 'holiday':
      return {
        kind: 'holiday',
        // Narrowed by the resolver, which only ever compares these against the
        // kinds `specialDaysOn` actually returns. A stored value that is not
        // one of them matches nothing, which is the conservative direction.
        specialDayKinds: list('special_day_kinds') as SpecialDayKind[],
      }
    case 'occupancy':
      return {
        kind: 'occupancy',
        fromPercent: numbers('from_percent'),
        toPercent: numbers('to_percent'),
      }
    case 'guest_count':
      return { kind: 'guest_count', from: numbers('from'), to: numbers('to') }
    case 'event_type':
      return {
        kind: 'event_type',
        anyOf: list('any_of') as EventType[],
      }
  }
}

export function toSuggestion(
  row: Row,
): RateSuggestion & { propertyId: string } {
  return {
    id: asString(row, 'id'),
    propertyId: asString(row, 'property_id'),
    unitId: asString(row, 'unit_id'),
    ratePlanId: asString(row, 'rate_plan_id'),
    date: asIsoDate(row, 'date'),
    deterministicAgorot: asAgorot(row, 'deterministic_agorot'),
    suggestedAgorot: asAgorot(row, 'suggested_agorot'),
    confidenceBps: asNumberOrNull(row, 'confidence_bps'),
    rationale: asString(row, 'rationale'),
    inputsHash: asString(row, 'inputs_hash'),
    status: asEnum(row, 'status', RATE_SUGGESTION_STATUSES),
    expiresAt: asTimestampOrNull(row, 'expires_at'),
    decidedBy: asStringOrNull(row, 'decided_by'),
    decidedAt: asTimestampOrNull(row, 'decided_at'),
    decisionReason: asStringOrNull(row, 'decision_reason'),
  }
}

/**
 * Everything a screen or a quote needs, or `null` when the tables are absent.
 *
 * `null` and `[]` are different answers and this class keeps them different:
 * an empty list is a business with no rate card, and `null` is a database
 * without the tables. Collapsing them would put "you have not set any prices"
 * in front of somebody whose deployment is simply behind.
 */
export class PricingRepository {
  constructor(private readonly db: Db) {}

  async plans(organizationId: string): Promise<RatePlan[] | null> {
    const { data, error } = await this.db
      .from('rate_plans')
      .select(PLAN_COLUMNS)
      .eq('organization_id', organizationId)
      .order('priority', { ascending: false })
      .order('code', { ascending: true })

    if (error) return isMissingTable(error) ? null : Promise.reject(error)
    return toRows(data).map(toRatePlan)
  }

  async plan(organizationId: string, id: string): Promise<RatePlan | null> {
    const { data, error } = await this.db
      .from('rate_plans')
      .select(PLAN_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', id)
      .maybeSingle()

    if (error) return isMissingTable(error) ? null : Promise.reject(error)
    return data === null ? null : toRatePlan(toRow(data))
  }

  async rulesForPlan(
    organizationId: string,
    ratePlanId: string,
  ): Promise<RateRuleWithProperty[] | null> {
    const { data, error } = await this.db
      .from('rate_rules')
      .select(RULE_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('rate_plan_id', ratePlanId)

    if (error) return isMissingTable(error) ? null : Promise.reject(error)
    return toRows(data).map(toRateRule)
  }

  async rule(
    organizationId: string,
    id: string,
  ): Promise<RateRuleWithProperty | null> {
    const { data, error } = await this.db
      .from('rate_rules')
      .select(RULE_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', id)
      .maybeSingle()

    if (error) return isMissingTable(error) ? null : Promise.reject(error)
    return data === null ? null : toRateRule(toRow(data))
  }

  /** One month of one unit, for the calendar screen. Half-open `[from, to)`. */
  async calendar(
    organizationId: string,
    query: { unitId: string; ratePlanId: string; from: string; to: string },
  ): Promise<(RateCalendarEntry & { propertyId: string })[] | null> {
    const { data, error } = await this.db
      .from('rate_calendar')
      .select(CALENDAR_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('unit_id', query.unitId)
      .eq('rate_plan_id', query.ratePlanId)
      .gte('date', query.from)
      .lt('date', query.to)
      .order('date', { ascending: true })

    if (error) return isMissingTable(error) ? null : Promise.reject(error)
    return toRows(data).map(toCalendarEntry)
  }

  async calendarNight(
    organizationId: string,
    key: { unitId: string; ratePlanId: string; date: string },
  ): Promise<(RateCalendarEntry & { propertyId: string }) | null> {
    const { data, error } = await this.db
      .from('rate_calendar')
      .select(CALENDAR_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('unit_id', key.unitId)
      .eq('rate_plan_id', key.ratePlanId)
      .eq('date', key.date)
      .maybeSingle()

    if (error) return isMissingTable(error) ? null : Promise.reject(error)
    return data === null ? null : toCalendarEntry(toRow(data))
  }

  async modifiers(
    organizationId: string,
    propertyId: string,
  ): Promise<RateModifier[] | null> {
    const { data, error } = await this.db
      .from('rate_modifiers')
      .select(MODIFIER_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('property_id', propertyId)
      .eq('is_active', true)

    if (error) return isMissingTable(error) ? null : Promise.reject(error)
    return toRows(data).map(toRateModifier)
  }

  async pendingSuggestions(
    organizationId: string,
    propertyIds: readonly string[],
  ): Promise<(RateSuggestion & { propertyId: string })[] | null> {
    if (propertyIds.length === 0) return []

    const { data, error } = await this.db
      .from('rate_suggestions')
      .select(SUGGESTION_COLUMNS)
      .eq('organization_id', organizationId)
      .in('property_id', [...propertyIds])
      .eq('status', 'pending')
      .order('date', { ascending: true })

    if (error) return isMissingTable(error) ? null : Promise.reject(error)
    return toRows(data).map(toSuggestion)
  }

  async suggestion(
    organizationId: string,
    id: string,
  ): Promise<(RateSuggestion & { propertyId: string }) | null> {
    const { data, error } = await this.db
      .from('rate_suggestions')
      .select(SUGGESTION_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', id)
      .maybeSingle()

    if (error) return isMissingTable(error) ? null : Promise.reject(error)
    return data === null ? null : toSuggestion(toRow(data))
  }

  async policy(
    organizationId: string,
    propertyId: string | null,
  ): Promise<DynamicPricingPolicy | null> {
    let query = this.db
      .from('dynamic_pricing_policies')
      .select(
        'id, property_id, auto_apply, max_delta_bps, max_daily_changes, ' +
          'floor_agorot, ceiling_agorot, enabled_by_user_id, enabled_at',
      )
      .eq('organization_id', organizationId)

    query =
      propertyId === null
        ? query.is('property_id', null)
        : query.eq('property_id', propertyId)

    const { data, error } = await query.maybeSingle()
    if (error) return isMissingTable(error) ? null : Promise.reject(error)
    if (data === null) return null

    const row = toRow(data)
    return {
      id: asString(row, 'id'),
      propertyId: asStringOrNull(row, 'property_id'),
      autoApply: asBoolean(row, 'auto_apply'),
      maxDeltaBps: asNumber(row, 'max_delta_bps'),
      maxDailyChanges: asNumber(row, 'max_daily_changes'),
      floorAgorot: asNumberOrNull(row, 'floor_agorot'),
      ceilingAgorot: asNumberOrNull(row, 'ceiling_agorot'),
      enabledByUserId: asStringOrNull(row, 'enabled_by_user_id'),
      enabledAt: asTimestampOrNull(row, 'enabled_at'),
    }
  }
}
