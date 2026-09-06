'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTION. Creating an invitation.
 *
 * ── What this closes ──────────────────────────────────────────────────────
 *
 * The form shipped complete with its submit switched off, and the reason
 * printed on the screen was exact at the time: `public.invitations` needs a
 * minted, hashed token and an expiry, and nothing in `src/lib` minted one.
 * `defineInvitationOperations` exists now, and — the other half that mattered
 * — so does a way to redeem what it mints: `/invite/[token]` and migration
 * 0027. An invitation nobody could accept was not worth enabling; every one
 * sent would have been a dead letter.
 *
 * ── Where the token goes ──────────────────────────────────────────────────
 *
 * Not into the operation's result. Read `delivery.ts`: a successful
 * operation's result is written into `idempotency_keys.result`, so a token
 * returned from the domain would be a credential stored in plain text through
 * the door nobody was watching. It leaves sideways, through the delivery port,
 * and this action turns it into a link exactly once — for the person who just
 * created it, on their own screen.
 *
 * There is no mail transport in this codebase, so `CapturingInvitationDelivery`
 * is what is wired and the inviter sends the link themselves. That is a real
 * product pattern rather than a placeholder, and it keeps the credential out of
 * the database and out of the logs.
 *
 * ── A replay returns no link, deliberately ────────────────────────────────
 *
 * On a replayed idempotency key the pipeline returns the stored result without
 * running `execute`, so nothing is delivered a second time and the port is
 * empty. That is correct: the second submission created no invitation, so
 * there is no second link. Minting a replacement here would leave two live
 * credentials for one row — so instead the caller is told the invitation
 * already exists and that the original link is the one to use.
 */

import { revalidatePath } from 'next/cache'

import { assertCan } from '@/lib/authz/can'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import {
  CapturingInvitationDelivery,
  defineInvitationOperations,
  type InvitationScopeKind,
  INVITATION_SCOPE_KINDS,
} from '@/lib/invitations'
import { env } from '@/lib/env'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
} from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

import { auditActorFor, transactionRunner } from '../../../_lib/wiring'
import { shellContext } from '../../../_lib/context'
import { domainEventBus } from '../../../_lib/events'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

export type CreatedInvitationResult = {
  invitationId: string
  email: string
  /** ISO 8601. */
  expiresAt: string
  /**
   * The link to hand to the invitee, or `null` on a replayed submission.
   *
   * Shown once, on the screen of the person who created it, and never
   * persisted. `null` is not a failure — see the note above on replays.
   */
  link: string | null
}

export type NewInvitationInput = {
  email: string
  roleId: string
  scopeKind: string
  propertyIds: readonly string[]
  unitIds: readonly string[]
  teamIds: readonly string[]
  message: string
  idempotencyKey: string
}

function isScopeKind(value: string): value is InvitationScopeKind {
  return (INVITATION_SCOPE_KINDS as readonly string[]).includes(value)
}

/** Absent is `null`, never `''` — an empty string is a value and reads as one. */
function orNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export async function createInvitationAction(
  input: NewInvitationInput,
): Promise<ActionResult<CreatedInvitationResult>> {
  const context = await shellContext()
  const correlationId = crypto.randomUUID()

  if (!context || context.status !== 'ready') {
    return {
      ok: false,
      error: {
        code: context ? 'membership_not_active' : 'unauthenticated',
        message: context
          ? 'אין לך מרחב עבודה פעיל, ולכן לא ניתן להזמין אנשים.'
          : 'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
        dataMessage: 'ההזמנה לא נוצרה. שום דבר במערכת לא השתנה.',
        retryMessage: context
          ? 'ניסיון חוזר לא יעזור עד שהחברות בארגון תופעל.'
          : 'ניסיון חוזר לא יעזור עד שתתחבר מחדש.',
        dataOutcome: 'not_saved',
        retryable: false,
        correlationId,
      },
    }
  }

  try {
    // Asserted here as well as in the operation. A Server Action is a public
    // endpoint reachable by a crafted POST whatever the screen chose to
    // render, and admitting somebody to an organization is the single most
    // consequential write in the product.
    assertCan(context.actor, 'user.invite', {
      organizationId: context.actor.organizationId,
      family: 'team',
    })

    if (!isScopeKind(input.scopeKind)) {
      // Refused before the schema so the message names the choice somebody
      // made rather than the whole vocabulary.
      return {
        ok: false,
        error: {
          code: 'unknown_scope_kind',
          message: 'הטווח שנבחר אינו מוכר. בחר מהרשימה.',
          dataMessage: 'ההזמנה לא נוצרה.',
          retryMessage: 'בחר טווח מהרשימה ונסה שוב.',
          dataOutcome: 'not_saved',
          retryable: false,
          correlationId,
        },
      }
    }

    const db = await createClient()
    const { transactions } = transactionRunner(db)
    const delivery = new CapturingInvitationDelivery()
    const operations = defineInvitationOperations({ db, delivery })

    const outcome = await operations.createInvitation.run({
      request: {
        input: {
          email: input.email.trim().toLowerCase(),
          roleId: input.roleId,
          scopeKind: input.scopeKind,
          propertyIds: [...input.propertyIds],
          unitIds: [...input.unitIds],
          teamIds: [...input.teamIds],
          message: orNull(input.message),
        },
        idempotencyKey: input.idempotencyKey,
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services: {
        audit: new SupabaseAuditWriter(db),
        events: domainEventBus(db),
        idempotency: new SupabaseIdempotencyStore(db),
        transactions,
        onEventError(error) {
          // An invitation whose event failed to deliver is still an
          // invitation. Logged so the loss is not silent — and note that the
          // handoff carries the token, so nothing about the handoff is ever
          // logged here.
          console.error('[invitations] domain event delivery failed', error)
        },
      },
    })

    const handoff = delivery.delivered

    revalidatePath('/team')

    return {
      ok: true,
      data: {
        invitationId: outcome.data.id,
        email: outcome.data.email,
        expiresAt: outcome.data.expiresAt,
        // `env.siteUrl` already carries no trailing slash — see its note in
        // `src/lib/env.ts` — so the path concatenates without doubling.
        link: handoff ? `${env.siteUrl}/invite/${handoff.token}` : null,
      },
    }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
