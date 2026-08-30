/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Server Components, Server Actions and Route Handlers. Never a
 * `"use client"` module: this file reads `next/headers`, which does not exist
 * in the browser, and importing it from a client component is the classic
 * Supabase-on-Next mistake.
 *
 * Like the browser client it uses the PUBLISHABLE key, so every query it makes
 * still runs as the signed-in user and is still subject to row level security.
 * That is deliberate. A server render is not a reason to escalate privilege —
 * for that there is `./admin.ts`, and it is a separate decision every time.
 *
 * Cookie contract (`@supabase/ssr` 0.12.x)
 * ----------------------------------------
 * `getAll` / `setAll` are both implemented. The deprecated `get`/`set`/`remove`
 * trio is not used: the library's own documentation warns that it misses edge
 * cases and produces random logouts that are very hard to debug.
 *
 * `setAll` throws when a Server Component tries to write — Next.js has already
 * begun streaming the response by then, and HTTP does not allow a `Set-Cookie`
 * after that. That throw is caught and ignored HERE and only here, because
 * `src/proxy.ts` refreshes the session on every request before any rendering
 * starts. If the proxy is ever removed, sessions will silently stop refreshing
 * and this comment is the place that explains why.
 */

import { cache } from 'react'

import { createServerClient } from '@supabase/ssr'
import type { User } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

import { env } from '@/lib/env'
import { isDemoMode } from '@/lib/demo/flag'

/**
 * The demo, loaded only when it is on.
 *
 * A dynamic import rather than a static one, so that with the flag off nothing
 * in `src/lib/demo` is ever evaluated: not the dataset, not the in-memory
 * client, not the persona cookies. The two functions below are the only place
 * in the application where the database and the signed-in person are chosen,
 * which is exactly why the demo is wired here and nowhere else — one branch,
 * twice, and every screen above it is untouched.
 */
async function demo() {
  return import('@/lib/demo')
}

function assertServer() {
  if (typeof window !== 'undefined') {
    throw new Error(
      'src/lib/supabase/server.ts was imported into the browser. ' +
        'Use src/lib/supabase/client.ts in client components.',
    )
  }
}

/**
 * A new client per request. Never hoist this into a module-level constant:
 * one client would then be shared by every concurrent request, and with it one
 * user's session.
 */
export async function createClient(): Promise<ServerClient> {
  assertServer()

  if (isDemoMode()) {
    // The rows come from memory and the person comes from a cookie. Everything
    // above this line — every adapter, every page query, every embed — is the
    // code a paying customer runs, and cannot tell the difference. The cast is
    // the same one `fake-client.ts` and `TransactionClient` make.
    const {
      createDemoClient,
      currentDemoPersona,
      demoUser,
      sharedDemoDatabase,
    } = await demo()
    const persona = await currentDemoPersona()
    return createDemoClient(
      sharedDemoDatabase(),
      demoUser(persona),
    ) as unknown as ServerClient
  }

  return supabaseClient()
}

/**
 * The real one, unchanged.
 *
 * Split out from `createClient` only so that `ServerClient` below can be its
 * return type. The alternative was annotating the demo branch with
 * `ReturnType<typeof createServerClient>`, which is *not* the same type: the
 * function is generic, and naming it without type arguments resolves the
 * parameters to their defaults rather than to what this call site infers. The
 * result type-checks and then degrades every `data` in every caller to `any`,
 * which showed up as an implicit-any three files away and would otherwise have
 * been a silent loss of type safety across the whole read layer.
 */
async function supabaseClient() {
  const cookieStore = await cookies()

  return createServerClient(env.supabaseUrl, env.supabasePublishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // Server Component render: cookies are read-only here. The proxy
          // already refreshed the session for this request, so nothing is lost.
          // Next.js marks any route that reads cookies as dynamic, so the
          // no-store headers `setAll` also offers are not needed.
        }
      },
    },
  })
}

/** Exactly what `createServerClient` infers at that call site, and nothing wider. */
type ServerClient = Awaited<ReturnType<typeof supabaseClient>>

/**
 * The authenticated user, or `null`.
 *
 * `getUser()`, not `getSession()`. `getSession()` returns whatever the cookie
 * claims without checking it, so a forged cookie would satisfy it. `getUser()`
 * revalidates the JWT against the auth server, which is the only answer worth
 * gating a page on.
 *
 * Wrapped in React `cache` so a layout, a page and an action inside the same
 * render share one round trip instead of three.
 *
 * Deliberately not branched for the demo. `createClient()` above already
 * returns a client whose `auth.getUser()` answers with the persona, so this
 * function reaches the demo identity along its ordinary path — one substitution
 * rather than two, and no second place to keep in step with the first.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()

  // A missing or expired session is the normal signed-out case, not a fault.
  if (error) return null

  return data.user ?? null
})
