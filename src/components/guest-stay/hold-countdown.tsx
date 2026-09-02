'use client'

/**
 * The clock on a held booking.
 *
 * ── The failure this component is written against ─────────────────────────
 *
 * A countdown that keeps running after the deadline. It is the worst thing
 * this screen can do: a guest watching `-00:04:12` tick downwards believes the
 * dates are still theirs, taps אישור, and the confirm fails against inventory
 * that went back on sale four minutes ago. So there are three guards and all
 * three are needed:
 *
 *   1. `guestHoldRemainingMs` floors at zero. The subtraction cannot go
 *      negative, whatever the clock does.
 *   2. On reaching zero the interval is cleared and the component swaps to
 *      the lapsed sentence. There is no state in which a number is rendered
 *      beside an expired deadline.
 *   3. It calls `router.refresh()` once at that moment, so the SERVER decides
 *      what the screen becomes. The client's job is to notice the deadline
 *      passed, not to author the page that follows.
 *
 * ── Why the server renders the first number ───────────────────────────────
 *
 * `initialRemainingMs` comes from the server render, and the first paint uses
 * it rather than the browser's clock. A visitor whose telephone is set four
 * hours fast would otherwise see a countdown that disagreed with the sentence
 * above it, and one whose telephone is slow would see time it does not have.
 * The browser's clock is used only for the DELTA between ticks, which is what
 * it is actually good for.
 *
 * ── Why the ticking number is not announced ───────────────────────────────
 *
 * A live region that updates every second reads the remaining time aloud
 * sixty times a minute and makes the screen unusable with a screen reader. So
 * the ticking text carries `aria-hidden`, the accessible name is the static
 * deadline in `<time>`, and the only announcement is the one that matters —
 * `role="status"` on the sentence that appears when the hold ends.
 */

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import {
  formatHoldRemaining,
  guestHoldRemainingMs,
  type GuestHold,
} from '@/lib/guest-journey/stay'

export function HoldCountdown({
  expiresAt,
  initialRemainingMs,
}: {
  /** ISO instant. The server has already established the hold is live. */
  expiresAt: string
  initialRemainingMs: number
}) {
  const router = useRouter()
  const [remainingMs, setRemainingMs] = useState(initialRemainingMs)
  const refreshed = useRef(false)

  useEffect(() => {
    const hold: GuestHold = {
      expiresAt,
      releasedAt: null,
      convertedToBookingId: null,
    }

    // The same pure function the server called. Two implementations of "how
    // long is left" is two answers, and the visible one would be the wrong one.
    const tick = () => setRemainingMs(guestHoldRemainingMs(hold, new Date()))

    tick()
    const timer = setInterval(tick, 1_000)
    return () => clearInterval(timer)
  }, [expiresAt])

  useEffect(() => {
    if (remainingMs > 0 || refreshed.current) return
    // Once. A re-render loop that refreshed on every tick past zero would
    // hammer the server on a screen somebody left open overnight.
    refreshed.current = true
    router.refresh()
  }, [remainingMs, router])

  if (remainingMs <= 0) {
    return (
      <p
        role="status"
        className="rounded-lg border border-warning bg-warning/10 px-3 py-3 text-sm text-foreground"
      >
        ההחזקה על התאריכים הסתיימה. טוענים מחדש את מצב ההזמנה.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">נותר לאישור</span>
      {/*
        The number is decoration for a screen reader — `time` below carries the
        real information, and it does not change sixty times a minute.
      */}
      <span
        aria-hidden="true"
        className="font-display text-2xl font-bold tabular-nums text-foreground"
      >
        {formatHoldRemaining(remainingMs)}
      </span>
      <time dateTime={expiresAt} className="sr-only">
        {`התאריכים שמורים עוד ${formatHoldRemaining(remainingMs)}`}
      </time>
    </div>
  )
}
