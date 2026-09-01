/**
 * EXECUTION CONTEXT — SERVER ONLY. Reading and writing the journey as a guest.
 *
 * The companion to `src/lib/guest-portal/session.ts`. That file answers "whose
 * booking is this"; this one answers "and what happens next", and carries the
 * five writes a guest is allowed to make.
 *
 * ── Three rules inherited from `guest-portal`, restated because they matter ─
 *
 * **The token is never logged.** Not in an error, not in a correlation
 * payload, not while debugging. It is a bearer credential for somebody's
 * booking and a log line outlives the stay. Every failure below goes through a
 * refusal that never echoes its input.
 *
 * **The projection is never widened from TypeScript.** If a screen needs a
 * field `guest_portal_journey` does not return, the field is added to the SQL
 * after somebody decides it is safe to disclose. There is no second query here
 * and there must not be one: the access code is absent from the payload when
 * the policy says so, and a `select` written next to this file to "just fetch
 * the property" would hand it over regardless.
 *
 * **No function here takes a booking id.** Every RPC below is called with the
 * token and nothing else that identifies a booking. That is what makes the
 * IDOR test in `idor.test.ts` a statement about the whole module rather than
 * about one call site: there is no argument to tamper with.
 */

import { AppError, BusinessRuleError } from '../errors'
import type { Db } from '../persistence'

import {
  isGuestDetailField,
  type GuestArrival,
  type GuestCheckout,
  type GuestConfirmation,
  type GuestContract,
  type GuestDetailField,
  type GuestDetails,
  type GuestJourney,
  type GuestJourneySettings,
  type GuestJourneyTerms,
  type GuestRequest,
  type GuestRequestCategory,
  type GuestRequestState,
  type GuestStay,
  GUEST_ARRIVAL_RELEASES,
  GUEST_CONTRACT_MODES,
  GUEST_REQUEST_CATEGORIES,
  GUEST_REQUEST_STATES,
  RECONFIRMATION_TRIGGERS,
} from './types'

/* ------------------------------------------------------------ refusals -- */

/**
 * What the database refuses, in words a guest can act on.
 *
 * Every message says what happened and what to do about it. None of them says
 * "error", none carries a code the guest could not use, and none blames them —
 * a person holding a link whose booking was changed under them has done
 * nothing wrong.
 */
const REFUSALS: Readonly<
  Record<string, { userMessage: string; status: number }>
> = {
  // ── The link itself. Same four as 0033, because these functions repeat
  //    0033's checks and can raise any of them.
  guest_link_not_found: {
    userMessage:
      'לא מצאנו את ההזמנה. ייתכן שהקישור הועתק חלקית — בקש מבית האירוח לשלוח אותו שוב.',
    status: 404,
  },
  guest_link_revoked: {
    userMessage:
      'הקישור הזה בוטל. פנה לבית האירוח כדי לקבל קישור חדש להזמנה שלך.',
    status: 410,
  },
  guest_link_expired: {
    userMessage: 'תוקף הקישור פג. פנה לבית האירוח כדי לקבל קישור חדש.',
    status: 410,
  },
  guest_link_unavailable: {
    userMessage: 'ההזמנה אינה זמינה כרגע. נסה שוב בעוד כמה דקות.',
    status: 503,
  },

  // ── Confirming.
  guest_confirmation_stale: {
    userMessage:
      'ההזמנה עודכנה מאז שפתחת את הדף. רענן כדי לראות מה השתנה, ואשר מחדש.',
    status: 409,
  },
  guest_confirmation_not_required: {
    userMessage: 'ההזמנה הזו אינה דורשת אישור שלך.',
    status: 422,
  },
  guest_booking_not_confirmable: {
    userMessage: 'ההזמנה בוטלה ולא ניתן לאשר אותה. פנה לבית האירוח.',
    status: 422,
  },

  // ── The contract.
  guest_contract_disabled: {
    userMessage: 'אין חוזה לחתימה בהזמנה הזו.',
    status: 422,
  },
  guest_contract_unavailable: {
    userMessage: 'נוסח החוזה אינו זמין כרגע. פנה לבית האירוח.',
    status: 503,
  },
  guest_signature_incomplete: {
    userMessage: 'יש להזין שם מלא וחתימה.',
    status: 422,
  },

  // ── Details.
  guest_details_invalid: {
    userMessage: 'הפרטים שנשלחו אינם תקינים. רענן את הדף ונסה שוב.',
    status: 422,
  },
  guest_details_too_large: {
    userMessage: 'הפרטים ארוכים מדי. קצר את התשובות ונסה שוב.',
    status: 422,
  },

  // ── Requests.
  guest_requests_disabled: {
    userMessage: 'לא ניתן לשלוח בקשות בהזמנה הזו.',
    status: 422,
  },
  guest_request_key_missing: {
    userMessage: 'לא ניתן לשלוח את הבקשה. רענן את הדף ונסה שוב.',
    status: 422,
  },
  guest_request_category_unknown: {
    userMessage: 'סוג הבקשה אינו מוכר. בחר מהרשימה.',
    status: 422,
  },
  guest_request_category_unavailable: {
    userMessage: 'סוג הבקשה הזה אינו זמין בהזמנה הזו.',
    status: 422,
  },

  // ── Leaving.
  guest_checkout_declaration_disabled: {
    userMessage: 'ההצהרה על עזיבה אינה פעילה בהזמנה הזו.',
    status: 422,
  },
}

export const GUEST_JOURNEY_REFUSAL_CODES = Object.keys(REFUSALS)

export class GuestJourneyRefusedError extends BusinessRuleError {
  /**
   * The live booking version, when the refusal was a stale confirmation.
   *
   * Carried so the caller can re-read and show the delta rather than merely
   * reporting a conflict. `guest_portal_confirm` puts it in the error's DETAIL
   * field for exactly this.
   */
  readonly liveVersion: number | null

  constructor(
    code: string,
    userMessage: string,
    status: number,
    liveVersion: number | null = null,
  ) {
    super({
      code,
      userMessage,
      status,
      message: `Guest journey refused: ${code}`,
    })
    this.liveVersion = liveVersion
  }
}

type PostgrestErrorish = {
  message?: string | null
  hint?: string | null
  details?: string | null
  code?: string | null
}

function refusalFrom(
  error: PostgrestErrorish,
): GuestJourneyRefusedError | null {
  const raised = (error.message ?? '').trim()
  const known = REFUSALS[raised]

  if (known) {
    const detail = (error.details ?? '').trim()
    const parsed = Number.parseInt(detail, 10)
    return new GuestJourneyRefusedError(
      raised,
      known.userMessage,
      known.status,
      Number.isInteger(parsed) ? parsed : null,
    )
  }

  // A refusal this file has not heard of. The database's hint is Hebrew and
  // describes the real reason, so it is used rather than discarded — and the
  // code is labelled unrecognised so the gap between the two halves shows up
  // instead of passing for a designed message. Same treatment as
  // `guest-portal/session.ts`, deliberately.
  const hint = (error.hint ?? '').trim()
  if (raised.length > 0 && hint.length > 0) {
    return new GuestJourneyRefusedError(
      `guest_journey_refused_${raised}`,
      hint,
      422,
    )
  }

  return null
}

/** Never attaches the token to what it throws. */
function rethrow(error: unknown): never {
  const refusal = refusalFrom(error as PostgrestErrorish)
  if (refusal) throw refusal
  throw error
}

function unreadable(what: string): AppError {
  return new AppError({
    code: 'guest_journey_unreadable',
    status: 502,
    message: `guest_portal_journey returned ${what}`,
    userMessage: 'לא הצלחנו לטעון את ההזמנה. נסה לרענן את הדף.',
    retryable: true,
    dataOutcome: 'unknown',
  })
}

/* -------------------------------------------------------------- parsing -- */

type Json = Record<string, unknown>

function object(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {}
}

function text(row: Json, key: string): string {
  return typeof row[key] === 'string' ? (row[key] as string) : ''
}

function orNull(row: Json, key: string): string | null {
  const found = row[key]
  return typeof found === 'string' && found.length > 0 ? found : null
}

function count(row: Json, key: string): number {
  const found = row[key]
  return typeof found === 'number' && Number.isFinite(found) ? found : 0
}

function flag(row: Json, key: string): boolean {
  return row[key] === true
}

/** A string array from jsonb, filtered through a known vocabulary. */
function vocabulary<T extends string>(
  row: Json,
  key: string,
  allowed: readonly T[],
): T[] {
  const found = row[key]
  if (!Array.isArray(found)) return []
  const set: ReadonlySet<string> = new Set(allowed)
  return found.filter(
    (item): item is T => typeof item === 'string' && set.has(item),
  )
}

function member<T extends string>(
  row: Json,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const found = row[key]
  return typeof found === 'string' &&
    (allowed as readonly string[]).includes(found)
    ? (found as T)
    : fallback
}

function parseSettings(row: Json): GuestJourneySettings {
  return {
    contractMode: member(row, 'contractMode', GUEST_CONTRACT_MODES, 'disabled'),
    requireGuestConfirmation: flag(row, 'requireGuestConfirmation'),
    // Filtered through the closed list in `types.ts`. A field name the
    // application does not know is dropped rather than rendered: the details
    // form is filled in by somebody with no account, and an unknown key is
    // either a configuration mistake or something worse.
    requiredDetailFields: detailFields(row, 'requiredDetailFields'),
    optionalDetailFields: detailFields(row, 'optionalDetailFields'),
    arrivalRelease: member(
      row,
      'arrivalRelease',
      GUEST_ARRIVAL_RELEASES,
      'after_confirmation',
    ),
    arrivalReleaseHours: count(row, 'arrivalReleaseHours'),
    duringStayTopics: Array.isArray(row.duringStayTopics)
      ? row.duringStayTopics.filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
    requestsEnabled: flag(row, 'requestsEnabled'),
    requestCategories: vocabulary(
      row,
      'requestCategories',
      GUEST_REQUEST_CATEGORIES,
    ),
    checkoutDeclarationEnabled: flag(row, 'checkoutDeclarationEnabled'),
    reviewEnabled: flag(row, 'reviewEnabled'),
    reviewUrl: orNull(row, 'reviewUrl'),
    rebookEnabled: flag(row, 'rebookEnabled'),
    reconfirmationTriggers: vocabulary(
      row,
      'reconfirmationTriggers',
      RECONFIRMATION_TRIGGERS,
    ),
  }
}

function detailFields(row: Json, key: string): GuestDetailField[] {
  const found = row[key]
  if (!Array.isArray(found)) return []
  return found.filter(
    (item): item is GuestDetailField =>
      typeof item === 'string' && isGuestDetailField(item),
  )
}

function parseTerms(row: Json): GuestJourneyTerms {
  return {
    bookingVersion: count(row, 'bookingVersion'),
    status: text(row, 'status'),
    checkIn: text(row, 'checkIn'),
    checkOut: text(row, 'checkOut'),
    adults: count(row, 'adults'),
    children: count(row, 'children'),
    infants: count(row, 'infants'),
    totalAgorot: count(row, 'totalAgorot'),
    currency: text(row, 'currency') || 'ILS',
    cancellationTerms: orNull(row, 'cancellationTerms'),
    inStay: flag(row, 'inStay'),
  }
}

function parseConfirmation(value: unknown): GuestConfirmation | null {
  if (value === null || value === undefined) return null
  const row = object(value)
  const confirmedAt = orNull(row, 'confirmedAt')
  if (!confirmedAt) return null

  const snapshot = object(row.snapshot)
  const numberOrNull = (key: string): number | null => {
    const found = snapshot[key]
    return typeof found === 'number' && Number.isFinite(found) ? found : null
  }

  return {
    confirmedAt,
    bookingVersion: count(row, 'bookingVersion'),
    snapshot: {
      checkIn: orNull(snapshot, 'checkIn'),
      checkOut: orNull(snapshot, 'checkOut'),
      adults: numberOrNull('adults'),
      children: numberOrNull('children'),
      infants: numberOrNull('infants'),
      totalAgorot: numberOrNull('totalAgorot'),
      currency: orNull(snapshot, 'currency'),
      cancellationTerms: orNull(snapshot, 'cancellationTerms'),
    },
  }
}

function parseContract(value: unknown): GuestContract {
  const row = object(value)
  const template = row.template ? object(row.template) : null
  const signature = row.signature ? object(row.signature) : null

  return {
    mode: member(row, 'mode', GUEST_CONTRACT_MODES, 'disabled'),
    template:
      template && text(template, 'body').length > 0
        ? { title: text(template, 'title'), body: text(template, 'body') }
        : null,
    signature:
      signature && orNull(signature, 'signedAt')
        ? {
            signedAt: text(signature, 'signedAt'),
            signerName: text(signature, 'signerName'),
            title: text(signature, 'title'),
            body: text(signature, 'body'),
            bookingVersion: count(signature, 'bookingVersion'),
          }
        : null,
  }
}

function parseDetails(value: unknown): GuestDetails {
  const row = object(value)
  const stored = object(row.fields)
  const fields: Partial<Record<GuestDetailField, string>> = {}

  for (const [key, item] of Object.entries(stored)) {
    if (isGuestDetailField(key) && typeof item === 'string') {
      fields[key] = item
    }
  }

  return { submittedAt: orNull(row, 'submittedAt'), fields }
}

function parseArrival(value: unknown): GuestArrival {
  const row = object(value)
  return {
    released: flag(row, 'released'),
    checkInTime: orNull(row, 'checkInTime'),
    addressNote: orNull(row, 'addressNote'),
    addressLine1: orNull(row, 'addressLine1'),
    addressLine2: orNull(row, 'addressLine2'),
    city: orNull(row, 'city'),
    directions: orNull(row, 'directions'),
    mapUrl: orNull(row, 'mapUrl'),
    parking: orNull(row, 'parking'),
    accessInstructions: orNull(row, 'accessInstructions'),
    accessCode: orNull(row, 'accessCode'),
  }
}

function parseStay(value: unknown): GuestStay {
  const row = object(value)
  return {
    inStay: flag(row, 'inStay'),
    wifiNetwork: orNull(row, 'wifiNetwork'),
    wifiPassword: orNull(row, 'wifiPassword'),
    propertyGuide: orNull(row, 'propertyGuide'),
    houseRules: orNull(row, 'houseRules'),
    emergencyContact: orNull(row, 'emergencyContact'),
  }
}

function parseRequests(value: unknown): GuestRequest[] {
  if (!Array.isArray(value)) return []
  const categories: ReadonlySet<string> = new Set(GUEST_REQUEST_CATEGORIES)
  const states: ReadonlySet<string> = new Set(GUEST_REQUEST_STATES)

  return value.flatMap((item) => {
    const row = object(item)
    const id = orNull(row, 'id')
    const category = text(row, 'category')
    const state = text(row, 'state')
    if (!id || !categories.has(category) || !states.has(state)) return []

    return [
      {
        id,
        category: category as GuestRequestCategory,
        body: orNull(row, 'body'),
        state: state as GuestRequestState,
        createdAt: text(row, 'createdAt'),
        completedAt: orNull(row, 'completedAt'),
      },
    ]
  })
}

function parseCheckout(value: unknown): GuestCheckout {
  const row = object(value)
  return {
    checkOutTime: orNull(row, 'checkOutTime'),
    instructions: orNull(row, 'instructions'),
    declaredAt: orNull(row, 'declaredAt'),
    enabled: flag(row, 'enabled'),
  }
}

export function parseGuestJourney(value: unknown): GuestJourney {
  if (typeof value !== 'object' || value === null) {
    throw unreadable('a non-object')
  }

  const row = value as Json
  const current = parseTerms(object(row.current))

  if (current.checkIn.length === 0 || current.checkOut.length === 0) {
    throw unreadable('no stay dates')
  }

  return {
    settings: parseSettings(object(row.settings)),
    current,
    confirmation: parseConfirmation(row.confirmation),
    contract: parseContract(row.contract),
    details: parseDetails(row.details),
    arrival: parseArrival(row.arrival),
    stay: parseStay(row.stay),
    requests: parseRequests(row.requests),
    checkout: parseCheckout(row.checkout),
  }
}

/* --------------------------------------------------------------- reads -- */

/**
 * Read the journey.
 *
 * `db` may be the anonymous client — that is the ordinary case, since the
 * visitor has no session. The function it calls is SECURITY DEFINER, takes the
 * capability as its only argument, and re-resolves the token itself.
 */
export async function guestJourney(
  db: Db,
  token: string,
): Promise<GuestJourney> {
  const trimmed = token.trim()
  if (trimmed.length === 0) {
    throw new GuestJourneyRefusedError(
      'guest_link_not_found',
      REFUSALS.guest_link_not_found.userMessage,
      404,
    )
  }

  const { data, error } = await db.rpc('guest_portal_journey', {
    p_token: trimmed,
  })

  if (error) rethrow(error)
  return parseGuestJourney(data)
}

/* -------------------------------------------------------------- writes -- */

export type GuestWriteContext = {
  /** From the proxy headers. Best effort; a bad value is stored as null. */
  ip?: string | null
  userAgent?: string | null
}

export type GuestConfirmResult = {
  confirmationId: string
  confirmedAt: string
  bookingVersion: number
  /** False when this request found an existing confirmation — a double tap. */
  created: boolean
}

/**
 * Record the guest's approval.
 *
 * `expectedVersion` is the version the guest was LOOKING at, and passing it is
 * not optional: the database refuses when it does not match the live row, which
 * is what stops an approval landing against terms nobody displayed. The refusal
 * comes back as `guest_confirmation_stale` carrying the live version, so the
 * caller can re-read and show the delta.
 */
export async function confirmBooking(
  db: Db,
  token: string,
  expectedVersion: number,
  context: GuestWriteContext = {},
): Promise<GuestConfirmResult> {
  const { data, error } = await db.rpc('guest_portal_confirm', {
    p_token: token.trim(),
    p_booking_version: expectedVersion,
    p_ip: context.ip ?? null,
    p_user_agent: context.userAgent ?? null,
  })

  if (error) rethrow(error)

  const row = object(data)
  return {
    confirmationId: text(row, 'confirmationId'),
    confirmedAt: text(row, 'confirmedAt'),
    bookingVersion: count(row, 'bookingVersion'),
    created: flag(row, 'created'),
  }
}

export type GuestSignResult = {
  signatureId: string
  signedAt: string
  created: boolean
}

export async function signContract(
  db: Db,
  token: string,
  input: {
    signerName: string
    signatureText: string
    idNumber?: string | null
  },
  context: GuestWriteContext = {},
): Promise<GuestSignResult> {
  const { data, error } = await db.rpc('guest_portal_sign_contract', {
    p_token: token.trim(),
    p_signer_name: input.signerName,
    p_signature_text: input.signatureText,
    p_signer_id_number: input.idNumber ?? null,
    p_ip: context.ip ?? null,
    p_user_agent: context.userAgent ?? null,
  })

  if (error) rethrow(error)

  const row = object(data)
  return {
    signatureId: text(row, 'signatureId'),
    signedAt: text(row, 'signedAt'),
    created: flag(row, 'created'),
  }
}

/**
 * Save the details.
 *
 * The keys are filtered against the closed list before they are sent, so a
 * crafted submission cannot write an arbitrary name into a jsonb column that a
 * staff screen later renders. The database caps the payload's size; this caps
 * its shape, and both are needed.
 */
export async function saveDetails(
  db: Db,
  token: string,
  fields: Partial<Record<GuestDetailField, string>>,
  complete = true,
): Promise<{ submittedAt: string | null }> {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (isGuestDetailField(key) && typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.length > 0) clean[key] = trimmed
    }
  }

  const { data, error } = await db.rpc('guest_portal_save_details', {
    p_token: token.trim(),
    p_fields: clean,
    p_complete: complete,
  })

  if (error) rethrow(error)
  return { submittedAt: orNull(object(data), 'submittedAt') }
}

export type GuestRequestResult = {
  requestId: string
  state: GuestRequestState
  created: boolean
}

/**
 * Ask for something.
 *
 * `clientKey` is minted when the compose form OPENS, not when it is submitted.
 * That is the whole idempotency story for this call and the reason it is the
 * one place in the module where a client supplies a key: a double tap shares
 * one and produces one request, while a second genuine request for towels an
 * hour later carries a new one — which no combination of category, body and
 * timestamp could distinguish.
 */
export async function submitRequest(
  db: Db,
  token: string,
  input: {
    category: GuestRequestCategory
    body: string | null
    clientKey: string
  },
): Promise<GuestRequestResult> {
  const { data, error } = await db.rpc('guest_portal_submit_request', {
    p_token: token.trim(),
    p_category: input.category,
    p_body: input.body,
    p_client_key: input.clientKey,
  })

  if (error) rethrow(error)

  const row = object(data)
  return {
    requestId: text(row, 'requestId'),
    state: member(row, 'state', GUEST_REQUEST_STATES, 'received'),
    created: flag(row, 'created'),
  }
}

export async function declareCheckout(
  db: Db,
  token: string,
): Promise<{ declaredAt: string | null }> {
  const { data, error } = await db.rpc('guest_portal_declare_checkout', {
    p_token: token.trim(),
  })

  if (error) rethrow(error)
  return { declaredAt: orNull(object(data), 'declaredAt') }
}
