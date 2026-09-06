/**
 * Reading history and writing proposals.
 *
 * A port and two implementations, the shape `src/lib/notifications/
 * repository.ts` uses and for the same two reasons: the detectors must be
 * exercisable without a database, and the adapter for this module's own table
 * belongs beside the module rather than in `src/lib/persistence/**`, which
 * another owner writes.
 *
 * ── One writable table, enforced on every call ────────────────────────────
 *
 * Every write here goes through `assertLearningWritable` before the client is
 * touched. Learning proposes; it does not adopt, and it must not be able to
 * reach `autopilot_policies`, `autopilot_settings`, `autopilot_safety_rules`
 * or any module's configuration even by a mistaken edit that typechecks. The
 * guard is one line per write and it is the difference between a separation
 * that is enforced and one that is merely intended.
 *
 * ── Adoption still needs a person, twice ──────────────────────────────────
 *
 * `decideCandidate` calls `prepareDecision`, which refuses `adopted` without a
 * name and a timestamp, and then the database refuses it again through
 * `autopilot_rule_candidates_decided_pair`. Neither check is redundant: this
 * one produces an error somebody can read, and that one holds even when this
 * file is bypassed.
 *
 * ── What this deployment cannot yet supply ────────────────────────────────
 *
 * Three of the eight history streams have no storage behind them, and they
 * raise `SchemaNotProvisionedError` rather than returning an empty array. The
 * difference matters: an empty array says "this business has no recurring
 * quantity overrides", which is a claim about their operation, and the truth
 * is "nothing in this deployment records what a plan said before somebody
 * changed it". Reporting the first as the second is how a learning feature
 * silently learns nothing for a year. The gaps are listed on
 * `UNRECORDED_STREAMS` and each one names the storage it needs.
 */

import {
  asDate,
  asNumber,
  asString,
  asStringOrNull,
  clientFor,
  recordWrite,
  toRow,
  toRows,
  SchemaNotProvisionedError,
  type Db,
  type Row,
} from '../../persistence'
import type { TransactionHandle } from '../../service'
import { AUTOPILOT_RULE_CANDIDATE_STATES } from '../../contracts/states'

import { assertLearningWritable, type BoundaryRefusal } from './boundaries'
import type { FeedbackRecord } from './feedback'
import type { OperationalPreference } from './memory'
import type {
  HistoryWindow,
  LaundryChoiceRecord,
  CleanerAssignmentRecord,
  OperationalHistory,
} from './patterns'
import { emptyHistory } from './patterns'
import {
  prepareDecision,
  type CandidateDecision,
  type ProposalBody,
  type RuleCandidate,
  type RuleCandidateDraft,
} from './propose'

/* ------------------------------------------------------------------ port -- */

export interface LearningRepository {
  /** Everything the detectors read, for one organization and one window. */
  loadHistory(
    organizationId: string,
    window: HistoryWindow,
  ): Promise<OperationalHistory>

  listCandidates(
    organizationId: string,
    options?: { states?: readonly RuleCandidate['state'][]; limit?: number },
  ): Promise<readonly RuleCandidate[]>

  /**
   * Write one proposal, or discover it is already there.
   *
   * `created: false` means the unique index on
   * (organization, property, pattern_code) held — the ordinary outcome of a
   * habit that is still happening, and the reason one habit does not become
   * forty cards. The occurrence count and the window are refreshed; the state
   * is never touched, so a candidate a person already decided about does not
   * quietly reopen.
   */
  upsertCandidate(
    draft: RuleCandidateDraft,
    tx?: TransactionHandle,
  ): Promise<{ candidate: RuleCandidate; created: boolean }>

  /** Accept, refuse or mute. Adoption without a decider is refused here. */
  decideCandidate(
    organizationId: string,
    candidateId: string,
    decision: CandidateDecision,
    tx?: TransactionHandle,
  ): Promise<RuleCandidate>

  listFeedback(
    organizationId: string,
    targetKeys: readonly string[],
  ): Promise<readonly FeedbackRecord[]>

  recordFeedback(
    organizationId: string,
    record: FeedbackRecord,
    tx?: TransactionHandle,
  ): Promise<void>

  listPreferences(
    organizationId: string,
  ): Promise<readonly OperationalPreference[]>

  savePreference(
    preference: OperationalPreference,
    tx?: TransactionHandle,
  ): Promise<OperationalPreference>

  /** So a refusal is a row somebody can query, not a value nobody saw. */
  recordRefusal(
    organizationId: string,
    refusal: BoundaryRefusal,
    tx?: TransactionHandle,
  ): Promise<void>
}

/* ------------------------------------------------------------------ gaps -- */

/**
 * The history this deployment does not record, and what each one would need.
 *
 * Written as data rather than as prose so the screen can show a customer why a
 * detector is quiet, and so the list cannot drift out of step with the
 * `SchemaNotProvisionedError` calls below — both read this.
 */
export const UNRECORDED_STREAMS: Readonly<Record<string, string>> = {
  quantityOverrides:
    'preparation plan revisions with the previous quantity — ' +
    'preparation_snapshots is append-only but holds no per-line diff',
  staffingAdditions:
    'planned versus actual crew size per shift — no table records a planned ' +
    'crew size',
  paymentExceptions:
    'a classified reason for settling a payment outside the normal path — ' +
    'payments carries no exception code',
  preparationAdjustments:
    'the configured value a preparation setting was overridden away from',
  messageTemplateChoices:
    'which template a sent guest message used — guest_link_sends records ' +
    'the send, not the template',
  feedback: 'a table for Helpful / Not helpful / Wrong on a recommendation',
  preferences: 'a table for approved operational preferences',
  refusals: 'a table for boundary refusals',
}

/* --------------------------------------------------------------- mapping -- */

const CANDIDATE_COLUMNS =
  'id, organization_id, property_id, state, pattern_code, summary, ' +
  'occurrences, observed_from, observed_to, sample, proposal, decided_at, ' +
  'decided_by, version'

/** A jsonb array of samples, refused rather than coerced when malformed. */
function asSample(value: unknown): RuleCandidate['sample'] {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const row = entry as Record<string, unknown>
    if (typeof row.reference !== 'string') return []

    return [
      {
        reference: row.reference,
        label: typeof row.label === 'string' ? row.label : row.reference,
        occurredOn: typeof row.occurredOn === 'string' ? row.occurredOn : '',
      },
    ]
  })
}

/**
 * The stored proposal.
 *
 * `null` for a candidate written before a proposal was composed — the column
 * defaults to `{}` — rather than a fabricated body. A screen showing an empty
 * proposal can say so; one showing invented text cannot be corrected.
 */
function asProposal(value: unknown): ProposalBody | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (typeof row.observed !== 'string') return null

  return {
    observed: row.observed,
    occurrences: typeof row.occurrences === 'number' ? row.occurrences : 0,
    opportunities:
      typeof row.opportunities === 'number' ? row.opportunities : 0,
    rate: typeof row.rate === 'string' ? row.rate : '',
    period: typeof row.period === 'string' ? row.period : '',
    suggestedRule:
      typeof row.suggestedRule === 'string' ? row.suggestedRule : '',
    expectedImpact:
      typeof row.expectedImpact === 'string' ? row.expectedImpact : '',
    module: typeof row.module === 'string' ? row.module : '',
    parameters:
      typeof row.parameters === 'object' && row.parameters !== null
        ? (row.parameters as ProposalBody['parameters'])
        : {},
    actionKind: typeof row.actionKind === 'string' ? row.actionKind : null,
  }
}

export function candidateFromRow(row: Row): RuleCandidate {
  const state = asString(row, 'state')
  const known: readonly string[] = AUTOPILOT_RULE_CANDIDATE_STATES
  if (!known.includes(state)) {
    // The enum and this file disagree, which means a migration moved and this
    // did not. A loud failure at the mapping boundary beats a card rendering
    // with a blank state three screens later.
    throw new Error(`Unknown rule candidate state: ${state}`)
  }

  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asStringOrNull(row, 'property_id'),
    state: state as RuleCandidate['state'],
    patternCode: asString(row, 'pattern_code'),
    summary: asString(row, 'summary'),
    occurrences: asNumber(row, 'occurrences'),
    observedFrom: asString(row, 'observed_from'),
    observedTo: asString(row, 'observed_to'),
    sample: asSample(row.sample),
    proposal: asProposal(row.proposal),
    decidedAt:
      row.decided_at == null ? null : asDate(row, 'decided_at').toISOString(),
    decidedBy: asStringOrNull(row, 'decided_by'),
    version: asNumber(row, 'version'),
  }
}

/* --------------------------------------------------------------- adapter -- */

const CANDIDATES = 'autopilot_rule_candidates'

/** PostgREST's code for a unique violation. The dedupe index, working. */
const UNIQUE_VIOLATION = '23505'

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  )
}

export class SupabaseLearningRepository implements LearningRepository {
  constructor(private readonly db: Db) {}

  /**
   * The two streams this deployment can actually answer.
   *
   * Laundry provider choices and cleaner assignments come off tables that
   * exist and whose columns are named here. The other five raise rather than
   * return empty — see the header, and `UNRECORDED_STREAMS`.
   */
  async loadHistory(
    organizationId: string,
    window: HistoryWindow,
  ): Promise<OperationalHistory> {
    const [laundryChoices, cleanerAssignments] = await Promise.all([
      this.loadLaundryChoices(organizationId, window),
      this.loadCleanerAssignments(organizationId, window),
    ])

    return { ...emptyHistory(window), laundryChoices, cleanerAssignments }
  }

  private async loadLaundryChoices(
    organizationId: string,
    window: HistoryWindow,
  ): Promise<readonly LaundryChoiceRecord[]> {
    const { data: settings, error: settingsError } = await this.db
      .from('laundry_settings')
      .select('property_id, default_provider_id')
      .eq('organization_id', organizationId)

    if (settingsError) throw settingsError

    // Property row first, organization row (property_id null) as the fallback.
    const defaults = new Map<string, string | null>()
    for (const row of toRows(settings)) {
      defaults.set(
        asStringOrNull(row, 'property_id') ?? '-',
        asStringOrNull(row, 'default_provider_id'),
      )
    }

    const { data, error } = await this.db
      .from('laundry_orders')
      .select(
        'id, property_id, provider_id, required_by, status, ' +
          'laundry_providers (name)',
      )
      .eq('organization_id', organizationId)
      .gte('required_by', `${window.from}T00:00:00Z`)
      .lte('required_by', `${window.to}T23:59:59Z`)
      // A cancelled order is not a choice the business made about a provider.
      .neq('status', 'cancelled')

    if (error) throw error

    return toRows(data).flatMap((row) => {
      const providerId = asStringOrNull(row, 'provider_id')
      if (providerId === null) return []

      const propertyId = asStringOrNull(row, 'property_id')
      const provider = row.laundry_providers
      const label =
        typeof provider === 'object' &&
        provider !== null &&
        typeof (provider as { name?: unknown }).name === 'string'
          ? (provider as { name: string }).name
          : providerId

      return [
        {
          orderId: asString(row, 'id'),
          propertyId,
          providerId,
          providerLabel: label,
          defaultProviderId:
            defaults.get(propertyId ?? '-') ?? defaults.get('-') ?? null,
          occurredOn: asDate(row, 'required_by').toISOString().slice(0, 10),
        },
      ]
    })
  }

  private async loadCleanerAssignments(
    organizationId: string,
    window: HistoryWindow,
  ): Promise<readonly CleanerAssignmentRecord[]> {
    const { data, error } = await this.db
      .from('tasks')
      .select(
        'id, property_id, assigned_to_user_id, completed_at, ' +
          'user_profiles:assigned_to_user_id (full_name)',
      )
      .eq('organization_id', organizationId)
      .eq('task_type', 'cleaning')
      .not('assigned_to_user_id', 'is', null)
      .gte('completed_at', `${window.from}T00:00:00Z`)
      .lte('completed_at', `${window.to}T23:59:59Z`)

    if (error) throw error

    return toRows(data).flatMap((row) => {
      const userId = asStringOrNull(row, 'assigned_to_user_id')
      if (userId === null) return []

      const profile = row.user_profiles
      const label =
        typeof profile === 'object' &&
        profile !== null &&
        typeof (profile as { full_name?: unknown }).full_name === 'string'
          ? (profile as { full_name: string }).full_name
          : userId

      return [
        {
          taskId: asString(row, 'id'),
          propertyId: asString(row, 'property_id'),
          assignedUserId: userId,
          assignedUserLabel: label,
          // No column anywhere records a property's standing cleaner, so there
          // is no default to compare against and every assignment counts. See
          // request 1 in the module's report.
          defaultUserId: null,
          occurredOn: asDate(row, 'completed_at').toISOString().slice(0, 10),
        },
      ]
    })
  }

  async listCandidates(
    organizationId: string,
    options: {
      states?: readonly RuleCandidate['state'][]
      limit?: number
    } = {},
  ): Promise<readonly RuleCandidate[]> {
    let query = this.db
      .from(CANDIDATES)
      .select(CANDIDATE_COLUMNS)
      // The policy is the enforcement; this filter is what stops a mistake in
      // this file from becoming a cross-tenant read under `service_role`.
      .eq('organization_id', organizationId)
      .order('occurrences', { ascending: false })
      .limit(options.limit ?? 100)

    if (options.states && options.states.length > 0) {
      query = query.in('state', [...options.states])
    }

    const { data, error } = await query
    if (error) throw error
    return toRows(data).map(candidateFromRow)
  }

  async upsertCandidate(
    draft: RuleCandidateDraft,
    tx?: TransactionHandle,
  ): Promise<{ candidate: RuleCandidate; created: boolean }> {
    assertLearningWritable(CANDIDATES)
    const db = clientFor(tx, this.db)

    const payload = {
      organization_id: draft.organizationId,
      property_id: draft.propertyId,
      state: draft.state,
      pattern_code: draft.patternCode,
      summary: draft.summary,
      occurrences: draft.occurrences,
      observed_from: draft.observedFrom,
      observed_to: draft.observedTo,
      sample: draft.sample,
      proposal: draft.proposal,
    }

    const { data, error } = await db
      .from(CANDIDATES)
      .insert(payload)
      .select(CANDIDATE_COLUMNS)
      .single()

    if (!error) {
      if (tx) recordWrite(tx, `${CANDIDATES}.insert`)
      return { candidate: candidateFromRow(toRow(data)), created: true }
    }

    if (!isUniqueViolation(error)) throw error

    // The habit is still happening. Refresh what was counted and leave the
    // state alone: a candidate somebody already rejected must not reopen
    // because the behaviour continued, which is what `muted` is for.
    const { data: updated, error: updateError } = await db
      .from(CANDIDATES)
      .update({
        summary: draft.summary,
        occurrences: draft.occurrences,
        observed_from: draft.observedFrom,
        observed_to: draft.observedTo,
        sample: draft.sample,
        proposal: draft.proposal,
      })
      .eq('organization_id', draft.organizationId)
      .eq('pattern_code', draft.patternCode)
      .in('state', ['observed', 'proposed'])
      .select(CANDIDATE_COLUMNS)
      .maybeSingle()

    if (updateError) throw updateError
    if (tx) recordWrite(tx, `${CANDIDATES}.refresh`)

    if (!updated) {
      // Already decided. Hand back what is there rather than inventing a row.
      const { data: existing, error: readError } = await db
        .from(CANDIDATES)
        .select(CANDIDATE_COLUMNS)
        .eq('organization_id', draft.organizationId)
        .eq('pattern_code', draft.patternCode)
        .single()

      if (readError) throw readError
      return { candidate: candidateFromRow(toRow(existing)), created: false }
    }

    return { candidate: candidateFromRow(toRow(updated)), created: false }
  }

  async decideCandidate(
    organizationId: string,
    candidateId: string,
    decision: CandidateDecision,
    tx?: TransactionHandle,
  ): Promise<RuleCandidate> {
    assertLearningWritable(CANDIDATES)
    // Refuses `adopted` and `rejected` without a named person and a time. The
    // database refuses the same thing again; both are wanted.
    const prepared = prepareDecision(decision)
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from(CANDIDATES)
      .update({
        state: prepared.state,
        decided_by: prepared.decidedBy,
        decided_at: prepared.decidedAt,
      })
      .eq('organization_id', organizationId)
      .eq('id', candidateId)
      .select(CANDIDATE_COLUMNS)
      .single()

    if (error) throw error
    if (tx) recordWrite(tx, `${CANDIDATES}.${prepared.state}`)
    return candidateFromRow(toRow(data))
  }

  async listFeedback(): Promise<readonly FeedbackRecord[]> {
    throw new SchemaNotProvisionedError(
      UNRECORDED_STREAMS.feedback,
      'autopilot recommendation feedback',
    )
  }

  async recordFeedback(): Promise<void> {
    throw new SchemaNotProvisionedError(
      UNRECORDED_STREAMS.feedback,
      'autopilot recommendation feedback',
    )
  }

  async listPreferences(): Promise<readonly OperationalPreference[]> {
    throw new SchemaNotProvisionedError(
      UNRECORDED_STREAMS.preferences,
      'approved operational preferences',
    )
  }

  async savePreference(): Promise<OperationalPreference> {
    throw new SchemaNotProvisionedError(
      UNRECORDED_STREAMS.preferences,
      'approved operational preferences',
    )
  }

  async recordRefusal(): Promise<void> {
    throw new SchemaNotProvisionedError(
      UNRECORDED_STREAMS.refusals,
      'learning boundary refusals',
    )
  }
}

/* ------------------------------------------------------------ in memory -- */

/**
 * The double the domain tests run against.
 *
 * It implements the two behaviours the module's most important tests assert:
 * the unique key on (organization, property, pattern_code) holds, so one habit
 * is one candidate; and `decideCandidate` refuses adoption without a decider,
 * so a double cannot let that test pass for the wrong reason.
 */
export class InMemoryLearningRepository implements LearningRepository {
  history = new Map<string, OperationalHistory>()
  candidates: RuleCandidate[] = []
  feedback: (FeedbackRecord & { organizationId: string })[] = []
  preferences: OperationalPreference[] = []
  refusals: (BoundaryRefusal & { organizationId: string })[] = []

  private sequence = 0

  private nextId(): string {
    this.sequence += 1
    return `candidate-${this.sequence}`
  }

  async loadHistory(
    organizationId: string,
    window: HistoryWindow,
  ): Promise<OperationalHistory> {
    return this.history.get(organizationId) ?? emptyHistory(window)
  }

  async listCandidates(
    organizationId: string,
    options: {
      states?: readonly RuleCandidate['state'][]
      limit?: number
    } = {},
  ): Promise<readonly RuleCandidate[]> {
    return this.candidates
      .filter(
        (row) =>
          row.organizationId === organizationId &&
          (!options.states || options.states.includes(row.state)),
      )
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, options.limit ?? 100)
  }

  async upsertCandidate(
    draft: RuleCandidateDraft,
  ): Promise<{ candidate: RuleCandidate; created: boolean }> {
    assertLearningWritable(CANDIDATES)

    const index = this.candidates.findIndex(
      (row) =>
        row.organizationId === draft.organizationId &&
        row.propertyId === draft.propertyId &&
        row.patternCode === draft.patternCode,
    )

    if (index >= 0) {
      const existing = this.candidates[index]
      const decided =
        existing.state === 'adopted' ||
        existing.state === 'rejected' ||
        existing.state === 'muted'

      const refreshed: RuleCandidate = {
        ...existing,
        summary: draft.summary,
        occurrences: draft.occurrences,
        observedFrom: draft.observedFrom,
        observedTo: draft.observedTo,
        sample: draft.sample.map((one) => ({ ...one })),
        proposal: { ...draft.proposal },
        // A decided candidate never reopens by itself.
        state: decided ? existing.state : draft.state,
        version: existing.version + 1,
      }

      this.candidates[index] = refreshed
      return { candidate: refreshed, created: false }
    }

    const candidate: RuleCandidate = {
      id: this.nextId(),
      organizationId: draft.organizationId,
      propertyId: draft.propertyId,
      state: draft.state,
      patternCode: draft.patternCode,
      summary: draft.summary,
      occurrences: draft.occurrences,
      observedFrom: draft.observedFrom,
      observedTo: draft.observedTo,
      sample: draft.sample.map((one) => ({ ...one })),
      proposal: { ...draft.proposal },
      decidedAt: null,
      decidedBy: null,
      version: 1,
    }

    this.candidates.push(candidate)
    return { candidate, created: true }
  }

  async decideCandidate(
    organizationId: string,
    candidateId: string,
    decision: CandidateDecision,
  ): Promise<RuleCandidate> {
    assertLearningWritable(CANDIDATES)
    const prepared = prepareDecision(decision)

    const index = this.candidates.findIndex(
      (row) => row.id === candidateId && row.organizationId === organizationId,
    )
    if (index < 0) throw new Error(`No such rule candidate: ${candidateId}`)

    const decided: RuleCandidate = {
      ...this.candidates[index],
      state: prepared.state,
      decidedBy: prepared.decidedBy,
      decidedAt: prepared.decidedAt,
      version: this.candidates[index].version + 1,
    }

    this.candidates[index] = decided
    return decided
  }

  async listFeedback(
    organizationId: string,
    targetKeys: readonly string[],
  ): Promise<readonly FeedbackRecord[]> {
    return this.feedback
      .filter(
        (row) =>
          row.organizationId === organizationId &&
          (targetKeys.length === 0 || targetKeys.includes(row.targetKey)),
      )
      .map(({ targetKey, verdict, givenBy, givenAt }) => ({
        targetKey,
        verdict,
        givenBy,
        givenAt,
      }))
  }

  async recordFeedback(
    organizationId: string,
    record: FeedbackRecord,
  ): Promise<void> {
    this.feedback.push({ ...record, organizationId })
  }

  async listPreferences(
    organizationId: string,
  ): Promise<readonly OperationalPreference[]> {
    return this.preferences.filter(
      (row) => row.organizationId === organizationId,
    )
  }

  async savePreference(
    preference: OperationalPreference,
  ): Promise<OperationalPreference> {
    const index = this.preferences.findIndex(
      (row) =>
        row.organizationId === preference.organizationId &&
        row.propertyId === preference.propertyId &&
        row.kind === preference.kind,
    )

    if (index >= 0) this.preferences[index] = preference
    else this.preferences.push(preference)

    return preference
  }

  async recordRefusal(
    organizationId: string,
    refusal: BoundaryRefusal,
  ): Promise<void> {
    this.refusals.push({ ...refusal, organizationId })
  }
}
