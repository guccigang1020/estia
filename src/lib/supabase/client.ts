/**
 * EXECUTION CONTEXT — BROWSER ONLY.
 *
 * This module is the one Supabase client that may appear inside a
 * `"use client"` component. It carries the `"use client"` directive itself, so
 * the bundler refuses to pull it into a Server Component graph rather than
 * letting the mistake compile and fail at runtime.
 *
 * It is built with the PUBLISHABLE key. That key grants nothing on its own —
 * every table in this project is protected by row level security (see
 * `supabase/migrations/0004_rls.sql`), so a copy of it in the browser is
 * expected and safe. The service role key is the opposite and must never come
 * near this file: see `./admin.ts`.
 *
 * Session storage is cookies, not localStorage. `@supabase/ssr` enforces that,
 * which is exactly what lets `./server.ts` read the same session during a
 * server render. Auth state written here is therefore visible to the server on
 * the next request.
 *
 * Almost nothing in ESTIA's authentication flow needs this client: every
 * mutation is a Server Action, which is both safer and works without
 * JavaScript. Reach for it only when a client component genuinely needs to
 * observe auth state in the browser — for example `onAuthStateChange`.
 */

'use client'

import { createBrowserClient } from '@supabase/ssr'

import { env } from '@/lib/env'

/**
 * `@supabase/ssr` already memoises this per browser tab (`isSingleton`
 * defaults to true), so calling it from several components does not open
 * several clients or several token-refresh timers.
 */
export function createClient() {
  return createBrowserClient(env.supabaseUrl, env.supabasePublishableKey)
}
