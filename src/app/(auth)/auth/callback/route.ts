/**
 * EXECUTION CONTEXT — ROUTE HANDLER (`GET /auth/callback`).
 *
 * Where every emailed link lands: email confirmation, magic link, and password
 * recovery. Written as a Route Handler rather than a page because it sets
 * cookies and then redirects, and per
 * `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
 * a Route Handler is the request-time context that is allowed to do both.
 *
 * TWO SHAPES ARRIVE HERE, and handling only one is a common way to ship a
 * magic link that works in development and not in production:
 *
 *   1. `?code=...`
 *      The PKCE flow. `@supabase/ssr` sets `flowType: "pkce"` for both
 *      clients, so the Server Action that sent the mail also dropped a code
 *      verifier cookie. `exchangeCodeForSession` pairs the two. This is why
 *      the link must be opened in the browser that requested it — the verifier
 *      lives in that browser and nowhere else.
 *
 *   2. `?token_hash=...&type=...`
 *      What Supabase's default email templates emit when they are not
 *      rewritten for PKCE, and what arrives when the project's own
 *      `/auth/v1/verify` endpoint forwards the link. `verifyOtp` handles it.
 *
 *   3. `?error=...&error_code=...`
 *      Supabase's verify endpoint redirects here with the failure rather than
 *      rendering its own page — an expired link is by far the most common. It
 *      is translated and shown on the screen where the user can request
 *      another one.
 *
 * This handler never renders. Every path ends in a redirect, so an emailed
 * one-time code is never left sitting in the address bar of a page the user
 * might share or bookmark.
 */

import type { EmailOtpType } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'

import { createClient } from '@/lib/supabase/server'

import { safeRedirectTarget } from '../../_lib/redirect-target'

/** The `type` values Supabase sends to an app callback. */
const OTP_TYPES: readonly EmailOtpType[] = [
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'email',
]

function isOtpType(value: string | null): value is EmailOtpType {
  return value !== null && (OTP_TYPES as readonly string[]).includes(value)
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl

  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const rawType = searchParams.get('type')
  const type = isOtpType(rawType) ? rawType : null

  // Attacker-controlled, like every other `next` in this route group.
  const next = safeRedirectTarget(searchParams.get('next'))

  // A recovery link is marked with `flow=recovery`, set by the Server Action
  // that sent it, NOT with `next=/reset-password`. `safeRedirectTarget`
  // deliberately refuses `/reset-password` as a destination — so encoding the
  // intent in `next` would be silently discarded here and the recovery session
  // would be handed to `/account` instead. `type=recovery` covers the
  // non-PKCE template shape, where Supabase supplies the type itself.
  const recovering =
    type === 'recovery' || searchParams.get('flow') === 'recovery'
  const failurePath = recovering ? '/forgot-password' : '/sign-in'

  const failure = (errorCode: string) =>
    NextResponse.redirect(
      new URL(`${failurePath}?error=${encodeURIComponent(errorCode)}`, origin),
    )

  // ── Supabase reported the failure before we ever got a code ──────────────
  const reportedError =
    searchParams.get('error_code') ?? searchParams.get('error')
  if (reportedError) {
    console.warn('[auth] callback received an error from Supabase', {
      code: reportedError,
    })
    return failure(reportedError)
  }

  if (!code && !(tokenHash && type)) {
    // Somebody opened /auth/callback directly, with nothing to exchange.
    return NextResponse.redirect(new URL(failurePath, origin))
  }

  const supabase = await createClient()

  // The client writes the new session cookies through `cookies().set()`, which
  // a Route Handler permits — this is why the exchange happens here and not in
  // a Server Component.
  const { error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : await supabase.auth.verifyOtp({
        type: type as EmailOtpType,
        token_hash: tokenHash as string,
      })

  if (error) {
    console.warn('[auth] callback exchange failed', {
      code: error.code,
      status: error.status,
    })
    return failure(error.code ?? 'unexpected_failure')
  }

  // A recovery link must land on the change-password form and nowhere else.
  // The session it just created can change a password without knowing the old
  // one, so dropping the user into the product holding it would turn a
  // forwarded email into an account takeover.
  const destination = recovering ? '/reset-password' : next

  return NextResponse.redirect(new URL(destination, origin))
}
