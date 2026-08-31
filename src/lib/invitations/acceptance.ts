/**
 * EXECUTION CONTEXT — SERVER ONLY. Redeeming an invitation.
 *
 * ── Why this is not a `defineOperation` ───────────────────────────────────
 *
 * Every other write in this codebase goes through the pipeline in
 * `src/lib/service`: authorization, validation, the domain rule, the
 * transaction, the audit event, idempotency. This one cannot, and the reason
 * is the first step. `defineOperation` begins by asserting a permission for an
 * actor inside an organization, and the person redeeming an invitation has no
 * membership in that organization, therefore no role, therefore no grant, and
 * therefore no actor to build. That is not an oversight in the pipeline — it
 * is the definition of an invitee.
 *
 * So the authorization here is possession of the token, and it is checked
 * where it can be checked atomically: `public.accept_invitation`, added by
 * migration 0027. That function verifies the hash, the expiry, the single-use
 * flags and the email, creates the membership, attaches the role, writes the
 * scope, consumes the invitation and records the audit event — and raises on
 * every refusal, so a failure anywhere rolls the whole act back. This file is
 * the thin, honest edge of that: it hashes, it calls, it translates.
 *
 * ── What this file must never do ──────────────────────────────────────────
 *
 * Log the token. Not in an error, not in a correlation payload, not in a
 * `console.error` while debugging. It is a bearer credential for admission to
 * somebody's business, and a log line is a place it would outlive its own
 * expiry. `hashInvitationToken` is called once, the digest goes to the
 * database, and the raw value never leaves this function's parameter.
 *
 * ── Why the Hebrew lives here and also in the SQL ─────────────────────────
 *
 * The function raises with a machine-readable message and a Hebrew hint, and
 * this file carries the same sentences keyed by the same codes. That is not
 * duplication for its own sake: the database is the authority on *which*
 * refusal happened, and the product is the authority on how a refusal is
 * worded to a person. If the two ever disagree the code below wins, and an
 * unknown code still produces a real sentence rather than a raw SQLSTATE.
 */

import { AppError, BusinessRuleError, NotFoundError } from '../errors'
import type { Db } from '../persistence'

import { hashInvitationToken } from './token'

/** What the caller gets when the token was good. */
export type AcceptedInvitation = {
  membershipId: string
  organizationId: string
  organizationName: string
  roleId: string
  /** False when an existing membership was re-activated rather than created. */
  created: boolean
  /**
   * True when this person had already accepted this same invitation.
   *
   * A refresh of the confirmation page is not a failure, and telling somebody
   * their access failed when their access is fine is worse than saying nothing.
   */
  replay: boolean
}

/**
 * The refusals `accept_invitation` raises, worded for the person reading them.
 *
 * `status` is carried because these travel to a page, not to a queue: a wrong
 * link is a 404, a used one is a 409, and an expired one is neither.
 */
const REFUSALS: Readonly<
  Record<string, { userMessage: string; status: number }>
> = {
  not_authenticated: {
    userMessage: 'צריך להתחבר כדי לקבל את ההזמנה.',
    status: 401,
  },
  invitation_not_found: {
    userMessage:
      'לא מצאנו את ההזמנה. ייתכן שהקישור הועתק חלקית — בקש מהמזמין לשלוח אותו שוב.',
    status: 404,
  },
  invitation_already_used: {
    userMessage:
      'ההזמנה הזאת כבר נוצלה. כל הזמנה תקפה לפעם אחת — בקש מהמזמין הזמנה חדשה.',
    status: 409,
  },
  invitation_revoked: {
    userMessage: 'ההזמנה בוטלה על ידי מי ששלח אותה. פנה אליו כדי לקבל חדשה.',
    status: 409,
  },
  invitation_expired: {
    userMessage: 'תוקף ההזמנה פג. בקש מהמזמין לשלוח קישור חדש.',
    status: 410,
  },
  invitation_email_mismatch: {
    userMessage:
      'ההזמנה נשלחה לכתובת דוא״ל אחרת. התחבר עם הכתובת שאליה נשלחה ההזמנה, ואז פתח את הקישור שוב.',
    status: 403,
  },
  already_member: {
    userMessage:
      'אתה כבר חבר פעיל בארגון הזה. לשינוי תפקיד או הרשאות פנה למנהל הארגון.',
    status: 409,
  },
  organization_missing: {
    userMessage: 'הארגון שאליו הוזמנת אינו קיים עוד.',
    status: 404,
  },
  role_missing: {
    userMessage: 'התפקיד שבהזמנה כבר אינו קיים. בקש מהמזמין הזמנה חדשה.',
    status: 409,
  },
}

/** The codes above, for a caller that wants to branch rather than display. */
export const ACCEPTANCE_REFUSAL_CODES = Object.keys(
  REFUSALS,
) as readonly string[]

export class InvitationRefusedError extends BusinessRuleError {
  constructor(code: string, userMessage: string, status: number) {
    super({
      code,
      userMessage,
      status,
      message: `Invitation refused: ${code}`,
    })
  }
}

/**
 * A Postgres error, as PostgREST hands it over.
 *
 * Not imported from `@supabase/supabase-js` because only these four fields are
 * read, and two of them are optional in practice whatever the type says.
 */
type PostgrestErrorish = {
  message?: string | null
  hint?: string | null
  details?: string | null
  code?: string | null
}

function refusalFrom(error: PostgrestErrorish): InvitationRefusedError | null {
  const raised = (error.message ?? '').trim()
  const known = REFUSALS[raised]
  if (known) {
    return new InvitationRefusedError(raised, known.userMessage, known.status)
  }

  // The function raised something this file does not know about. The hint is
  // still Hebrew and still describes the actual refusal, so it is used rather
  // than discarded — but the code is reported as unknown so it shows up as a
  // gap between the two halves instead of passing for a designed message.
  const hint = (error.hint ?? '').trim()
  if (raised.length > 0 && hint.length > 0) {
    return new InvitationRefusedError(`invitation_refused_${raised}`, hint, 422)
  }

  return null
}

/**
 * The shape `accept_invitation` returns. Parsed rather than cast, because a
 * jsonb from a function is `unknown` until something checks it.
 */
function parse(value: unknown): AcceptedInvitation {
  if (typeof value !== 'object' || value === null) {
    throw new AppError({
      code: 'invitation_acceptance_unreadable',
      status: 502,
      message: 'accept_invitation returned a non-object',
      userMessage:
        'ההזמנה התקבלה, אך לא הצלחנו לקרוא את התשובה. רענן את הדף — אם אתה רואה את הארגון, הכול תקין.',
      retryable: true,
      dataOutcome: 'unknown',
    })
  }

  const row = value as Record<string, unknown>
  const text = (key: string): string =>
    typeof row[key] === 'string' ? (row[key] as string) : ''

  const membershipId = text('membershipId')
  const organizationId = text('organizationId')

  if (membershipId.length === 0 || organizationId.length === 0) {
    throw new AppError({
      code: 'invitation_acceptance_unreadable',
      status: 502,
      message: 'accept_invitation returned no membership',
      userMessage:
        'ההזמנה התקבלה, אך לא הצלחנו לקרוא את התשובה. רענן את הדף — אם אתה רואה את הארגון, הכול תקין.',
      retryable: true,
      dataOutcome: 'unknown',
    })
  }

  return {
    membershipId,
    organizationId,
    organizationName: text('organizationName'),
    roleId: text('roleId'),
    created: row.created === true,
    replay: row.replay === true,
  }
}

/**
 * Redeem a token.
 *
 * `db` must be the request-scoped client — the one carrying the signed-in
 * person's session. The function reads `auth.uid()` and refuses a null, so a
 * service client here would raise rather than quietly admit the wrong person,
 * but passing one would still be wrong: nothing on the server accepts an
 * invitation on somebody's behalf.
 */
export async function acceptInvitation(
  db: Db,
  token: string,
): Promise<AcceptedInvitation> {
  const trimmed = token.trim()
  if (trimmed.length === 0) {
    throw new NotFoundError('invitation', 'missing-token', {
      userMessage: REFUSALS.invitation_not_found.userMessage,
    })
  }

  const tokenHash = await hashInvitationToken(trimmed)

  const { data, error } = await db.rpc('accept_invitation', {
    p_token_hash: tokenHash,
  })

  if (error) {
    const refusal = refusalFrom(error as PostgrestErrorish)
    if (refusal) throw refusal
    // Never `cause: error` with the token anywhere near it — there is none in
    // the error, and there must be none added here.
    throw error
  }

  return parse(data)
}
