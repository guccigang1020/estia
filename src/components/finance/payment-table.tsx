/**
 * The payments list, as a table on a desk and as cards on a phone.
 *
 * Two renderings of the same rows rather than one table that scrolls
 * sideways, exactly as `BookingTable` does and for the same reason: the
 * product is used one-handed, and a horizontally scrolling table is unusable
 * there. Both are in the DOM once each and the heading order is the same in
 * both.
 *
 * ── What an absence means here ────────────────────────────────────────────
 *
 * A missing key is a withheld field — `payerName` is gone for a reader without
 * `guest.view_name`, and the three amounts are gone without
 * `booking.view_price`. `Money` and the cells below say so in words. A blank
 * cell in a money column reads as ₪0, which is a number and a wrong one.
 *
 * A null is a real absence: a payment that has not been paid has no `paidOn`,
 * and that is the answer rather than a gap.
 *
 * ── The row that is still waiting for somebody ────────────────────────────
 *
 * `requiresAttention` is rendered as an instruction under the status, and
 * `unknown` keeps its own tone. Neither is folded into "נכשל": a processor
 * timeout means the card may or may not have been charged, and telling a
 * bookkeeper it definitely was not is the one thing nobody knows.
 *
 * No `"use client"`: rows in, markup out.
 */

import Link from 'next/link'

import {
  COLLECTION_CHANNEL_LABEL,
  PAYMENT_ATTENTION_LABEL,
  PAYMENT_METHOD_LABEL,
  PAYMENT_PURPOSE_LABEL,
  WITHHELD,
} from '@/app/(app)/finance/_lib/labels'
import type { PaymentListItem } from '@/app/(app)/finance/_lib/queries'
import { cn } from '@/components/ui/cn'
import { formatDayMonthYear } from '@/lib/booking'

import { Money } from './money'
import { PaymentStatusBadge } from './status-badges'

export type PaymentTableProps = {
  payments: readonly PaymentListItem[]
  /**
   * False when the reader lacks `booking.view`. The reference is then text
   * rather than a link, because the route behind it would refuse them — an
   * offered link that redirects is worse than no link.
   */
  linkBookings: boolean
}

export function PaymentTable({ payments, linkBookings }: PaymentTableProps) {
  return (
    <>
      {/* -------------------------------------------------------- phone -- */}
      <ul className="flex flex-col gap-3 sm:hidden">
        {payments.map((payment) => (
          <li
            key={payment.id}
            className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="font-display text-base font-bold text-foreground">
                <Payer payment={payment} />
              </span>
              <PaymentStatusBadge status={payment.status} />
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Cell label="סכום">
                <Money agorot={payment.amountAgorot} emphasis />
              </Cell>
              <Cell label="אמצעי תשלום">
                {PAYMENT_METHOD_LABEL[payment.method]}
              </Cell>
              <Cell label="הזמנה">
                <BookingReference payment={payment} linked={linkBookings} />
              </Cell>
              <Cell label="תאריך">
                <PaymentDates payment={payment} />
              </Cell>
            </dl>

            <AttentionNote payment={payment} />
          </li>
        ))}
      </ul>

      {/* -------------------------------------------------------- desk --- */}
      <div className="hidden overflow-hidden rounded-xl border border-border bg-surface shadow-soft sm:block">
        {/* Its own scroller, so a wide table never widens the shell. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-200 border-collapse text-start text-sm">
            <caption className="sr-only">
              רשימת התשלומים של הארגון, ממוינת מהחדש לישן
            </caption>
            <thead>
              <tr className="border-b border-border bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <Th>משלם</Th>
                <Th>הזמנה</Th>
                <Th>אמצעי תשלום</Th>
                <Th>סטטוס</Th>
                <Th>תאריך</Th>
                <Th align="end">סכום</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {payments.map((payment) => (
                <tr
                  key={payment.id}
                  className="transition-colors hover:bg-muted"
                >
                  <Td>
                    <Payer payment={payment} />
                    <span className="block text-xs text-muted-foreground">
                      {PAYMENT_PURPOSE_LABEL[payment.purpose]}
                    </span>
                  </Td>
                  <Td>
                    <BookingReference payment={payment} linked={linkBookings} />
                  </Td>
                  <Td>
                    {PAYMENT_METHOD_LABEL[payment.method]}
                    <span className="block text-xs text-muted-foreground">
                      {COLLECTION_CHANNEL_LABEL[payment.channel]}
                    </span>
                  </Td>
                  <Td>
                    <PaymentStatusBadge status={payment.status} />
                    <AttentionNote payment={payment} />
                  </Td>
                  <Td>
                    <PaymentDates payment={payment} />
                  </Td>
                  <Td align="end">
                    <Money agorot={payment.amountAgorot} emphasis />
                    {/* Shown only when there is one. A "הוחזר: ₪0" on every
                        row is noise that hides the rows where it is not. */}
                    {payment.refundedAgorot !== undefined &&
                      payment.refundedAgorot > 0 && (
                        <span className="block text-xs text-muted-foreground">
                          הוחזר <Money agorot={payment.refundedAgorot} />
                        </span>
                      )}
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
 * Who paid.
 *
 * Three states, and they are not the same sentence. The key is absent when the
 * reader may not see guest names; the value is null when the payment recorded
 * no payer — money that arrived by transfer with nothing but a reference. Both
 * are said, and neither becomes "אורח".
 */
function Payer({ payment }: { payment: PaymentListItem }) {
  if (!('payerName' in payment)) {
    return <span className="font-normal text-muted-foreground">{WITHHELD}</span>
  }
  if (payment.payerName === null || payment.payerName === undefined) {
    return (
      <span className="font-normal text-muted-foreground">לא נרשם שם משלם</span>
    )
  }
  return <>{payment.payerName}</>
}

function BookingReference({
  payment,
  linked,
}: {
  payment: PaymentListItem
  linked: boolean
}) {
  if (payment.bookingReference === null) {
    return <span className="text-muted-foreground">–</span>
  }

  const reference = (
    <span dir="ltr" className="font-mono text-xs">
      {payment.bookingReference}
    </span>
  )

  if (!linked) return reference

  return (
    <Link
      href={`/bookings/${payment.bookingId}`}
      className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {reference}
    </Link>
  )
}

/**
 * When it was recorded, and when the money actually arrived.
 *
 * Two dates because they are two facts. A payment recorded on Sunday and paid
 * on Thursday is the ordinary shape of a bank transfer, and a screen showing
 * one date cannot answer "when did we get the money".
 */
function PaymentDates({ payment }: { payment: PaymentListItem }) {
  return (
    <span className="flex flex-col">
      <span>{formatDayMonthYear(payment.recordedOn)}</span>
      <span className="text-xs text-muted-foreground">
        {payment.paidOn === null
          ? 'טרם שולם'
          : `שולם ${formatDayMonthYear(payment.paidOn)}`}
      </span>
    </span>
  )
}

/** The instruction, when the automation has stopped and will not restart. */
function AttentionNote({ payment }: { payment: PaymentListItem }) {
  if (payment.requiresAttention === null) return null

  return (
    <span className="mt-1.5 block text-xs text-foreground">
      {PAYMENT_ATTENTION_LABEL[payment.requiresAttention]}
      {payment.unknownSince !== null && (
        <span className="text-muted-foreground">
          {' '}
          (מאז {formatDayMonthYear(payment.unknownSince)})
        </span>
      )}
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
