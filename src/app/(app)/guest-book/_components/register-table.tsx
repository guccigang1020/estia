/**
 * The register itself: one row per stay, in the order a person reads it.
 *
 * ── Why a table and not cards ─────────────────────────────────────────────
 *
 * Because the whole value of a register is scanning down one column — the
 * arrival dates — and finding the week somebody is asking about. Cards make
 * that impossible. The table scrolls inside its own container so a long row
 * never makes the page scroll sideways.
 *
 * ── A withheld name and an unnamed guest look different ───────────────────
 *
 * `primaryGuestName` is absent from the row when the reader lacks
 * `guest.view_name`, and `null` when the stay genuinely has no name recorded
 * yet. Those are different sentences — "you may not see this" and "nobody has
 * filled this in" — and this component prints a different thing for each. The
 * blank cell that would collapse them is the mistake `Withheld` exists to
 * prevent.
 *
 * No `"use client"`: it renders text. The filter above it is a form of links,
 * so nothing on this screen needs to be a Client Component.
 */

import { Withheld } from '@/components/shell-screens/screen'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import {
  GUEST_BOOK_FIELD_LABEL,
  GUEST_BOOK_STATUS_LABEL,
  type GuestBookEntryStatus,
} from '@/lib/guest-book'

import type { GuestBookRow } from '../_lib/queries'

const STATUS_TONE: Record<GuestBookEntryStatus, BadgeTone> = {
  expected: 'neutral',
  arrived: 'brand',
  departed: 'neutral',
  cancelled: 'accent',
}

function dateTime(date: string | null, time: string | null): string {
  if (date === null) return '—'
  return time === null ? date : `${date} ${time}`
}

export function RegisterTable({
  entries,
  canSeeName,
}: {
  entries: readonly GuestBookRow[]
  /** Whether the reader holds `guest.view_name`. Decides the empty-name cell. */
  canSeeName: boolean
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-start text-xs text-muted-foreground">
            <th scope="col" className="py-2 text-start font-medium">
              {GUEST_BOOK_FIELD_LABEL.booking_reference}
            </th>
            <th scope="col" className="py-2 text-start font-medium">
              {GUEST_BOOK_FIELD_LABEL.property}
            </th>
            <th scope="col" className="py-2 text-start font-medium">
              {GUEST_BOOK_FIELD_LABEL.primary_guest_name}
            </th>
            <th scope="col" className="py-2 text-start font-medium">
              {GUEST_BOOK_FIELD_LABEL.arrival}
            </th>
            <th scope="col" className="py-2 text-start font-medium">
              {GUEST_BOOK_FIELD_LABEL.departure}
            </th>
            <th scope="col" className="py-2 text-start font-medium">
              {GUEST_BOOK_FIELD_LABEL.guest_count}
            </th>
            <th scope="col" className="py-2 text-start font-medium">
              {GUEST_BOOK_FIELD_LABEL.financial_document}
            </th>
            <th scope="col" className="py-2 text-start font-medium">
              סטטוס
            </th>
          </tr>
        </thead>

        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id} className="border-b border-border last:border-0">
              <td className="py-2.5 align-top">
                <span dir="ltr" className="font-mono text-xs">
                  {entry.bookingReference}
                </span>
              </td>
              <td className="py-2.5 align-top">{entry.propertyName ?? '—'}</td>
              <td className="py-2.5 align-top">
                {'primaryGuestName' in entry ? (
                  (entry.primaryGuestName ?? 'טרם נרשם שם')
                ) : canSeeName ? (
                  'טרם נרשם שם'
                ) : (
                  <Withheld />
                )}
              </td>
              <td className="py-2.5 align-top tabular-nums">
                {dateTime(entry.arrivalDate, entry.arrivalTime)}
              </td>
              <td className="py-2.5 align-top tabular-nums">
                {dateTime(entry.departureDate, entry.departureTime)}
              </td>
              <td className="py-2.5 align-top tabular-nums">
                {entry.guestCount}
              </td>
              <td className="py-2.5 align-top">
                {entry.financialDocumentRef === null ? (
                  '—'
                ) : (
                  <span dir="ltr" className="font-mono text-xs">
                    {entry.financialDocumentRef}
                  </span>
                )}
              </td>
              <td className="py-2.5 align-top">
                <div className="flex flex-col items-start gap-1">
                  <Badge tone={STATUS_TONE[entry.status]}>
                    {GUEST_BOOK_STATUS_LABEL[entry.status]}
                  </Badge>
                  {/*
                   * What this entry is still missing, named. A register with
                   * holes in it is only workable if the holes are visible; a
                   * row that looked complete and was not is the failure mode.
                   */}
                  {entry.missingFields.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {`חסר: ${entry.missingFields
                        .map((field) => GUEST_BOOK_FIELD_LABEL[field])
                        .join(', ')}`}
                    </span>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
