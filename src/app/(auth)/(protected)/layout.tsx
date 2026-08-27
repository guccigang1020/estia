import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'

import { getCurrentUser } from '@/lib/supabase/server'

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. THE authentication gate.
 *
 * This is the pattern an authenticated area of ESTIA should follow: a layout
 * that resolves the user on the server, redirects when there is none, and
 * renders nothing until that has happened. A page below it can assume a user
 * exists, because it never renders without one.
 *
 * The `next=` parameter that returns a user to the page they were reaching for
 * is added by `src/proxy.ts`, which is the layer that still has the request URL
 * — a layout is not given its own pathname. In practice the proxy redirects
 * first and this gate only fires when the proxy's optimistic read of the
 * cookie disagreed with the auth server, so plain `/sign-in` is the right
 * destination here.
 *
 * WHAT THIS DOES NOT DO — and must not start doing.
 * It proves WHO someone is. It says nothing about WHAT THEY MAY DO. Roles,
 * permissions and scope are `can(user, action, resource)` in
 * `src/lib/authz/can.ts`, they are enforced in the service layer, and beneath
 * both sits row level security in the database. A second, weaker copy of that
 * logic growing here — a role check in a layout, a permission cached in a
 * cookie — is how authorization ends up with two answers that disagree.
 *
 * PLACEMENT. This sits inside the `(auth)` route group because that is the
 * directory this engineer owns. The real authenticated shell belongs in its
 * own top-level group alongside the dashboard; moving it is a directory
 * rename, and the guard itself is unchanged by the move.
 */
export default async function ProtectedLayout({
  children,
}: {
  children: ReactNode
}) {
  const user = await getCurrentUser()

  if (!user) redirect('/sign-in')

  return <>{children}</>
}
