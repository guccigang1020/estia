/**
 * One guest's stay history.
 *
 * A table rather than the card/table pair the list screens use: this one has
 * five short columns and lives inside a card that is already narrow on a
 * phone, so it scrolls in its own container instead of being rendered twice.
 *
 * ── A cancelled stay is shown, and is not counted ─────────────────────────
 *
 * The rows include `cancelled` and `no_show`, marked as such. Hiding them
 * would make the history disagree with the calendar and would hide exactly the
 * pattern somebody looking at a guest card is checking for — three bookings
 * and two no-shows is the story. They are excluded from the counts and from
 * the money above, which is `GuestStay.happened` doing that work in one place.
 *
 * No `"use client"`: rows in, markup out.
 */

import Link from 'next/link'

import type { GuestStay } from '@/app/(app)/guests/_lib/queries'
import { BookingStatusBadge } from '@/components/booking/status-badge'
import { cn } from '@/components/ui/cn'
import { formatDayMonthYear } from '@/lib/booking/dates'
import { nightsBetween } from '@/lib/booking/types'
import { formatAgorot } from '@/lib/plans/plan'

const WITHHELD = 'לא זמין לצפייה'

export function GuestStays({
  stays,
  propertyNames,
}: {
  stays: readonly GuestStay[]
  /** `property id → name`, from the shell. The id is never printed instead. */
  propertyNames: ReadonlyMap<string, string | null>
}) {
  if (stays.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        לאורח הזה אין עדיין שהיות שאתה רשאי לראות. כרטיס אורח יכול להיפתח לפני
        ההזמנה הראשונה, ומעבר לכך — רשימת השהיות מוגבלת לנכסים שבטווח שלך.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-160 border-collapse text-start text-sm">
        <caption className="sr-only">
          היסטוריית השהיות של האורח, מהמאוחרת למוקדמת
        </caption>
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <Th>תאריכים</Th>
            <Th>יחידה</Th>
            <Th>סטטוס</Th>
            <Th>מספר</Th>
            <Th align="end">סכום</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {stays.map((stay) => (
            <tr
              key={stay.bookingId}
              className={cn(
                'transition-colors hover:bg-muted',
                // A stay that did not happen is dimmed rather than removed, so
                // the history and the counts above it can both be true.
                !stay.happened && 'text-muted-foreground',
              )}
            >
              <Td>
                <span className="flex flex-col">
                  <span>
                    {formatDayMonthYear(stay.checkIn)} –{' '}
                    {formatDayMonthYear(stay.checkOut)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {nights(stay)}
                  </span>
                </span>
              </Td>
              <Td>
                <span className="flex flex-col">
                  <span>{stay.unitName ?? WITHHELD}</span>
                  <span className="text-xs text-muted-foreground">
                    {propertyLabel(stay, propertyNames)}
                  </span>
                </span>
              </Td>
              <Td>
                <BookingStatusBadge status={stay.status} />
              </Td>
              <Td>
                <Link
                  href={`/bookings/${stay.bookingId}`}
                  className="font-mono text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  dir="ltr"
                >
                  {stay.reference}
                </Link>
              </Td>
              <Td align="end">
                {stay.totalAgorot === undefined ? (
                  <span className="text-muted-foreground">{WITHHELD}</span>
                ) : (
                  <span className="tabular-nums">
                    {formatAgorot(stay.totalAgorot)}
                  </span>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ------------------------------------------------------------ fragments -- */

/**
 * `nightsBetween` rather than a subtraction written here: the range is
 * half-open and the arithmetic belongs to the domain, which is what keeps this
 * label agreeing with the price the same range produced.
 */
function nights(stay: GuestStay): string {
  const count = nightsBetween({
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
  })
  return count === 1 ? 'לילה אחד' : `${count} לילות`
}

/**
 * The property's name, or nothing.
 *
 * Never the uuid. A truncated id is unhelpful and a confident wrong label is
 * worse — the same rule `PropertyOption.name` in `context.ts` is nullable for.
 */
function propertyLabel(
  stay: GuestStay,
  names: ReadonlyMap<string, string | null>,
): string {
  if (stay.propertyId === null) return ''
  return names.get(stay.propertyId) ?? ''
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
        'px-3 py-2 font-semibold',
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
        'px-3 py-3 align-top',
        align === 'end' ? 'text-end' : 'text-start',
      )}
    >
      {children}
    </td>
  )
}
