'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTION. Redeeming an invitation.
 *
 * ── Why acceptance is a button and not a page load ────────────────────────
 *
 * The page next door reads the invitation and writes nothing. This is the only
 * thing that consumes the token, and it runs on a POST because an invitation
 * is single-use: a mail client's link checker, a corporate security scanner or
 * a browser prefetching what it thinks you are about to click would each burn
 * the token by merely looking at the link, and the real invitee would arrive
 * at "this invitation has already been used".
 *
 * ── Why there is no `assertCan` here ──────────────────────────────────────
 *
 * Every other Server Action in this codebase opens with one, and its absence
 * is the point rather than an omission. The person redeeming an invitation
 * holds no membership in that organization, so there is no actor to check and
 * no grant they could hold. The authorization is possession of the token, and
 * it is checked in `public.accept_invitation` — together with the expiry, the
 * single-use flags and the address, inside one transaction that rolls the
 * whole thing back if any part fails.
 *
 * What this file must still refuse on its own terms is the signed-out case. A
 * Server Action is a public endpoint reachable by a crafted POST whatever the
 * screen rendered, and the function's own `auth.uid()` check is the floor
 * underneath this one.
 */

import { revalidatePath } from 'next/cache'

import { acceptInvitation } from '@/lib/invitations'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import { createClient, getCurrentUser } from '@/lib/supabase/server'

export type AcceptResult =
  | {
      ok: true
      data: { organizationName: string; created: boolean; replay: boolean }
    }
  | { ok: false; error: SafeErrorBody }

export async function acceptInvitationAction(
  token: string,
): Promise<AcceptResult> {
  const correlationId = crypto.randomUUID()

  try {
    const user = await getCurrentUser()
    if (!user) {
      return {
        ok: false,
        error: {
          code: 'unauthenticated',
          message: 'החיבור למערכת פג. התחבר מחדש ופתח את הקישור שוב.',
          dataMessage: 'שום דבר לא השתנה. ההזמנה עדיין ממתינה לך.',
          retryMessage: 'ניסיון חוזר לא יעזור עד שתתחבר מחדש.',
          dataOutcome: 'not_saved',
          retryable: false,
          correlationId,
        },
      }
    }

    const db = await createClient()
    const accepted = await acceptInvitation(db, token)

    // The shell reads the membership on every request, and the person who has
    // just joined has to see the organization they joined rather than the
    // empty state they saw a second ago.
    revalidatePath('/', 'layout')

    return {
      ok: true,
      data: {
        organizationName: accepted.organizationName,
        created: accepted.created,
        replay: accepted.replay,
      },
    }
  } catch (cause) {
    // `toSafeResponse` never echoes what it was given. That matters more here
    // than anywhere else in the app: the argument to this action is a bearer
    // credential, and an error that quoted its own input would put it in a log.
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
