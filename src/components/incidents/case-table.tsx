/**
 * The damage case register: what is being argued about, and who is waiting.
 *
 * ── Why this is not the fault register with columns added ─────────────────
 *
 * `components/operations/incident-table.tsx` lists faults — things that are
 * broken and need fixing — and its most important column is whether anybody
 * has picked one up. This lists cases, which are disputes, and its most
 * important column is **who is being waited on and for how long**. A case in
 * `awaiting_vendor` for eleven days looks identical to a healthy one unless
 * that is drawn, and it is the single state where money quietly goes away: the
 * deposit is released on schedule, the quote never arrives, and the worktop is
 * still burnt.
 *
 * There is no money on this screen at all. `incident.view` and `expense.view`
 * are different grants held by different people, and a register that leaked a
 * repair bill would be a register a supervisor could not be shown. The cost is
 * on the case, behind its own grant.
 *
 * No `"use client"`: rows in, markup out.
 */

import Link from 'next/link'

import type { CaseRow } from '@/app/(app)/incidents/cases/_lib/queries'
import { Cell, Td, Th } from '@/components/operations/table-parts'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/components/ui/cn'
import { formatDayMonthYear } from '@/lib/booking'
import {
  INCIDENT_CASE_STATUS_LABEL,
  INCIDENT_CASE_TYPE_LABEL,
  INCIDENT_ORIGIN_LABEL,
} from '@/lib/incidents'

/** A wait this long is what the register exists to surface. */
const STALE_DAYS = 7

function CaseStatus({ row }: { row: CaseRow }) {
  return (
    <Badge tone={row.waiting ? 'accent' : 'neutral'}>
      {INCIDENT_CASE_STATUS_LABEL[row.status]}
    </Badge>
  )
}

function Waiting({ row }: { row: CaseRow }) {
  if (!row.waiting) {
    return (
      <span className="text-muted-foreground">
        {row.ageDays === 0 ? 'נפתח היום' : `${row.ageDays} ימים`}
      </span>
    )
  }

  const stale = row.ageDays >= STALE_DAYS
  return (
    <span
      className={cn(stale ? 'font-semibold text-danger' : 'text-foreground')}
    >
      {row.ageDays === 0 ? 'מהיום' : `${row.ageDays} ימים`}
      {stale && <span className="block text-xs">כדאי לרדוף אחרי זה</span>}
    </span>
  )
}

export function CaseTable({
  rows,
  caption,
}: {
  rows: readonly CaseRow[]
  caption: string
}) {
  return (
    <>
      {/* -------------------------------------------------------- phone -- */}
      <ul className="flex flex-col gap-3 sm:hidden">
        {rows.map((row) => (
          <li
            key={row.id}
            className={cn(
              'flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft',
              row.waiting &&
                row.ageDays >= STALE_DAYS &&
                'border-s-4 border-s-danger',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <Link
                href={`/incidents/cases/${row.id}`}
                className="font-display text-base font-bold text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {row.title}
              </Link>
              <CaseStatus row={row} />
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Cell label="סוג">{INCIDENT_CASE_TYPE_LABEL[row.caseType]}</Cell>
              <Cell label="נמצא ב">{INCIDENT_ORIGIN_LABEL[row.origin]}</Cell>
              <Cell label="נפתח">{formatDayMonthYear(row.openedOn)}</Cell>
              <Cell label="ממתין">
                <Waiting row={row} />
              </Cell>
            </dl>
          </li>
        ))}
      </ul>

      {/* -------------------------------------------------------- desk --- */}
      <div className="hidden overflow-hidden rounded-xl border border-border bg-surface shadow-soft sm:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-200 border-collapse text-start text-sm">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="border-b border-border bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <Th>התיק</Th>
                <Th>סוג</Th>
                <Th>נמצא ב</Th>
                <Th>נפתח</Th>
                <Th>ממתין</Th>
                <Th>מצב</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={cn(
                    'transition-colors hover:bg-muted',
                    row.waiting &&
                      row.ageDays >= STALE_DAYS &&
                      'border-s-4 border-s-danger bg-danger/5',
                  )}
                >
                  <Td>
                    <Link
                      href={`/incidents/cases/${row.id}`}
                      className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      {row.title}
                    </Link>
                  </Td>
                  <Td>{INCIDENT_CASE_TYPE_LABEL[row.caseType]}</Td>
                  <Td>{INCIDENT_ORIGIN_LABEL[row.origin]}</Td>
                  <Td>{formatDayMonthYear(row.openedOn)}</Td>
                  <Td>
                    <Waiting row={row} />
                  </Td>
                  <Td>
                    <CaseStatus row={row} />
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
