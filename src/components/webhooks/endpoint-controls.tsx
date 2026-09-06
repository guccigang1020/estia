'use client'

/**
 * PAUSING AND ROTATING.
 *
 * ── The version is carried ────────────────────────────────────────────────
 *
 * `expectedVersion` goes with both writes, so two people acting on the same
 * endpoint from two tabs get a conflict somebody is told about rather than a
 * silent last-write-wins.
 *
 * ── Rotation warns before it acts ─────────────────────────────────────────
 *
 * A rotation changes what every future delivery is signed with. The old
 * secret keeps verifying for twenty-four hours, which is the only reason the
 * operation is safe to offer as a button at all — without that overlap this
 * would be a button that breaks a customer's integration instantly. The copy
 * says the number rather than leaving somebody to find out.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import type { WebhookEndpointStatus } from '@/lib/webhooks'

import {
  rotateSecretAction,
  togglePausedAction,
} from '@/app/(app)/settings/webhooks/_lib/actions'

export function EndpointControls({
  endpointId,
  status,
  expectedVersion,
}: {
  endpointId: string
  status: WebhookEndpointStatus
  expectedVersion: number
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  async function toggle() {
    setBusy(true)
    setError(null)
    const result = await togglePausedAction({
      endpointId,
      expectedVersion,
      idempotencyKey: crypto.randomUUID(),
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    router.refresh()
  }

  async function rotate() {
    setBusy(true)
    setError(null)
    const result = await rotateSecretAction({
      endpointId,
      expectedVersion,
      idempotencyKey: crypto.randomUUID(),
    })
    setBusy(false)
    setConfirming(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setSecret(result.data.signingSecret)
    router.refresh()
  }

  if (secret !== null) {
    return (
      <div className="space-y-2 rounded border border-border p-3">
        <p className="text-sm font-medium">
          סוד חתימה חדש. מוצג עכשיו ולא ניתן יהיה לראות אותו שוב.
        </p>
        <code
          dir="ltr"
          className="block break-all rounded bg-muted p-2 font-mono text-xs"
        >
          {secret}
        </code>
        <p className="text-xs text-muted-foreground">
          הסוד הקודם ימשיך לאמת מסירות עוד 24 שעות. עד אז כל מסירה חתומה בשניהם.
        </p>
        <button
          type="button"
          className="text-sm underline"
          onClick={() => setSecret(null)}
        >
          שמרתי אותו
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-3 pt-1">
      <button
        type="button"
        disabled={busy}
        onClick={toggle}
        className="text-sm underline disabled:opacity-50"
      >
        {status === 'active' ? 'השהה' : 'הפעל'}
      </button>

      {confirming ? (
        <span className="flex items-center gap-2 text-xs">
          להחליף את סוד החתימה? הישן יאמת עוד 24 שעות.
          <button
            type="button"
            disabled={busy}
            onClick={rotate}
            className="underline disabled:opacity-50"
          >
            כן, החלף
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="underline"
          >
            בטל
          </button>
        </span>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirming(true)}
          className="text-sm underline disabled:opacity-50"
        >
          החלף סוד חתימה
        </button>
      )}

      {error !== null && (
        <span className="text-xs text-destructive">{error}</span>
      )}
    </div>
  )
}
