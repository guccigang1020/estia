/**
 * What the guest is paying for, line by line.
 *
 * ── The rule this component is built around ───────────────────────────────
 *
 * The total is `sumLines(lines)` and nothing else. It is not a column read
 * beside the lines and it is not a number this component adds up its own way:
 * it is the domain's own sum function, over the domain's own lines. "Why is it
 * ₪6,400?" is the most common question a guest asks, and a screen whose total
 * does not equal the lines above it cannot answer.
 *
 * `totalAgorot` from the booking row is passed in separately and *compared*
 * rather than displayed. When the two disagree the screen says so instead of
 * picking one, because the disagreement is the finding — a booking whose
 * stored total has drifted from its lines is a real defect, and quietly
 * rendering either number hides it.
 *
 * ── The empty case is not zero ────────────────────────────────────────────
 *
 * `booking_price_lines_select` requires `booking.view_price`. A reader without
 * it gets an empty array, which means "withheld", not "free". Rendering a
 * ₪0 total there would be a fabricated number, so the component refuses to
 * render at all and the caller is expected to gate on the grant.
 *
 * No `"use client"`: arithmetic and markup.
 */

import { cn } from '@/components/ui/cn'
import { sumLines } from '@/lib/booking/pricing'
import type { PriceLine } from '@/lib/booking/types'
import { formatDayMonth } from '@/lib/booking/dates'
import { formatAgorot } from '@/lib/plans/plan'

export function BookingPriceLines({
  lines,
  /** The booking row's stored total, for the consistency check described above. */
  storedTotalAgorot,
  className,
}: {
  lines: readonly PriceLine[]
  storedTotalAgorot: number
  className?: string
}) {
  if (lines.length === 0) {
    return (
      <p className={cn('text-sm text-muted-foreground', className)}>
        פירוט המחיר אינו זמין לצפייה בהרשאות שלך. הסכום עצמו מוצג רק למי שמורשה
        לראות מחירים.
      </p>
    )
  }

  const total = sumLines(lines)
  const drifted = total !== storedTotalAgorot

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">פירוט מחיר ההזמנה</caption>
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="py-2 text-start font-semibold">
                פריט
              </th>
              <th scope="col" className="py-2 text-start font-semibold">
                כמות
              </th>
              <th scope="col" className="py-2 text-end font-semibold">
                סכום
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {lines.map((line, index) => (
              <tr key={`${line.kind}-${line.label}-${line.date ?? index}`}>
                <td className="py-2.5 text-start text-foreground">
                  {line.label}
                  {line.date !== null && (
                    <span className="ms-2 text-xs text-muted-foreground">
                      {formatDayMonth(line.date)}
                    </span>
                  )}
                </td>
                <td className="py-2.5 text-start text-muted-foreground">
                  {line.quantity}
                </td>
                <td
                  className={cn(
                    'py-2.5 text-end tabular-nums',
                    // A discount is negative so the total stays a plain sum.
                    // It is coloured because it is the one line a reader
                    // scanning for "why is this cheaper" is looking for.
                    line.amount < 0 ? 'text-success' : 'text-foreground',
                  )}
                >
                  {formatAgorot(line.amount)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border-strong">
              <th scope="row" colSpan={2} className="py-3 text-start font-bold">
                סה״כ
              </th>
              <td className="py-3 text-end text-base font-bold tabular-nums text-foreground">
                {formatAgorot(total)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {drifted && (
        <p
          role="alert"
          className="rounded-lg border border-danger bg-surface px-4 py-3 text-xs text-danger"
        >
          הסכום השמור בהזמנה ({formatAgorot(storedTotalAgorot)}) אינו שווה לסכום
          השורות ({formatAgorot(total)}). זו תקלה בנתונים — אל תסתמך על אף אחד
          משני המספרים עד לבירור.
        </p>
      )}
    </div>
  )
}
