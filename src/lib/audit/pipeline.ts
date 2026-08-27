/**
 * The only sanctioned way to record an audit event.
 *
 * `events.ts` defines the shape and the two rules that make the trail worth
 * keeping: store the difference, not the record, and never store a secret.
 * This file is what guarantees those rules actually hold, by being the single
 * door every event goes through. A call site that assembled a row and inserted
 * it directly would bypass both, and would do so silently.
 *
 * Three things happen here, in this order:
 *
 *   1. **Diff.** Before/after are reduced to the fields that changed. A caller
 *      may hand over whole records; what lands is the difference.
 *   2. **Scrub.** Recursively, unlike `scrubSensitive` on its own — a token
 *      nested inside `payment.provider.card_token` is exactly as permanent in
 *      a years-retained log as one at the top level.
 *   3. **Refuse.** An event missing an actor label, an action, a resource type
 *      or a summary is rejected here rather than by the database, because the
 *      database would reject it at the end of the transaction and the operation
 *      would already have run.
 *
 * The writer is injected. This file never opens a connection, so the rules
 * above are provable without one.
 */

import { AppError } from '../errors/app-error'
import {
  diffFields,
  scrubSensitive,
  type ActorType,
  type AuditEventInput,
} from './events'

/**
 * A row of `public.audit_events`, ready to insert.
 *
 * Flat, matching the columns, so the writer is a mapping and nothing more.
 * There is no `id` and no `version`: the database generates the first and the
 * table deliberately has no second — nothing may ever update an audit row.
 */
export interface AuditRecord {
  organizationId: string
  actorUserId: string | null
  actorType: ActorType
  actorLabel: string
  onBehalfOfUserId: string | null
  action: string
  resourceType: string
  resourceId: string | null
  propertyId: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  summary: string
  reason: string | null
  occurredAt: Date
  ip: string | null
  userAgent: string | null
  requestId: string
}

/**
 * Where a finished record goes.
 *
 * `tx` is the transaction handle from the service pipeline, opaque here. The
 * audit write belongs inside the same transaction as the change it describes:
 * a committed change with no audit row is an untraceable change, and an audit
 * row for a rolled-back change is a lie.
 */
export interface AuditWriter {
  write(record: AuditRecord, tx?: unknown): Promise<void>
}

/** Collects records instead of writing them. For tests and for dry runs. */
export class InMemoryAuditWriter implements AuditWriter {
  readonly records: AuditRecord[] = []

  async write(record: AuditRecord): Promise<void> {
    this.records.push(record)
  }
}

/** A writer that always fails, to prove an audit failure fails the operation. */
export class FailingAuditWriter implements AuditWriter {
  constructor(private readonly reason = 'audit write failed') {}

  async write(): Promise<void> {
    throw new Error(this.reason)
  }
}

// ── Deep scrubbing ────────────────────────────────────────────────────────

/**
 * Apply `scrubSensitive` at every level.
 *
 * `scrubSensitive` is shallow, which is right for its own contract but wrong
 * for a payload assembled from a provider response, where the interesting
 * value is three levels down. Arrays are walked; anything that is not a plain
 * object or array is left as it is.
 */
export function deepScrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepScrub)

  if (isPlainObject(value)) {
    const shallow = scrubSensitive(value)
    const output: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(shallow)) {
      // Already replaced by the marker: do not walk into it.
      output[key] = entry === '[redacted]' ? entry : deepScrub(entry)
    }
    return output
  }

  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return false
  if (value instanceof Date) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function scrubRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!value || Object.keys(value).length === 0) return null
  return deepScrub(value) as Record<string, unknown>
}

// ── Validation ────────────────────────────────────────────────────────────

/**
 * Rejected before the insert, mirroring the table's own check constraints.
 *
 * A 500 rather than a 4xx: an event missing its summary is a defect in the
 * operation that produced it, not something a user did.
 */
export class AuditEventInvalidError extends AppError {
  constructor(problem: string) {
    super({
      code: 'audit_event_invalid',
      status: 500,
      message: `Refusing to record an audit event: ${problem}`,
      userMessage:
        'אירעה תקלה במערכת ולכן הפעולה לא בוצעה. נסה שוב בעוד מספר רגעים.',
      retryable: true,
      dataOutcome: 'not_saved',
    })
  }
}

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim().length === 0
}

// ── The pipeline ──────────────────────────────────────────────────────────

export interface RecordAuditEventOptions {
  /** When the action happened. Injected so events are deterministic in tests. */
  occurredAt?: Date
  /** The transaction the described change is running in. */
  tx?: unknown
}

/**
 * Scrub, diff, check, write.
 *
 * Returns the record it wrote, so a caller can assert on exactly what landed —
 * which is how "exactly one audit event per successful operation" becomes a
 * statement a test can make rather than one a report can claim.
 */
export async function recordAuditEvent(
  input: AuditEventInput,
  writer: AuditWriter,
  options: RecordAuditEventOptions = {},
): Promise<AuditRecord> {
  if (isBlank(input.actor.label)) {
    throw new AuditEventInvalidError('actor label is blank')
  }
  if (isBlank(input.action)) {
    throw new AuditEventInvalidError('action is blank')
  }
  if (isBlank(input.resourceType)) {
    throw new AuditEventInvalidError('resource type is blank')
  }
  if (isBlank(input.summary)) {
    throw new AuditEventInvalidError('summary is blank')
  }
  if (isBlank(input.context.organizationId)) {
    throw new AuditEventInvalidError('organization id is blank')
  }
  if (isBlank(input.context.requestId)) {
    throw new AuditEventInvalidError('request id is blank')
  }
  // "booking.update" is not a sentence. The whole point of the summary column
  // is that it says something the action string does not.
  if (input.summary.trim() === input.action.trim()) {
    throw new AuditEventInvalidError(
      'summary repeats the action instead of describing what happened',
    )
  }

  const { before, after } = diffFields(
    input.before ?? undefined,
    input.after ?? undefined,
  )

  const record: AuditRecord = {
    organizationId: input.context.organizationId,
    actorUserId: input.actor.userId,
    actorType: input.actor.type,
    actorLabel: input.actor.label,
    onBehalfOfUserId: input.actor.onBehalfOfUserId ?? null,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    propertyId: input.context.propertyId ?? null,
    before: scrubRecord(before),
    after: scrubRecord(after),
    summary: input.summary,
    reason: input.reason ?? null,
    occurredAt: options.occurredAt ?? new Date(),
    ip: input.context.ip ?? null,
    userAgent: input.context.userAgent ?? null,
    requestId: input.context.requestId,
  }

  await writer.write(record, options.tx)
  return record
}
