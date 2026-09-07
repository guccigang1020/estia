'use client'

/**
 * "Merged three days ago · undo."
 *
 * ── The button is offered; the refusal is where the honesty is ────────────
 *
 * `undoAvailability` only knows whether the thirty days are up. Whether the
 * undo can actually run depends on whether any moved row has been edited since
 * — a question about rows this screen never read, which `guest_merge_undo`
 * answers by comparing the `version` it recorded at the moment of each move.
 *
 * So the control does not promise. It offers, and when the database refuses it
 * shows the refusal, which names every table and id that moved on. That is the
 * right way round: an undo that silently overwrote two weeks of somebody's
 * corrections would be worse than no undo at all, and a button that hid itself
 * whenever it was unsure would hide itself almost always.
 *
 * ── The reason is required, and it is not the merge's reason ──────────────
 *
 * §13.2 lists undoing a merge among the actions that need one of their own.
 * "Why did you join these two" and "why did you separate them again" are
 * different questions and the second is the one somebody asks later.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { undoGuestMergeAction } from '@/app/(app)/guests/merge/_lib/actions'
import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Textarea } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
// The leaf module, not the barrel: `@/lib/leads` re-exports `operations.ts`,
// which reaches `@/lib/persistence` and through it the `postgres` driver. A
// Client Component that pulls a Node builtin takes every route down with
// `Can't resolve 'fs'`, from a file nobody touched.
import { MERGE_REASON_MIN } from '@/lib/leads/merge'

export function UndoMergeControl({
  mergeId,
  daysLeft,
}: {
  mergeId: string
  daysLeft: number
}) {
  const router = useRouter()
  const run = useAsyncAction<void>()

  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [idempotencyKey] = useState(() => crypto.randomUUID())

  const tooShort = reason.trim().length < MERGE_REASON_MIN

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        בטל מיזוג · נותרו {daysLeft} ימים
      </Button>
    )
  }

  return (
    <form
      className="flex w-full flex-col gap-3 rounded-lg border border-border bg-muted p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (tooShort || run.pending) return

        setFailure(null)
        void run.run(async () => {
          const result = await undoGuestMergeAction({
            mergeId,
            reason: reason.trim(),
            idempotencyKey,
          })

          if (!result.ok) {
            setFailure(result.error)
            return
          }
          setOpen(false)
          router.refresh()
        })
      }}
    >
      <Field
        label="למה מבטלים"
        description={`לפחות ${MERGE_REASON_MIN} תווים. הביטול מחזיר בדיוק את השורות שהועברו — ואם אחת מהן נערכה מאז, הוא ייעצר ויפרט מה השתנה במקום למחוק את העבודה הזאת.`}
        required
      >
        <Textarea
          rows={2}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>

      {failure && <ActionError error={failure} />}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={tooShort || run.pending}>
          {run.pending ? 'מבטל…' : 'בטל את המיזוג'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setOpen(false)}
        >
          השאר כפי שהוא
        </Button>
      </div>
    </form>
  )
}
