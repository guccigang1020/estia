/**
 * EXECUTION CONTEXT — SERVER ONLY. Autopilot, as ESTIA's own staff see it.
 *
 * ══ THE STATE IS THE WORKFLOW. THE ENTITLEMENT IS THE GATE. ═══════════════
 *
 * `capabilities.ts` argues that there is exactly one override mechanism —
 * `entitlement_grants`, `entitlement_revocations`, `limit_overrides` — and
 * that a second table answering "does this customer have X" is a second
 * answer. `autopilot_capability` is not that second answer and this file is
 * where that stays true.
 *
 * `autopilot_capability.state` records WHY: eligible, on trial until the
 * fourteenth, suspended after an incident with the note that says which one.
 * It gates nothing. What the product reads is the `autopilot` entitlement in
 * `organization_subscriptions`, exactly as it reads the other nineteen, through
 * `effectiveEntitlements()`.
 *
 * So the two must move together, and `setAutopilotCapability` is one operation
 * that performs both writes:
 *
 *     trial | enabled              → the entitlement is granted
 *     suspended | disabled         → the grant is removed AND a revocation is
 *                                    written, because a withdrawal after a
 *                                    safety incident must hold even if a plan
 *                                    someday carries `autopilot`
 *     not_available | eligible     → neither. Nothing was offered, so nothing
 *                                    was withdrawn, and writing a revocation
 *                                    would make `capabilityStates()` report
 *                                    `revoked` for a customer nobody withdrew
 *                                    anything from
 *
 * There is deliberately no second entry point. `applyCapabilityDecision` takes
 * both halves in one call, and the store implements it as one method, because
 * two methods is two call sites and the second one is the one somebody forgets
 * at half past six.
 *
 * ── A trial ends whether or not anything ran ──────────────────────────────
 *
 * `effectiveAutopilotCapability()` compares `trial_ends_at` to the clock. A
 * trial that ended yesterday does not read as enabled here, on any screen, at
 * any hour, with no job having run.
 *
 * That is a statement about the CONSOLE'S READING and not about the gate, and
 * the difference matters: nothing expires the entitlement itself. Making the
 * product consult `trial_ends_at` would be the second answer this whole file
 * exists to prevent. So an expired trial that still holds the grant is a
 * DIVERGENCE, it is computed as one (`capabilityDivergence`), and the fleet
 * screen lists it as work for a person rather than resolving it silently in a
 * direction nobody chose. See request 2 in the report that accompanies this
 * file for the scheduled sweep that would close the window.
 *
 * ── What is read, and what is deliberately not ────────────────────────────
 *
 * `autopilot_capability`, `autopilot_safety_rules`, and a NARROW column list
 * from `autopilot_actions`: kind, safety level, disposition, run mode,
 * outcome, suppression reason, error code, timestamps. Not `reason`, not
 * `evidence`, not `command_input`, not `result`, not `error_detail` — those
 * carry the guest's own words, their phone number and the body of the message
 * ESTIA sent them. A fleet console answers "how many failed", and answering it
 * must not hand ESTIA staff the text of a customer's guest correspondence.
 * Same argument as `platform_organization_usage()` in 0041, one table along.
 *
 * ── Every read is scoped by the platform floor and by nothing else ────────
 *
 * No query below names a membership. `autopilot_capability_select` admits
 * platform staff through `is_platform_staff()`, and `autopilot_safety_rules`
 * is readable by everyone who can see Autopilot at all. There is no
 * service-role client anywhere in this file: a console that bypasses row level
 * security for convenience is a console whose safety is a convention.
 *
 * `autopilot_actions` is the exception and it is an honest one. 0046 gives it
 * a per-tenant SELECT policy and no platform counterpart, so a staff member —
 * who is a member of nothing — reads zero rows from it. The activity figures
 * therefore report what the platform floor CAN SEE, `visibleRows` says how
 * much that was, and the screen states that a zero there does not distinguish
 * "nothing happened" from "not visible from here". It is never rendered as a
 * measured zero. Request 1 asks for the definer function that closes it.
 */

import { BusinessRuleError } from '@/lib/errors'
import type { Db, Row } from '@/lib/persistence'
import {
  asEnum,
  asJsonRecord,
  asNumberOrNull,
  asString,
  asStringArray,
  asStringOrNull,
  asTimestamp,
  asTimestampOrNull,
  toRows,
} from '@/lib/persistence'
import {
  ACTION_SAFETY_LEVELS,
  AUTOPILOT_ACTION_OUTCOMES,
  AUTOPILOT_CAPABILITY_STATES,
  AUTOPILOT_DISPOSITIONS,
  AUTOPILOT_RUN_MODES,
  type ActionSafetyLevel,
  type AutopilotActionOutcome,
  type AutopilotCapabilityState,
  type AutopilotDisposition,
  type AutopilotRunMode,
} from '@/lib/contracts/states'
import { ENTITLEMENTS, type Entitlement } from '@/lib/plans/entitlements'
import { defineOperation, s, type Operation } from '@/lib/service'

import { capabilityStates } from './capabilities'
import {
  ORGANIZATION_STATUSES,
  type ConsoleSubscription,
  type OrganizationSummary,
} from './organizations'
import type { OrganizationSnapshot } from './operations'

/** The one entitlement this whole file is about. */
export const AUTOPILOT_ENTITLEMENT: Entitlement = 'autopilot'

/* ----------------------------------------------------------------- types -- */

/** One row of `autopilot_capability`, as read. */
export interface AutopilotCapabilityRecord {
  organizationId: string
  state: AutopilotCapabilityState
  trialEndsAt: string | null
  /** A ceiling on automatic actions per day. `null` is no ceiling, not zero. */
  actionLimit: number | null
  note: string | null
  decidedBy: string | null
  decidedAt: string
}

/**
 * How the console reads a customer's Autopilot standing right now.
 *
 * `recorded` is what the row says. `entitled` is what the product reads. They
 * are separate fields because the entire point of this module is that they can
 * differ and that somebody must be told when they do.
 */
export interface EffectiveAutopilotCapability {
  /** What `autopilot_capability.state` says. `not_available` when no row. */
  recorded: AutopilotCapabilityState
  /** A `trial` whose end date has passed. Computed, never stored. */
  trialExpired: boolean
  /**
   * Whether the workflow record says this customer should be running.
   * An expired trial is `false` — that is the rule the brief asks for.
   */
  shouldBeEntitled: boolean
  /** Whether the `autopilot` entitlement is actually in force for them. */
  entitled: boolean
  divergence: CapabilityDivergence
  trialEndsAt: string | null
  actionLimit: number | null
  note: string | null
}

/**
 * Whether the workflow record and the gate agree.
 *
 * Named rather than boolean because the two disagreements are different
 * problems. `entitlement_missing` is a customer who was promised Autopilot and
 * does not have it — a support call. `entitlement_lingering` is a customer who
 * is running it after the platform decided they should not — which, after a
 * suspension, is the one that matters.
 */
export type CapabilityDivergence =
  'aligned' | 'entitlement_missing' | 'entitlement_lingering'

/* ------------------------------------------------- the rules, as functions -- */

/**
 * The two states that mean "this customer runs Autopilot".
 *
 * Written once, here, and consulted by the operation, by the console's reading
 * and by the tests. A second copy of this list is how the grant and the record
 * come apart.
 */
const ENTITLED_STATES: ReadonlySet<AutopilotCapabilityState> = new Set([
  'trial',
  'enabled',
])

/** The states the schema refuses without a note. Mirrors the CHECK in 0046. */
const NOTE_REQUIRED_STATES: ReadonlySet<AutopilotCapabilityState> = new Set([
  'suspended',
  'disabled',
])

/**
 * The states that are a WITHDRAWAL rather than an absence.
 *
 * These write a revocation as well as removing the grant. A revocation beats
 * both a grant and a plan, so it is the only withdrawal that stays a
 * withdrawal if `autopilot` is ever added to a package — and a suspension made
 * after a safety incident is exactly the one that must not quietly come back.
 */
const WITHDRAWN_STATES: ReadonlySet<AutopilotCapabilityState> = new Set([
  'suspended',
  'disabled',
])

/** Does the database refuse this state without a note? */
export function noteIsRequiredFor(state: AutopilotCapabilityState): boolean {
  return NOTE_REQUIRED_STATES.has(state)
}

/** Does the database refuse this state without an end date? */
export function trialEndIsRequiredFor(
  state: AutopilotCapabilityState,
): boolean {
  return state === 'trial'
}

/**
 * Should this record hold the `autopilot` entitlement, at this instant?
 *
 * The clock is an argument. A trial is time-boxed and the box closes whether
 * or not anything ran, so `enabled` is `true` forever and `trial` is `true`
 * only until its end date.
 */
export function shouldHoldEntitlement(
  state: AutopilotCapabilityState,
  trialEndsAt: string | null,
  now: Date,
): boolean {
  if (!ENTITLED_STATES.has(state)) return false
  if (state !== 'trial') return true
  return !trialHasEnded(trialEndsAt, now)
}

/**
 * Has a trial's end date passed?
 *
 * A trial with no end date reads as ENDED rather than as endless. The CHECK in
 * 0046 makes that unreachable through the console; if a row ever arrives
 * without one — a restore from an older schema, a hand-written UPDATE — the
 * safe reading of "a time-boxed offer with no box" is that it is over.
 */
export function trialHasEnded(trialEndsAt: string | null, now: Date): boolean {
  if (trialEndsAt === null) return true
  const end = new Date(trialEndsAt)
  if (Number.isNaN(end.getTime())) return true
  return end.getTime() <= now.getTime()
}

/** Days until a trial ends. Negative once it has. `null` with no date. */
export function daysOfTrialLeft(
  trialEndsAt: string | null,
  now: Date,
): number | null {
  if (trialEndsAt === null) return null
  const end = new Date(trialEndsAt)
  if (Number.isNaN(end.getTime())) return null
  return Math.ceil((end.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
}

/** A trial ending within this many days is "expiring soon" on the fleet screen. */
export const TRIAL_EXPIRY_WARNING_DAYS = 7

/**
 * The console's reading of one customer.
 *
 * Pure, and given both halves plus the clock. Nothing here queries anything,
 * so the rule that an expired trial is not enabled is testable without a
 * database and cannot be undone by a screen that forgot to pass `now`.
 */
export function effectiveAutopilotCapability(
  record: AutopilotCapabilityRecord | null,
  entitled: boolean,
  now: Date,
): EffectiveAutopilotCapability {
  // No row is `not_available`, which 0046 calls the honest default rather than
  // an unfinished state: most customers will never be offered this.
  const recorded = record?.state ?? 'not_available'
  const trialEndsAt = record?.trialEndsAt ?? null
  const shouldBeEntitled = shouldHoldEntitlement(recorded, trialEndsAt, now)

  return {
    recorded,
    trialExpired: recorded === 'trial' && trialHasEnded(trialEndsAt, now),
    shouldBeEntitled,
    entitled,
    divergence: capabilityDivergence(shouldBeEntitled, entitled),
    trialEndsAt,
    actionLimit: record?.actionLimit ?? null,
    note: record?.note ?? null,
  }
}

export function capabilityDivergence(
  shouldBeEntitled: boolean,
  entitled: boolean,
): CapabilityDivergence {
  if (shouldBeEntitled === entitled) return 'aligned'
  return entitled ? 'entitlement_lingering' : 'entitlement_missing'
}

/**
 * Is the `autopilot` entitlement in force for this customer?
 *
 * Delegates to `capabilityStates()` rather than reimplementing the precedence.
 * Grant, revocation, plan and a cancelled subscription resolve in one place —
 * the same place the capability screen uses — so the fleet console and the
 * capability screen can never report different answers about the same row.
 */
export function autopilotEntitlementActive(
  subscription: ConsoleSubscription | null,
): boolean {
  if (!subscription) return false
  return capabilityStates(subscription).some(
    (state) => state.entitlement === AUTOPILOT_ENTITLEMENT && state.active,
  )
}

/* ----------------------------------------------------------- the reads ---- */

const CAPABILITY_COLUMNS =
  'organization_id, state, trial_ends_at, action_limit, note, ' +
  'decided_by, decided_at'

/** One organization's capability row. `null` means `not_available`. */
export async function loadAutopilotCapability(
  db: Db,
  organizationId: string,
): Promise<AutopilotCapabilityRecord | null> {
  const { data, error } = await db
    .from('autopilot_capability')
    .select(CAPABILITY_COLUMNS)
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!data) return null

  // `as unknown as Row` for the same reason `loadPlatformOrganization` does it:
  // PostgREST types a single-row result as a union including its own error
  // shape, and every column below is mapped explicitly.
  return capabilityRecord(data as unknown as Row)
}

/**
 * Capability rows for a set of organizations.
 *
 * A map rather than a list, and an organization missing from it is
 * `not_available` rather than an error. That distinction is what lets the
 * fleet screen show every customer, including the great majority who have
 * never been offered this.
 */
export async function listAutopilotCapabilities(
  db: Db,
  organizationIds: readonly string[],
): Promise<Map<string, AutopilotCapabilityRecord>> {
  const result = new Map<string, AutopilotCapabilityRecord>()
  if (organizationIds.length === 0) return result

  const { data, error } = await db
    .from('autopilot_capability')
    .select(CAPABILITY_COLUMNS)
    .in('organization_id', [...organizationIds])

  if (error) throw new Error(error.message)

  for (const row of toRows(data)) {
    const record = capabilityRecord(row)
    result.set(record.organizationId, record)
  }

  return result
}

function capabilityRecord(row: Row): AutopilotCapabilityRecord {
  return {
    organizationId: asString(row, 'organization_id'),
    state: asEnum(row, 'state', AUTOPILOT_CAPABILITY_STATES),
    trialEndsAt: asTimestampOrNull(row, 'trial_ends_at'),
    actionLimit: asNumberOrNull(row, 'action_limit'),
    note: asStringOrNull(row, 'note'),
    decidedBy: asStringOrNull(row, 'decided_by'),
    decidedAt: asTimestamp(row, 'decided_at'),
  }
}

/* ------------------------------------------------------------ safety floor -- */

/** One row of `autopilot_safety_rules` — the ceiling no customer may raise. */
export interface AutopilotSafetyRule {
  id: string
  /** `null` means every action at or above `maxSafetyLevel`. */
  actionKind: string | null
  maxSafetyLevel: ActionSafetyLevel
  maxDisposition: AutopilotDisposition
  reason: string
  updatedAt: string | null
}

/**
 * The platform safety floor.
 *
 * Read-only from the console, and that is a property of the database rather
 * than of this function: 0046 revokes INSERT, DELETE and TRUNCATE on the table
 * from every application role including `service_role`, and grants UPDATE to
 * platform staff alone. So no screen above this may offer to add or remove a
 * rule, because nothing could carry out the offer.
 */
export async function listAutopilotSafetyRules(
  db: Db,
): Promise<readonly AutopilotSafetyRule[]> {
  const { data, error } = await db
    .from('autopilot_safety_rules')
    .select(
      'id, action_kind, max_safety_level, max_disposition, reason, updated_at',
    )
    .order('max_safety_level', { ascending: false })

  if (error) throw new Error(error.message)

  return toRows(data).map((row) => ({
    id: asString(row, 'id'),
    actionKind: asStringOrNull(row, 'action_kind'),
    maxSafetyLevel: asEnum(row, 'max_safety_level', ACTION_SAFETY_LEVELS),
    maxDisposition: asEnum(row, 'max_disposition', AUTOPILOT_DISPOSITIONS),
    reason: asString(row, 'reason'),
    updatedAt: asTimestampOrNull(row, 'updated_at'),
  }))
}

/* ---------------------------------------------------------------- activity -- */

/**
 * One action, with the guest's half left in the database.
 *
 * Every field here is about ESTIA's machinery: what kind of thing it was, how
 * dangerous, whether a person had agreed, what became of it. `reason`,
 * `evidence`, `command_input`, `result` and `error_detail` are absent by
 * design — see the header.
 */
export interface AutopilotActionSummary {
  id: string
  organizationId: string
  actionKind: string
  safetyLevel: ActionSafetyLevel
  disposition: AutopilotDisposition
  runMode: AutopilotRunMode
  outcome: AutopilotActionOutcome
  suppressedReason: string | null
  errorCode: string | null
  attempt: number
  createdAt: string
  executedAt: string | null
}

const ACTION_COLUMNS =
  'id, organization_id, action_kind, safety_level, disposition, run_mode, ' +
  'outcome, suppressed_reason, error_code, attempt, created_at, executed_at'

/** The outcomes that mean a person has to look. 0046 indexes exactly these. */
export const SAFETY_INCIDENT_OUTCOMES: readonly AutopilotActionOutcome[] = [
  'failed',
  'needs_review',
  'executed_unaudited',
]

/**
 * How many action rows one read will fetch.
 *
 * A cap rather than a full scan, because the fleet grows and a console must
 * not become the slowest query in the database. Whether the cap was reached is
 * reported as `truncated`, so a figure that is a lower bound is labelled as
 * one instead of being presented as a count.
 */
export const ACTIVITY_ROW_CAP = 2000

/** What the platform floor could actually see of the activity record. */
export interface FleetActivity {
  /**
   * Rows this read returned. Zero is NOT proof that nothing happened: 0046
   * gives `autopilot_actions` a per-tenant SELECT policy and no platform
   * counterpart, so a staff member reads none of it. The screen says so.
   */
  visibleRows: number
  /** The cap was reached, so every count below is a lower bound. */
  truncated: boolean
  byOrganization: ReadonlyMap<string, OrganizationActivity>
}

/** The counts for one customer, over the rows that were read. */
export interface OrganizationActivity {
  organizationId: string
  total: number
  byOutcome: Readonly<Record<AutopilotActionOutcome, number>>
  /** `outcome = 'executed'`, live runs only. */
  executed: number
  /** `failed`, `needs_review` and `executed_unaudited` together. */
  failures: number
  suppressed: number
  simulated: number
  /**
   * Of the actions Autopilot took WITHOUT asking — `disposition = 'auto'`,
   * `run_mode = 'live'` — the share that ended in `executed`.
   *
   * `null` when it never took one. A rate of 100% computed from an empty
   * denominator is the most confident wrong number a console can print.
   */
  automaticSuccessRate: number | null
  automaticAttempts: number
}

/**
 * The activity record, as much of it as the platform floor admits.
 *
 * Ordered newest first and capped. Narrow columns — see the header — and no
 * organization filter, because this is the fleet view and the policy is what
 * decides which rows come back, not a `where` clause written here.
 */
export async function loadFleetActivity(
  db: Db,
  options: { since?: Date; cap?: number } = {},
): Promise<FleetActivity | null> {
  const cap = options.cap ?? ACTIVITY_ROW_CAP

  let query = db
    .from('autopilot_actions')
    .select(ACTION_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(cap)

  if (options.since)
    query = query.gte('created_at', options.since.toISOString())

  const { data, error } = await query

  // `null` is "unknown", never zero. The caller renders a failed read as a
  // failed read; an empty fleet is rendered from the organization list, which
  // is a different question with a different answer.
  if (error) return null

  const actions = toRows(data).map(actionSummary)
  return summariseActivity(actions, cap)
}

/**
 * Fold a set of action rows into per-organization counts.
 *
 * Exported and pure so the arithmetic — particularly the success rate, whose
 * denominator is the interesting part — is tested without a database.
 */
export function summariseActivity(
  actions: readonly AutopilotActionSummary[],
  cap: number = ACTIVITY_ROW_CAP,
): FleetActivity {
  const byOrganization = new Map<string, MutableActivity>()

  for (const action of actions) {
    const entry =
      byOrganization.get(action.organizationId) ??
      blankActivity(action.organizationId)
    byOrganization.set(action.organizationId, entry)

    entry.total += 1
    entry.byOutcome[action.outcome] += 1

    if (action.outcome === 'executed') entry.executed += 1
    if (SAFETY_INCIDENT_OUTCOMES.includes(action.outcome)) entry.failures += 1
    if (action.outcome === 'suppressed') entry.suppressed += 1
    if (action.outcome === 'simulated') entry.simulated += 1

    // "Automatic" is the disposition, not the outcome. An action a person
    // approved is not evidence about whether Autopilot is safe unattended, and
    // a simulated one did not happen at all.
    if (action.disposition === 'auto' && action.runMode === 'live') {
      if (action.outcome === 'executed') entry.automaticSucceeded += 1
      if (SAFETY_INCIDENT_OUTCOMES.includes(action.outcome)) {
        entry.automaticFailed += 1
      }
    }
  }

  const finished = new Map<string, OrganizationActivity>()
  for (const [organizationId, entry] of byOrganization) {
    const attempts = entry.automaticSucceeded + entry.automaticFailed
    finished.set(organizationId, {
      organizationId: entry.organizationId,
      total: entry.total,
      byOutcome: entry.byOutcome,
      executed: entry.executed,
      failures: entry.failures,
      suppressed: entry.suppressed,
      simulated: entry.simulated,
      automaticAttempts: attempts,
      automaticSuccessRate:
        attempts === 0 ? null : entry.automaticSucceeded / attempts,
    })
  }

  return {
    visibleRows: actions.length,
    truncated: actions.length >= cap,
    byOrganization: finished,
  }
}

interface MutableActivity {
  organizationId: string
  total: number
  byOutcome: Record<AutopilotActionOutcome, number>
  executed: number
  failures: number
  suppressed: number
  simulated: number
  automaticSucceeded: number
  automaticFailed: number
}

function blankActivity(organizationId: string): MutableActivity {
  const byOutcome = {} as Record<AutopilotActionOutcome, number>
  for (const outcome of AUTOPILOT_ACTION_OUTCOMES) byOutcome[outcome] = 0

  return {
    organizationId,
    total: 0,
    byOutcome,
    executed: 0,
    failures: 0,
    suppressed: 0,
    simulated: 0,
    automaticSucceeded: 0,
    automaticFailed: 0,
  }
}

/**
 * Actions needing a person, newest first, across the fleet or for one customer.
 *
 * Its own query rather than a filter over `loadFleetActivity`, so that a fleet
 * busy enough to hit the row cap cannot hide the incidents underneath it —
 * which is precisely when they matter. 0046's `autopilot_actions_review_idx`
 * indexes these three outcomes.
 */
export async function listAutopilotSafetyIncidents(
  db: Db,
  options: { organizationId?: string; limit?: number } = {},
): Promise<readonly AutopilotActionSummary[] | null> {
  let query = db
    .from('autopilot_actions')
    .select(ACTION_COLUMNS)
    .in('outcome', [...SAFETY_INCIDENT_OUTCOMES])
    .order('created_at', { ascending: false })
    .limit(options.limit ?? 100)

  if (options.organizationId) {
    query = query.eq('organization_id', options.organizationId)
  }

  const { data, error } = await query
  if (error) return null

  return toRows(data).map(actionSummary)
}

/** One customer's recent actions, newest first. `null` when the read failed. */
export async function listAutopilotActions(
  db: Db,
  organizationId: string,
  limit = 50,
): Promise<readonly AutopilotActionSummary[] | null> {
  const { data, error } = await db
    .from('autopilot_actions')
    .select(ACTION_COLUMNS)
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) return null

  return toRows(data).map(actionSummary)
}

function actionSummary(row: Row): AutopilotActionSummary {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    actionKind: asString(row, 'action_kind'),
    safetyLevel: asEnum(row, 'safety_level', ACTION_SAFETY_LEVELS),
    disposition: asEnum(row, 'disposition', AUTOPILOT_DISPOSITIONS),
    runMode: asEnum(row, 'run_mode', AUTOPILOT_RUN_MODES),
    outcome: asEnum(row, 'outcome', AUTOPILOT_ACTION_OUTCOMES),
    suppressedReason: asStringOrNull(row, 'suppressed_reason'),
    errorCode: asStringOrNull(row, 'error_code'),
    attempt: asNumberOrNull(row, 'attempt') ?? 1,
    createdAt: asTimestamp(row, 'created_at'),
    executedAt: asTimestampOrNull(row, 'executed_at'),
  }
}

/* ------------------------------------------------------------ the fleet ---- */

/** One customer's line on the fleet screen. */
export interface FleetOrganization {
  organization: OrganizationSummary
  capability: AutopilotCapabilityRecord | null
  effective: EffectiveAutopilotCapability
  activity: OrganizationActivity | null
}

/**
 * Every customer, with their Autopilot standing.
 *
 * Pure: the caller does the three reads and this joins them. `activity` is
 * `null` for a customer no action row was seen for — which, given the policy
 * gap described in the header, is currently every customer, and which the
 * screen must not print as a zero.
 */
export function fleetOrganizations(input: {
  organizations: readonly OrganizationSummary[]
  capabilities: ReadonlyMap<string, AutopilotCapabilityRecord>
  activity: FleetActivity | null
  now: Date
}): readonly FleetOrganization[] {
  return input.organizations.map((organization) => {
    const capability = input.capabilities.get(organization.id) ?? null
    return {
      organization,
      capability,
      effective: effectiveAutopilotCapability(
        capability,
        autopilotEntitlementActive(organization.subscription),
        input.now,
      ),
      activity: input.activity?.byOrganization.get(organization.id) ?? null,
    }
  })
}

/** The fleet, counted. */
export interface FleetMetrics {
  organizations: number
  enabled: number
  onTrial: number
  /** Trials ending within `TRIAL_EXPIRY_WARNING_DAYS`, still running. */
  trialsExpiringSoon: readonly FleetOrganization[]
  /** Trials whose end date has passed. Whether or not anything ran. */
  trialsExpired: readonly FleetOrganization[]
  suspended: readonly FleetOrganization[]
  /** Record and gate disagree. Each one is work for a person. */
  diverged: readonly FleetOrganization[]
  /** Holding the entitlement, by any route. */
  entitled: number
  /**
   * Of the entitled, how many have any visible action at all.
   *
   * `null` when the activity record could not be read, because an adoption
   * figure computed from rows nobody could see is a figure that says every
   * customer ignored the feature.
   */
  adopted: number | null
  actionsSeen: number | null
  failuresSeen: number | null
  suppressionsSeen: number | null
  /** Across the fleet. `null` when Autopilot never acted unattended. */
  automaticSuccessRate: number | null
}

export function fleetMetrics(
  rows: readonly FleetOrganization[],
  activity: FleetActivity | null,
  now: Date,
): FleetMetrics {
  const entitledRows = rows.filter((row) => row.effective.entitled)

  let succeeded = 0
  let attempted = 0
  let actions = 0
  let failures = 0
  let suppressions = 0

  if (activity) {
    for (const entry of activity.byOrganization.values()) {
      actions += entry.total
      failures += entry.failures
      suppressions += entry.suppressed
      if (entry.automaticSuccessRate !== null) {
        succeeded += Math.round(
          entry.automaticSuccessRate * entry.automaticAttempts,
        )
        attempted += entry.automaticAttempts
      }
    }
  }

  return {
    organizations: rows.length,
    enabled: rows.filter((row) => row.effective.recorded === 'enabled').length,
    onTrial: rows.filter(
      (row) =>
        row.effective.recorded === 'trial' && !row.effective.trialExpired,
    ).length,
    trialsExpiringSoon: rows.filter((row) => {
      if (row.effective.recorded !== 'trial' || row.effective.trialExpired) {
        return false
      }
      const days = daysOfTrialLeft(row.effective.trialEndsAt, now)
      return days !== null && days <= TRIAL_EXPIRY_WARNING_DAYS
    }),
    trialsExpired: rows.filter((row) => row.effective.trialExpired),
    suspended: rows.filter((row) => row.effective.recorded === 'suspended'),
    diverged: rows.filter((row) => row.effective.divergence !== 'aligned'),
    entitled: entitledRows.length,
    adopted: activity
      ? entitledRows.filter((row) => (row.activity?.total ?? 0) > 0).length
      : null,
    actionsSeen: activity ? actions : null,
    failuresSeen: activity ? failures : null,
    suppressionsSeen: activity ? suppressions : null,
    automaticSuccessRate: attempted === 0 ? null : succeeded / attempted,
  }
}

/* ------------------------------------------------------------------ port --- */

/** The three override columns, as the console reads and rewrites them. */
export interface EntitlementOverrides {
  entitlementGrants: readonly Entitlement[]
  entitlementRevocations: readonly Entitlement[]
  limitOverrides: Record<string, number | null>
}

/** What `setAutopilotCapability` loads before it decides anything. */
export interface AutopilotCapabilityTarget {
  organization: OrganizationSnapshot
  capability: AutopilotCapabilityRecord | null
  /** `null` when there is no live subscription — see the rule. */
  entitlements: EntitlementOverrides | null
}

/**
 * Both halves of one decision, already computed.
 *
 * This is the shape the store is handed, and it is one object rather than two
 * arguments for the reason the header gives: the record and the gate move
 * together or the customer is living in a state nobody can name.
 */
export interface AutopilotCapabilityDecision {
  organizationId: string
  state: AutopilotCapabilityState
  trialEndsAt: string | null
  actionLimit: number | null
  note: string | null
  /** True when the state means the customer runs Autopilot, at write time. */
  entitled: boolean
  overrides: EntitlementOverrides
}

export interface AutopilotCapabilityStore {
  readOrganization(organizationId: string): Promise<OrganizationSnapshot | null>
  readCapability(
    organizationId: string,
  ): Promise<AutopilotCapabilityRecord | null>
  readEntitlements(organizationId: string): Promise<EntitlementOverrides | null>
  /**
   * ONE method, and it performs BOTH writes.
   *
   * Not `setCapabilityRow` plus `setEntitlements`. Two methods is two call
   * sites, and a caller that performs the first and returns early leaves a
   * customer whose record and whose gate disagree — with no error anywhere,
   * because each write succeeded.
   */
  applyCapabilityDecision(decision: AutopilotCapabilityDecision): Promise<void>
}

/* ------------------------------------------------------------- operation --- */

const capabilityInput = s.object({
  organizationId: s.uuid({ label: 'ארגון' }),
  state: s.enumOf(AUTOPILOT_CAPABILITY_STATES, { label: 'מצב' }),
  // Optional AND nullable, and they are different statements: absent means the
  // state does not need one, `null` means clear the one that is there.
  trialEndsAt: s.optional(s.nullable(s.isoDateTime({ label: 'סיום התנסות' }))),
  actionLimit: s.optional(
    s.nullable(s.number({ label: 'תקרת פעולות ליום', min: 1, integer: true })),
  ),
  note: s.optional(s.nullable(s.string({ label: 'הערה', max: 2000 }))),
})

export interface SetAutopilotCapabilityInput {
  organizationId: string
  state: AutopilotCapabilityState
  trialEndsAt?: Date | null
  actionLimit?: number | null
  note?: string | null
}

export interface AutopilotOperations {
  setAutopilotCapability: Operation<
    SetAutopilotCapabilityInput,
    AutopilotCapabilityTarget,
    AutopilotCapabilityDecision
  >
}

export function defineAutopilotOperations(
  store: AutopilotCapabilityStore,
): AutopilotOperations {
  const setAutopilotCapability = defineOperation<
    SetAutopilotCapabilityInput,
    AutopilotCapabilityTarget,
    AutopilotCapabilityDecision
  >({
    name: 'platform.autopilot.capability',
    // The capability row's write policy names this grant, so the operation and
    // the database agree about who may reach it. The entitlement half then
    // demands `platform.feature_flag.manage` inside
    // `platform_set_organization_capabilities`, independently — see request 3.
    permission: 'platform.organization.manage',
    resourceType: 'organization',
    input: capabilityInput,
    // Withdrawing Autopilot from a paying customer, or handing it to one, is
    // exactly as consequential as suspending their account. Stated explicitly
    // rather than left to SENSITIVE_ACTIONS, as the other console writes are.
    requiresReason: true,

    loadResource: async ({ input }) => {
      const organization = await store.readOrganization(input.organizationId)
      if (!organization) return null

      const [capability, entitlements] = await Promise.all([
        store.readCapability(organization.id),
        store.readEntitlements(organization.id),
      ])

      return {
        resource: { organizationId: organization.id },
        entity: { organization, capability, entitlements },
      }
    },

    rule: ({ input, entity, now }) => {
      // Both writes or neither. Without a live subscription there is nowhere to
      // put the entitlement, so writing the capability row alone would produce
      // precisely the divergence this module exists to prevent — a platform
      // record saying `enabled` and a product that has never heard of it.
      if (!entity.entitlements) {
        throw new BusinessRuleError({
          code: 'no_live_subscription',
          message: `Organization ${entity.organization.id} has no live subscription`,
          userMessage:
            'לארגון הזה אין שורת מנוי פעילה, ולכן אין לאן לכתוב את ההרשאה. ' +
            'מצב היכולת וההרשאה נכתבים יחד או בכלל לא — רישום פלטפורמה בלי ' +
            'הרשאה בפועל הוא בדיוק הפער שהמנגנון הזה נועד למנוע.',
        })
      }

      if (noteIsRequiredFor(input.state) && isBlank(input.note)) {
        throw new BusinessRuleError({
          code: 'note_required',
          message: `State ${input.state} requires a note`,
          userMessage:
            'השהיה או ביטול של היכולת מחייבים הערה. מישהו שולל יכולת מלקוח ' +
            'משלם, והסיבה צריכה לשרוד את מי שהחליט עליה.',
        })
      }

      if (trialEndIsRequiredFor(input.state)) {
        if (!input.trialEndsAt) {
          throw new BusinessRuleError({
            code: 'trial_end_required',
            message: 'A trial requires an end date',
            userMessage:
              'התנסות מחייבת תאריך סיום. התנסות בלי סוף היא שכבה חינמית ' +
              'שאיש לא החליט למכור.',
          })
        }

        // A trial that ends in the past is not a decision anybody meant, and
        // it would read as expired the instant it was saved.
        if (input.trialEndsAt.getTime() <= now.getTime()) {
          throw new BusinessRuleError({
            code: 'trial_end_in_past',
            message: 'A trial cannot end in the past',
            userMessage:
              'תאריך סיום ההתנסות כבר עבר. התנסות כזו הייתה נקראת כפגה ' +
              'ברגע השמירה, וההרשאה שניתנה לצידה הייתה נשארת בתוקף.',
          })
        }
      }
    },

    execute: async ({ input, entity, now }) => {
      // `entity.entitlements` is non-null here: the rule above refuses the
      // operation when it is not, and the rule runs before execute.
      const current = entity.entitlements as EntitlementOverrides
      const entitled = shouldHoldEntitlement(
        input.state,
        input.trialEndsAt ? input.trialEndsAt.toISOString() : null,
        now,
      )

      const decision: AutopilotCapabilityDecision = {
        organizationId: entity.organization.id,
        state: input.state,
        // The end date belongs to a trial and to nothing else. Left on an
        // `enabled` row it would be a date the next reader has to guess the
        // meaning of, and `daysOfTrialLeft` would happily count down to it.
        trialEndsAt:
          input.state === 'trial' && input.trialEndsAt
            ? input.trialEndsAt.toISOString()
            : null,
        actionLimit: input.actionLimit ?? null,
        note: isBlank(input.note) ? null : (input.note as string).trim(),
        entitled,
        overrides: nextOverrides(current, input.state, entitled),
      }

      await store.applyCapabilityDecision(decision)
      return decision
    },

    audit: ({ entity, result }) => ({
      resourceId: entity.organization.id,
      summary:
        `צוות ESTIA קבע את מצב הטייס האוטומטי של "${entity.organization.name}" ` +
        `ל-${result.state}, ו${
          result.entitled ? 'העניק' : 'הסיר'
        } בהתאם את ההרשאה autopilot במנוי. ` +
        'שני החלקים נכתבו יחד: הרישום מסביר למה, וההרשאה היא מה שהמוצר קורא.' +
        (result.note ? ` נימוק שנרשם: ${result.note}` : ''),
      before: {
        state: entity.capability?.state ?? 'not_available',
        trialEndsAt: entity.capability?.trialEndsAt ?? null,
        entitlementGrants: [...(entity.entitlements?.entitlementGrants ?? [])],
        entitlementRevocations: [
          ...(entity.entitlements?.entitlementRevocations ?? []),
        ],
      },
      after: {
        state: result.state,
        trialEndsAt: result.trialEndsAt,
        actionLimit: result.actionLimit,
        entitled: result.entitled,
        entitlementGrants: [...result.overrides.entitlementGrants],
        entitlementRevocations: [...result.overrides.entitlementRevocations],
      },
    }),
  })

  return { setAutopilotCapability }
}

/**
 * The three override columns, rewritten for one decision.
 *
 * Every other entitlement is copied through untouched. This operation has an
 * opinion about exactly one member of the list, and a console write that
 * rewrote the whole set would silently drop a grant somebody made on the
 * capability screen ten minutes earlier.
 */
export function nextOverrides(
  current: EntitlementOverrides,
  state: AutopilotCapabilityState,
  entitled: boolean,
): EntitlementOverrides {
  const grants = current.entitlementGrants.filter(
    (entitlement) => entitlement !== AUTOPILOT_ENTITLEMENT,
  )
  const revocations = current.entitlementRevocations.filter(
    (entitlement) => entitlement !== AUTOPILOT_ENTITLEMENT,
  )

  if (entitled) {
    // The grant, and the removal of any revocation — a revocation beats a
    // grant, so leaving one in place would make this write do nothing at all.
    grants.push(AUTOPILOT_ENTITLEMENT)
  } else if (WITHDRAWN_STATES.has(state)) {
    revocations.push(AUTOPILOT_ENTITLEMENT)
  }

  return {
    entitlementGrants: grants,
    entitlementRevocations: revocations,
    limitOverrides: { ...current.limitOverrides },
  }
}

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim().length === 0
}

/* ------------------------------------------------------- the Supabase store */

/**
 * The port, against Postgres. Mapping only — every rule is above this line.
 *
 * ══ ONE ROUND TRIP, BECAUSE THE TWO WRITES MUST NOT BE SEPARABLE ══════════
 *
 * `applyCapabilityDecision` calls ONE definer function,
 * `platform_set_autopilot_capability`, which writes the capability row and the
 * subscription's override columns inside a single database transaction.
 *
 * The alternative — an upsert here, then a call to
 * `platform_set_organization_capabilities` — is two statements over PostgREST,
 * which is two transactions unless `DATABASE_URL` happens to point at the
 * pooler. The failure mode of that is the exact one this module exists to
 * prevent: the record says `suspended`, the entitlement is still granted, both
 * writes reported success, and nobody knows which one the customer is living
 * in. The lockstep is not something a client should be trusted to maintain.
 *
 * It is also the only path that CAN work. 0046 revokes INSERT and UPDATE on
 * `autopilot_capability` from `authenticated`, so a direct write is refused by
 * table privilege before any policy is consulted — the
 * `autopilot_capability_platform_write` policy is unreachable from the
 * application role as the migration stands. A SECURITY DEFINER function owned
 * by the table owner is what the grants leave room for, and it is the same
 * shape as `platform_set_organization_status` in 0041, for the same stated
 * reason: the column list belongs inside the database, where no adapter can
 * widen it.
 *
 * ── The function does not exist yet, and this says so out loud ────────────
 *
 * See request 1 in the report accompanying this file. Until the migration
 * lands, `applyCapabilityDecision` fails, and it fails with a sentence naming
 * the missing function rather than with a PostgREST digest — because the one
 * thing worse than a control that cannot be used is a control that cannot be
 * used and does not say why.
 */
export class SupabaseAutopilotStore implements AutopilotCapabilityStore {
  constructor(private readonly db: Db) {}

  async readOrganization(
    organizationId: string,
  ): Promise<OrganizationSnapshot | null> {
    const { data, error } = await this.db
      .from('organizations')
      .select('id, name, status')
      .eq('id', organizationId)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!data) return null

    const row = data as unknown as Row
    return {
      id: asString(row, 'id'),
      name: asString(row, 'name'),
      status: asEnum(row, 'status', ORGANIZATION_STATUSES),
    }
  }

  readCapability(
    organizationId: string,
  ): Promise<AutopilotCapabilityRecord | null> {
    return loadAutopilotCapability(this.db, organizationId)
  }

  async readEntitlements(
    organizationId: string,
  ): Promise<EntitlementOverrides | null> {
    const { data, error } = await this.db
      .from('organization_subscriptions')
      .select('entitlement_grants, entitlement_revocations, limit_overrides')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw new Error(error.message)
    // Not an error. A customer with no live subscription row is a real state,
    // and the rule refuses the whole operation rather than half-performing it.
    if (!data) return null

    const row = data as unknown as Row
    return {
      entitlementGrants: knownEntitlements(row, 'entitlement_grants'),
      entitlementRevocations: knownEntitlements(row, 'entitlement_revocations'),
      limitOverrides: numericLimits(asJsonRecord(row, 'limit_overrides')),
    }
  }

  async applyCapabilityDecision(
    decision: AutopilotCapabilityDecision,
  ): Promise<void> {
    const { error } = await this.db.rpc('platform_set_autopilot_capability', {
      target_organization_id: decision.organizationId,
      next_state: decision.state,
      next_trial_ends_at: decision.trialEndsAt,
      next_action_limit: decision.actionLimit,
      next_note: decision.note,
      grants: [...decision.overrides.entitlementGrants],
      revocations: [...decision.overrides.entitlementRevocations],
      limits: decision.overrides.limitOverrides,
    })

    if (!error) return

    // PGRST202: PostgREST could not find the function. That is the one failure
    // an operator can act on without reading a stack trace, so it is named.
    if (error.code === 'PGRST202') {
      throw new BusinessRuleError({
        code: 'autopilot_capability_writer_missing',
        status: 501,
        message:
          'platform_set_autopilot_capability() is not in the database; ' +
          '0046 revokes insert and update on autopilot_capability from the ' +
          'application role, so there is no other path for this write',
        userMessage:
          'הפונקציה שכותבת את מצב הטייס האוטומטי אינה קיימת עדיין במסד ' +
          'הנתונים, ולכן לא בוצע שום שינוי — לא ברישום ולא בהרשאה. ' +
          'הכתיבה הזו חייבת להתבצע בפעולה אחת, ולכן היא אינה מפוצלת לשני ' +
          'עדכונים שאפשר לבצע חצי מהם.',
      })
    }

    throw new Error(error.message)
  }
}

/**
 * A stored feature list, narrowed to the names the product knows.
 *
 * Same filter, and the same argument, as `organizations.ts`: the CHECK
 * constraints make an unknown entitlement unreachable, and if one ever appears
 * the console shows the features it understands rather than re-saving a string
 * it cannot read.
 */
function knownEntitlements(row: Row, column: string): readonly Entitlement[] {
  const known = ENTITLEMENTS as readonly string[]
  return asStringArray(row, column).filter((value): value is Entitlement =>
    known.includes(value),
  )
}

/** The override object as numbers and nulls. `null` is "unlimited", and real. */
function numericLimits(
  stored: Record<string, unknown>,
): Record<string, number | null> {
  const result: Record<string, number | null> = {}
  for (const [key, value] of Object.entries(stored)) {
    if (value === null) result[key] = null
    else if (typeof value === 'number') result[key] = value
  }
  return result
}
