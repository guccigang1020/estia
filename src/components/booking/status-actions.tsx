'use client'

/**
 * The moves this person can make on this booking, right now.
 *
 * ── Where the buttons come from ───────────────────────────────────────────
 *
 * `legalNextStatuses(actor, { booking, now })`, computed on the server and
 * passed in. Not a status comparison written here, and not a hard-coded list:
 * the state machine already knows which moves are legal from this status,
 * which permission each one needs — `deposit.release` is not
 * `booking.change_status` — and which conditions must hold. Deriving the
 * buttons from anything else is how a screen and a server come to disagree
 * about what is possible.
 *
 * ── Why the button being here is not permission ───────────────────────────
 *
 * `changeBookingStatusAction` calls `assertCan` before it reads anything, and
 * the operation behind it calls `assertTransition`, which re-checks the
 * specific permission for the specific move. Rendering a button is a hint;
 * both refusals are the enforcement. Nothing here can grant anything.
 *
 * ── Duplicate submission ──────────────────────────────────────────────────
 *
 * `useAsyncAction` holds a ref that is set synchronously, so two clicks in the
 * same tick cannot both start — a `disabled` attribute alone loses that race.
 * The whole group is disabled while any one of them runs, because the second
 * move would be made against a version the first has already bumped.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import {
  changeBookingStatusAction,
  type ActionResult,
} from '@/app/(app)/bookings/_lib/actions'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { TextInput } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
import { BOOKING_STATUS_LABEL } from '@/lib/booking/state-machine'
import type { BookingStatus } from '@/lib/booking/types'

import { ActionError } from './action-error'

export type StatusActionsProps = {
  bookingId: string
  /** The version the screen was rendered from. Optimistic locking depends on it. */
  version: number
  /** From `legalNextStatuses` on the server. Empty means no move is available. */
  nextStatuses: readonly BookingStatus[]
  /**
   * Statuses whose transition declares `requiresReason`. Computed server-side
   * from the state machine, so the form demands exactly what the server does.
   */
  reasonRequired: readonly BookingStatus[]
}

export function StatusActions({
  bookingId,
  version,
  nextStatuses,
  reasonRequired,
}: StatusActionsProps) {
  const router = useRouter()
  const { pending, run, state } =
    useAsyncAction<ActionResult<{ status: BookingStatus; version: number }>>()
  const [chosen, setChosen] = useState<BookingStatus | null>(null)
  const [reason, setReason] = useState('')
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)

  if (nextStatuses.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        אין כרגע מעבר מצב זמין להזמנה הזו — או שההזמנה הגיעה למצב סופי, או
        שהתפקיד שלך אינו כולל את המעברים האפשריים ממנה.
      </p>
    )
  }

  const needsReason = chosen !== null && reasonRequired.includes(chosen)
  const reasonMissing = needsReason && reason.trim().length === 0

  async function apply(to: BookingStatus) {
    setFailure(null)

    await run(async () => {
      const result = await changeBookingStatusAction({
        bookingId,
        to,
        version,
        ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
      })

      if (!result.ok) {
        setFailure(result.error)
        return result
      }

      setChosen(null)
      setReason('')
      // The server owns the new version. Re-fetching rather than patching
      // local state is what stops the next move being sent with a stale one.
      router.refresh()
      return result
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        role="group"
        aria-label="מעברי מצב אפשריים"
        className="flex flex-wrap gap-2"
      >
        {nextStatuses.map((status) => {
          const selected = chosen === status

          return (
            <Button
              key={status}
              variant={selected ? 'primary' : 'secondary'}
              size="sm"
              disabled={pending}
              aria-pressed={selected}
              onClick={() => {
                if (pending) return
                // A move that needs a justification is staged rather than
                // fired, so the reason box appears before anything happens.
                if (reasonRequired.includes(status)) {
                  setChosen(selected ? null : status)
                  return
                }
                setChosen(status)
                void apply(status)
              }}
            >
              {BOOKING_STATUS_LABEL[status]}
            </Button>
          )
        })}
      </div>

      {needsReason && (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/50 p-4">
          <Field
            label="נימוק"
            description={`המעבר למצב "${BOOKING_STATUS_LABEL[chosen]}" נרשם ביומן הביקורת עם הנימוק הזה.`}
            required
            error={
              reasonMissing && state.status === 'error'
                ? 'צריך לכתוב נימוק לפני ביצוע המעבר.'
                : undefined
            }
          >
            <TextInput
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="מה הסיבה למעבר הזה?"
              autoComplete="off"
            />
          </Field>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={pending || reasonMissing}
              onClick={() => {
                if (pending || chosen === null || reasonMissing) return
                void apply(chosen)
              }}
            >
              {pending ? 'מעדכן…' : `העבר ל״${BOOKING_STATUS_LABEL[chosen]}״`}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                setChosen(null)
                setReason('')
              }}
            >
              ביטול
            </Button>
          </div>
        </div>
      )}

      {failure && <ActionError error={failure} />}

      {/* The change is a navigation-free re-render, so nothing else on screen
          would announce it. */}
      <span aria-live="polite" className="sr-only">
        {pending ? 'מעדכן את סטטוס ההזמנה' : ''}
      </span>
    </div>
  )
}
