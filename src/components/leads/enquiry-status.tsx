'use client'

/**
 * Moving one enquiry along, from the pipeline board.
 *
 * ── The control offers only moves that exist ──────────────────────────────
 *
 * The options come from `nextStatuses`, which reads the same table
 * `tg_lead_is_governed` enforces — so a stage that cannot be reached from here
 * is not in the list rather than being offered and refused. A dropdown that
 * lets somebody pick "הפך להזמנה" from `new` and then explains why not is a
 * dropdown that wastes the one moment they were paying attention.
 *
 * ── Closing a lead asks why, in the same breath ───────────────────────────
 *
 * ק40 and §5.4: dragging to `lost` opens the reason and CHANGES NOTHING until
 * one is chosen. So the reason fields appear as soon as `lost` is selected and
 * the button stays disabled until they are complete — the move and its reason
 * are one decision, not a move followed by a question.
 *
 * ── Why the version is carried ────────────────────────────────────────────
 *
 * The board is a screen two people work at once. `expectedVersion` makes a
 * second submission against a stale card a conflict the pipeline reports,
 * rather than one colleague's decision quietly overwriting another's.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { changeEnquiryStatusAction } from '@/app/(app)/leads/_lib/actions'
import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, TextInput, Textarea } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
// Leaf modules, not the barrel. `@/lib/leads` re-exports `operations.ts`,
// which reaches `@/lib/persistence` and through it the `postgres` driver —
// and a Client Component that pulls a Node builtin takes every route down
// with `Can't resolve 'fs'`, from a file nobody touched. `scripts/client-bundle.mjs`
// exists to catch exactly this, and it caught it here.
import {
  LEAD_LOST_REASONS,
  LEAD_LOST_REASON_LABEL,
  LEAD_STATUS_LABEL,
  type LeadLostReason,
  type LeadStatus,
} from '@/lib/leads/types'
import { nextStatuses, problemsWith } from '@/lib/leads/transitions'

export function EnquiryStatusControl({
  leadId,
  status,
  version,
  displayName,
}: {
  leadId: string
  status: LeadStatus
  version: number
  displayName: string
}) {
  const router = useRouter()
  const move = useAsyncAction<void>()

  const options = nextStatuses(status)
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<LeadStatus | ''>('')
  const [lostReason, setLostReason] = useState<LeadLostReason | ''>('')
  const [lostNote, setLostNote] = useState('')
  const [bookingId, setBookingId] = useState('')
  const [note, setNote] = useState('')
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)

  if (options.length === 0) {
    // `booked` is terminal. Saying so is more useful than an empty control:
    // somebody looking for the button needs to know it is absent on purpose.
    return (
      <p className="text-sm text-muted-foreground">
        הפנייה הפכה להזמנה. זה מצב סופי — ביטול ההזמנה לא מחזיר אותה לצנרת.
      </p>
    )
  }

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        עדכון מצב
      </Button>
    )
  }

  // The same function the server runs, so the button is disabled for exactly
  // the reasons the operation would refuse — and the sentence a person reads
  // is the sentence the server would have sent.
  const problems =
    target === ''
      ? [{ field: 'status', message: 'יש לבחור מצב.' }]
      : problemsWith({
          from: status,
          to: target,
          lostReason: lostReason === '' ? null : lostReason,
          lostNote,
          bookingId: bookingId.trim() === '' ? null : bookingId.trim(),
          // The screen cannot know the booking's status, so it does not
          // pretend to: the "is this really a stay" test belongs to the server,
          // which reads the booking. This one only checks the shape.
          bookingStatus: 'confirmed',
          reason: note,
        })

  const blocking = problems.filter((problem) => problem.field !== 'bookingId')

  return (
    <form
      className="flex w-full flex-col gap-4 rounded-lg border border-border bg-muted p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (target === '' || blocking.length > 0 || move.pending) return

        setFailure(null)
        void move.run(async () => {
          const result = await changeEnquiryStatusAction({
            leadId,
            status: target,
            lostReason:
              target === 'lost' && lostReason !== '' ? lostReason : null,
            lostNote: target === 'lost' ? lostNote : null,
            bookingId: bookingId.trim() === '' ? null : bookingId.trim(),
            note: note.trim() === '' ? null : note.trim(),
            expectedVersion: version,
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
      <p className="text-sm text-muted-foreground">
        עדכון הפנייה של {displayName}, כרגע ב״{LEAD_STATUS_LABEL[status]}״.
      </p>

      <Field label="מצב חדש" required>
        <Select
          value={target}
          onChange={(event) => setTarget(event.target.value as LeadStatus)}
        >
          <option value="">בחר…</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {LEAD_STATUS_LABEL[option]}
            </option>
          ))}
        </Select>
      </Field>

      {target === 'lost' && (
        <>
          <Field
            label="סיבת סגירה"
            description="בלי זה אי אפשר ללמוד למה מפסידים פניות, ולכן היא חובה."
            required
          >
            <Select
              value={lostReason}
              onChange={(event) =>
                setLostReason(event.target.value as LeadLostReason)
              }
            >
              <option value="">בחר…</option>
              {LEAD_LOST_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {LEAD_LOST_REASON_LABEL[reason]}
                </option>
              ))}
            </Select>
          </Field>

          {lostReason === 'other' && (
            <Field label="פירוט" required>
              <TextInput
                value={lostNote}
                onChange={(event) => setLostNote(event.target.value)}
              />
            </Field>
          )}
        </>
      )}

      {target === 'booked' && (
        <Field
          label="מזהה ההזמנה שנוצרה"
          description="הפנייה תצא מהצנרת ותוצג כתוצאה של ההזמנה הזאת, כדי שאותו אדם לא ייספר פעמיים."
          required
        >
          <TextInput
            dir="ltr"
            value={bookingId}
            onChange={(event) => setBookingId(event.target.value)}
          />
        </Field>
      )}

      {status === 'lost' && (
        <Field
          label="נימוק לפתיחה מחדש"
          description="פתיחה מחדש מוחקת את סיבת הסגירה, ולכן היא נרשמת עם נימוק."
          required
        >
          <Textarea
            rows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
      )}

      {blocking.length > 0 && target !== '' && (
        <ul className="flex flex-col gap-1 text-sm text-danger">
          {blocking.map((problem) => (
            <li key={problem.field}>{problem.message}</li>
          ))}
        </ul>
      )}

      {failure && <ActionError error={failure} />}

      <div className="flex flex-wrap gap-3">
        <Button
          type="submit"
          size="sm"
          disabled={target === '' || blocking.length > 0 || move.pending}
        >
          {move.pending ? 'שומר…' : 'עדכן'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen(false)}
        >
          ביטול
        </Button>
      </div>
    </form>
  )
}
