'use client'

/**
 * TURNING AN ARRIVAL INTO A THREAD.
 *
 * Two inbound sources already existed and were never threaded: a website
 * enquiry and a guest portal request. This is the control that adopts one.
 *
 * ── It is idempotent, and says so when it was already done ────────────────
 *
 * The operation refuses to adopt twice — a second thread for one enquiry is
 * exactly the split this module exists to prevent — and returns
 * `alreadyOpen`. Two people clicking at the same moment both succeed and both
 * get the same thread, which is the behaviour that stops a shared inbox
 * turning a race into duplicate work.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import {
  adoptGuestRequestAction,
  adoptSiteRequestAction,
} from '@/app/(app)/inbox/_lib/actions'

export function AdoptButton({
  id,
  kind,
}: {
  id: string
  kind: 'site_request' | 'guest_request'
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  async function adopt() {
    setBusy(true)
    setError(null)
    setNote(null)

    const idempotencyKey = crypto.randomUUID()
    const result =
      kind === 'site_request'
        ? await adoptSiteRequestAction({ siteRequestId: id, idempotencyKey })
        : await adoptGuestRequestAction({ guestRequestId: id, idempotencyKey })

    setBusy(false)

    if (!result.ok) {
      setError(result.error.message)
      return
    }

    if (result.data.alreadyOpen) {
      setNote('כבר הייתה שיחה פתוחה לפנייה הזו.')
    }
    router.refresh()
  }

  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={adopt}
        className="text-xs underline disabled:opacity-50"
      >
        {busy ? 'פותח…' : 'פתח שיחה'}
      </button>
      {note !== null && (
        <span className="text-xs text-muted-foreground">{note}</span>
      )}
      {error !== null && (
        <span className="text-xs text-destructive">{error}</span>
      )}
    </span>
  )
}
