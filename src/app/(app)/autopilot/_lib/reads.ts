/**
 * EXECUTION CONTEXT — SERVER ONLY. Everything the Autopilot screens read.
 *
 * The header of `action-center/_lib/queries.ts` is the model for this file and
 * the three floors it describes hold here unchanged. What follows is what is
 * different about Autopilot, because the differences are where the mistakes
 * would be.
 *
 * ── Three floors, and the menu is none of them ───────────────────────────
 *
 *   1. `requireAutopilotGrant` refuses the route, or renders the plan offer
 *      for a customer whose package does not carry the add-on. Each read below
 *      additionally asks `holdsGrant` for its OWN grant before it issues a
 *      query — and the grants are genuinely different amounts of authority:
 *      `autopilot.view` opens today's exceptions, `autopilot.activity_view`
 *      opens the full history of every message ESTIA has sent on the
 *      business's behalf, and the second is not implied by the first.
 *   2. The membership's scope is pushed into the query as a narrowing by
 *      `autopilotNarrowing`, and every row that survives it is checked again
 *      with `can()` against the property it names. Read that file before
 *      changing a filter here: the ordinary `scopeNarrowings` helper names
 *      columns no Autopilot table has.
 *   3. Row level security refuses regardless of both, and it is not the same
 *      predicate on every table — `autopilot_actions_select` requires
 *      `autopilot.activity_view` while `autopilot_exceptions_select` requires
 *      `autopilot.view`. A screen that asked for the wrong one gets an empty
 *      list from Postgres and no error, which is exactly why the grant is
 *      checked here as well as there.
 *
 * ── Nothing in this file decides anything ────────────────────────────────
 *
 * No readiness percentage is computed, no disposition is resolved against the
 * safety floor, no risk is inferred from a deadline. Every value returned is a
 * column, a stored JSON fact, or a catalogue lookup by primary key. The one
 * shaping step is grouping exceptions by `caused_by`, which is following a
 * foreign key rather than forming an opinion.
 *
 * ── `reason` and `evidence` are read, never re-derived ───────────────────
 *
 * 0046 is explicit and the whole activity screen depends on it: an action
 * taken about a booking that has since been cancelled must still say what it
 * said at the time. So this file never joins back to the subject to explain a
 * row. `evidence` is parsed defensively — it is stored JSON and a malformed
 * entry must drop out rather than crash the screen — and otherwise printed as
 * it was written.
 *
 * ── Every table may be empty, and empty is not an error ──────────────────
 *
 * This product seeds nothing. `autopilot_settings` with no row means level
 * `off` and run mode `simulation`, which the migration calls "a complete and
 * deliberately timid configuration" — so `loadSettings` returns those defaults
 * with `configured: false` rather than `null`, and the screen prints the
 * difference. A caller that got `null` would have to invent the defaults, and
 * the second copy would be the one that drifts.
 */

import { can, holdsGrant, type Actor } from '@/lib/authz/can'
import { actionSpec } from '@/lib/autopilot/actions'
import type { Evidence } from '@/lib/autopilot/types'
import {
  ACTION_SAFETY_LEVELS,
  AUTOPILOT_ACTION_OUTCOMES,
  AUTOPILOT_CAPABILITY_STATES,
  AUTOPILOT_CONFIDENCE_LEVELS,
  AUTOPILOT_DISPOSITIONS,
  AUTOPILOT_DOMAINS,
  AUTOPILOT_EXCEPTION_STATES,
  AUTOPILOT_LEVELS,
  AUTOPILOT_RISK_STATES,
  AUTOPILOT_RUN_MODES,
  AUTOPILOT_SUPPRESSION_REASONS,
  type ActionSafetyLevel,
  type AutopilotCapabilityState,
  type AutopilotDisposition,
  type AutopilotExceptionState,
  type AutopilotLevel,
  type AutopilotRunMode,
  type AutopilotSuppressionReason,
} from '@/lib/contracts/states'
import {
  asBoolean,
  asEnum,
  asNumber,
  asString,
  asStringOrNull,
  asTimestamp,
  asTimestampOrNull,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'
import type { ActionView, ExceptionView } from '@/components/autopilot/views'

import { autopilotNarrowing, autopilotResource } from './scope'

/**
 * The ceiling on any one list.
 *
 * The same argument `ACTION_PANEL_SIZE` makes: this is a list of things a
 * person is going to act on, and a panel that needs two hundred rows is a
 * panel nobody reads. Each list says out loud when it hits the ceiling.
 */
export const AUTOPILOT_PAGE_SIZE = 50

export type AutopilotReadArgs = {
  db: Db
  actor: Actor
  organizationId: string
  /** A single property, or null for every property in scope. */
  propertyId: string | null
  limit?: number
}

/* ------------------------------------------------------------ evidence -- */

/**
 * Stored JSON into `Evidence`, dropping anything that is not one.
 *
 * Defensive rather than trusting, and not because the writer is suspect: the
 * column is `jsonb` with only an `is array` constraint, it will be written by
 * five different detectors over time, and one malformed entry must cost a
 * bullet point rather than the screen. Nothing is invented for a missing
 * field — an entry without a source is dropped, because a fact with no
 * attribution is the exact thing `Evidence` exists to prevent.
 */
export function evidenceFrom(value: unknown): readonly Evidence[] {
  if (!Array.isArray(value)) return []

  const facts: Evidence[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>

    const key = record.key
    const label = record.label
    const source = record.source
    if (
      typeof key !== 'string' ||
      typeof label !== 'string' ||
      typeof source !== 'string'
    ) {
      continue
    }

    const raw = record.value
    const fact: Evidence = {
      key,
      label,
      source,
      value:
        typeof raw === 'string' ||
        typeof raw === 'number' ||
        typeof raw === 'boolean'
          ? raw
          : null,
    }
    if (typeof record.sourceId === 'string') fact.sourceId = record.sourceId
    if (typeof record.observedAt === 'string') {
      fact.observedAt = record.observedAt
    }
    facts.push(fact)
  }
  return facts
}

/* ------------------------------------------------------------ settings -- */

export type AutopilotSettingsView = {
  /** False when no row exists. The values below are then the defaults. */
  configured: boolean
  level: AutopilotLevel
  runMode: AutopilotRunMode
  simulationStartedAt: string | null
  /** The kill switch. `false` stops everything except reading. */
  enabled: boolean
  /** In the future means paused; in the past means nothing. */
  pausedUntil: string | null
  pausedReason: string | null
  preset: string
  dailyBriefEnabled: boolean
  dailyBriefAt: string
  eveningSummaryEnabled: boolean
  eveningSummaryAt: string
  lookaheadHours: number
  updatedAt: string | null
}

/** What 0046 says a missing row means. Stated once, here. */
export const DEFAULT_SETTINGS: AutopilotSettingsView = {
  configured: false,
  level: 'off',
  runMode: 'simulation',
  simulationStartedAt: null,
  enabled: true,
  pausedUntil: null,
  pausedReason: null,
  preset: 'safe',
  dailyBriefEnabled: true,
  dailyBriefAt: '07:30',
  eveningSummaryEnabled: false,
  eveningSummaryAt: '20:00',
  lookaheadHours: 72,
  updatedAt: null,
}

export async function loadSettings(
  args: AutopilotReadArgs,
): Promise<AutopilotSettingsView> {
  const { db, actor, organizationId } = args
  if (!holdsGrant(actor, 'autopilot.view')) return DEFAULT_SETTINGS

  const { data, error } = await db
    .from('autopilot_settings')
    .select(
      'level, run_mode, simulation_started_at, enabled, paused_until, ' +
        'paused_reason, preset, daily_brief_enabled, daily_brief_at, ' +
        'evening_summary_enabled, evening_summary_at, lookahead_hours, ' +
        'updated_at',
    )
    .eq('organization_id', organizationId)
    .limit(1)

  if (error) throw error

  const row = toRows(data)[0]
  if (row === undefined) return DEFAULT_SETTINGS

  return {
    configured: true,
    level: asEnum(row, 'level', AUTOPILOT_LEVELS),
    runMode: asEnum(row, 'run_mode', AUTOPILOT_RUN_MODES),
    simulationStartedAt: asTimestampOrNull(row, 'simulation_started_at'),
    enabled: asBoolean(row, 'enabled'),
    pausedUntil: asTimestampOrNull(row, 'paused_until'),
    pausedReason: asStringOrNull(row, 'paused_reason'),
    preset: asString(row, 'preset'),
    dailyBriefEnabled: asBoolean(row, 'daily_brief_enabled'),
    dailyBriefAt: asString(row, 'daily_brief_at'),
    eveningSummaryEnabled: asBoolean(row, 'evening_summary_enabled'),
    eveningSummaryAt: asString(row, 'evening_summary_at'),
    lookaheadHours: asNumber(row, 'lookahead_hours'),
    updatedAt: asTimestampOrNull(row, 'updated_at'),
  }
}

/* ---------------------------------------------------------- capability -- */

export type CapabilityView = {
  state: AutopilotCapabilityState
  trialEndsAt: string | null
  actionLimit: number | null
  note: string | null
}

/**
 * The platform's record of WHY this customer does or does not hold the
 * feature.
 *
 * Read, never used as a gate. `platform/capabilities.ts` and the header of
 * 0046 both argue that a second table answering "does this customer have X" is
 * a second answer; the entitlement is the gate and this is what lets a screen
 * say "בתקופת התנסות עד ה־14" instead of nothing. No row means `not_available`,
 * which is the honest default and not an unfinished state.
 */
export async function loadCapability(
  args: AutopilotReadArgs,
): Promise<CapabilityView> {
  const { db, organizationId } = args

  const { data, error } = await db
    .from('autopilot_capability')
    .select('state, trial_ends_at, action_limit, note')
    .eq('organization_id', organizationId)
    .limit(1)

  if (error) throw error

  const row = toRows(data)[0]
  if (row === undefined) {
    return {
      state: 'not_available',
      trialEndsAt: null,
      actionLimit: null,
      note: null,
    }
  }

  return {
    state: asEnum(row, 'state', AUTOPILOT_CAPABILITY_STATES),
    trialEndsAt: asTimestampOrNull(row, 'trial_ends_at'),
    actionLimit:
      row.action_limit === null || row.action_limit === undefined
        ? null
        : asNumber(row, 'action_limit'),
    note: asStringOrNull(row, 'note'),
  }
}

/* ------------------------------------------------------- safety floor --- */

export type SafetyRuleView = {
  id: string
  /** Null means "every action at or above `maxSafetyLevel`". */
  actionKind: string | null
  maxSafetyLevel: ActionSafetyLevel
  maxDisposition: AutopilotDisposition
  /** ESTIA's own sentence. Rendered verbatim; never summarised. */
  reason: string
}

/**
 * The ceiling no customer may raise.
 *
 * `autopilot_safety_rules_select` is `using (true)` on purpose — 0046 says
 * everybody who can see Autopilot at all can read the floor, because "a
 * ceiling the customer cannot see is a ceiling they will spend an afternoon
 * trying to configure their way past". So there is no grant check here, and
 * that is not an omission.
 */
export async function loadSafetyRules(
  db: Db,
): Promise<readonly SafetyRuleView[]> {
  const { data, error } = await db
    .from('autopilot_safety_rules')
    .select('id, action_kind, max_safety_level, max_disposition, reason')

  if (error) throw error

  return toRows(data).map((row) => ({
    id: asString(row, 'id'),
    actionKind: asStringOrNull(row, 'action_kind'),
    maxSafetyLevel: asEnum(row, 'max_safety_level', ACTION_SAFETY_LEVELS),
    maxDisposition: asEnum(row, 'max_disposition', AUTOPILOT_DISPOSITIONS),
    reason: asString(row, 'reason'),
  }))
}

/* -------------------------------------------------------- the matrix --- */

export type PolicyRowView = {
  id: string
  actionKind: string
  /** Null for the organization-wide cell; set for a per-property override. */
  propertyId: string | null
  disposition: AutopilotDisposition
}

/**
 * What the customer has actually written down.
 *
 * A MISSING row is not `off` — 0046 says it means the level's default, so a
 * business can move the whole ladder without having written a row per action
 * first. This function therefore returns only what exists, and the screen says
 * "לפי הרמה" for the rest rather than printing a `off` nobody chose.
 */
export async function loadPolicies(
  args: AutopilotReadArgs,
): Promise<readonly PolicyRowView[]> {
  const { db, actor, organizationId } = args
  if (!holdsGrant(actor, 'autopilot.view')) return []

  const { data, error } = await db
    .from('autopilot_policies')
    .select('id, action_kind, property_id, disposition')
    .eq('organization_id', organizationId)

  if (error) throw error

  return toRows(data)
    .filter((row) =>
      can(
        actor,
        'autopilot.view',
        autopilotResource(organizationId, asStringOrNull(row, 'property_id')),
      ),
    )
    .map((row) => ({
      id: asString(row, 'id'),
      actionKind: asString(row, 'action_kind'),
      propertyId: asStringOrNull(row, 'property_id'),
      disposition: asEnum(row, 'disposition', AUTOPILOT_DISPOSITIONS),
    }))
}

/* -------------------------------------------------- property narrowing -- */

export type PropertyLevelView = {
  propertyId: string
  propertyName: string | null
  level: AutopilotLevel
  note: string | null
}

export async function loadPropertyLevels(
  args: AutopilotReadArgs,
): Promise<readonly PropertyLevelView[]> {
  const { db, actor, organizationId } = args
  if (!holdsGrant(actor, 'autopilot.view')) return []

  const narrowing = autopilotNarrowing(actor)
  if (narrowing.kind === 'nothing') return []

  let query = db
    .from('autopilot_property_settings')
    .select('property_id, level, note')
    .eq('organization_id', organizationId)

  if (narrowing.kind === 'property_in') {
    query = query.in('property_id', [...narrowing.values])
  }

  const { data, error } = await query
  if (error) throw error

  const rows = toRows(data).filter((row) =>
    can(
      actor,
      'autopilot.view',
      autopilotResource(organizationId, asString(row, 'property_id')),
    ),
  )

  const names = await propertyNames(
    db,
    actor,
    organizationId,
    rows.map((row) => asString(row, 'property_id')),
  )

  return rows.map((row) => {
    const propertyId = asString(row, 'property_id')
    return {
      propertyId,
      propertyName: names.get(propertyId) ?? null,
      level: asEnum(row, 'level', AUTOPILOT_LEVELS),
      note: asStringOrNull(row, 'note'),
    }
  })
}

/* ---------------------------------------------------------- exceptions -- */

/** The three states that mean somebody still has this in front of them. */
export const OPEN_EXCEPTION_STATES: readonly AutopilotExceptionState[] = [
  'new',
  'acknowledged',
  'in_progress',
]

export type ExceptionQuery = {
  /** Which states to read. Defaults to the open three. */
  states?: readonly AutopilotExceptionState[]
}

const EXCEPTION_COLUMNS =
  'id, property_id, domain, risk, state, code, title, detail, ' +
  'resource_type, resource_id, evidence, caused_by, due_at, warn_at, ' +
  'critical_at, owner_user_id, first_seen_at, last_seen_at, seen_count'

export async function listExceptions(
  args: AutopilotReadArgs,
  options: ExceptionQuery = {},
): Promise<readonly ExceptionView[]> {
  const { db, actor, organizationId, propertyId } = args
  const limit = args.limit ?? AUTOPILOT_PAGE_SIZE

  if (!holdsGrant(actor, 'autopilot.view')) return []

  const narrowing = autopilotNarrowing(actor)
  if (narrowing.kind === 'nothing') return []

  const states = options.states ?? OPEN_EXCEPTION_STATES

  let query = db
    .from('autopilot_exceptions')
    .select(EXCEPTION_COLUMNS)
    .eq('organization_id', organizationId)
    .in('state', [...states])

  if (propertyId !== null) query = query.eq('property_id', propertyId)
  if (narrowing.kind === 'property_in') {
    query = query.in('property_id', [...narrowing.values])
  }

  const { data, error } = await query
    // `domain` is a Postgres enum declared in triage order — safety first,
    // optimization last — so ordering by the column IS the priority order,
    // stated once in `AUTOPILOT_DOMAINS` rather than restated as a comparator
    // here. `due_at` breaks the tie, soonest first, and a row with no deadline
    // sits after the ones that have one.
    .order('domain', { ascending: true })
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('last_seen_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = toRows(data).filter((row) =>
    can(
      actor,
      'autopilot.view',
      autopilotResource(organizationId, asStringOrNull(row, 'property_id')),
    ),
  )

  const [names, owners] = await Promise.all([
    propertyNames(
      db,
      actor,
      organizationId,
      rows
        .map((row) => asStringOrNull(row, 'property_id'))
        .filter((id): id is string => id !== null),
    ),
    userNames(
      db,
      actor,
      rows
        .map((row) => asStringOrNull(row, 'owner_user_id'))
        .filter((id): id is string => id !== null),
    ),
  ])

  return rows.map((row) => exceptionFrom(row, names, owners))
}

function exceptionFrom(
  row: Row,
  names: ReadonlyMap<string, string>,
  owners: ReadonlyMap<string, string>,
): ExceptionView {
  const property = asStringOrNull(row, 'property_id')
  const owner = asStringOrNull(row, 'owner_user_id')

  return {
    id: asString(row, 'id'),
    code: asString(row, 'code'),
    domain: asEnum(row, 'domain', AUTOPILOT_DOMAINS),
    risk: asEnum(row, 'risk', AUTOPILOT_RISK_STATES),
    state: asEnum(row, 'state', AUTOPILOT_EXCEPTION_STATES),
    title: asString(row, 'title'),
    detail: asString(row, 'detail'),
    resourceType: asString(row, 'resource_type'),
    resourceId: asStringOrNull(row, 'resource_id'),
    propertyId: property,
    propertyName: property === null ? null : (names.get(property) ?? null),
    evidence: evidenceFrom(row.evidence),
    causedBy: asStringOrNull(row, 'caused_by'),
    dueAt: asTimestampOrNull(row, 'due_at'),
    warnAt: asTimestampOrNull(row, 'warn_at'),
    criticalAt: asTimestampOrNull(row, 'critical_at'),
    ownerUserId: owner,
    ownerName: owner === null ? null : (owners.get(owner) ?? null),
    firstSeenAt: asTimestamp(row, 'first_seen_at'),
    lastSeenAt: asTimestamp(row, 'last_seen_at'),
    seenCount: asNumber(row, 'seen_count'),
  }
}

/* ------------------------------------------------------------- actions -- */

export type ActionQuery = {
  /** Which outcomes to read. Defaults to every outcome. */
  outcomes?: readonly ActionView['outcome'][]
  /** Only actions created at or after this instant. */
  since?: string
}

const ACTION_COLUMNS =
  'id, property_id, exception_id, action_kind, safety_level, disposition, ' +
  'run_mode, outcome, confidence, reason, trigger_event, evidence, command, ' +
  'suppressed_reason, error_code, error_detail, attempt, requested_by, ' +
  'approved_by, approved_at, scheduled_for, executed_at, undone_at, created_at'

/**
 * The activity log, and the grant is `autopilot.activity_view`.
 *
 * Not `autopilot.view`, and the difference is the point. Somebody who can see
 * today's exceptions is not thereby entitled to the full history of every
 * message ESTIA has sent on the business's behalf — 0046 says so in the policy
 * itself, and a screen that asked with the wrong grant would get an empty list
 * from Postgres with no error and render it as "ESTIA has done nothing".
 */
export async function listActions(
  args: AutopilotReadArgs,
  options: ActionQuery = {},
): Promise<readonly ActionView[]> {
  const { db, actor, organizationId, propertyId } = args
  const limit = args.limit ?? AUTOPILOT_PAGE_SIZE

  if (!holdsGrant(actor, 'autopilot.activity_view')) return []

  const narrowing = autopilotNarrowing(actor)
  if (narrowing.kind === 'nothing') return []

  let query = db
    .from('autopilot_actions')
    .select(ACTION_COLUMNS)
    .eq('organization_id', organizationId)

  if (options.outcomes !== undefined) {
    query = query.in('outcome', [...options.outcomes])
  }
  if (options.since !== undefined) {
    query = query.gte('created_at', options.since)
  }
  if (propertyId !== null) query = query.eq('property_id', propertyId)
  if (narrowing.kind === 'property_in') {
    query = query.in('property_id', [...narrowing.values])
  }

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = toRows(data).filter((row) =>
    can(
      actor,
      'autopilot.activity_view',
      autopilotResource(organizationId, asStringOrNull(row, 'property_id')),
    ),
  )

  const [names, people] = await Promise.all([
    propertyNames(
      db,
      actor,
      organizationId,
      rows
        .map((row) => asStringOrNull(row, 'property_id'))
        .filter((id): id is string => id !== null),
    ),
    userNames(
      db,
      actor,
      rows.flatMap((row) =>
        [
          asStringOrNull(row, 'approved_by'),
          asStringOrNull(row, 'requested_by'),
        ].filter((id): id is string => id !== null),
      ),
    ),
  ])

  return rows.map((row) => actionFrom(row, names, people))
}

/**
 * A suppression reason, when it is one the vocabulary knows.
 *
 * NOT `asEnumOrNull`, which THROWS on a value outside the tuple. That is right
 * for a column backed by a Postgres enum and wrong for this one:
 * `suppressed_reason` is TEXT on purpose, so a new diagnostic needs no
 * migration, and `AUTOPILOT_SUPPRESSION_REASONS` says in its own comment that
 * it is held as text for exactly that reason. A screen that crashed on a
 * reason written by a newer engine would fail hardest precisely when Autopilot
 * has learned to refuse something new.
 *
 * So an unrecognised value returns null here and travels on in
 * `suppressedText`, where the screen prints it as itself. The refusal is still
 * said out loud, which is the requirement 0046 actually states.
 *
 * Found by its own test, which passed a value the vocabulary does not carry.
 */
function suppressionReason(
  raw: string | null,
): AutopilotSuppressionReason | null {
  if (raw === null) return null
  return (AUTOPILOT_SUPPRESSION_REASONS as readonly string[]).includes(raw)
    ? (raw as AutopilotSuppressionReason)
    : null
}

function actionFrom(
  row: Row,
  names: ReadonlyMap<string, string>,
  people: ReadonlyMap<string, string>,
): ActionView {
  const property = asStringOrNull(row, 'property_id')
  const kind = asString(row, 'action_kind')
  // A kind the catalogue no longer carries is a stale row, not a crash —
  // `actionSpec` returns rather than throws for exactly this, and the card
  // prints the raw kind and says the action can no longer run.
  const spec = actionSpec(kind)
  const approvedBy = asStringOrNull(row, 'approved_by')
  const requestedBy = asStringOrNull(row, 'requested_by')
  const suppressed = asStringOrNull(row, 'suppressed_reason')

  return {
    id: asString(row, 'id'),
    kind,
    kindLabel: spec?.label ?? kind,
    inCatalogue: spec !== null,
    safetyLevel: asEnum(row, 'safety_level', ACTION_SAFETY_LEVELS),
    disposition: asEnum(row, 'disposition', AUTOPILOT_DISPOSITIONS),
    runMode: asEnum(row, 'run_mode', AUTOPILOT_RUN_MODES),
    outcome: asEnum(row, 'outcome', AUTOPILOT_ACTION_OUTCOMES),
    confidence: asEnum(row, 'confidence', AUTOPILOT_CONFIDENCE_LEVELS),
    reason: asString(row, 'reason'),
    triggerEvent: asStringOrNull(row, 'trigger_event'),
    evidence: evidenceFrom(row.evidence),
    command: asStringOrNull(row, 'command'),
    suppressedReason: suppressionReason(suppressed),
    suppressedText: suppressed,
    errorCode: asStringOrNull(row, 'error_code'),
    errorDetail: asStringOrNull(row, 'error_detail'),
    attempt: asNumber(row, 'attempt'),
    approvedAt: asTimestampOrNull(row, 'approved_at'),
    approvedByName:
      approvedBy === null ? null : (people.get(approvedBy) ?? null),
    requestedByName:
      requestedBy === null ? null : (people.get(requestedBy) ?? null),
    scheduledFor: asTimestampOrNull(row, 'scheduled_for'),
    executedAt: asTimestampOrNull(row, 'executed_at'),
    undoneAt: asTimestampOrNull(row, 'undone_at'),
    createdAt: asTimestamp(row, 'created_at'),
    propertyId: property,
    propertyName: property === null ? null : (names.get(property) ?? null),
    exceptionId: asStringOrNull(row, 'exception_id'),
  }
}

/* ------------------------------------------------------------- lookups -- */

/**
 * Property names for the rows on screen, or an empty map.
 *
 * Not issued at all without `property.view`. `properties_select` would refuse
 * it in production anyway, but a query that cannot succeed is a round trip
 * nobody should pay for — and the demo client has no policy engine to do the
 * refusing, which is the argument `action-center/_lib/queries.ts` makes about
 * guest names. A name that does not come back stays null and the screen prints
 * nothing rather than a uuid.
 */
export async function propertyNames(
  db: Db,
  actor: Actor,
  organizationId: string,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (!holdsGrant(actor, 'property.view')) return new Map()

  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()

  const { data, error } = await db
    .from('properties')
    .select('id, name')
    .eq('organization_id', organizationId)
    .in('id', unique)

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    const name = asStringOrNull(row, 'name')
    if (name !== null) names.set(asString(row, 'id'), name)
  }
  return names
}

/**
 * Who owns an exception, or who approved an action.
 *
 * Gated on `user.view` and, like the names above, not asked for without it. An
 * id in place of a name is not something a person can act on, so a missing
 * name renders as "משויך" and never as the uuid.
 */
export async function userNames(
  db: Db,
  actor: Actor,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (!holdsGrant(actor, 'user.view')) return new Map()

  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()

  const { data, error } = await db
    .from('user_profiles')
    .select('id, full_name')
    .in('id', unique)

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    const name = asStringOrNull(row, 'full_name')
    if (name !== null) names.set(asString(row, 'id'), name)
  }
  return names
}
