/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The guest portal's frame.
 *
 * ── Why this file belongs to the coordinator and not to a feature ─────────
 *
 * Two workers build inside this portal — the guest journey and the store —
 * and both need the same answer to "whose booking is this". If either
 * resolved the token itself there would be two readings of one capability,
 * and the day they disagree is the day one section shows a guest somebody
 * else's stay. So the token is resolved exactly once, here, and everything
 * below receives the result.
 *
 * ── What this frame does and does not do ──────────────────────────────────
 *
 * It resolves, it refuses, and it renders a shell. It renders no journey step,
 * no store card and no call to action; those belong to the segments. A layout
 * that started deciding what a guest should do next would become the third
 * place the journey is defined.
 *
 * ── Refusing ──────────────────────────────────────────────────────────────
 *
 * A bad link is not an error page. Somebody holding a link that was revoked,
 * or that expired, or that lost its last character to a mail client, has done
 * nothing wrong and cannot fix it themselves — so each refusal says which of
 * those happened and what to do about it, in Hebrew, and never shows a stack
 * trace or a correlation id they cannot use.
 *
 * ── The token in the URL ──────────────────────────────────────────────────
 *
 * `robots` refuses indexing and following. The token is a bearer credential
 * for one booking; a search engine that crawled it would publish somebody's
 * stay, and a referrer header carrying it is why nothing here links outward
 * without care. It is never written to a log — see `session.ts`.
 */

import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { loadGuestSession } from '@/lib/guest-portal'
import { toSafeResponse } from '@/lib/errors'

export const metadata: Metadata = {
  title: 'ההזמנה שלך',
  robots: { index: false, follow: false },
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      dir="rtl"
      className="mx-auto flex min-h-svh w-full max-w-2xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10"
    >
      {children}
    </div>
  )
}

export default async function GuestPortalLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  try {
    // Resolved here so that a refused link never reaches a segment. The
    // result is cached for the request, so the page below pays nothing to ask
    // again.
    await loadGuestSession(token)
  } catch (cause) {
    const { error } = toSafeResponse(cause, crypto.randomUUID())

    return (
      <Frame>
        <div className="flex flex-1 flex-col justify-center gap-4 text-center">
          <h1 className="font-display text-2xl font-bold text-foreground">
            לא הצלחנו לפתוח את ההזמנה
          </h1>
          <p className="text-sm text-muted-foreground">{error.message}</p>
          <p className="text-xs text-muted-foreground">
            אם הקישור הגיע אליך בהודעה, ודא שהעתקת אותו במלואו.
          </p>
        </div>
      </Frame>
    )
  }

  return <Frame>{children}</Frame>
}
