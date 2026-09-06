'use client'

/**
 * REGISTERING A DESTINATION.
 *
 * ── The URL is judged before the round trip ───────────────────────────────
 *
 * `checkWebhookUrl` runs here, in the browser, as the field changes. It is the
 * same function the operation calls and the same one the sender re-runs
 * against the resolved address — one rule, three places it is applied, and the
 * message beside the field is the message the server would have sent back.
 *
 * This is only possible because `@/lib/webhooks` deliberately excludes the
 * signer and the sender: the barrel is pure, so a Client Component can import
 * it without dragging `node:crypto` into a browser bundle. That constraint is
 * stated in `index.ts` and enforced by `scripts/client-bundle.mjs`.
 *
 * It is convenience, never the gate. The operation refuses again on the
 * server, because anything a browser checks is a suggestion.
 *
 * ── The secret is shown once, and the copy says so ────────────────────────
 *
 * On success the result carries the signing secret. It cannot be fetched
 * again by anything — the read path has no method for it and `authenticated`
 * has no privilege on the table — so this component shows it with an explicit
 * warning rather than a quiet reveal that implies it could be found later.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { DOMAIN_EVENTS } from '@/lib/contracts/events'
import type { DomainEventName } from '@/lib/contracts/events'
import { URL_REFUSAL_LABEL, checkWebhookUrl } from '@/lib/webhooks'

import { registerEndpointAction } from '@/app/(app)/settings/webhooks/_lib/actions'

/**
 * The events offered first.
 *
 * Every name in the catalogue is selectable, but a list of ninety checkboxes
 * with no order is a list nobody reads. These are the ones an external system
 * actually reacts to; the rest are behind "show everything".
 */
const COMMON: readonly DomainEventName[] = [
  'booking.created',
  'booking.cancelled',
  'payment.received',
  'invoice.issued',
  'task.overdue',
  'incident.opened',
]

export function WebhookEndpointForm() {
  const router = useRouter()
  const [url, setUrl] = useState('')
  const [description, setDescription] = useState('')
  const [selected, setSelected] = useState<readonly DomainEventName[]>([])
  const [showAll, setShowAll] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)

  const verdict = url.trim() === '' ? null : checkWebhookUrl(url)
  const urlProblem =
    verdict !== null && !verdict.ok ? URL_REFUSAL_LABEL[verdict.reason] : null

  const offered = showAll ? DOMAIN_EVENTS : COMMON
  const ready = verdict?.ok === true && selected.length > 0 && !busy

  function toggle(event: DomainEventName) {
    setSelected((current) =>
      current.includes(event)
        ? current.filter((name) => name !== event)
        : [...current, event],
    )
  }

  async function submit() {
    setBusy(true)
    setError(null)
    const result = await registerEndpointAction({
      url,
      description: description.trim() === '' ? null : description.trim(),
      events: selected,
      idempotencyKey: crypto.randomUUID(),
    })
    setBusy(false)

    if (!result.ok) {
      setError(result.error.message)
      return
    }

    setSecret(result.data.signingSecret)
    setUrl('')
    setDescription('')
    setSelected([])
    router.refresh()
  }

  if (secret !== null) {
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium">
          היעד נרשם. זהו סוד החתימה — הוא מוצג עכשיו ולא ניתן יהיה לראות אותו
          שוב.
        </p>
        <code
          dir="ltr"
          className="block break-all rounded border border-border bg-muted p-3 font-mono text-xs"
        >
          {secret}
        </code>
        <p className="text-xs text-muted-foreground">
          אם אבד — אפשר להחליף אותו במסך הזה. החלפה משאירה את הסוד הישן תקף 24
          שעות, כדי שלא תהיה שעה שבה כל המסירות נכשלות.
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
    <div className="space-y-4">
      <label className="block space-y-1">
        <span className="text-sm">כתובת היעד</span>
        <input
          dir="ltr"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://hooks.example.com/estia"
          className="w-full rounded border border-border px-3 py-2 font-mono text-sm"
        />
        {urlProblem !== null && (
          <span className="block text-xs text-destructive">{urlProblem}</span>
        )}
      </label>

      <label className="block space-y-1">
        <span className="text-sm">תיאור (לא חובה)</span>
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="מערכת הנהלת החשבונות"
          className="w-full rounded border border-border px-3 py-2 text-sm"
        />
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm">אירועים</legend>
        <div className="flex flex-wrap gap-2">
          {offered.map((event) => (
            <label
              key={event}
              className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs"
            >
              <input
                type="checkbox"
                checked={selected.includes(event)}
                onChange={() => toggle(event)}
              />
              <span dir="ltr" className="font-mono">
                {event}
              </span>
            </label>
          ))}
        </div>
        <button
          type="button"
          className="text-xs underline"
          onClick={() => setShowAll((current) => !current)}
        >
          {showAll
            ? 'הצג רק את הנפוצים'
            : `הצג את כל ${DOMAIN_EVENTS.length} האירועים`}
        </button>
        {selected.length === 0 && (
          <p className="text-xs text-muted-foreground">
            יעד בלי אירועים לא מקבל דבר. אין כאן ״הכול״ בכוונה.
          </p>
        )}
      </fieldset>

      {error !== null && <p className="text-sm text-destructive">{error}</p>}

      <button
        type="button"
        disabled={!ready}
        onClick={submit}
        className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
      >
        {busy ? 'רושם…' : 'רשום יעד'}
      </button>
    </div>
  )
}
