/**
 * The service pipeline.
 *
 * The charter names one path that every state-changing operation takes:
 *
 *     Authenticate → Authorize → Validate → Business rule
 *                  → Transaction → Audit event → Domain event
 *
 * A path written as a convention is a path someone skips at four in the
 * afternoon under deadline. So it is not a convention here: an operation is
 * *declared* as its parts, and the pipeline runs them. There is no way to
 * reorder them, no way to reach `execute` without having passed `assertCan`,
 * and no way to finish successfully without an audit event, because the caller
 * never gets to write the sequence.
 *
 * Authentication is upstream of this file — by the time an `Actor` exists, the
 * session has been established. This is everything after that.
 *
 * ── Why authorization is checked twice ────────────────────────────────────
 *
 * `assertCan(actor, permission)` runs *before* `loadResource`, with no
 * resource. It settles membership, the grant and the plan, so a cleaner
 * attempting a refund is refused without a single row being read — the check
 * cannot be undermined by a load that throws, logs, or has a side effect.
 *
 * `assertCan(actor, permission, resource)` runs again immediately after the
 * load, and it is the one that settles tenant and scope, which are questions
 * about the resource and cannot be answered before it exists. Nothing runs
 * between the two but the load itself.
 */

import { assertCan, type Actor, type Resource } from '../authz/can'
import { SENSITIVE_ACTIONS, type Grant } from '../authz/permissions'
import {
  recordAuditEvent,
  type AuditRecord,
  type AuditWriter,
} from '../audit/pipeline'
import type { AuditActor } from '../audit/events'
import {
  AppError,
  ConflictError,
  IdempotencyConflictError,
  NotFoundError,
  QuotaExceededError,
  ValidationError,
  withCorrelation,
  type FieldIssue,
} from '../errors'
import type { PlanLimits } from '../plans/entitlements'
import {
  checkQuota,
  isBlockedByQuota,
  type QuotaKey,
  type QuotaState,
} from '../plans/quota'
import {
  nullEventBus,
  type DomainEvent,
  type DomainEventDraft,
  type EventBus,
} from './events'
import {
  fingerprint,
  type IdempotencyScope,
  type IdempotencyStore,
} from './idempotency'
import type { Schema } from './schema'
import {
  noTransactionRunner,
  type TransactionHandle,
  type TransactionRunner,
} from './transaction'

// ── Inputs ────────────────────────────────────────────────────────────────

/**
 * Everything about *who* and *when*, as opposed to *what*.
 *
 * `auditActor` is separate from `actor` and required. The authorization engine
 * does not know anyone's name — it deals in ids, grants and scope — and the
 * audit trail is worthless without one. Keeping it explicit is also what makes
 * `system` and `ai_agent` first-class: a nightly sync and a copywriting agent
 * run the same operations as a person and are named as themselves in the same
 * timeline.
 */
export interface OperationContext {
  actor: Actor
  auditActor: AuditActor
  /** Ties the request, the audit event, the domain events and the log together. */
  correlationId: string
  /** Injected rather than read, so an operation's output is deterministic. */
  now?: Date
  /** The organization's effective quotas. Required if the operation declares one. */
  limits?: PlanLimits
  ip?: string | null
  userAgent?: string | null
  /** The stated justification, for actions that require one. */
  reason?: string | null
}

export interface OperationRequest {
  /** Raw and untrusted. Validated by the declared schema, never used before. */
  input?: unknown
  resourceId?: string | null
  /** The version the caller believes they are editing. Optimistic locking. */
  expectedVersion?: number
  idempotencyKey?: string | null
}

/** What the pipeline is given to work with. All injected; none constructed here. */
export interface OperationServices {
  audit: AuditWriter
  events?: EventBus
  idempotency?: IdempotencyStore
  transactions?: TransactionRunner
  /**
   * Told when domain event delivery failed. Never rethrown — see `events.ts`.
   * Wire this to the error reporter; a silently dropped event is a
   * confirmation email nobody knows was not sent.
   */
  onEventError?: (error: unknown, events: readonly DomainEvent[]) => void
}

// ── Step arguments ────────────────────────────────────────────────────────

/**
 * What `loadResource` gives back.
 *
 * `resource` is the authorization view — the tenant, and where the thing sits
 * — and is what the second `assertCan` reads. `entity` is the domain object
 * the rest of the operation works with. They are separate because the
 * authorization engine must not depend on the shape of any particular table.
 */
export interface LoadedResource<TEntity> {
  resource: Resource
  entity: TEntity
  /** The record's current `version` column, when it has one. */
  version?: number
}

export interface LoadArgs<TInput> {
  input: TInput
  request: OperationRequest
  context: OperationContext
  correlationId: string
  now: Date
}

export interface RuleArgs<TInput, TEntity> extends LoadArgs<TInput> {
  /** The loaded record. `null` for operations that create one. */
  entity: TEntity
  resource: Resource | null
  version: number | null
}

export interface ExecuteArgs<TInput, TEntity> extends RuleArgs<
  TInput,
  TEntity
> {
  /** The open transaction. Pass it to every write. */
  tx: TransactionHandle
}

export interface ResultArgs<TInput, TEntity, TResult> extends RuleArgs<
  TInput,
  TEntity
> {
  result: TResult
}

/** How much of a limited resource the organization is using. */
export interface QuotaUsage {
  key: QuotaKey
  current: number
}

/**
 * The audit event this operation produces, described by the operation itself.
 *
 * `summary` is the reason this is a callback and not a template. Only the
 * operation knows that the number that changed was a price and that the right
 * sentence is "דנה שינתה את סכום ההזמנה מ-₪5,200 ל-₪4,700". A generic pipeline
 * can only ever produce "booking updated", which is the thing the charter
 * forbids.
 *
 * `before` and `after` may be whole records — the pipeline reduces them to the
 * difference and scrubs them.
 */
export interface AuditDescriptor {
  summary: string
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  resourceId?: string | null
  propertyId?: string | null
  reason?: string | null
  /** Defaults to the operation's permission, keeping event and model aligned. */
  action?: string
}

// ── The definition ────────────────────────────────────────────────────────

export interface OperationDefinition<TInput, TEntity, TResult> {
  /** Dotted, e.g. `booking.update`. Scopes idempotency keys and names the event. */
  name: string
  /** The grant required. Checked before any data is read. */
  permission: Grant
  /** `booking`, `payment`, `guest` — what the audit row is about. */
  resourceType: string
  input: Schema<TInput>
  /**
   * Refuse the request unless it states which version it is editing.
   * Set on any operation that updates a record with a `version` column.
   */
  requiresVersion?: boolean
  /**
   * Demand a stated justification. Defaults to whether the permission is in
   * `SENSITIVE_ACTIONS` — so a refund, a deletion or a customer export cannot
   * be performed on the strength of a permission alone, which is the charter's
   * rule rather than an option.
   */
  requiresReason?: boolean
  /** Reads the target. Absent for operations that create something. */
  loadResource?: (
    args: LoadArgs<TInput>,
  ) => Promise<LoadedResource<TEntity> | null>
  /** Current usage of a limited resource, checked against the plan. */
  quota?: (
    args: RuleArgs<TInput, TEntity>,
  ) => QuotaUsage | null | Promise<QuotaUsage | null>
  /** The domain law. Throws a `BusinessRuleError` when it does not hold. */
  rule?: (args: RuleArgs<TInput, TEntity>) => void | Promise<void>
  /** The change. Runs inside the transaction. */
  execute: (args: ExecuteArgs<TInput, TEntity>) => Promise<TResult>
  /** Exactly one event per success. Not optional. */
  audit: (args: ResultArgs<TInput, TEntity, TResult>) => AuditDescriptor
  /** Reactions. Published after the commit; failures never roll anything back. */
  events?: (
    args: ResultArgs<TInput, TEntity, TResult>,
  ) => readonly DomainEventDraft[]
}

// ── The outcome ───────────────────────────────────────────────────────────

export interface OperationOutcome<TResult> {
  ok: true
  data: TResult
  correlationId: string
  /** True when this is the stored answer to a request that already ran. */
  replayed: boolean
  /** The event recorded. `null` on a replay — the original run recorded it. */
  auditEvent: AuditRecord | null
  events: readonly DomainEvent[]
  /** Set when a handler threw. The operation still succeeded. */
  eventError: unknown
  /** The organization is over a non-blocking allowance. Warn, do not stop. */
  quotaWarning: QuotaState | null
}

export interface Operation<TInput, TEntity, TResult> {
  readonly definition: OperationDefinition<TInput, TEntity, TResult>
  run(args: {
    request?: OperationRequest
    context: OperationContext
    services: OperationServices
  }): Promise<OperationOutcome<TResult>>
}

// ── Wiring failures ───────────────────────────────────────────────────────

/**
 * The operation is misconfigured, not misused.
 *
 * A 500 rather than a 4xx, and loud: an idempotency key arriving at an
 * operation with no store would otherwise be honoured by ignoring it, which is
 * the exact failure the key exists to prevent, dressed as success.
 */
class OperationWiringError extends AppError {
  constructor(operation: string, problem: string) {
    super({
      code: 'operation_misconfigured',
      status: 500,
      message: `Operation '${operation}' is misconfigured: ${problem}`,
      userMessage:
        'אירעה תקלה במערכת ולכן הפעולה לא בוצעה. נסה שוב בעוד מספר רגעים.',
      retryable: false,
      dataOutcome: 'not_saved',
    })
  }
}

// ── The builder ───────────────────────────────────────────────────────────

export function defineOperation<TInput, TEntity = null, TResult = void>(
  definition: OperationDefinition<TInput, TEntity, TResult>,
): Operation<TInput, TEntity, TResult> {
  const requiresReason =
    definition.requiresReason ?? SENSITIVE_ACTIONS.has(definition.permission)

  return {
    definition,

    async run({ request = {}, context, services }) {
      try {
        return await runOperation(
          definition,
          requiresReason,
          request,
          context,
          services,
        )
      } catch (error) {
        throw withCorrelation(error, context.correlationId)
      }
    },
  }
}

async function runOperation<TInput, TEntity, TResult>(
  definition: OperationDefinition<TInput, TEntity, TResult>,
  requiresReason: boolean,
  request: OperationRequest,
  context: OperationContext,
  services: OperationServices,
): Promise<OperationOutcome<TResult>> {
  const { actor, correlationId } = context
  const now = context.now ?? new Date()

  // 1 ── Authorize, before anything reads anything.
  //      Membership, grant and plan. Tenant and scope come after the load,
  //      because they are questions about a resource that does not exist yet.
  assertCan(actor, definition.permission)

  // 2 ── Validate. Input, the stated reason and the expected version are
  //      reported together: a form must not reveal its problems one at a time.
  const issues: FieldIssue[] = []

  const parsed = definition.input.validate(request.input ?? {}, '')
  if (!parsed.ok) issues.push(...parsed.issues)

  if (requiresReason && isBlank(context.reason)) {
    issues.push({
      field: 'reason',
      code: 'required',
      message: 'הפעולה הזו דורשת נימוק. הסבר בקצרה מדוע היא מבוצעת.',
      label: 'סיבה',
    })
  }

  if (definition.requiresVersion && request.expectedVersion === undefined) {
    issues.push({
      field: 'version',
      code: 'required',
      message: 'לא ידוע איזו גרסה של הרשומה נערכה. רענן את הדף ונסה שוב.',
    })
  }

  if (issues.length > 0) throw new ValidationError(issues)
  const input = (parsed as { ok: true; value: TInput }).value

  const loadArgs: LoadArgs<TInput> = {
    input,
    request,
    context,
    correlationId,
    now,
  }

  // 3 ── Reserve the idempotency key, before the work and not after it.
  //      Two identical submissions eight milliseconds apart both reach this
  //      line; exactly one leaves it holding the key.
  const idempotency = beginIdempotency(definition, request, context, services)
  const reservation = await idempotency?.begin(input)

  if (reservation?.status === 'replayed') {
    return {
      ok: true,
      data: reservation.record.result as TResult,
      correlationId,
      replayed: true,
      auditEvent: null,
      events: [],
      eventError: null,
      quotaWarning: null,
    }
  }
  if (reservation?.status === 'in_flight') {
    throw new IdempotencyConflictError({
      kind: 'in_flight',
      operation: definition.name,
    })
  }
  if (reservation?.status === 'mismatch') {
    throw new IdempotencyConflictError({
      kind: 'payload_mismatch',
      operation: definition.name,
    })
  }

  try {
    // 4 ── Load the target.
    const loaded = definition.loadResource
      ? await definition.loadResource(loadArgs)
      : null

    if (definition.loadResource && !loaded) {
      throw new NotFoundError(definition.resourceType, request.resourceId)
    }

    // 5 ── Authorize again, now that there is a resource: tenant, then scope.
    if (loaded) assertCan(actor, definition.permission, loaded.resource)

    const ruleArgs: RuleArgs<TInput, TEntity> = {
      ...loadArgs,
      entity: (loaded ? loaded.entity : null) as TEntity,
      resource: loaded?.resource ?? null,
      version: loaded?.version ?? null,
    }

    // 6 ── Optimistic locking. Before the rule, because a rule evaluated
    //      against a record someone else has already changed proves nothing.
    if (request.expectedVersion !== undefined) {
      const actual = loaded?.version ?? null
      if (actual !== request.expectedVersion) {
        throw new ConflictError({
          resourceType: definition.resourceType,
          resourceId: request.resourceId,
          expectedVersion: request.expectedVersion,
          actualVersion: actual,
        })
      }
    }

    // 7 ── Quota. Blocks only where refusing cannot stop the day's work.
    const quotaWarning = await evaluateQuota(definition, ruleArgs, context)

    // 8 ── The domain law.
    if (definition.rule) await definition.rule(ruleArgs)

    // 9 ── Transaction: the change, its audit event and the idempotency
    //      completion commit together or not at all.
    const runner = services.transactions ?? noTransactionRunner
    const committed = await runner.run(async (tx) => {
      const result = await definition.execute({ ...ruleArgs, tx })

      const resultArgs: ResultArgs<TInput, TEntity, TResult> = {
        ...ruleArgs,
        result,
      }
      const descriptor = definition.audit(resultArgs)

      const auditEvent = await recordAuditEvent(
        {
          actor: context.auditActor,
          context: {
            organizationId: actor.organizationId,
            propertyId:
              descriptor.propertyId ?? loaded?.resource.propertyId ?? null,
            requestId: correlationId,
            ip: context.ip ?? null,
            userAgent: context.userAgent ?? null,
          },
          action: descriptor.action ?? definition.permission,
          resourceType: definition.resourceType,
          resourceId: descriptor.resourceId ?? request.resourceId ?? null,
          before: descriptor.before ?? null,
          after: descriptor.after ?? null,
          reason: descriptor.reason ?? context.reason ?? null,
          summary: descriptor.summary,
        },
        services.audit,
        { occurredAt: now, tx },
      )

      if (idempotency) await idempotency.complete(result, tx)

      return { result, auditEvent, resultArgs }
    })

    // 10 ── Domain events. Outside the transaction, deliberately: the booking
    //       is already real, and nothing an integration does may undo it.
    const drafts = definition.events
      ? definition.events(committed.resultArgs)
      : []

    const events: DomainEvent[] = drafts.map((draft) => ({
      name: draft.name,
      organizationId: actor.organizationId,
      propertyId: draft.propertyId ?? loaded?.resource.propertyId ?? null,
      correlationId,
      occurredAt: now,
      payload: draft.payload,
    }))

    let eventError: unknown = null
    if (events.length > 0) {
      const bus = services.events ?? nullEventBus
      try {
        await bus.publish(events)
      } catch (error) {
        // Reported, never rethrown. A confirmation email that fails must not
        // un-create the booking it was confirming.
        eventError = error
        services.onEventError?.(error, events)
      }
    }

    return {
      ok: true,
      data: committed.result,
      correlationId,
      replayed: false,
      auditEvent: committed.auditEvent,
      events,
      eventError,
      quotaWarning,
    }
  } catch (error) {
    // Release the key so the retry the user is told to make can proceed.
    // Without this a transient failure poisons the key permanently.
    if (idempotency) await idempotency.abandon()
    throw error
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim().length === 0
}

/**
 * Bind the idempotency store to this request, or return `null` when the
 * request carries no key.
 *
 * The scope includes the organization and the operation, never the key alone:
 * two customers choosing the same client-generated key must not be able to
 * read each other's results, and one operation's key must not replay another's.
 */
function beginIdempotency<TInput, TEntity, TResult>(
  definition: OperationDefinition<TInput, TEntity, TResult>,
  request: OperationRequest,
  context: OperationContext,
  services: OperationServices,
): {
  begin: (input: TInput) => ReturnType<IdempotencyStore['begin']>
  complete: (result: unknown, tx: TransactionHandle) => Promise<void>
  abandon: () => Promise<void>
} | null {
  const key = request.idempotencyKey
  if (isBlank(key)) return null

  const store = services.idempotency
  if (!store) {
    throw new OperationWiringError(
      definition.name,
      'the request carries an idempotency key but no idempotency store is wired',
    )
  }

  const scope: IdempotencyScope = {
    organizationId: context.actor.organizationId,
    operation: definition.name,
  }
  const idempotencyKey = key as string

  return {
    begin: (input) =>
      store.begin(
        scope,
        idempotencyKey,
        fingerprint({
          input,
          resourceId: request.resourceId ?? null,
          expectedVersion: request.expectedVersion ?? null,
        }),
      ),
    complete: (result, tx) => store.complete(scope, idempotencyKey, result, tx),
    abandon: () => store.abandon(scope, idempotencyKey),
  }
}

/**
 * Check the declared quota.
 *
 * Returns a warning for an overage the product allows — growing past the unit
 * limit must never stop a check-in — and throws only for the keys
 * `QUOTA_BLOCKS_ACTION` marks as blocking, which are the ones that can wait.
 */
async function evaluateQuota<TInput, TEntity, TResult>(
  definition: OperationDefinition<TInput, TEntity, TResult>,
  ruleArgs: RuleArgs<TInput, TEntity>,
  context: OperationContext,
): Promise<QuotaState | null> {
  if (!definition.quota) return null

  if (!context.limits) {
    throw new OperationWiringError(
      definition.name,
      'declares a quota but the context carries no plan limits',
    )
  }

  const usage = await definition.quota(ruleArgs)
  if (!usage) return null

  const state = checkQuota(usage.key, usage.current, context.limits)
  if (isBlockedByQuota(state)) {
    throw new QuotaExceededError({ quota: state })
  }

  // Handed back so the interface can warn. Not an error: the action proceeds.
  return state.inOverage || state.approaching ? state : null
}
