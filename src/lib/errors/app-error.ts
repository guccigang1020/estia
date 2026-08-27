/**
 * The error taxonomy.
 *
 * A failure has to answer three questions before it is useful to the person
 * who hit it:
 *
 *   1. What failed?              → `userMessage`, in Hebrew, written for a
 *                                  hotelier and not for a developer.
 *   2. Was my data saved?        → `dataOutcome`. "Unknown" is an honest
 *                                  answer and is treated as one; guessing
 *                                  "saved" is how a customer gets charged
 *                                  twice.
 *   3. Is it safe to try again?  → `retryable`.
 *
 * Every error also carries a stable machine `code`. The code is the contract:
 * the interface switches on it, the logs group by it, and it does not change
 * when someone improves the wording of the sentence beside it.
 *
 * The technical `message` — the one inherited from `Error` — is for the log.
 * It may name a table, an id or a provider. It never reaches a user; see
 * `safe-response.ts`, which is the only sanctioned way out of the server.
 */

import type { QuotaState } from '../plans/quota'

/**
 * Whether the caller's work survived the failure.
 *
 * `unknown` is not a cop-out. A payment processor that times out has either
 * charged the card or not, and the server genuinely cannot tell. Saying so —
 * and telling the user to check before retrying — is the correct behaviour;
 * claiming `not_saved` is a lie that produces a double charge.
 */
export type DataOutcome = 'not_saved' | 'saved' | 'unknown'

/** The Hebrew sentence for each outcome, so every surface says the same thing. */
export const DATA_OUTCOME_MESSAGE: Record<DataOutcome, string> = {
  not_saved: 'השינוי שלך לא נשמר.',
  saved: 'השינוי נשמר, אך הפעולה לא הושלמה במלואה.',
  unknown: 'לא ידוע אם השינוי נשמר. בדוק את המצב לפני ניסיון חוזר.',
}

/**
 * The Hebrew sentence about retrying.
 *
 * `retryable` means "sending this same request again is safe and might
 * succeed". A validation failure is safe to resend and will fail identically,
 * so it is not retryable — resending it is pointless, and telling the user to
 * try again instead of to fix the field is worse than useless.
 */
export const RETRY_MESSAGE: Record<'true' | 'false', string> = {
  true: 'אפשר לנסות שוב.',
  false: 'ניסיון חוזר באותם נתונים לא יעזור.',
}

export interface AppErrorInit {
  code: string
  status: number
  /** Technical. Goes to the log, never to a user. */
  message: string
  /** Hebrew. Goes to the user. */
  userMessage: string
  retryable?: boolean
  dataOutcome?: DataOutcome
  /**
   * Structured detail that is safe to hand to a client. Sanitised again on the
   * way out — see `sanitizeDetails` — so a mistake here is not a leak.
   */
  publicDetails?: Record<string, unknown>
  correlationId?: string | null
  cause?: unknown
}

/**
 * The base every deliberate failure in ESTIA extends.
 *
 * Anything thrown that is *not* an `AppError` is by definition a bug rather
 * than a handled outcome, and is reported to the user as a generic internal
 * failure with nothing of its content exposed.
 */
export class AppError extends Error {
  readonly code: string
  readonly status: number
  readonly retryable: boolean
  readonly dataOutcome: DataOutcome
  readonly userMessage: string
  readonly publicDetails: Readonly<Record<string, unknown>>
  /** Set as the error travels out, so one failure can be traced end to end. */
  correlationId: string | null

  constructor(init: AppErrorInit) {
    super(
      init.message,
      init.cause !== undefined ? { cause: init.cause } : undefined,
    )
    this.name = new.target.name
    this.code = init.code
    this.status = init.status
    this.userMessage = init.userMessage
    this.retryable = init.retryable ?? false
    this.dataOutcome = init.dataOutcome ?? 'not_saved'
    this.publicDetails = init.publicDetails ?? {}
    this.correlationId = init.correlationId ?? null
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}

// ── Validation ────────────────────────────────────────────────────────────

/**
 * One thing wrong with one field.
 *
 * `field` is a dotted path (`guest.email`, `nights[0].date`) so the interface
 * can put the message next to the input that caused it. `code` is stable;
 * `message` is Hebrew and may be reworded freely.
 */
export interface FieldIssue {
  field: string
  code: string
  message: string
  /** The Hebrew name of the field, when the schema declared one. */
  label?: string
}

/**
 * Input the server refused.
 *
 * Carries *every* offending field, never only the first. A form that reveals
 * its problems one at a time is a form people abandon.
 */
export class ValidationError extends AppError {
  readonly issues: readonly FieldIssue[]

  constructor(
    issues: readonly FieldIssue[],
    options: { message?: string; userMessage?: string; cause?: unknown } = {},
  ) {
    super({
      code: 'validation_failed',
      status: 422,
      message:
        options.message ??
        `Validation failed for ${issues.length} field(s): ${issues
          .map((i) => i.field)
          .join(', ')}`,
      userMessage:
        options.userMessage ??
        (issues.length === 1
          ? 'שדה אחד אינו תקין. תקן אותו ונסה שוב.'
          : `${issues.length} שדות אינם תקינים. תקן אותם ונסה שוב.`),
      retryable: false,
      dataOutcome: 'not_saved',
      cause: options.cause,
    })
    this.issues = issues
  }
}

// ── Not found ─────────────────────────────────────────────────────────────

/**
 * The record is not there — or the caller is not allowed to know that it is.
 *
 * Deliberately indistinguishable from a cross-tenant refusal on the way out,
 * so probing another organization's ids cannot confirm that they exist.
 */
export class NotFoundError extends AppError {
  readonly resourceType: string
  readonly resourceId: string | null

  constructor(
    resourceType: string,
    resourceId: string | null = null,
    options: { userMessage?: string; cause?: unknown } = {},
  ) {
    super({
      code: 'not_found',
      status: 404,
      // The id belongs in the log, where support can use it. It is not in
      // publicDetails and does not reach the response.
      message: `${resourceType} not found: ${resourceId ?? '(no id)'}`,
      userMessage: options.userMessage ?? 'הרשומה המבוקשת לא נמצאה.',
      retryable: false,
      dataOutcome: 'not_saved',
      publicDetails: { resourceType },
      cause: options.cause,
    })
    this.resourceType = resourceType
    this.resourceId = resourceId
  }
}

// ── Optimistic locking ────────────────────────────────────────────────────

/**
 * Someone changed the record between the read and the write.
 *
 * Not retryable on purpose. An automatic retry here is precisely the lost
 * update the `version` column exists to prevent: it would resend the stale
 * form and erase the other person's change. The user has to see the current
 * values first.
 */
export class ConflictError extends AppError {
  readonly resourceType: string
  readonly expectedVersion: number | null
  readonly actualVersion: number | null

  constructor(init: {
    resourceType: string
    resourceId?: string | null
    expectedVersion?: number | null
    actualVersion?: number | null
    userMessage?: string
    cause?: unknown
  }) {
    super({
      code: 'version_conflict',
      status: 409,
      message:
        `Optimistic lock failure on ${init.resourceType} ` +
        `${init.resourceId ?? '(no id)'}: expected version ` +
        `${init.expectedVersion ?? 'none'}, found ${init.actualVersion ?? 'none'}`,
      userMessage:
        init.userMessage ??
        'הרשומה שונתה על ידי משתמש אחר מאז שפתחת אותה. רענן את הנתונים ובצע את השינוי מחדש.',
      retryable: false,
      dataOutcome: 'not_saved',
      publicDetails: {
        resourceType: init.resourceType,
        expectedVersion: init.expectedVersion ?? null,
        actualVersion: init.actualVersion ?? null,
      },
      cause: init.cause,
    })
    this.resourceType = init.resourceType
    this.expectedVersion = init.expectedVersion ?? null
    this.actualVersion = init.actualVersion ?? null
  }
}

// ── Quota ─────────────────────────────────────────────────────────────────

/**
 * The organization is over an allowance on an action that is allowed to wait.
 *
 * Only ever thrown for the keys `QUOTA_BLOCKS_ACTION` marks as blocking.
 * Growing past a limit must never stop a business serving a guest today, so
 * the overage that matters is the one on inviting a colleague, not the one on
 * checking one in. See `plans/quota.ts`.
 */
export class QuotaExceededError extends AppError {
  readonly quota: QuotaState
  readonly upgradeSuggestion: string

  constructor(init: {
    quota: QuotaState
    upgradeSuggestion?: string
    userMessage?: string
    cause?: unknown
  }) {
    const { quota } = init
    super({
      code: 'quota_exceeded',
      status: 402,
      message:
        `Quota '${quota.key}' exceeded: ${quota.current} of ` +
        `${quota.limit ?? 'unlimited'}`,
      userMessage:
        init.userMessage ??
        `${QUOTA_LABEL[quota.key]}: הגעת למכסת החבילה (${quota.current} מתוך ${
          quota.limit ?? '∞'
        }). שדרוג החבילה יפתח את הפעולה.`,
      retryable: false,
      dataOutcome: 'not_saved',
      publicDetails: {
        quotaKey: quota.key,
        current: quota.current,
        limit: quota.limit,
        upgradeAvailable: true,
      },
      cause: init.cause,
    })
    this.quota = quota
    this.upgradeSuggestion =
      init.upgradeSuggestion ?? 'שדרג את החבילה כדי להמשיך.'
  }
}

/** Hebrew names for the quota keys, so the message reads as a sentence. */
const QUOTA_LABEL: Record<QuotaState['key'], string> = {
  properties: 'נכסים',
  units: 'יחידות',
  members: 'משתמשים',
  storageGb: 'שטח אחסון',
}

// ── External services ─────────────────────────────────────────────────────

/**
 * A processor, channel or provider failed.
 *
 * The provider's own message is kept in the technical message and never
 * forwarded: it is written in English for their support team, frequently names
 * internal endpoints, and occasionally echoes back the request — including
 * whatever was in it.
 */
export class ExternalServiceError extends AppError {
  readonly service: string

  constructor(init: {
    service: string
    message?: string
    userMessage?: string
    retryable?: boolean
    dataOutcome?: DataOutcome
    cause?: unknown
  }) {
    super({
      code: 'external_service_failed',
      status: 502,
      message: init.message ?? `External service '${init.service}' failed`,
      userMessage:
        init.userMessage ??
        'שירות חיצוני אינו זמין כרגע. נסה שוב בעוד מספר רגעים.',
      retryable: init.retryable ?? true,
      // The safe default when a network call fails mid-flight: nobody knows.
      dataOutcome: init.dataOutcome ?? 'unknown',
      publicDetails: { service: init.service },
      cause: init.cause,
    })
    this.service = init.service
  }
}

// ── Idempotency ───────────────────────────────────────────────────────────

/**
 * `payload_mismatch` — the key was already used for a *different* request.
 *   Replaying it would silently return someone else's result. Refused.
 *
 * `in_flight` — the first attempt has not finished. The client is told to
 *   wait rather than to act, because the answer is still being decided.
 */
export type IdempotencyConflictKind = 'payload_mismatch' | 'in_flight'

export class IdempotencyConflictError extends AppError {
  readonly kind: IdempotencyConflictKind
  readonly operation: string

  constructor(init: {
    kind: IdempotencyConflictKind
    operation: string
    userMessage?: string
    cause?: unknown
  }) {
    const inFlight = init.kind === 'in_flight'
    super({
      code: 'idempotency_conflict',
      status: 409,
      message: inFlight
        ? `Idempotency key for '${init.operation}' is still in flight`
        : `Idempotency key for '${init.operation}' was used with different input`,
      userMessage:
        init.userMessage ??
        (inFlight
          ? 'הבקשה הקודמת עדיין מעובדת. המתן רגע ובדוק את התוצאה לפני ניסיון נוסף.'
          : 'מפתח הבקשה כבר שימש לפעולה אחרת. רענן ונסה שוב עם בקשה חדשה.'),
      retryable: inFlight,
      dataOutcome: inFlight ? 'unknown' : 'not_saved',
      publicDetails: { kind: init.kind },
      cause: init.cause,
    })
    this.kind = init.kind
    this.operation = init.operation
  }
}

// ── Business rules ────────────────────────────────────────────────────────

/**
 * The input was well formed and the caller was allowed, but the domain says
 * no: the dates overlap an existing booking, the invoice is already issued,
 * the transition is not legal from this state.
 *
 * The `code` is supplied by the operation, because the interface needs to
 * distinguish "already checked in" from "unit unavailable" in order to offer
 * anything useful next.
 */
export class BusinessRuleError extends AppError {
  constructor(init: {
    code: string
    userMessage: string
    message?: string
    status?: number
    publicDetails?: Record<string, unknown>
    cause?: unknown
  }) {
    super({
      code: init.code,
      status: init.status ?? 422,
      message: init.message ?? `Business rule violated: ${init.code}`,
      userMessage: init.userMessage,
      retryable: false,
      dataOutcome: 'not_saved',
      publicDetails: init.publicDetails,
      cause: init.cause,
    })
  }
}

// ── The catch-all ─────────────────────────────────────────────────────────

/**
 * Wraps anything thrown that was not an `AppError`.
 *
 * The original value is kept as `cause` for the log and contributes nothing to
 * the response. A `TypeError` reading a property of undefined must not become
 * a Hebrew sentence about that property.
 */
export class InternalError extends AppError {
  constructor(init: { message?: string; cause?: unknown } = {}) {
    super({
      code: 'internal_error',
      status: 500,
      message: init.message ?? 'Unhandled internal failure',
      userMessage:
        'אירעה תקלה במערכת. הצוות שלנו מקבל התראה. נסה שוב בעוד מספר רגעים.',
      retryable: true,
      // A crash can happen on either side of the write. Nobody knows.
      dataOutcome: 'unknown',
      cause: init.cause,
    })
  }
}

/**
 * Normalise any thrown value into an `AppError`.
 *
 * Deliberately not exhaustive about what it recognises: an `AuthorizationError`
 * is left alone here and handled by `toSafeResponse`, because it belongs to the
 * authorization contract and mapping it twice would let the two drift.
 */
export function toAppError(thrown: unknown): AppError {
  if (isAppError(thrown)) return thrown
  return new InternalError({
    message:
      thrown instanceof Error
        ? `Unhandled ${thrown.name}: ${thrown.message}`
        : `Unhandled non-error thrown: ${typeof thrown}`,
    cause: thrown,
  })
}

/**
 * Stamp the correlation id onto an error on its way out.
 *
 * Mutating rather than re-wrapping keeps the original stack, which is the only
 * thing that makes the log entry worth reading.
 */
export function withCorrelation<E>(error: E, correlationId: string): E {
  if (isAppError(error) && error.correlationId === null) {
    error.correlationId = correlationId
  }
  return error
}
