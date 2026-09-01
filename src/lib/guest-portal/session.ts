/**
 * EXECUTION CONTEXT — SERVER ONLY. Resolving a guest from their link.
 *
 * ── Why this is not `shellContext()` ──────────────────────────────────────
 *
 * Every authenticated screen in ESTIA resolves a membership, an organization
 * and an actor, and refuses without them. A guest has none: no account, no
 * membership, no role, no `auth.uid()`. That is not an edge case to be worked
 * around — it is the definition of a guest, and it is why the portal lives
 * outside `(app)` and why this file exists beside `shellContext` rather than
 * inside it.
 *
 * The authorization is possession of a 32-byte capability, and it is checked
 * in `public.guest_portal_session` — migration 0033 — which is the only
 * function in the schema `anon` may execute against tenant data.
 *
 * ── What comes back, and what deliberately does not ───────────────────────
 *
 * A hand-picked projection, not the booking row. `internal_notes`, the agent
 * who sold the stay, the source channel, the tax treatment and
 * `status_reason` are all absent by design; the reasoning is written out in
 * §2 of the migration. This file must never widen that — if a screen needs a
 * field the projection does not carry, the field is added to the SQL after
 * somebody decides it is safe to disclose, not read around it here.
 *
 * ── What this file must never do ──────────────────────────────────────────
 *
 * Log the token. Not in an error, not in a correlation payload, not while
 * debugging. It is a bearer credential for somebody's booking, and a log line
 * outlives the stay. `toSafeResponse` never echoes its input, which is why
 * every failure below goes through it.
 */

import { AppError, BusinessRuleError, NotFoundError } from '../errors'
import type { Db } from '../persistence'

/** The guest-facing projection of one booking. Nothing else is disclosed. */
export type GuestSession = {
  bookingId: string
  organizationId: string
  organizationName: string
  reference: string
  status: string
  /** ISO date, `YYYY-MM-DD`. */
  checkIn: string
  checkOut: string
  /** `HH:MM:SS`, or null when the property has not set one. */
  arrivalTime: string | null
  adults: number
  children: number
  infants: number
  couples: number
  cotsRequested: number
  eventType: string
  /** The guest's own words. */
  specialRequests: string | null
  guestNotes: string | null
  currency: string
  /** What the guest owes, in agorot. Never how it was arrived at. */
  totalAgorot: number
  propertyId: string | null
  propertyName: string | null
  propertyCity: string | null
  unitName: string | null
  /** First name only — enough to greet somebody, and one less disclosure. */
  guestFirstName: string
  linkExpiresAt: string | null
  firstOpenedAt: string | null
}

/** Nights, computed rather than stored, because the two dates are the truth. */
export function nightsBetween(checkIn: string, checkOut: string): number {
  const from = Date.parse(`${checkIn}T00:00:00Z`)
  const to = Date.parse(`${checkOut}T00:00:00Z`)
  if (Number.isNaN(from) || Number.isNaN(to)) return 0
  return Math.max(0, Math.round((to - from) / 86_400_000))
}

/** Heads under the roof. Not sleeping places — an infant is a head, not a bed. */
export function totalGuests(session: GuestSession): number {
  return session.adults + session.children + session.infants
}

const REFUSALS: Readonly<
  Record<string, { userMessage: string; status: number }>
> = {
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
}

/** The codes above, for a caller that wants to branch rather than display. */
export const GUEST_LINK_REFUSAL_CODES = Object.keys(REFUSALS)

export class GuestLinkRefusedError extends BusinessRuleError {
  constructor(code: string, userMessage: string, status: number) {
    super({ code, userMessage, status, message: `Guest link refused: ${code}` })
  }
}

type PostgrestErrorish = {
  message?: string | null
  hint?: string | null
  code?: string | null
}

function refusalFrom(error: PostgrestErrorish): GuestLinkRefusedError | null {
  const raised = (error.message ?? '').trim()
  const known = REFUSALS[raised]
  if (known) {
    return new GuestLinkRefusedError(raised, known.userMessage, known.status)
  }

  // A refusal this file has not heard of. The database's hint is Hebrew and
  // describes the real reason, so it is used rather than discarded — and the
  // code is labelled unrecognised so the gap between the two halves shows up
  // instead of passing for a designed message.
  const hint = (error.hint ?? '').trim()
  if (raised.length > 0 && hint.length > 0) {
    return new GuestLinkRefusedError(`guest_link_refused_${raised}`, hint, 422)
  }

  return null
}

function parse(value: unknown): GuestSession {
  if (typeof value !== 'object' || value === null) {
    throw new AppError({
      code: 'guest_session_unreadable',
      status: 502,
      message: 'guest_portal_session returned a non-object',
      userMessage: 'לא הצלחנו לטעון את ההזמנה. נסה לרענן את הדף.',
      retryable: true,
      dataOutcome: 'unknown',
    })
  }

  const row = value as Record<string, unknown>
  const text = (key: string): string =>
    typeof row[key] === 'string' ? (row[key] as string) : ''
  const orNull = (key: string): string | null => {
    const found = row[key]
    return typeof found === 'string' && found.length > 0 ? found : null
  }
  const count = (key: string): number => {
    const found = row[key]
    return typeof found === 'number' && Number.isFinite(found) ? found : 0
  }

  const bookingId = text('bookingId')
  const organizationId = text('organizationId')

  if (bookingId.length === 0 || organizationId.length === 0) {
    throw new AppError({
      code: 'guest_session_unreadable',
      status: 502,
      message: 'guest_portal_session returned no booking',
      userMessage: 'לא הצלחנו לטעון את ההזמנה. נסה לרענן את הדף.',
      retryable: true,
      dataOutcome: 'unknown',
    })
  }

  return {
    bookingId,
    organizationId,
    organizationName: text('organizationName'),
    reference: text('reference'),
    status: text('status'),
    checkIn: text('checkIn'),
    checkOut: text('checkOut'),
    arrivalTime: orNull('arrivalTime'),
    adults: count('adults'),
    children: count('children'),
    infants: count('infants'),
    couples: count('couples'),
    cotsRequested: count('cotsRequested'),
    eventType: text('eventType') || 'accommodation',
    specialRequests: orNull('specialRequests'),
    guestNotes: orNull('guestNotes'),
    currency: text('currency') || 'ILS',
    totalAgorot: count('totalAgorot'),
    propertyId: orNull('propertyId'),
    propertyName: orNull('propertyName'),
    propertyCity: orNull('propertyCity'),
    unitName: orNull('unitName'),
    guestFirstName: text('guestFirstName'),
    linkExpiresAt: orNull('linkExpiresAt'),
    firstOpenedAt: orNull('firstOpenedAt'),
  }
}

/**
 * Resolve a guest link, or refuse.
 *
 * `db` may be the anonymous client — that is the ordinary case, since the
 * visitor has no session. The function it calls is `SECURITY DEFINER` and
 * takes the capability as its only argument.
 */
export async function guestSession(
  db: Db,
  token: string,
): Promise<GuestSession> {
  const trimmed = token.trim()
  if (trimmed.length === 0) {
    throw new NotFoundError('booking', 'missing-guest-token', {
      userMessage: REFUSALS.guest_link_not_found.userMessage,
    })
  }

  const { data, error } = await db.rpc('guest_portal_session', {
    p_token: trimmed,
  })

  if (error) {
    const refusal = refusalFrom(error as PostgrestErrorish)
    if (refusal) throw refusal
    // Never attach the token to a rethrown error. There is none in it, and
    // there must be none added here.
    throw error
  }

  return parse(data)
}

/**
 * Record that somebody opened the link.
 *
 * Deliberately swallows its own failure. "Sent and never opened" is useful to
 * a business, and it is never worth a guest seeing an error page because a
 * telemetry write did not land.
 */
export async function markGuestPortalOpened(
  db: Db,
  token: string,
): Promise<void> {
  const trimmed = token.trim()
  if (trimmed.length === 0) return

  try {
    await db.rpc('guest_portal_opened', { p_token: trimmed })
  } catch (cause) {
    // No token in the log line. The code is enough to find this call site.
    console.error('[guest-portal] could not stamp opened_at', {
      code: (cause as { code?: string })?.code ?? 'unknown',
    })
  }
}
