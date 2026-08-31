/**
 * Agent commissions: who is owed what, where it is on the ladder, and on what
 * the figure was computed.
 *
 * ── The payee is two things, and the model says which ─────────────────────
 *
 * `commissions.agent_user_id` is nullable and so is `agency_id`;
 * `commissions_has_a_payee` requires one of the two, because an agency keeps
 * the commercial relationship when the individual leaves. So `payee.kind` is
 * rendered rather than inferred from a name being present, and the third case
 * — neither, which `on delete set null` on the person makes reachable — is
 * shown as a row somebody must look at rather than papered over with an id.
 *
 * ── The base is the argument, two years later ─────────────────────────────
 *
 * `basisAgorot` and `rateBps` are shown beside the amount because a commission
 * nobody can recompute is a commission nobody can defend, and the argument
 * happens long after the agreement was renegotiated. Nothing here multiplies
 * them: the amount is the stored figure, computed from the snapshotted rule at
 * the time, and re-deriving it on screen would produce a second answer that
 * disagrees the moment a rate changes.
 *
 * `basisAgorot` is withheld from a reader without `booking.view_price` — an
 * external seller sees what they are owed and not what the stay earned — and
 * the rule's free-text label is withheld with it, because the label routinely
 * spells the base out in words.
 *
 * No `"use client"`: rows in, markup out.
 */

import Link from 'next/link'

import { WITHHELD } from '@/app/(app)/finance/_lib/labels'
import type {
  CommissionListItem,
  CommissionPayee,
} from '@/app/(app)/finance/_lib/queries'
import { cn } from '@/components/ui/cn'
import { formatDayMonthYear } from '@/lib/booking'
import { COMMISSION_BASE_LABEL } from '@/lib/contracts/states'

import { Money } from './money'
import { CommissionStatusBadge } from './status-badges'

export type CommissionTableProps = {
  commissions: readonly CommissionListItem[]
  /** False without `booking.view`; the reference is then not a link. */
  linkBookings: boolean
}

export function CommissionTable({
  commissions,
  linkBookings,
}: CommissionTableProps) {
  return (
    <>
      {/* -------------------------------------------------------- phone -- */}
      <ul className="flex flex-col gap-3 sm:hidden">
        {commissions.map((commission) => (
          <li
            key={commission.id}
            className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="font-display text-base font-bold text-foreground">
                <Payee payee={commission.payee} />
              </span>
              <CommissionStatusBadge status={commission.status} />
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Cell label="עמלה">
                <Money agorot={commission.amountAgorot} emphasis />
              </Cell>
              <Cell label="בסיס החישוב">
                <Basis commission={commission} />
              </Cell>
              <Cell label="הזמנה">
                <Reference commission={commission} linked={linkBookings} />
              </Cell>
              <Cell label="בשלב">
                <LadderMoment commission={commission} />
              </Cell>
            </dl>

            <Notes commission={commission} />
          </li>
        ))}
      </ul>

      {/* -------------------------------------------------------- desk --- */}
      <div className="hidden overflow-hidden rounded-xl border border-border bg-surface shadow-soft sm:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-200 border-collapse text-start text-sm">
            <caption className="sr-only">
              עמלות הסוכנים של הארגון, ממוינות מהחדשה לישנה
            </caption>
            <thead>
              <tr className="border-b border-border bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <Th>מקבל התשלום</Th>
                <Th>הזמנה</Th>
                <Th>סטטוס</Th>
                <Th>בסיס החישוב</Th>
                <Th align="end">עמלה</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {commissions.map((commission) => (
                <tr
                  key={commission.id}
                  className="transition-colors hover:bg-muted"
                >
                  <Td>
                    <Payee payee={commission.payee} />
                  </Td>
                  <Td>
                    <Reference commission={commission} linked={linkBookings} />
                  </Td>
                  <Td>
                    <CommissionStatusBadge status={commission.status} />
                    <LadderMoment commission={commission} />
                    <Notes commission={commission} />
                  </Td>
                  <Td>
                    <Basis commission={commission} />
                  </Td>
                  <Td align="end">
                    <Money agorot={commission.amountAgorot} emphasis />
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

function Payee({ payee }: { payee: CommissionPayee }) {
  if (payee.kind === 'unknown') {
    return (
      <span className="text-danger">
        לא ניתן לזהות את מקבל התשלום — יש לבדוק את הרשומה
      </span>
    )
  }

  if (payee.kind === 'agency') {
    return (
      <span className="flex flex-col">
        <span>{payee.name ?? WITHHELD}</span>
        <span className="text-xs text-muted-foreground">סוכנות</span>
      </span>
    )
  }

  return (
    <span className="flex flex-col">
      <span>{payee.name ?? WITHHELD}</span>
      {payee.agencyName !== null && (
        <span className="text-xs text-muted-foreground">
          {payee.agencyName}
        </span>
      )}
    </span>
  )
}

/**
 * What the commission was computed on: the named base, the rate, and the
 * amount that rate was applied to.
 *
 * The base's *name* is always shown — a percentage of the gross is a different
 * deal from a percentage of the net, and knowing which was agreed is not a
 * price. The *figure* is the stay's revenue and is withheld with prices.
 */
function Basis({ commission }: { commission: CommissionListItem }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span>{COMMISSION_BASE_LABEL[commission.basis]}</span>
      <span className="text-xs text-muted-foreground">
        {commission.rateBps === null
          ? 'סכום קבוע'
          : `${commission.rateBps / 100}% מתוך `}
        {commission.rateBps !== null && (
          <Money agorot={commission.basisAgorot} />
        )}
      </span>
      {commission.rule.label.length > 0 && (
        <span className="text-xs text-muted-foreground">
          {commission.rule.label}
        </span>
      )}
    </span>
  )
}

function Reference({
  commission,
  linked,
}: {
  commission: CommissionListItem
  linked: boolean
}) {
  if (commission.bookingReference === null) {
    return <span className="text-muted-foreground">–</span>
  }

  const reference = (
    <span dir="ltr" className="font-mono text-xs">
      {commission.bookingReference}
    </span>
  )

  if (!linked) return reference

  return (
    <Link
      href={`/bookings/${commission.bookingId}`}
      className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {reference}
    </Link>
  )
}

/**
 * The last rung the commission actually reached.
 *
 * The newest moment wins, because the ladder only moves forward:
 * `estimated → pending → eligible → approved → paid`. Showing all three dates
 * on every row makes the reader work out which one is current.
 */
function LadderMoment({ commission }: { commission: CommissionListItem }) {
  const moment =
    commission.paidOn !== null
      ? `שולמה ${formatDayMonthYear(commission.paidOn)}`
      : commission.approvedOn !== null
        ? `אושרה ${formatDayMonthYear(commission.approvedOn)}`
        : commission.becameEligibleOn !== null
          ? `זכאית מ-${formatDayMonthYear(commission.becameEligibleOn)}`
          : `נרשמה ${formatDayMonthYear(commission.recordedOn)}`

  return (
    <span className="mt-1 block text-xs text-muted-foreground">{moment}</span>
  )
}

/**
 * The two things about a commission that need saying out loud.
 *
 * A clawback is money that has already left the business, so it is not a
 * status change and cannot be one — the honest record is a flag that somebody
 * must get it back.
 */
function Notes({ commission }: { commission: CommissionListItem }) {
  return (
    <>
      {commission.clawbackRequired && (
        <span className="mt-1.5 block text-xs text-danger">
          ההזמנה זוכתה אחרי שהעמלה שולמה — יש להשיב את הכסף.
        </span>
      )}
      {commission.cancellationReason !== null && (
        <span className="mt-1.5 block text-xs text-muted-foreground">
          {commission.cancellationReason}
        </span>
      )}
    </>
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
