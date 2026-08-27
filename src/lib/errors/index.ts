/**
 * The error taxonomy, in one import.
 *
 * `AuthorizationError` is re-exported rather than redefined. It belongs to the
 * authorization engine, which is the only thing entitled to decide what a
 * refusal means; a second definition here would be a second answer to the same
 * question, and the two would disagree within a month.
 */

export {
  AppError,
  BusinessRuleError,
  ConflictError,
  DATA_OUTCOME_MESSAGE,
  ExternalServiceError,
  IdempotencyConflictError,
  InternalError,
  NotFoundError,
  QuotaExceededError,
  RETRY_MESSAGE,
  ValidationError,
  isAppError,
  toAppError,
  withCorrelation,
  type AppErrorInit,
  type DataOutcome,
  type FieldIssue,
  type IdempotencyConflictKind,
} from './app-error'

export {
  sanitizeDetails,
  toLogEntry,
  toSafeResponse,
  type ErrorLogEntry,
  type SafeErrorBody,
  type SafeErrorResponse,
} from './safe-response'

export { AuthorizationError } from '../authz/can'
