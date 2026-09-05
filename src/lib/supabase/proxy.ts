/**
 * EXECUTION CONTEXT — PROXY ONLY (`src/proxy.ts`).
 *
 * Next.js 16 renamed Middleware to Proxy; the file convention is `proxy.ts`
 * and the exported function is `proxy`. See
 * `node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md`.
 * Proxy runs on the Node.js runtime, so `@supabase/ssr` works here unchanged.
 *
 * Why this exists at all
 * ---------------------
 * A Supabase access token is short-lived. Something has to spend the refresh
 * token and write the new pair back as cookies, and it has to happen BEFORE
 * rendering starts — once Next.js begins streaming a Server Component, no
 * `Set-Cookie` can be added. That is precisely what a proxy is for, and it is
 * why `src/lib/supabase/server.ts` is allowed to swallow its cookie-write
 * error. Remove this and sessions expire silently after an hour.
 *
 * The refresh is the load-bearing part. The redirect below it is an
 * OPTIMISTIC check only — the Next.js authentication guide is explicit that
 * proxy runs on prefetches too and must not be the only gate. The real gate is
 * `getCurrentUser()` inside the protected layout, which revalidates the JWT
 * against the auth server.
 */

import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

import { isDemoMode } from '@/lib/demo/flag'
import { env } from '@/lib/env'

/** Paths a signed-out visitor may reach. Everything else needs a session. */
const PUBLIC_PREFIXES = [
  '/', // the marketing home page
  '/sign-in',
  '/sign-up',
  '/magic-link',
  '/forgot-password',
  '/reset-password',
  '/auth', // the callback route handler
  // The guest portal. A guest has no account and never will — the whole
  // design of `bookings.guest_token` is that possession of a capability is
  // the authorization. Redirecting them to /sign-in would send somebody who
  // is legitimately holding their own booking to a form they cannot complete.
  //
  // Public here means only "the proxy does not demand a session". The route
  // still refuses every invalid, revoked and expired token, and the database
  // still hands `anon` nothing but one hand-picked projection of one booking
  // — see migration 0033.
  '/g',
  // The customer's own public website. A visitor reading a villa's page is a
  // member of the public and there is nothing for them to sign in to; without
  // this line every published site in production redirects to ESTIA's login,
  // which is both broken and absurd — the page exists to be found by somebody
  // who has never heard of ESTIA.
  //
  // Public here means the same narrow thing it means above. `anon` holds no
  // privilege on any of the eleven website tables; the single door is
  // `site_public_snapshot`, which reads the PUBLISHED version and joins to no
  // draft table, so there is no query in which somebody could forget a filter
  // and serve an unpublished page. See migration 0042.
  '/s',
]

/** Auth screens a signed-in visitor should be moved off. */
const GUEST_ONLY_PREFIXES = [
  '/sign-in',
  '/sign-up',
  '/magic-link',
  '/forgot-password',
]

/** Where a signed-in user lands when they have no better destination. */
export const AFTER_SIGN_IN = '/account'

/** Where a signed-out user is sent from a protected route. */
export const SIGN_IN_PATH = '/sign-in'

function matches(pathname: string, prefixes: string[]) {
  return prefixes.some(
    (prefix) =>
      pathname === prefix ||
      (prefix !== '/' && pathname.startsWith(`${prefix}/`)),
  )
}

/**
 * Refreshes the session and applies the optimistic redirects.
 *
 * The response object is rebuilt inside `setAll` rather than mutated at the
 * end, because the refreshed cookies must be visible both to the outgoing
 * response (so the browser stores them) and to `request.cookies` (so the
 * render that follows in this same pass reads the NEW token, not the expired
 * one it arrived with).
 */
export async function updateSession(request: NextRequest) {
  // The demo has no Supabase session to refresh and no signed-out state to
  // redirect out of — the person is a cookie, resolved per request inside
  // `createClient()`. Both halves of this function are therefore about
  // something that does not exist here, and running the optimistic redirect
  // would send every demo request to `/sign-in`, which is a screen the demo
  // deliberately has no way to complete.
  //
  // This is the third choke point, and the only one outside the two the demo
  // set out to touch. It is here because the proxy runs before rendering: with
  // it left alone, nothing below it ever renders at all.
  if (isDemoMode()) return NextResponse.next({ request })

  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    env.supabaseUrl,
    env.supabasePublishableKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value)
          }
          response = NextResponse.next({ request })
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options)
          }
          // `Cache-Control: private, no-store` and friends. A response that
          // carries a rotated session token must never be cached by a CDN, or a
          // second visitor is handed the first one's session.
          for (const [key, value] of Object.entries(headers)) {
            response.headers.set(key, value)
          }
        },
      },
    },
  )

  // Must be awaited before any response is returned: this is the call that
  // triggers the refresh and therefore the `setAll` above.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname, search } = request.nextUrl

  if (!user && !matches(pathname, PUBLIC_PREFIXES)) {
    const url = request.nextUrl.clone()
    url.pathname = SIGN_IN_PATH
    url.search = ''
    // Remember where they were headed so sign-in can finish the journey.
    url.searchParams.set('next', `${pathname}${search}`)
    return copyCookies(response, NextResponse.redirect(url))
  }

  if (user && matches(pathname, GUEST_ONLY_PREFIXES)) {
    const url = request.nextUrl.clone()
    url.pathname = AFTER_SIGN_IN
    url.search = ''
    return copyCookies(response, NextResponse.redirect(url))
  }

  return response
}

/**
 * A redirect is a different response object, so any cookie the refresh just
 * wrote has to be carried across. Dropping them here is the well-known way to
 * build an infinite redirect loop: the session is refreshed, thrown away, and
 * the next request arrives signed out again.
 */
function copyCookies(from: NextResponse, to: NextResponse) {
  for (const cookie of from.cookies.getAll()) {
    to.cookies.set(cookie)
  }
  to.headers.set('Cache-Control', 'private, no-store')
  return to
}
