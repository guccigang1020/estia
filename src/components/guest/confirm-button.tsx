'use client'

/**
 * The control that records a guest's approval.
 *
 * ── Two locks against a double tap, and both are needed ───────────────────
 *
 * A guest on a bus with one bar of signal taps the button, nothing visibly
 * happens, and they tap again. `useAsyncAction` holds a synchronous ref that
 * refuses the second run before React has re-rendered — the `disabled`
 * attribute alone is too late, because both click events are delivered in the
 * same tick.
 *
 * That is the client half and it is the weaker one. The guarantee is in the
 * database: `booking_guest_confirmations` is unique on
 * `(booking_id, booking_version)`, so confirming version 4 twice is one
 * confirmation of version 4 and the second call returns the first one's row.
 * The lock here stops the second request; the constraint stops the second row.
 *
 * ── The stale refusal is not an error, it is a conversation ───────────────
 *
 * If the booking moved between the page rendering and the tap, the server
 * refuses with `guest_confirmation_stale` rather than recording approval of
 * terms nobody displayed. That is not shown as a failure — the guest did
 * nothing wrong. It is shown as "the booking was updated, here is what
 * changed", and `router.refresh()` re-reads so the delta appears.
 */

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { confirmBookingAction } from '@/app/g/[token]/_lib/actions'
import { Button } from '@/components/ui/button'
import { useAsyncAction } from '@/components/ui/async-action'

export function ConfirmButton({
  token,
  bookingVersion,
  label = 'אישור ההזמנה',
  reconfirm = false,
}: {
  token: string
  /** The version the guest is LOOKING at. The server refuses on a mismatch. */
  bookingVersion: number
  label?: string
  reconfirm?: boolean
}) {
  const router = useRouter()
  const { pending, run } = useAsyncAction()
  const [problem, setProblem] = useState<string | null>(null)
  const [stale, setStale] = useState(false)

  return (
    <div className="flex flex-col gap-2">
      <Button
        size="lg"
        // A full-width primary control. On a telephone this is the one thing
        // the screen is asking for, and a button that has to be aimed at is a
        // button that gets mis-tapped.
        className="w-full"
        disabled={pending}
        onClick={() => {
          if (pending) return
          setProblem(null)
          setStale(false)

          void run(async () => {
            const result = await confirmBookingAction(token, bookingVersion)

            if (result.ok) {
              router.refresh()
              return
            }

            if (result.error.code === 'guest_confirmation_stale') {
              // Not a failure. Re-read so the delta and a fresh version reach
              // the screen, and say what happened in a sentence.
              setStale(true)
              router.refresh()
              return
            }

            setProblem(result.error.message)
          })
        }}
      >
        {pending ? 'שולח…' : label}
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        {reconfirm
          ? 'האישור נרשם עם התאריך והפרטים המעודכנים.'
          : 'האישור נרשם עם התאריך והפרטים שמופיעים למעלה.'}
      </p>

      {stale && (
        <p
          role="status"
          className="rounded-lg border border-warning bg-warning/10 px-3 py-2 text-sm text-foreground"
        >
          ההזמנה עודכנה בזמן שהדף היה פתוח. הפרטים החדשים נטענו — בדוק אותם ואשר
          שוב.
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
    </div>
  )
}
