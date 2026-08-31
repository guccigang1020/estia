/**
 * Invoices, each as a document rather than as a row.
 *
 * A tax invoice is not a list item. It has a number, a customer, an
 * itemisation, a split between net and VAT, and the payments it accounts for —
 * and a bookkeeper's question is almost always about one document rather than
 * about the shape of the column. So each one is a card carrying its own
 * breakdown, and the list is the stack of them.
 *
 * ── The total is the document's, and the sum is the lines' ────────────────
 *
 * Both are shown, and neither is computed here. `linesTotalAgorot` is
 * `sumAgorot` over the lines, computed once in `finance/_lib/queries.ts`;
 * `totalAgorot` is the frozen figure on the document. An issued invoice's total
 * may not be recomputed — the only correction to a legal document is a credit
 * note — so a screen that quietly rendered the sum of the lines in its place
 * would be silently amending a tax record.
 *
 * When the two disagree the card says so and asks the reader to trust neither,
 * exactly as `BookingPriceLines` does for a booking whose stored total has
 * drifted. That disagreement is the finding; picking one of the numbers hides
 * it.
 *
 * ── Two different reasons an invoice shows no payments ────────────────────
 *
 * `payments === null` means this reader may not see payment records at all;
 * an empty array means the document has settled nothing yet. Collapsing them
 * would tell somebody an invoice is unpaid because of their own permissions.
 * The link count comes from `invoice_payments` and needs only `invoice.view`,
 * so the first case can still say how many there are.
 *
 * No `"use client"`: rows in, markup out.
 */

import Link from 'next/link'

import {
  INVOICE_KIND_LABEL,
  PAYMENT_METHOD_LABEL,
  WITHHELD,
} from '@/app/(app)/finance/_lib/labels'
import type {
  InvoiceListItem,
  InvoicePaymentLink,
} from '@/app/(app)/finance/_lib/queries'
import { cn } from '@/components/ui/cn'
import { formatDayMonth, formatDayMonthYear } from '@/lib/booking'

import { Money } from './money'
import { InvoiceStatusBadge, PaymentStatusBadge } from './status-badges'

export function InvoiceList({
  invoices,
  linkBookings,
}: {
  invoices: readonly InvoiceListItem[]
  /** False without `booking.view`; the reference is then not a link. */
  linkBookings: boolean
}) {
  return (
    <ul className="flex flex-col gap-5">
      {invoices.map((invoice) => (
        <li key={invoice.id}>
          <InvoiceCard invoice={invoice} linkBookings={linkBookings} />
        </li>
      ))}
    </ul>
  )
}

function InvoiceCard({
  invoice,
  linkBookings,
}: {
  invoice: InvoiceListItem
  linkBookings: boolean
}) {
  const drifted =
    invoice.linesTotalAgorot !== undefined &&
    invoice.totalAgorot !== undefined &&
    invoice.linesTotalAgorot !== invoice.totalAgorot

  return (
    <article className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-5 shadow-soft sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-lg font-bold tracking-tight text-foreground">
            {INVOICE_KIND_LABEL[invoice.kind]}{' '}
            {invoice.displayNumber === null ? (
              // `invoices_issued_pair`: a draft has no number, and printing
              // one would show a tax document number never allocated.
              <span className="font-normal text-muted-foreground">
                — טרם הופקה
              </span>
            ) : (
              <span dir="ltr" className="font-mono text-base">
                {invoice.displayNumber}
              </span>
            )}
          </h2>
          <p className="text-sm text-muted-foreground">
            <Customer invoice={invoice} />
          </p>
        </div>
        <InvoiceStatusBadge status={invoice.status} />
      </header>

      <dl className="grid gap-4 text-sm sm:grid-cols-3">
        <Fact label="הופקה">
          {invoice.issuedOn === null
            ? 'טרם הופקה'
            : formatDayMonthYear(invoice.issuedOn)}
        </Fact>
        <Fact label="סדרה">
          <span dir="ltr" className="font-mono text-xs">
            {invoice.series} · {invoice.year}
          </span>
        </Fact>
        <Fact label="הזמנה">
          {linkBookings ? (
            <Link
              href={`/bookings/${invoice.bookingId}`}
              className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              מעבר להזמנה
            </Link>
          ) : (
            <span className="text-muted-foreground">–</span>
          )}
        </Fact>
      </dl>

      {invoice.status === 'cancelled' &&
        invoice.cancellationReason !== null && (
          <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground">
            <span className="font-semibold">בוטלה</span>
            {invoice.cancelledOn !== null &&
              ` ב-${formatDayMonthYear(invoice.cancelledOn)}`}
            : {invoice.cancellationReason}
          </p>
        )}

      <InvoiceLines invoice={invoice} />

      {drifted && (
        <p
          role="alert"
          className="rounded-lg border border-danger bg-surface px-4 py-3 text-xs text-danger"
        >
          סכום השורות (<Money agorot={invoice.linesTotalAgorot} />) אינו שווה
          לסך המסמך (<Money agorot={invoice.totalAgorot} />
          ). זו תקלה בנתונים — אל תסתמך על אף אחד משני המספרים עד לבירור.
        </p>
      )}

      <LinkedPayments invoice={invoice} />
    </article>
  )
}

/* ------------------------------------------------------------ fragments -- */

function Customer({ invoice }: { invoice: InvoiceListItem }) {
  if (!('customerName' in invoice)) return <>{WITHHELD}</>

  return (
    <>
      {invoice.customerName}
      {invoice.customerTaxId !== null &&
        invoice.customerTaxId !== undefined && (
          <span dir="ltr" className="ms-2 font-mono text-xs">
            {invoice.customerTaxId}
          </span>
        )}
    </>
  )
}

/**
 * The itemisation and the document's own totals.
 *
 * The lines are absent, not empty, for a reader without `booking.view_price`.
 * Rendering a ₪0 total there would be a fabricated number, so the block says
 * what happened instead — the same choice `BookingPriceLines` makes.
 */
function InvoiceLines({ invoice }: { invoice: InvoiceListItem }) {
  if (invoice.lines === undefined) {
    return (
      <p className="text-sm text-muted-foreground">
        פירוט המסמך והסכומים אינם זמינים לצפייה בהרשאות שלך.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">פירוט שורות המסמך</caption>
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
          {invoice.lines.map((line, index) => (
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
              <td className="py-2.5 text-end">
                <Money agorot={line.amount} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t-2 border-border-strong">
          <tr>
            <th scope="row" colSpan={2} className="py-2 text-start font-normal">
              סכום השורות
            </th>
            <td className="py-2 text-end">
              <Money agorot={invoice.linesTotalAgorot} />
            </td>
          </tr>
          <tr>
            <th scope="row" colSpan={2} className="py-1 text-start font-normal">
              לפני מע״מ
            </th>
            <td className="py-1 text-end">
              <Money agorot={invoice.subtotalAgorot} />
            </td>
          </tr>
          <tr>
            <th scope="row" colSpan={2} className="py-1 text-start font-normal">
              מע״מ
              {invoice.taxRateBps !== null && (
                <span className="text-muted-foreground">
                  {' '}
                  ({invoice.taxRateBps / 100}%)
                </span>
              )}
            </th>
            <td className="py-1 text-end">
              <Money agorot={invoice.taxAgorot} />
            </td>
          </tr>
          <tr>
            <th scope="row" colSpan={2} className="py-3 text-start font-bold">
              סה״כ המסמך
            </th>
            <td className="py-3 text-end text-base">
              <Money agorot={invoice.totalAgorot} emphasis />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function LinkedPayments({ invoice }: { invoice: InvoiceListItem }) {
  if (invoice.payments === null) {
    return (
      <p className="text-sm text-muted-foreground">
        {invoice.linkedPaymentCount === 0
          ? 'לא שויכו תשלומים למסמך הזה.'
          : `${invoice.linkedPaymentCount} תשלומים משויכים למסמך הזה. פרטי התשלומים אינם זמינים לצפייה בהרשאות שלך.`}
      </p>
    )
  }

  if (invoice.payments.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {invoice.status === 'draft'
          ? 'טיוטה עוד לא סילקה דבר, ולכן אין תשלומים משויכים.'
          : 'לא שויכו תשלומים למסמך הזה.'}
      </p>
    )
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        תשלומים משויכים
      </h3>
      <ul className="flex flex-col gap-2">
        {invoice.payments.map((payment) => (
          <li
            key={payment.id}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted px-3 py-2 text-sm"
          >
            <PaymentStatusBadge status={payment.status} />
            <span>{PAYMENT_METHOD_LABEL[payment.method]}</span>
            <PaymentMoment payment={payment} />
            <Money agorot={payment.amountAgorot} className="ms-auto" emphasis />
          </li>
        ))}
      </ul>
    </section>
  )
}

function PaymentMoment({ payment }: { payment: InvoicePaymentLink }) {
  return (
    <span className="text-muted-foreground">
      {payment.paidOn === null
        ? 'טרם שולם'
        : formatDayMonthYear(payment.paidOn)}
    </span>
  )
}

function Fact({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('flex flex-col gap-0.5')}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  )
}
