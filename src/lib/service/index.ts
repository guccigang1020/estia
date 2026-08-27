/**
 * The service layer, in one import.
 *
 * A business operation is declared with `defineOperation` and nothing else.
 * If a code path writes to a business table without going through here, it has
 * skipped authorization, validation, locking, idempotency or the audit trail —
 * and which one it skipped will not be obvious until it matters.
 */

export {
  defineOperation,
  type AuditDescriptor,
  type ExecuteArgs,
  type LoadArgs,
  type LoadedResource,
  type Operation,
  type OperationContext,
  type OperationDefinition,
  type OperationOutcome,
  type OperationRequest,
  type OperationServices,
  type QuotaUsage,
  type ResultArgs,
  type RuleArgs,
} from './operation'

export {
  InMemoryEventBus,
  nullEventBus,
  type DomainEvent,
  type DomainEventDraft,
  type DomainEventName,
  type EventBus,
  type EventHandler,
} from './events'

export {
  InMemoryIdempotencyStore,
  fingerprint,
  stableStringify,
  type IdempotencyBegin,
  type IdempotencyRecord,
  type IdempotencyScope,
  type IdempotencyStore,
} from './idempotency'

export {
  RecordingTransactionRunner,
  noTransactionRunner,
  type TransactionHandle,
  type TransactionRunner,
} from './transaction'

export {
  s,
  type Infer,
  type InferShape,
  type OptionalSchema,
  type Schema,
  type SchemaResult,
} from './schema'
