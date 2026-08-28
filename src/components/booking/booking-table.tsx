/**
 * The bookings list, as a table on a desk and as cards on a phone.
 *
 * Two renderings of the same rows rather than one table that scrolls
 * sideways, because the product is genuinely used one-handed in a car park —
 * see the note in `skeleton.tsx` — and a horizontally scrolling table is
 * unusable there. The table is hidden below `sm` and the cards above it; both
 * are in the DOM once each, and the heading order is the same in both.
 *
 * ── Two absences that are not blanks ──────────────────────────────────────
 *
 * `guestName` and `unitName` are nullable, and null means "this reader may not
 * see that record" — `guests_select` requires `guest.view`, which a cleaner
 * does not hold. The cell says so in words rather than rendering an empty
 * space or, worse, the raw uuid. A truncated id is unhelpful; a confident
 * wrong label is worse.
 *
 * No `"use client"`: rows in, markup out.
 */

import Link from 'next/link'

import { cn } from '@/components/ui/cn'
import type { BookingListItem } from '@/app/(app)/bookings/_lib/queries'
import { formatDayMonthYear } from '@/lib/booking/dates'
import { nightsBetween } from '@/lib/booking/types'
import { formatAgorot } from '@/lib/plans/plan'

import { BookingStatusBadge } from './status-badge'

export type BookingTableProps = {
  bookings: readonly BookingListItem[]
  /**
   * False when the reader lacks `booking.view_price`. The money column is then
   * absent rather than zero — a total of ₪0 is a number, and a wrong one.
   */
  showTotals: boolean
}

const WITHHELD = 'לא זמין לצפייה'

export function BookingTable({ bookings, showTotals }: BookingTableProps) {
  return (
    <>
      {/* ------------------------------------------------------- phone -- */}
      <ul className="flex flex-col gap-3 sm:hidden">
        {bookings.map((booking) => (
          <li key={booking.id}>
            <Link
              href={`/bookings/${booking.id}`}
              className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="font-display text-base font-bold text-foreground">
                  {booking.guestName ?? (
                    <span className="font-normal text-muted-foreground">
                      {WITHHELD}
                    </span>
                  )}
                </span>
                <BookingStatusBadge status={booking.status} />
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <Cell label="תאריכים">
                  <StayDates
                    checkIn={booking.checkIn}
                    checkOut={booking.checkOut}
                  />
                </Cell>
                <Cell label="יחידה">{booking.unitName ?? WITHHELD}</Cell>
                <Cell label="מספר הזמנה">
                  <span dir="ltr" className="font-mono text-xs">
                    {booking.reference}
                  </span>
                </Cell>
                {showTotals && (
                  <Cell label="סה״כ">{formatAgorot(booking.totalAgorot)}</Cell>
                )}
              </dl>
            </Link>
          </li>
        ))}
      </ul>

      {/* ------------------------------------------------------- desk --- */}
      <div className="hidden overflow-hidden rounded-xl border border-border bg-surface shadow-soft sm:block">
        {/* Its own scroller, so a wide table never widens the shell. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-160 border-collapse text-start text-sm">
            <caption className="sr-only">
              רשימת ההזמנות של הארגון, ממוינת מהתאריך המאוחר למוקדם
            </caption>
            <thead>
              <tr className="border-b border-border bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <Th>אורח</Th>
                <Th>תאריכים</Th>
                <Th>יחידה</Th>
                <Th>סטטוס</Th>
                <Th>מספר</Th>
                {showTotals && <Th align="end">סה״כ</Th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {bookings.map((booking) => (
                <tr
                  key={booking.id}
                  className="transition-colors hover:bg-muted"
                >
                  <Td>
                    {/* The link is on the name rather than the whole row: a
                        row-level click handler is not reachable by keyboard
                        and not announced as a link. */}
                    <Link
                      href={`/bookings/${booking.id}`}
                      className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      {booking.guestName ?? WITHHELD}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {booking.guestCount} אורחים
                    </span>
                  </Td>
                  <Td>
                    <StayDates
                      checkIn={booking.checkIn}
                      checkOut={booking.checkOut}
                    />
                  </Td>
                  <Td>{booking.unitName ?? WITHHELD}</Td>
                  <Td>
                    <BookingStatusBadge status={booking.status} />
                  </Td>
                  <Td>
                    <span dir="ltr" className="font-mono text-xs">
                      {booking.reference}
                    </span>
                  </Td>
                  {showTotals && (
                    <Td align="end">
                      <span className="font-medium">
                        {formatAgorot(booking.totalAgorot)}
                      </span>
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------ fragments -- */

/**
 * The stay, with its length spelled out.
 *
 * `nightsBetween` rather than a subtraction written here: the range is
 * half-open and the arithmetic belongs to the domain, which is what keeps this
 * label agreeing with the price the same range produced.
 */
function StayDates({
  checkIn,
  checkOut,
}: {
  checkIn: string
  checkOut: string
}) {
  const nights = nightsBetween({ checkIn, checkOut })

  return (
    <span className="flex flex-col">
      <span>
        {formatDayMonthYear(checkIn)} – {formatDayMonthYear(checkOut)}
      </span>
      <span className="text-xs text-muted-foreground">
        {nights === 1 ? 'לילה אחד' : `${nights} לילות`}
      </span>
    </span>
  )
}

function Cell({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  )
}

function Th({
  children,
  align = 'start',
}: {
  children: React.ReactNode
  align?: 'start' | 'end'
}) {
  return (
    <th
      scope="col"
      className={cn(
        'px-4 py-3 font-semibold',
        align === 'end' ? 'text-end' : 'text-start',
      )}
    >
      {children}
    </th>
  )
}

function Td({
  children,
  align = 'start',
}: {
  children: React.ReactNode
  align?: 'start' | 'end'
}) {
  return (
    <td
      className={cn(
        'px-4 py-3 align-top text-foreground',
        align === 'end' ? 'text-end' : 'text-start',
      )}
    >
      {children}
    </td>
  )
}
