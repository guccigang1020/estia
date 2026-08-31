/**
 * Money that arrived, against money that was expected.
 *
 * ── `unknown` is the reason this screen exists ────────────────────────────
 *
 * A processor that stops answering leaves a payment that is neither a success
 * nor a failure: the card may or may not have been charged, and nobody knows
 * which. Counted as arrived, the booking looks settled and the guest is never
 * chased; counted as missing, a guest who has already paid is chased twice. So
 * it is neither. `unresolvedAgorot` is its own column, it is listed before the
 * differences rather than among them, and the badge for it does not share a
 * word or a tone with "פער".
 *
 * The dataset's own unresolved money is `pending` carrying
 * `requires_attention = 'reconcile_unknown'` rather than the `unknown` status,
 * and the two are counted together deliberately — they are the same sentence to
 * whoever is reading: the automation has stopped and will not start again on
 * its own.
 *
 * ── Nothing here is re-derived ────────────────────────────────────────────
 *
 * Every figure on a row is computed once in `_lib/queries.ts` with `sumAgorot`
 * from the finance domain, over integer agorot. This component formats and
 * places them; it does not add, subtract or compare a single one.
 *
 * No `"use client"`: rows in, markup out.
 */

import Link from 'next/link'

import {
  RECONCILIATION_OUTCOME_LABEL,
  reconciliationTone,
} from '@/app/(app)/finance/_lib/labels'
import type { ReconciliationRow } from '@/app/(app)/finance/_lib/queries'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/components/ui/cn'
import { formatDayMonthYear } from '@/lib/booking'

import { Money } from './money'

export type ReconciliationTableProps = {
  rows: readonly ReconciliationRow[]
  /** False without `booking.view`; the reference is then not a link. */
  linkBookings: boolean
}

export function ReconciliationTable({
  rows,
  linkBookings,
}: ReconciliationTableProps) {
  return (
    <>
      {/* ---------------------------------------------------------- phone -- */}
      <ul className="flex flex-col gap-3 sm:hidden">
        {rows.map((row) => (
          <li
            key={row.bookingId}
            className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft"
          >
            <div className="flex items-start justify-between gap-3">
              <Reference row={row} linked={linkBookings} />
              <Badge tone={reconciliationTone(row.outcome)}>
                {RECONCILIATION_OUTCOME_LABEL[row.outcome]}
              </Badge>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Cell label="נדרש">
                <Money agorot={row.expectedAgorot} />
              </Cell>
              <Cell label="התקבל">
                <Money agorot={row.receivedAgorot} emphasis />
              </Cell>
              <Cell label="פער">
                <Difference row={row} />
              </Cell>
              <Cell label="בבירור">
                <Unresolved row={row} />
              </Cell>
            </dl>

            <Moment row={row} />
          </li>
        ))}
      </ul>

      {/* ---------------------------------------------------------- desk --- */}
      <div className="hidden overflow-hidden rounded-xl border border-border bg-surface shadow-soft sm:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-200 border-collapse text-start text-sm">
            <caption className="sr-only">
              הזמנות שנרשם עליהן כסף, מהדורשות בירור ועד לתואמות
            </caption>
            <thead>
              <tr className="border-b border-border bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <Th>הזמנה</Th>
                <Th>מצב ההתאמה</Th>
                <Th align="end">נדרש</Th>
                <Th align="end">התקבל</Th>
                <Th align="end">פער</Th>
                <Th align="end">בבירור</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr
                  key={row.bookingId}
                  className="transition-colors hover:bg-muted"
                >
                  <Td>
                    <Reference row={row} linked={linkBookings} />
                    <Moment row={row} />
                  </Td>
                  <Td>
                    <Badge tone={reconciliationTone(row.outcome)}>
                      {RECONCILIATION_OUTCOME_LABEL[row.outcome]}
                    </Badge>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {row.paymentCount === 1
                        ? 'תשלום אחד'
                        : `${row.paymentCount} תשלומים`}
                    </span>
                  </Td>
                  <Td align="end">
                    <Money agorot={row.expectedAgorot} />
                  </Td>
                  <Td align="end">
                    <Money agorot={row.receivedAgorot} emphasis />
                  </Td>
                  <Td align="end">
                    <Difference row={row} />
                  </Td>
                  <Td align="end">
                    <Unresolved row={row} />
                  </Td>
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
 * The gap, and what it means in words.
 *
 * A positive figure is money the business is still owed and a negative one is
 * money it holds beyond what it billed — two different problems, so the sign is
 * spelled out rather than left for the reader to interpret from a colour.
 */
function Difference({ row }: { row: ReconciliationRow }) {
  if (row.differenceAgorot === null) {
    return <Money agorot={null} />
  }
  if (row.differenceAgorot === 0) {
    return <span className="text-muted-foreground">–</span>
  }

  return (
    <span className="flex flex-col items-end gap-0.5">
      <Money agorot={row.differenceAgorot} emphasis />
      <span className="text-xs text-muted-foreground">
        {row.differenceAgorot > 0 ? 'חסר' : 'עודף'}
      </span>
    </span>
  )
}

function Unresolved({ row }: { row: ReconciliationRow }) {
  if (row.unresolvedCount === 0) {
    return <span className="text-muted-foreground">–</span>
  }

  return (
    <span className="flex flex-col items-end gap-0.5">
      <Money agorot={row.unresolvedAgorot} emphasis className="text-danger" />
      <span className="text-xs text-danger">
        {row.unresolvedCount === 1
          ? 'תשלום אחד ללא תשובה'
          : `${row.unresolvedCount} תשלומים ללא תשובה`}
      </span>
    </span>
  )
}

function Reference({
  row,
  linked,
}: {
  row: ReconciliationRow
  linked: boolean
}) {
  if (row.bookingReference === null) {
    return <span className="text-muted-foreground">–</span>
  }

  const reference = (
    <span dir="ltr" className="font-mono text-xs">
      {row.bookingReference}
    </span>
  )

  if (!linked) return reference

  return (
    <Link
      href={`/bookings/${row.bookingId}`}
      className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {reference}
    </Link>
  )
}

function Moment({ row }: { row: ReconciliationRow }) {
  return (
    <span className="mt-1 block text-xs text-muted-foreground">
      {row.lastMovedOn === null
        ? 'עוד לא נכנס כסף'
        : `תנועה אחרונה ${formatDayMonthYear(row.lastMovedOn)}`}
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
