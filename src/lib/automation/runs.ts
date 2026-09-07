/**
 * EXECUTION CONTEXT — SERVER ONLY. The decision record, written and read.
 *
 * `evaluation.ts` says where this belongs — pure decisions in, and the write
 * lives here — and this is that file. It decides nothing.
 *
 * ── The write goes through a function, and that is the whole point ────────
 *
 * `record_automation_evaluation` (0075) is SECURITY DEFINER for the reason
 * `enqueue_webhook_deliveries` (0061) is. A receptionist confirms a booking and
 * `booking.confirmed` is published. Three library rules listen to it, and
 * whether they are on is a row in `automation_rules`, which 0067 gates behind
 * `automation.view` — a grant an owner and a general manager hold and a
 * receptionist does not. She can read neither the rules nor write the decision,
 * and both refusals are correct.
 *
 * The obvious fix is an admin client in the event bus. That would put a
 * credential which bypasses row level security into every write path in the
 * product so that a log line can be written. So nothing here constructs a
 * client and nothing here reaches for a service-role key: this calls the
 * function with the CALLER'S client, and the function checks membership
 * explicitly because row level security is bypassed inside it.
 *
 * The function returns a COUNT and never the configuration it read, so 0067's
 * read policy is not widened by the existence of a runner.
 *
 * ── The event key, and why it is built rather than taken ──────────────────
 *
 * `contracts/events.ts` gives a `DomainEvent` an `idempotencyKey`. The envelope
 * the service pipeline actually publishes — `service/events.ts` — does not have
 * one; it carries a `correlationId`, which ties every event of one operation to
 * the request that caused it, and is therefore shared by the four events a
 * single booking confirmation emits.
 *
 * So the key is the correlation, the name, and a fingerprint of the payload.
 * The name separates the four; the fingerprint separates two events of the same
 * name that an operation legitimately emits about different things — two
 * shortages, say — and is stable across a redelivery of either. `fingerprint`
 * is the service layer's own, over `stableStringify`, so key order in a payload
 * cannot change the key.
 *
 * The key does not fabricate uniqueness where there is none: two events with
 * the same correlation, the same name and byte-identical payloads are one
 * event, and treating them as one is the behaviour that is wanted.
 */

import { fingerprint, type DomainEvent } from '../service'
import {
  asEnum,
  asJsonRecord,
  asString,
  asStringOrNull,
  asTimestamp,
  asTimestampOrNull,
  toRows,
  type Db,
  type Row,
} from '../persistence'

import { candidatesForEvent, type EvaluationCandidate } from './evaluation'
import type { RuleSource } from './state'

const RUNS_TABLE = 'automation_runs'
const CONSENT_TABLE = 'automation_execution_consent'

/* ---------------------------------------------------------- the writing --- */

/** Matches the `automation_runs_event_key_bounded` CHECK in 0075. */
const EVENT_KEY_LIMIT = 200

export function automationEventKey(event: DomainEvent): string {
  return `${event.correlationId}::${event.name}::${fingerprint(event.payload)}`
}

/**
 * The RPC argument, built from a candidate.
 *
 * snake_case because the function reads it out of jsonb by name, and the SQL
 * side of a boundary names things the way SQL does. Kept in one function so the
 * shape 0075 documents has exactly one producer.
 */
function toRpcCandidate(
  candidate: EvaluationCandidate,
): Record<string, unknown> {
  return {
    template_id: candidate.templateId,
    shipped_enabled: candidate.shippedEnabled,
    conditions_met: candidate.conditionsMet,
    reason: candidate.reason,
    gates: candidate.gates.map((gate) => ({
      key: gate.key,
      operator: gate.operator,
      fact: gate.fact,
      shipped: gate.shipped,
    })),
    would_perform: candidate.wouldPerform.map((action) => ({
      kind: action.kind,
      note: action.note,
    })),
    facts: candidate.facts,
  }
}

/**
 * Record what every rule listening to this event decided.
 *
 * Returns the number of decisions actually written, which is zero for an event
 * no rule listens to — the overwhelmingly common case, since the library covers
 * fifteen of roughly a hundred catalogue names — and zero again for a
 * redelivery, because the unique constraint refused it. A caller cannot tell
 * those two apart from the number and does not need to: neither is a failure.
 *
 * **No round trip when nothing listens.** The check is local, from the frozen
 * library, so the ninety-odd events that reach no rule do not each cost a
 * database call inside somebody's booking request.
 */
export async function recordAutomationEvaluation(
  db: Db,
  event: DomainEvent,
): Promise<number> {
  const candidates = candidatesForEvent(event.name, event.payload)
  if (candidates.length === 0) return 0

  const key = automationEventKey(event)
  if (key.length > EVENT_KEY_LIMIT) {
    // Refused here as well as in the function, so the message names the event
    // rather than a constraint. A key this long means a correlation id nothing
    // in this product generates, which is worth failing loudly over.
    throw new Error(
      `automation event key for ${event.name} is longer than ${EVENT_KEY_LIMIT} characters`,
    )
  }

  const { data, error } = await db.rpc('record_automation_evaluation', {
    p_organization_id: event.organizationId,
    p_property_id: event.propertyId,
    p_event_name: event.name,
    p_event_key: key,
    p_correlation_id: event.correlationId,
    // `new Date(...)` around a value the type already says is a Date, because
    // this envelope crosses a JSON boundary in some callers and a string that
    // arrived where a Date was declared would throw inside a booking request.
    // The subscriber's failure would be collected rather than fatal, but a
    // whole organization silently recording nothing is not a failure mode worth
    // buying with a saved allocation.
    p_occurred_at: new Date(event.occurredAt).toISOString(),
    p_candidates: candidates.map(toRpcCandidate),
  })

  if (error) throw error
  return typeof data === 'number' ? data : 0
}

/* ---------------------------------------------------------- the reading --- */

export const AUTOMATION_DECISIONS = [
  /** The rule is on here and its conditions held. NOT "this happened". */
  'would_act',
  'skipped_conditions',
  'skipped_disabled',
] as const

export type AutomationDecision = (typeof AUTOMATION_DECISIONS)[number]

const SOURCES: readonly RuleSource[] = ['shipped', 'organization', 'property']

/** One action a rule would have performed, as the record kept it. */
export interface RecordedAction {
  kind: string
  note: string
}

export interface RecordedDecision {
  id: string
  propertyId: string | null
  templateId: string
  eventName: string
  decision: AutomationDecision
  /** Which of state.ts's three answers decided. */
  source: RuleSource
  reason: string | null
  wouldPerform: readonly RecordedAction[]
  facts: Readonly<Record<string, unknown>>
  occurredAt: string
  decidedAt: string
  /**
   * Always null in this deployment, and the screen states that as a fact rather
   * than rendering an empty column. Nothing holds UPDATE on the table.
   */
  performedAt: string | null
}

const COLUMNS =
  'id, property_id, template_id, event_name, decision, source, reason, ' +
  'would_perform, facts, occurred_at, decided_at, performed_at'

/**
 * The stored action list, with anything the screen could not render left out.
 *
 * 0075 refuses a malformed entry at the constraint, so this is the second
 * statement of the same rule rather than the only one — and it is not an
 * exception, for `repository.ts`'s reason: one bad row must not make a whole
 * organization's automation screen fail to render.
 */
function toActions(value: unknown): readonly RecordedAction[] {
  if (!Array.isArray(value)) return []
  const actions: RecordedAction[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const { kind, note } = entry as Record<string, unknown>
    if (typeof kind === 'string' && typeof note === 'string') {
      actions.push({ kind, note })
    }
  }
  return actions
}

function toDecision(row: Row): RecordedDecision {
  return {
    id: asString(row, 'id'),
    propertyId: asStringOrNull(row, 'property_id'),
    templateId: asString(row, 'template_id'),
    eventName: asString(row, 'event_name'),
    decision: asEnum(row, 'decision', AUTOMATION_DECISIONS),
    source: asEnum(row, 'source', SOURCES),
    reason: asStringOrNull(row, 'reason'),
    wouldPerform: toActions(row.would_perform),
    facts: asJsonRecord(row, 'facts'),
    occurredAt: asTimestamp(row, 'occurred_at'),
    decidedAt: asTimestamp(row, 'decided_at'),
    performedAt: asTimestampOrNull(row, 'performed_at'),
  }
}

/** What a business has authorised its automations to do beyond deciding. */
export interface AutomationExecutionConsent {
  organizationId: string
  /** False, everywhere. See `performing.ts`. */
  performingEnabled: boolean
  note: string | null
  consentedAt: string | null
  consentedBy: string | null
  revokedAt: string | null
}

export class AutomationRunRepository {
  constructor(private readonly db: Db) {}

  /**
   * The newest decisions, for the organization or for one property.
   *
   * A property view includes the organization-wide rows — a decision about an
   * event that named no property is still a decision this property's manager
   * needs — which is why it is an `or` and not an `eq`. Row level security
   * narrows to properties in scope on top of this; the filter is what the
   * reader asked for, the policy is what they are allowed.
   */
  async recent(
    organizationId: string,
    propertyId: string | null,
    limit: number,
  ): Promise<readonly RecordedDecision[]> {
    const query = this.db
      .from(RUNS_TABLE)
      .select(COLUMNS)
      .eq('organization_id', organizationId)

    const scoped =
      propertyId === null
        ? query
        : query.or(`property_id.eq.${propertyId},property_id.is.null`)

    const { data, error } = await scoped
      .order('decided_at', { ascending: false })
      .limit(limit)

    if (error) throw error
    return toRows(data).map(toDecision)
  }

  /**
   * This organization's consent to let automations act, or null.
   *
   * Null is the state every organization is in, and it is not a missing value:
   * it is "nobody has authorised anything", which is off. See 0075.
   */
  async consent(
    organizationId: string,
  ): Promise<AutomationExecutionConsent | null> {
    const { data, error } = await this.db
      .from(CONSENT_TABLE)
      .select(
        'organization_id, performing_enabled, note, consented_at, consented_by, revoked_at',
      )
      .eq('organization_id', organizationId)
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    const row = data as Row
    return {
      organizationId: asString(row, 'organization_id'),
      performingEnabled: row.performing_enabled === true,
      note: asStringOrNull(row, 'note'),
      consentedAt: asTimestampOrNull(row, 'consented_at'),
      consentedBy: asStringOrNull(row, 'consented_by'),
      revokedAt: asTimestampOrNull(row, 'revoked_at'),
    }
  }
}
