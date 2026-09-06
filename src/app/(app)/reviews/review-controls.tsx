'use client'

/**
 * Replying to a review, and hiding one.
 *
 * ── Why hiding asks for a sentence and not a confirmation ─────────────────
 *
 * `ConfirmDialog`'s `requiredPhrase` exists to prove intent on a destructive
 * action by making somebody retype a name. This is a different demand: the
 * reason is not a speed bump, it is a record that a person will read later —
 * possibly a guest asking why their review disappeared — and the server
 * refuses anything under eight characters regardless of what this form does.
 * The same argument `cancel-booking.tsx` makes about a cancellation reason.
 *
 * ── There is no edit control, anywhere ────────────────────────────────────
 *
 * The guest's words and score cannot be changed. Not by this screen, not by
 * the action, and not by the database — `0066_guest_reviews.sql` has a trigger
 * that rejects the UPDATE. Offering a disabled edit button would imply the
 * capability exists and is merely withheld, so there is none.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { fromSafeError } from '@/components/states/error-copy'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Textarea } from '@/components/ui/input'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

import { hideReviewAction, replyToReviewAction } from './_lib/actions'

export function ReviewControls({
  reviewId,
  hasReply,
  canManage,
}: {
  reviewId: string
  hasReply: boolean
  canManage: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState<'none' | 'reply' | 'hide'>('none')
  const [reply, setReply] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<SafeErrorBody | null>(null)

  if (!canManage) return null

  async function run(
    work: () => Promise<{ ok: boolean; error?: SafeErrorBody }>,
  ) {
    setBusy(true)
    setError(null)
    const outcome = await work()
    setBusy(false)

    if (outcome.ok) {
      setOpen('none')
      setReply('')
      setReason('')
      router.refresh()
      return
    }
    setError(outcome.error ?? null)
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => setOpen(open === 'reply' ? 'none' : 'reply')}
        >
          {hasReply ? 'עדכון התשובה' : 'השבה'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => setOpen(open === 'hide' ? 'none' : 'hide')}
        >
          הסתרה
        </Button>
      </div>

      {open === 'reply' && (
        <Field label="התשובה שלכם">
          <Textarea
            id={`reply-${reviewId}`}
            value={reply}
            rows={3}
            onChange={(event) => setReply(event.target.value)}
          />
          <Button
            type="button"
            disabled={busy || reply.trim() === ''}
            onClick={() =>
              run(() =>
                replyToReviewAction({
                  reviewId,
                  reply,
                  idempotencyKey: crypto.randomUUID(),
                }),
              )
            }
          >
            שליחה
          </Button>
        </Field>
      )}

      {open === 'hide' && (
        <Field
          label="למה הביקורת מוסתרת"
          description="הנימוק נשמר על הביקורת וגם ברישום הביקורת, ואי אפשר לשנות אותו אחר כך. הביקורת אינה נמחקת ותמשיך להיספר בדוח האיכות."
        >
          <Textarea
            id={`hide-${reviewId}`}
            value={reason}
            rows={2}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button
            type="button"
            variant="danger"
            disabled={busy || reason.trim().length < 8}
            onClick={() =>
              run(() =>
                hideReviewAction({
                  reviewId,
                  reason,
                  idempotencyKey: crypto.randomUUID(),
                }),
              )
            }
          >
            הסתרה
          </Button>
        </Field>
      )}

      {error && (
        <p className="text-xs text-destructive">{fromSafeError(error).title}</p>
      )}
    </div>
  )
}
