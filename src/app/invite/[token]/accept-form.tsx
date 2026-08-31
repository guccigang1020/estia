'use client'

/**
 * EXECUTION CONTEXT — CLIENT COMPONENT. The one control that consumes a token.
 *
 * A client component for three reasons a server component cannot hold: the
 * pending state while the round trip runs, the failure to render in place
 * rather than as a thrown digest, and the confirmation that replaces the
 * button once the membership exists.
 *
 * The token is passed in as a prop, which means it is in the HTML this page
 * sends to the browser. That is not a leak: the token is already in the URL
 * the browser navigated to, in its address bar and its history. What matters
 * is that it goes nowhere else — no analytics, no logging, no query string on
 * the redirect afterwards.
 */

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { ActionError } from '@/components/booking/action-error'
import { useAsyncAction } from '@/components/ui/async-action'
import { Button } from '@/components/ui/button'
import type { SafeErrorBody } from '@/lib/errors'

import { acceptInvitationAction } from './_lib/actions'

export function AcceptForm({
  token,
  organizationName,
}: {
  token: string
  organizationName: string | null
}) {
  const router = useRouter()
  const accept = useAsyncAction<void>()
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [joined, setJoined] = useState<string | null>(null)

  if (joined) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-foreground">
          הצטרפת ל{joined}. אפשר להתחיל לעבוד.
        </p>
        <div>
          <Button onClick={() => router.push('/dashboard')}>
            כניסה למערכת
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (accept.pending) return

        setFailure(null)
        void accept.run(async () => {
          const result = await acceptInvitationAction(token)

          if (!result.ok) {
            setFailure(result.error)
            return
          }

          setJoined(result.data.organizationName || 'ארגון')
          // The shell reads the membership on the server, so the new one is
          // only visible after a fresh render.
          router.refresh()
        })
      }}
    >
      {failure ? <ActionError error={failure} /> : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={accept.pending}>
          {accept.pending ? 'מצטרף…' : 'אישור והצטרפות'}
        </Button>
        <span aria-live="polite" className="sr-only">
          {accept.pending ? 'מצרף אותך לארגון' : ''}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        אישור יצרף את החשבון שלך{' '}
        {organizationName ? `ל${organizationName}` : ''} בתפקיד שנקבע עבורך.
        ההזמנה תקפה לפעם אחת בלבד.
      </p>
    </form>
  )
}
