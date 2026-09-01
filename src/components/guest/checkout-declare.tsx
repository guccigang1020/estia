'use client'

/**
 * "יצאנו מהנכס".
 *
 * ── Optional, and it moves nothing ────────────────────────────────────────
 *
 * This stamps `booking_guest_journey.checkout_declared_at` and deliberately
 * does NOT touch `bookings.status`. A guest saying they have left is a useful
 * signal to housekeeping — it is often the earliest anybody knows the unit is
 * free — and it is not evidence the unit is empty. Letting it move the booking
 * would hand the state machine to somebody with no account, and the first
 * consequence would be a cleaner sent to a room the family is still packing in.
 *
 * ── Idempotent, and irreversible on purpose ───────────────────────────────
 *
 * `coalesce(checkout_declared_at, now())` in the RPC, so a second tap is a
 * no-op that keeps the first time. There is no "undo": a guest who tapped it
 * by mistake and drove back has not un-left, and the honest fix is a telephone
 * call to the business rather than a control that rewrites a timestamp
 * housekeeping may already have acted on.
 */

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { declareCheckoutAction } from '@/app/g/[token]/_lib/actions'
import { useAsyncAction } from '@/components/ui/async-action'
import { Button } from '@/components/ui/button'

export function CheckoutDeclare({
  token,
  declaredAt,
}: {
  token: string
  declaredAt: string | null
}) {
  const router = useRouter()
  const { pending, run } = useAsyncAction()
  const [problem, setProblem] = useState<string | null>(null)

  if (declaredAt) {
    const when = new Date(declaredAt)
    const label = Number.isNaN(when.getTime())
      ? null
      : new Intl.DateTimeFormat('he-IL', {
          day: 'numeric',
          month: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Asia/Jerusalem',
        }).format(when)

    return (
      <p
        role="status"
        className="rounded-xl border border-success bg-success/10 px-4 py-3 text-sm text-foreground"
      >
        תודה — עדכנת שיצאתם{label ? ` ב-${label}` : ''}. נסיעה טובה.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="secondary"
        size="lg"
        className="w-full"
        disabled={pending}
        onClick={() => {
          if (pending) return
          setProblem(null)
          void run(async () => {
            const result = await declareCheckoutAction(token)
            if (result.ok) {
              router.refresh()
              return
            }
            setProblem(result.error.message)
          })
        }}
      >
        {pending ? 'מעדכן…' : 'יצאנו מהנכס'}
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        לא חובה. זה רק עוזר לצוות לדעת שהנכס פנוי.
      </p>

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
