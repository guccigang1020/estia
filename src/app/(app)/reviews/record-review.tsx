'use client'

/**
 * Writing down a review that arrived somewhere else.
 *
 * ── Why this form exists at all ───────────────────────────────────────────
 *
 * Most guesthouses in this market are sent a paragraph on WhatsApp and have
 * nowhere to put it. Without this the module could read reviews and never
 * receive one, because the guest portal's own form belongs to another agent's
 * work in this repository — so `recordReviewAction` would have been a write
 * path with no door, which is the exact shape `product-reality.mjs` exists to
 * catch.
 *
 * ── The stay list is the server's, not a free text field ──────────────────
 *
 * `bookingId` comes from a list the server built from the SAME statuses
 * `tg_review_needs_a_completed_stay` accepts, minus the stays already
 * reviewed. So the form cannot offer a booking the database is about to
 * refuse, and a person is never told "no" by a constraint they had no way to
 * see. The database still refuses independently — that is the point of having
 * both.
 *
 * ── The dimensions are optional and stay optional ─────────────────────────
 *
 * Only the overall score is required. Somebody typing in a review they were
 * sent has one number and a paragraph; demanding five more would mean either
 * an abandoned form or five invented numbers, and invented numbers are worse
 * because they look like measurements afterwards.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { fromSafeError } from '@/components/states/error-copy'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Textarea } from '@/components/ui/input'
import { DIMENSION_LABEL, REVIEW_DIMENSIONS } from '@/lib/reviews'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

import { recordReviewAction } from './_lib/actions'
import type { ReviewableStay } from './_lib/queries'

const STARS = [1, 2, 3, 4, 5] as const

/** The action's field name for each dimension, which is camelCase there. */
const FIELD = {
  cleanliness: 'cleanliness',
  accuracy: 'accuracy',
  communication: 'communication',
  location: 'location',
  value_for_money: 'valueForMoney',
} as const

export function RecordReview({ stays }: { stays: readonly ReviewableStay[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [bookingId, setBookingId] = useState('')
  const [overall, setOverall] = useState(0)
  const [comment, setComment] = useState('')
  const [dimensions, setDimensions] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<SafeErrorBody | null>(null)

  if (stays.length === 0) return null

  async function submit() {
    setBusy(true)
    setError(null)

    const outcome = await recordReviewAction({
      bookingId,
      overall,
      comment: comment.trim() === '' ? undefined : comment.trim(),
      cleanliness: dimensions.cleanliness,
      accuracy: dimensions.accuracy,
      communication: dimensions.communication,
      location: dimensions.location,
      valueForMoney: dimensions.valueForMoney,
      idempotencyKey: crypto.randomUUID(),
    })

    setBusy(false)

    if (outcome.ok) {
      setOpen(false)
      setBookingId('')
      setOverall(0)
      setComment('')
      setDimensions({})
      router.refresh()
      return
    }
    setError(outcome.error)
  }

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)}>
        רישום ביקורת שהתקבלה
      </Button>
    )
  }

  return (
    <div className="space-y-3">
      <Field
        label="השהייה"
        description="רק שהיות שהסתיימו ושאין להן עדיין ביקורת. הרשימה נבנית מאותם סטטוסים שהמסד מקבל."
      >
        <select
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={bookingId}
          onChange={(event) => setBookingId(event.target.value)}
        >
          <option value="">בחרו שהייה</option>
          {stays.map((stay) => (
            <option key={stay.bookingId} value={stay.bookingId}>
              {stay.reference} · יצא ב-{stay.checkOut}
            </option>
          ))}
        </select>
      </Field>

      <Field label="ציון כללי" description="חובה. שאר הנושאים אופציונליים.">
        <Stars value={overall} onChange={setOverall} />
      </Field>

      <Field
        label="מה האורח כתב"
        description="העתיקו את מה שנשלח, כלשונו. אחרי השמירה אי אפשר לערוך את הטקסט — כך גם ביקורת שהוזנה ידנית אינה ניתנת לשכתוב בדיעבד."
      >
        <Textarea
          value={comment}
          rows={4}
          onChange={(event) => setComment(event.target.value)}
        />
      </Field>

      {REVIEW_DIMENSIONS.map((dimension) => (
        <Field key={dimension} label={DIMENSION_LABEL[dimension]}>
          <Stars
            value={dimensions[FIELD[dimension]] ?? 0}
            onChange={(value) =>
              setDimensions((current) => ({
                ...current,
                [FIELD[dimension]]: value,
              }))
            }
          />
        </Field>
      ))}

      <div className="flex gap-2">
        <Button
          type="button"
          disabled={busy || bookingId === '' || overall === 0}
          onClick={submit}
        >
          שמירה
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          ביטול
        </Button>
      </div>

      {error && (
        <p className="text-xs text-destructive">{fromSafeError(error).title}</p>
      )}
    </div>
  )
}

/**
 * Five buttons, not a number input.
 *
 * `type="button"` on every one of them: inside a form a bare `<button>`
 * submits, and a star rating that submits the form on the first click is the
 * kind of bug that only appears once somebody wraps this in a `<form>`.
 */
function Stars({
  value,
  onChange,
}: {
  value: number
  onChange: (value: number) => void
}) {
  return (
    <div className="flex gap-1">
      {STARS.map((star) => (
        <button
          key={star}
          type="button"
          aria-label={`${star} כוכבים`}
          aria-pressed={value === star}
          onClick={() => onChange(star)}
          className={
            value >= star
              ? 'rounded-md border border-foreground px-3 py-1 text-sm'
              : 'rounded-md border px-3 py-1 text-sm text-muted-foreground'
          }
        >
          {star}
        </button>
      ))}
    </div>
  )
}
