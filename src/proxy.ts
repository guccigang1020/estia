/**
 * EXECUTION CONTEXT — Next.js Proxy. Runs before every matched request.
 *
 * Next.js 16 renamed Middleware to Proxy. There is no `middleware.ts` in this
 * project and adding one would do nothing: the convention is a single
 * `proxy.ts` beside `app`, exporting `proxy` (or a default export). Verified
 * against `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`,
 * which states that the middleware convention is deprecated and renamed.
 *
 * Only one proxy file is supported per project, so this file stays a thin
 * dispatcher: the session logic lives in `src/lib/supabase/proxy.ts` and other
 * concerns should be added here as further imported modules, not inlined.
 */

import type { NextRequest } from 'next/server'

import { updateSession } from '@/lib/supabase/proxy'

export async function proxy(request: NextRequest) {
  return updateSession(request)
}

export const config = {
  /**
   * Everything except static assets. The negative lookahead matters: without a
   * matcher, proxy also runs on `_next/static`, `_next/image` and files in
   * `public/`, and the redirect above would then intercept the stylesheet of
   * the very sign-in page it redirects to.
   *
   * `.well-known` is excluded so ACME and passkey association files stay
   * reachable without a session.
   */
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|\\.well-known|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff|woff2|ttf|otf|css|js|map|txt|xml)$).*)',
  ],
}
