'use client'

/**
 * Asking for towels.
 *
 * ── The idempotency key is minted when the form OPENS ─────────────────────
 *
 * This is the one place in the whole guest journey where the client supplies
 * an idempotency key, and the timing is the entire reason it works.
 *
 * Every other guest write is idempotent on a domain fact: confirming version 4
 * twice is one confirmation of version 4, there is one live signature per
 * booking, details are keyed on the booking. A request has no such fact — two
 * genuine requests for towels an hour apart are two requests, and no
 * combination of category, body and timestamp can tell them apart from a
 * double tap.
 *
 * So the key is minted in `useState`'s initialiser, which runs once when the
 * form mounts. A double tap shares it and produces one request. After a
 * successful submission the key is rolled, so the next request the guest
 * composes carries a new one and produces a second row. `guest_requests` is
 * unique on `(booking_id, client_key)` and the RPC returns the existing row
 * rather than an error when it collides — including when the second tap races
 * the first one's read.
 *
 * ── What the guest is told afterwards ─────────────────────────────────────
 *
 * התקבלה, and nothing about who will do it or when. The request becomes a row
 * in `public.tasks` and the staff side of that — the assignee, the note, the
 * completion comment — is never projected back. See §11 of migration 0034.
 */

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { submitRequestAction } from '@/app/g/[token]/_lib/actions'
import { useAsyncAction } from '@/components/ui/async-action'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Textarea } from '@/components/ui/input'
import {
  GUEST_REQUEST_CATEGORY_LABEL,
  type GuestRequestCategory,
} from '@/lib/guest-journey/types'

export function RequestForm({
  token,
  categories,
}: {
  token: string
  categories: readonly GuestRequestCategory[]
}) {
  const router = useRouter()
  const { pending, run } = useAsyncAction()

  // Once, on mount. See the header — this is the whole mechanism.
  const [clientKey, setClientKey] = useState(() => crypto.randomUUID())
  const [category, setCategory] = useState<GuestRequestCategory | null>(null)
  const [body, setBody] = useState('')
  const [sent, setSent] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  // A business can switch requests off, or narrow the categories. With none
  // configured there is nothing to render — not a disabled form.
  if (categories.length === 0) return null

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (pending || category === null) return

        setProblem(null)
        setSent(false)

        void run(async () => {
          const result = await submitRequestAction(token, {
            category,
            body: body.trim() || null,
            clientKey,
          })

          if (result.ok) {
            setSent(true)
            setCategory(null)
            setBody('')
            // Rolled only after a success. A retry after a failure must reuse
            // the old key, or a request that actually landed would be sent
            // twice.
            setClientKey(crypto.randomUUID())
            router.refresh()
            return
          }

          setProblem(result.error.message)
        })
      }}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium text-foreground">
          מה נדרש?
        </legend>

        {/* Buttons rather than a <select>: on a telephone a native select is a
            modal wheel, and six options fit on the screen as targets big
            enough to hit while holding a suitcase. */}
        <div className="flex flex-wrap gap-2">
          {categories.map((option) => {
            const active = category === option
            return (
              <button
                key={option}
                type="button"
                aria-pressed={active}
                onClick={() => setCategory(option)}
                className={
                  active
                    ? 'rounded-full border-2 border-primary bg-primary-soft px-4 py-2 text-sm font-semibold text-primary'
                    : 'rounded-full border border-border-strong bg-surface px-4 py-2 text-sm text-foreground'
                }
              >
                {GUEST_REQUEST_CATEGORY_LABEL[option]}
              </button>
            )
          })}
        </div>
      </fieldset>

      <Field label="פרטים" description="לא חובה — אבל עוזר לנו להביא את הנכון">
        <Textarea
          value={body}
          rows={3}
          maxLength={2000}
          placeholder="למשל: שתי מגבות גדולות נוספות"
          onChange={(event) => setBody(event.target.value)}
        />
      </Field>

      <Button
        type="submit"
        size="lg"
        className="w-full"
        disabled={pending || category === null}
      >
        {pending ? 'שולח…' : 'שליחת הבקשה'}
      </Button>

      {sent && (
        <p
          role="status"
          className="rounded-lg border border-success bg-success/10 px-3 py-2 text-sm text-foreground"
        >
          הבקשה התקבלה. אפשר לעקוב אחריה ברשימה למטה.
        </p>
      )}

      {problem && (
        <p
          role="alert"
          className="rounded-lg border border-danger bg-danger/10 px-3 py-2 text-sm text-foreground"
        >
          {problem}
        </p>
      )}
    </form>
  )
}
