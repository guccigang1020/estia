/**
 * What the business spends, as rules rather than as a ledger.
 *
 * ── There is no `expenses` table, and this screen does not pretend there is ─
 *
 * The schema models cost as `expense_rules` + `expense_allocations`: a rule
 * says what recurs and an allocation says which booking carried a share of it.
 * So a row here is a *rule*, and the money beside it is either the periodic
 * amount the business committed to or the shares actually recorded under it —
 * never a made-up row per month, which is what a ledger view would have to
 * invent.
 *
 * ── Fixed and variable are not two flavours of the same thing ─────────────
 *
 * A fixed rule carries an amount per period: ₪3,100 a month whether or not
 * anybody stayed. A variable rule carries a formula and no amount at all — its
 * cost is whatever the stay produces. Rendering them in one money column would
 * put ₪0 beside every variable rule, which reads as "this costs nothing". So
 * the column says the amount for one and the calculation for the other, and the
 * two are never summed.
 *
 * ── What the shares are, and who may see them ─────────────────────────────
 *
 * `allocations` is what each *stay* was charged, which is booking
 * profitability rather than what the business spent. It is withheld from a
 * reader without `booking.view_profitability` by never being built — the array
 * is nested, and `redact()` deletes keys on the record it is handed rather than
 * reaching one level down.
 *
 * No `"use client"`: rows in, markup out.
 */

import Link from 'next/link'

import {
  ALLOCATION_METHOD_LABEL,
  EXPENSE_FREQUENCY_LABEL,
  EXPENSE_KIND_LABEL,
  EXPENSE_SCOPE_LABEL,
  WITHHELD,
  describeFormula,
} from '@/app/(app)/finance/_lib/labels'
import type { ExpenseRuleListItem } from '@/app/(app)/finance/_lib/queries'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/components/ui/cn'
import { formatDayMonthYear } from '@/lib/booking'

import { Money } from './money'

export type ExpenseTableProps = {
  rules: readonly ExpenseRuleListItem[]
  /** False without `booking.view`; an allocation's reference is then not a link. */
  linkBookings: boolean
}

export function ExpenseTable({ rules, linkBookings }: ExpenseTableProps) {
  return (
    <ul className="flex flex-col gap-4">
      {rules.map((rule) => (
        <li
          key={rule.id}
          className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="font-display text-base font-bold text-foreground">
                {rule.label}
              </h3>
              <p className="text-xs text-muted-foreground">
                {rule.category} · {EXPENSE_KIND_LABEL[rule.kind]}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {rule.approvalRequired && (
                // Not a warning. It is a term of the rule: this cost does not
                // go out without somebody signing for it.
                <Badge tone="accent">דורש אישור לפני תשלום</Badge>
              )}
              <Badge tone={rule.effectiveTo === null ? 'brand' : 'neutral'}>
                {rule.effectiveTo === null ? 'בתוקף' : 'הסתיים'}
              </Badge>
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
            <Cell label={rule.kind === 'fixed' ? 'סכום לתקופה' : 'החישוב'}>
              {rule.kind === 'fixed' ? (
                <span className="flex flex-col gap-0.5">
                  <Money agorot={rule.amountAgorot} emphasis />
                  <span className="text-xs text-muted-foreground">
                    {EXPENSE_FREQUENCY_LABEL[rule.frequency]}
                  </span>
                </span>
              ) : rule.formula === null ? (
                // A variable rule with no formula computes nothing. The
                // database refuses to store one; if a row ever arrives here in
                // that state, it is said out loud rather than shown as ₪0.
                <span className="text-danger">
                  אין נוסחה — הכלל אינו מחשב דבר
                </span>
              ) : (
                <span className="text-foreground">
                  {describeFormula(rule.formula)}
                </span>
              )}
            </Cell>

            <Cell label="ייחוס להזמנות">
              <span className="flex flex-col gap-0.5">
                <span>{ALLOCATION_METHOD_LABEL[rule.allocation]}</span>
                <span className="text-xs text-muted-foreground">
                  שיטת החלוקה קובעת אילו הזמנות נראות רווחיות
                </span>
              </span>
            </Cell>

            <Cell label="תחולה">
              <span className="flex flex-col gap-0.5">
                <span>{EXPENSE_SCOPE_LABEL[rule.scopeKind]}</span>
                {rule.scopePropertyId !== null && (
                  <span className="text-xs text-muted-foreground">
                    {rule.scopePropertyName ?? WITHHELD}
                  </span>
                )}
              </span>
            </Cell>

            <Cell label="נחייב הזמנות">
              {rule.allocationCount === undefined ? (
                // The key is gone rather than zero. "No stay has carried this"
                // and "you may not see what stays carried" are different
                // sentences, and only one of them is true here.
                <span className="text-muted-foreground">{WITHHELD}</span>
              ) : rule.allocationCount === 0 ? (
                <span className="text-muted-foreground">
                  עוד לא יוחס לאף הזמנה
                </span>
              ) : (
                <span className="flex flex-col gap-0.5">
                  <Money agorot={rule.allocatedAgorot} emphasis />
                  <span className="text-xs text-muted-foreground">
                    {rule.allocationCount === 1
                      ? 'הזמנה אחת'
                      : `${rule.allocationCount} הזמנות`}
                  </span>
                </span>
              )}
            </Cell>
          </dl>

          <p className="text-xs text-muted-foreground">
            בתוקף מ־{formatDayMonthYear(rule.effectiveFrom)}
            {rule.effectiveTo !== null &&
              ` עד ${formatDayMonthYear(rule.effectiveTo)}`}
            {' · '}גרסה {rule.version}
          </p>

          {rule.allocations !== undefined && rule.allocations.length > 0 && (
            <details className="rounded-lg border border-border bg-muted/40">
              <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-foreground">
                מה כל הזמנה נשאה
              </summary>

              <div className="overflow-x-auto border-t border-border">
                <table className="w-full min-w-120 border-collapse text-start text-sm">
                  <caption className="sr-only">
                    השורות שנרשמו תחת הכלל ״{rule.label}״
                  </caption>
                  <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                      <Th>הזמנה</Th>
                      <Th>תקופה</Th>
                      <Th>הבסיס</Th>
                      <Th align="end">סכום</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rule.allocations.map((allocation) => (
                      <tr key={allocation.id}>
                        <Td>
                          <Reference
                            bookingId={allocation.bookingId}
                            reference={allocation.bookingReference}
                            linked={linkBookings}
                          />
                        </Td>
                        <Td>
                          <span className="text-xs text-muted-foreground">
                            {formatDayMonthYear(allocation.periodStart)} –{' '}
                            {formatDayMonthYear(allocation.periodEnd)}
                          </span>
                        </Td>
                        <Td>
                          <span className="text-xs text-muted-foreground">
                            {allocation.basis ?? '–'}
                          </span>
                        </Td>
                        <Td align="end">
                          <Money agorot={allocation.amountAgorot} />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------------------------------------ fragments -- */

function Reference({
  bookingId,
  reference,
  linked,
}: {
  bookingId: string
  reference: string | null
  linked: boolean
}) {
  if (reference === null) {
    return <span className="text-muted-foreground">–</span>
  }

  const label = (
    <span dir="ltr" className="font-mono text-xs">
      {reference}
    </span>
  )

  if (!linked) return label

  return (
    <Link
      href={`/bookings/${bookingId}`}
      className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {label}
    </Link>
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
        'px-4 py-2.5 font-semibold',
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
        'px-4 py-2.5 align-top text-foreground',
        align === 'end' ? 'text-end' : 'text-start',
      )}
    >
      {children}
    </td>
  )
}
