/**
 * Where the raw invitation token goes.
 *
 * ── Why this is a port and not a return value ─────────────────────────────
 *
 * The obvious design is for `invitation.create` to return the token so the
 * caller can build a link. It is wrong, and the reason is one line in the
 * service pipeline: a successful operation's result is written into
 * `idempotency_keys.result`. A token in the result is a credential in the
 * database in plain text — precisely what `invitations.token_hash` exists to
 * prevent, reintroduced through the door nobody was watching.
 *
 * So the token leaves the operation sideways, through a port. The result
 * carries the invitation's id and its expiry and nothing secret, and what is
 * persisted for a replay is therefore safe to persist.
 *
 * ── What a replay does, and why that is right ─────────────────────────────
 *
 * On a replayed idempotency key the pipeline returns the stored result without
 * running `execute`, so nothing is delivered a second time. That is correct
 * rather than a limitation: the second submission did not create an
 * invitation, so there is no second link to hand out. A caller that finds no
 * handoff after a replay should say the invitation already exists — never mint
 * a replacement token, which would leave two live credentials for one row.
 */

/** Everything needed to build and send the link, and nothing else. */
export type InvitationHandoff = {
  invitationId: string
  email: string
  /** Raw. Never stored, never logged. */
  token: string
  expiresAt: Date
  /** The personal note the inviter wrote, if any. */
  message: string | null
}

export interface InvitationDelivery {
  deliver(handoff: InvitationHandoff): Promise<void>
}

/**
 * Keeps the handoff in memory for the life of one request.
 *
 * This is what the application wires today, and it is honest about being a
 * stopgap: there is no mail transport in this codebase, so the invitation link
 * is shown once to the person who created it and they send it themselves. That
 * is a real product pattern — every tool with a "copy invite link" button does
 * it — and it keeps the credential out of the database and out of the logs.
 *
 * A `MailInvitationDelivery` replacing it changes this file's consumers not at
 * all; it is one line in the wiring.
 */
export class CapturingInvitationDelivery implements InvitationDelivery {
  private handoff: InvitationHandoff | null = null

  async deliver(handoff: InvitationHandoff): Promise<void> {
    this.handoff = handoff
  }

  /** What was minted on this request, or `null` — including after a replay. */
  get delivered(): InvitationHandoff | null {
    return this.handoff
  }
}
