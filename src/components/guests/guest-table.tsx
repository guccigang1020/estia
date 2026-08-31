/**
 * The guest list, as a table on a desk and as cards on a phone.
 *
 * Two renderings of the same rows rather than one table that scrolls sideways,
 * for the reason `booking-table.tsx` gives: the product is used one-handed,
 * and a horizontally scrolling table is unusable there. Both are in the DOM
 * once each and the heading order is the same in both.
 *
 * ── Three absences, three different sentences ─────────────────────────────
 *
 * `fullName`, `phone` and `email` are three separate grants in this product —
 * `guest.view_name`, `guest.view_phone`, `guest.view_email` — and a role may
 * hold any one without the others. `redact()` deletes the key it may not hand
 * over, so the *absence of the key* is the signal, and this component says so
 * in words per field rather than hiding a whole column. Hiding the column
 * would be a different claim: that nobody has a telephone number, rather than
 * that this reader may not see it.
 *
 * The name is the sharpest of the three, because a list of unnamed rows is
 * useless and the temptation is to fall back to "אורח" or to the id. Neither
 * is done: the row says the name is withheld, and the link still works for
 * anybody who may open it, because `guest.view` and `guest.view_name` are
 * genuinely different questions.
 *
 * No `"use client"`: rows in, markup out.
 */

import Link from 'next/link'

import type { GuestListItem } from '@/app/(app)/guests/_lib/queries'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/components/ui/cn'
import { formatDayMonthYear } from '@/lib/booking/dates'
import { formatAgorot } from '@/lib/plans/plan'

export type GuestTableProps = {
  guests: readonly GuestListItem[]
  /**
   * False when the reader lacks `booking.view_price`. The money column is then
   * absent rather than zero — a lifetime value of ₪0 is a number, and a wrong
   * one.
   */
  showValue: boolean
}

const WITHHELD = 'לא זמין לצפייה'
const NONE_RECORDED = 'לא נרשם'

export function GuestTable({ guests, showValue }: GuestTableProps) {
  return (
    <>
      {/* ------------------------------------------------------- phone -- */}
      <ul className="flex flex-col gap-3 sm:hidden">
        {guests.map((guest) => (
          <li key={guest.id}>
            <Link
              href={`/guests/${guest.id}`}
              className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="font-display text-base font-bold text-foreground">
                  <GuestName guest={guest} />
                </span>
                {guest.isBlocked && <BlockedBadge />}
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <Cell label="טלפון">
                  <Contact
                    present={'phone' in guest}
                    value={guest.phone ?? null}
                  />
                </Cell>
                <Cell label="אימייל">
                  <Contact
                    present={'email' in guest}
                    value={guest.email ?? null}
                  />
                </Cell>
                <Cell label="שהיות">
                  <StayCount guest={guest} />
                </Cell>
                <Cell label="שהות אחרונה">
                  {guest.lastStayOn
                    ? formatDayMonthYear(guest.lastStayOn)
                    : 'עוד לא שהה'}
                </Cell>
                {showValue && (
                  <Cell label="שווי השהיות">
                    <Value guest={guest} />
                  </Cell>
                )}
              </dl>

              <TagList tags={guest.tags} />
            </Link>
          </li>
        ))}
      </ul>

      {/* ------------------------------------------------------- desk --- */}
      <div className="hidden overflow-hidden rounded-xl border border-border bg-surface shadow-soft sm:block">
        {/* Its own scroller, so a wide table never widens the shell. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-200 border-collapse text-start text-sm">
            <caption className="sr-only">
              רשימת האורחים של הארגון, ממוינת לפי שם
            </caption>
            <thead>
              <tr className="border-b border-border bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <Th>אורח</Th>
                <Th>קשר</Th>
                <Th>שפה ואזרחות</Th>
                <Th>שהיות</Th>
                <Th>שהות אחרונה</Th>
                <Th>תגיות</Th>
                {showValue && <Th align="end">שווי השהיות</Th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {guests.map((guest) => (
                <tr key={guest.id} className="transition-colors hover:bg-muted">
                  <Td>
                    {/* The link is on the name rather than the whole row: a
                        row-level click handler is not reachable by keyboard
                        and is not announced as a link. */}
                    <Link
                      href={`/guests/${guest.id}`}
                      className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      <GuestName guest={guest} />
                    </Link>
                    <span className="mt-1 flex flex-wrap items-center gap-2">
                      {guest.city && (
                        <span className="text-xs text-muted-foreground">
                          {guest.city}
                        </span>
                      )}
                      {guest.isBlocked && <BlockedBadge />}
                    </span>
                  </Td>
                  <Td>
                    <span className="flex flex-col gap-0.5">
                      <Contact
                        present={'phone' in guest}
                        value={guest.phone ?? null}
                      />
                      <span className="text-xs text-muted-foreground">
                        <Contact
                          present={'email' in guest}
                          value={guest.email ?? null}
                        />
                      </span>
                    </span>
                  </Td>
                  <Td>
                    <span className="flex flex-col gap-0.5">
                      <span>{languageName(guest.language)}</span>
                      <span className="text-xs text-muted-foreground">
                        {guest.nationality
                          ? countryName(guest.nationality)
                          : NONE_RECORDED}
                      </span>
                    </span>
                  </Td>
                  <Td>
                    <StayCount guest={guest} />
                  </Td>
                  <Td>
                    {guest.lastStayOn ? (
                      formatDayMonthYear(guest.lastStayOn)
                    ) : (
                      <span className="text-muted-foreground">עוד לא שהה</span>
                    )}
                  </Td>
                  <Td>
                    <TagList tags={guest.tags} />
                  </Td>
                  {showValue && (
                    <Td align="end">
                      <span className="font-medium tabular-nums">
                        <Value guest={guest} />
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
 * The name, or the reason it is missing.
 *
 * `'fullName' in guest` and not `guest.fullName === undefined`: the key is
 * what `redact` removes, and the check has to be the same shape as the removal
 * or it will one day answer for a name that merely happens to be empty — which
 * `guests_full_name_not_blank` makes impossible, and which is exactly why the
 * distinction is worth keeping honest.
 */
function GuestName({ guest }: { guest: GuestListItem }) {
  if (!('fullName' in guest)) {
    return <span className="font-normal text-muted-foreground">{WITHHELD}</span>
  }
  return <>{guest.fullName}</>
}

/** A contact field: withheld, never recorded, or the value itself. */
function Contact({
  present,
  value,
}: {
  present: boolean
  value: string | null
}) {
  if (!present) return <span className="text-muted-foreground">{WITHHELD}</span>
  if (value === null) {
    return <span className="text-muted-foreground">{NONE_RECORDED}</span>
  }
  return (
    <span dir="ltr" className="inline-block">
      {value}
    </span>
  )
}

/**
 * Stays behind and stays ahead, kept apart.
 *
 * A single "3 stays" that quietly includes next month's arrival is the number
 * somebody quotes to a guest on the telephone as history.
 */
function StayCount({ guest }: { guest: GuestListItem }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span>
        {guest.stayCount === 1 ? 'שהות אחת' : `${guest.stayCount} שהיות`}
      </span>
      {guest.upcomingCount > 0 && (
        <span className="text-xs text-muted-foreground">
          {guest.upcomingCount === 1
            ? 'ועוד שהות עתידית'
            : `ועוד ${guest.upcomingCount} שהיות עתידיות`}
        </span>
      )}
    </span>
  )
}

function Value({ guest }: { guest: GuestListItem }) {
  if (guest.staysValueAgorot === undefined) {
    return <span className="font-normal text-muted-foreground">{WITHHELD}</span>
  }
  return <>{formatAgorot(guest.staysValueAgorot)}</>
}

function BlockedBadge() {
  return (
    <Badge tone="accent" className="shrink-0">
      חסום
    </Badge>
  )
}

function TagList({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  return (
    <span className="flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <Badge key={tag} tone="brand">
          {tag}
        </Badge>
      ))}
    </span>
  )
}

/**
 * A language code, named in Hebrew.
 *
 * `guests.language` is `text not null default 'he'` with no check constraint,
 * so the value is whatever was written — there is no vocabulary to look up.
 * `Intl.DisplayNames` names the ones that are real codes and returns the input
 * for the ones that are not, which is the honest fallback: showing `xx` is
 * better than inventing a language for it.
 */
function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['he'], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

/** The same, for the ISO-3166 alpha-2 `nationality` column. */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['he'], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
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
