import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'

import { getCurrentUser } from '@/lib/supabase/server'

import { DEFAULT_AFTER_SIGN_IN } from '../_lib/redirect-target'

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Guard for the guest-only screens.
 *
 * Someone already signed in has no business on a sign-in form; landing there
 * from a stale tab or a bookmarked link should move them on, not offer to
 * authenticate them a second time.
 *
 * `src/proxy.ts` performs the same redirect earlier and faster. This is not
 * redundant. The Next.js authentication guide is explicit that a proxy check
 * is OPTIMISTIC — it reads a cookie, it runs on prefetches, and it must not be
 * the only gate. `getCurrentUser()` revalidates the JWT against the auth
 * server, which is what actually establishes identity. The proxy is the
 * optimisation; this is the decision.
 */
export default async function GuestLayout({
  children,
}: {
  children: ReactNode
}) {
  const user = await getCurrentUser()

  if (user) redirect(DEFAULT_AFTER_SIGN_IN)

  return <>{children}</>
}
