/**
 * The one way a failure leaves the server.
 *
 * Everything thrown anywhere in the product passes through here before it
 * becomes a response. The rule it enforces is absolute: a stack trace, a SQL
 * string, a provider's raw error, a table name, a primary key — none of them
 * cross this line. What does cross is a stable code, a Hebrew sentence, an
 * honest statement about whether the data was saved, whether retrying helps,
 * and the correlation id.
 *
 * The correlation id is the part that makes the rest survivable. A user
 * reading "אירעה תקלה במערכת" can quote eight characters to support, and
 * support can find the exact request in the log with the stack we refused to
 * show them.
 */

import { AuthorizationError, type DenialReason } from '../authz/can'
import {
  DATA_OUTCOME_MESSAGE,
  RETRY_MESSAGE,
  ValidationError,
  isAppError,
  toAppError,
  type DataOutcome,
  type FieldIssue,
} from './app-error'

export interface SafeErrorBody {
  /** Stable. The interface switches on this, never on the message. */
  code: string
  /** Hebrew, for the user. */
  message: string
  /** Hebrew: was my data saved? */
  dataMessage: string
  /** Hebrew: is it worth trying again? */
  retryMessage: string
  dataOutcome: DataOutcome
  retryable: boolean
  correlationId: string
  /** Present only for validation failures. Every offending field, not the first. */
  fields?: readonly FieldIssue[]
  /** Sanitised, primitive-only, product-level detail. Never internal state. */
  details?: Record<string, unknown>
}

export interface SafeErrorResponse {
  ok: false
  status: number
  error: SafeErrorBody
}

// ── Authorization ─────────────────────────────────────────────────────────

/**
 * How a refusal is presented.
 *
 * Note `cross_organization`: it is reported as a plain "not found", with a 404
 * and the same wording as a missing record. Answering "you are not allowed to
 * see this booking" to someone probing another organization's ids confirms the
 * booking exists, which is itself the leak. The event is still recorded
 * server-side under its real reason.
 */
const AUTHORIZATION_PRESENTATION: Record<
  DenialReason,
  { code: string; status: number; message: string; retryable: boolean }
> = {
  membership_not_active: {
    code: 'membership_not_active',
    status: 403,
    message: 'החשבון שלך בארגון זה אינו פעיל. פנה למנהל הארגון.',
    retryable: false,
  },
  cross_organization: {
    code: 'not_found',
    status: 404,
    message: 'הרשומה המבוקשת לא נמצאה.',
    retryable: false,
  },
  missing_permission: {
    code: 'missing_permission',
    status: 403,
    message:
      'אין לך הרשאה לבצע פעולה זו. מנהל הארגון יכול להוסיף אותה לתפקיד שלך.',
    retryable: false,
  },
  plan_does_not_include: {
    code: 'plan_does_not_include',
    status: 402,
    message: 'התכונה הזו אינה כלולה בחבילה של הארגון.',
    retryable: false,
  },
  out_of_scope: {
    code: 'out_of_scope',
    status: 403,
    message: 'הפעולה הזו נמצאת מחוץ לנכסים שהוקצו לך.',
    retryable: false,
  },
}

/**
 * Detail attached to a refusal.
 *
 * The required grant and entitlement are named on purpose. Both are product
 * surface — a customer edits roles and reads the package comparison — and
 * without them the interface can only say "no" where it could say "ask your
 * manager for booking.override_price" or offer the upgrade that unlocks it.
 * Neither reveals anything about the resource, which is the thing that must
 * stay hidden.
 */
function authorizationDetails(
  error: AuthorizationError,
): Record<string, unknown> | undefined {
  const { decision } = error
  switch (decision.reason) {
    case 'missing_permission':
      return { requiredGrant: error.grant }
    case 'plan_does_not_include':
      return {
        requiredGrant: error.grant,
        requiredEntitlement: decision.entitlement,
        upgradeAvailable: true,
      }
    default:
      // Scope, tenant and membership refusals say nothing about the resource.
      return undefined
  }
}

// ── Detail sanitising ─────────────────────────────────────────────────────

/**
 * Keys that never travel, whatever an error attached to them.
 *
 * Defence in depth. `publicDetails` is already meant to be safe; this is what
 * catches the day someone puts the caught exception in it "just for debugging"
 * and it reaches production.
 */
const FORBIDDEN_DETAIL_KEYS = new Set([
  'stack',
  'sql',
  'query',
  'statement',
  'trace',
  'cause',
  'error',
  'internalid',
  'password',
  'password_hash',
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'api_key',
  'card_token',
  'cvv',
  'connectionstring',
  'env',
])

const MAX_DETAIL_STRING = 200

function isSafeScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

/**
 * Reduce arbitrary detail to primitives with known keys.
 *
 * Anything nested, functional or object-shaped is dropped rather than
 * traversed: an object is exactly where a stack, a request or a database row
 * hides, and there is no product need for one here.
 */
export function sanitizeDetails(
  details: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  if (!details) return undefined

  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(details)) {
    if (FORBIDDEN_DETAIL_KEYS.has(key.toLowerCase())) continue

    if (typeof value === 'string') {
      output[key] =
        value.length > MAX_DETAIL_STRING
          ? `${value.slice(0, MAX_DETAIL_STRING)}…`
          : value
      continue
    }
    if (isSafeScalar(value)) {
      output[key] = value
      continue
    }
    if (Array.isArray(value) && value.every(isSafeScalar)) {
      output[key] = value
      continue
    }
    // Dropped: objects, functions, dates, errors, undefined.
  }

  return Object.keys(output).length > 0 ? output : undefined
}

// ── The function ──────────────────────────────────────────────────────────

/**
 * Turn anything thrown into a response a user may see.
 *
 * `correlationId` is a required argument rather than something read off the
 * error, because the one case that matters most — an unexpected crash carrying
 * no correlation id of its own — is exactly the case where losing it would
 * make the failure untraceable.
 */
export function toSafeResponse(
  thrown: unknown,
  correlationId: string,
): SafeErrorResponse {
  if (thrown instanceof AuthorizationError) {
    const presentation = AUTHORIZATION_PRESENTATION[thrown.decision.reason]
    return {
      ok: false,
      status: presentation.status,
      error: {
        code: presentation.code,
        message: presentation.message,
        dataOutcome: 'not_saved',
        dataMessage: DATA_OUTCOME_MESSAGE.not_saved,
        retryable: presentation.retryable,
        retryMessage: RETRY_MESSAGE.false,
        correlationId,
        details: sanitizeDetails(authorizationDetails(thrown)),
      },
    }
  }

  const error = toAppError(thrown)
  const body: SafeErrorBody = {
    code: error.code,
    message: error.userMessage,
    dataOutcome: error.dataOutcome,
    dataMessage: DATA_OUTCOME_MESSAGE[error.dataOutcome],
    retryable: error.retryable,
    retryMessage: RETRY_MESSAGE[error.retryable ? 'true' : 'false'],
    correlationId,
  }

  if (error instanceof ValidationError && error.issues.length > 0) {
    body.fields = error.issues
  }

  const details = sanitizeDetails(error.publicDetails)
  if (details) body.details = details

  return { ok: false, status: error.status, error: body }
}

/**
 * What goes to the log when the user gets the safe response.
 *
 * Kept beside `toSafeResponse` so the pair is obvious: everything withheld
 * above is retained here, under the same correlation id.
 */
export interface ErrorLogEntry {
  correlationId: string
  code: string
  status: number
  /** The technical message. Never sent to a client. */
  message: string
  name: string
  stack?: string
  cause?: string
}

export function toLogEntry(
  thrown: unknown,
  correlationId: string,
): ErrorLogEntry {
  const error =
    thrown instanceof AuthorizationError ? thrown : toAppError(thrown)
  const status = isAppError(error) ? error.status : 403
  const code = isAppError(error) ? error.code : error.decision.reason

  const cause = (error as { cause?: unknown }).cause
  return {
    correlationId,
    code,
    status,
    message: error.message,
    name: error.name,
    stack: error.stack,
    cause:
      cause instanceof Error
        ? `${cause.name}: ${cause.message}`
        : cause === undefined
          ? undefined
          : String(cause),
  }
}
