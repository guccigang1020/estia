import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { StoreLock } from '@/components/store/store-lock'
import {
  AttentionBadge,
  Money,
  OrderStatusBadge,
  PaymentStatusBadge,
  StoreNav,
} from '@/components/store/store-chrome'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { holdsGrant } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'
import {
  STORE_FULFILMENT_KIND_LABEL,
  STORE_ORDER_SOURCE_LABEL,
  STORE_PAYMENT_MODE_LABEL,
  STORE_PRICE_SOURCE_LABEL,
  tasksForOrder,
} from '@/lib/store'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../../_lib/context'
import { requireStoreGrant } from '../../_lib/gate'
import { loadOrderDetail, type OrderDetailView } from '../../_lib/queries'
import { OrderActions } from './order-actions'

export const metadata: Metadata = { title: 'הזמנה · חנות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. One order, in full.
 *
 * ── The panel that matters most is the lines panel ───────────────────────
 *
 * Every figure on it is a SNAPSHOT, and the screen says so beside each one:
 * `priceSource` is rendered in words — "מחיר הקטלוג בזמן ההזמנה", "מחיר שנקבע
 * לנכס הזה" — because a figure whose provenance is unknown is a figure nobody
 * can defend when a guest rings up in three weeks. Nothing on this page reads
 * the catalogue.
 *
 * ── The provider panel says what it does not send ────────────────────────
 *
 * A person writing "for Mrs Cohen, 052-987-6543" into an operational note is
 * the one hole the type system cannot close, so the panel states out loud that
 * the note is the only free text the provider reads.
 */
export default async function StoreOrderDetailPage({
  params,
}: {
  params: Promise<{ orderId: string }>
}) {
  const [access, context, { orderId }] = await Promise.all([
    requireStoreGrant('order.view'),
    shellContext(),
    params,
  ])

  if (access.kind === 'locked') {
    return (
      <StoreLock
        entitlement={access.entitlement}
        title="החנות אינה כלולה בחבילה שלכם"
        body="כאן היו פרטי ההזמנה."
      />
    )
  }

  if (!context || context.status !== 'ready') return null

  let detail: OrderDetailView | null = null
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    detail = await loadOrderDetail({
      db,
      actor: access.actor,
      orderId,
      now: new Date(),
    })
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  if (!failure && !detail) notFound()

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <StoreNav current="/store/orders" />

      {failure ? (
        <ActionError error={failure.error} />
      ) : !detail ? null : (
        <OrderDetail
          detail={detail}
          mayManage={holdsGrant(access.actor, 'order.manage')}
        />
      )}
    </div>
  )
}

function OrderDetail({
  detail,
  mayManage,
}: {
  detail: OrderDetailView
  mayManage: boolean
}) {
  const { order } = detail

  // Derived from the SNAPSHOT recipes on the lines, so a recipe edited on the
  // catalogue since the purchase does not change what this order promised.
  const tasks = tasksForOrder({
    order,
    serviceAt: new Date(
      `${order.requestedForDate ?? new Date().toISOString().slice(0, 10)}T12:00:00Z`,
    ),
  })

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
              {order.reference}
            </h1>
            <OrderStatusBadge status={order.status} />
            <AttentionBadge attention={detail.attention} />
          </div>
          <p className="text-sm text-muted-foreground">
            נוצרה על ידי {STORE_ORDER_SOURCE_LABEL[order.source]} ·{' '}
            {new Date(order.createdAt).toLocaleDateString('he-IL')}
            {order.bookingId && ' · משויכת להזמנת שהות'}
          </p>
        </div>

        <div className="flex flex-col items-end gap-1">
          <Money agorot={order.totalAgorot} emphasis className="text-xl" />
          <PaymentStatusBadge
            status={order.paymentStatus}
            mode={order.paymentMode}
          />
        </div>
      </header>

      {/* ────────────────────────────────────────────────── the lines ── */}
      <Card>
        <CardHeader>
          <CardTitle as="h2">פריטים</CardTitle>
        </CardHeader>

        <p className="mt-2 text-sm text-muted-foreground">
          כל הסכומים כאן הם מה שסוכם ברגע ההזמנה. שינוי מחיר בקטלוג אינו משנה
          אותם.
        </p>

        <ul className="mt-4 flex flex-col divide-y divide-border">
          {order.lines.map((line) => (
            <li key={line.id} className="flex flex-col gap-1.5 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <span className="font-medium text-foreground">
                  {line.itemNameSnapshot}
                  {line.quantity > 1 && ` × ${line.quantity}`}
                </span>
                <Money agorot={line.lineTotalAgorot} emphasis />
              </div>

              {line.chosenOptions.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  {line.chosenOptions
                    .map(
                      (option) =>
                        `${option.optionNameSnapshot}: ${option.valueLabelSnapshot}`,
                    )
                    .join(' · ')}
                </p>
              )}

              {Object.keys(line.customizationAnswers).length > 0 && (
                <p className="text-sm text-muted-foreground">
                  {Object.entries(line.customizationAnswers)
                    .map(([key, value]) => `${key}: ${value}`)
                    .join(' · ')}
                </p>
              )}

              <p className="text-xs text-muted-foreground">
                <Money agorot={line.unitPriceAgorot} /> ליחידה ·{' '}
                {STORE_PRICE_SOURCE_LABEL[line.priceSource]} ·{' '}
                {new Date(line.priceSnapshotAt).toLocaleDateString('he-IL')}
                {line.optionsAgorot !== 0 && (
                  <>
                    {' · אפשרויות '}
                    <Money agorot={line.optionsAgorot} />
                  </>
                )}
              </p>

              {line.fulfilmentKindSnapshot !== 'none' && (
                <p className="text-xs text-muted-foreground">
                  ביצוע:{' '}
                  {STORE_FULFILMENT_KIND_LABEL[line.fulfilmentKindSnapshot]}
                  {line.leadTimeHoursSnapshot > 0 &&
                    ` · ${line.leadTimeHoursSnapshot} שעות התראה שהובטחו`}
                </p>
              )}
            </li>
          ))}
        </ul>

        <dl className="mt-4 flex flex-col gap-1 border-t border-border pt-4 text-sm">
          <Row label="סכום ביניים" agorot={order.subtotalAgorot} />
          {order.discountAgorot > 0 && (
            <Row label="הנחה" agorot={-order.discountAgorot} />
          )}
          <Row label="סך הכול" agorot={order.totalAgorot} emphasis />
        </dl>
      </Card>

      {/* ────────────────────────────────────────────────── the money ── */}
      <Card>
        <CardHeader>
          <CardTitle as="h2">תשלום</CardTitle>
        </CardHeader>

        <p className="mt-2 text-sm text-muted-foreground">
          {STORE_PAYMENT_MODE_LABEL[order.paymentMode]}.{' '}
          {order.paymentStatus === 'unpaid' &&
            order.paymentMode === 'with_booking' &&
            'הסכום מצטרף ליתרת השהות — זו אינה חריגה.'}
        </p>

        {detail.payments.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            טרם נרשם תשלום על ההזמנה הזו.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col divide-y divide-border">
            {detail.payments.map((payment) => (
              <li
                key={payment.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
              >
                <span className="text-muted-foreground">
                  {new Date(payment.recordedAt).toLocaleDateString('he-IL')} ·{' '}
                  {payment.method}
                  {payment.reference && ` · ${payment.reference}`}
                </span>
                <Money agorot={payment.amountAgorot} emphasis />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ──────────────────────────────────────────────── fulfilment ── */}
      <Card>
        <CardHeader>
          <CardTitle as="h2">תפעול</CardTitle>
        </CardHeader>

        {tasks.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            הפריטים בהזמנה הזו אינם יוצרים משימה לצוות.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {tasks.map((task) => (
              <li
                key={task.dedupeKey}
                className="rounded-lg border border-border bg-muted px-4 py-3"
              >
                <p className="font-medium text-foreground">{task.title}</p>
                <p className="text-xs text-muted-foreground">
                  לביצוע עד {new Date(task.dueAt).toLocaleString('he-IL')}
                </p>
                {task.checklist.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
                    {task.checklist.map((step) => (
                      <li key={step}>· {step}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}

        {detail.providerRequests.length > 0 && (
          <div className="mt-5 border-t border-border pt-4">
            <p className="text-sm font-semibold text-foreground">
              בקשות לספקים
            </p>
            <ul className="mt-2 flex flex-col gap-2 text-sm">
              {detail.providerRequests.map((request) => (
                <li key={request.id} className="flex flex-wrap gap-3">
                  <Badge>{request.status}</Badge>
                  <span className="text-muted-foreground">
                    {request.serviceName} · {request.serviceDate} ·{' '}
                    {request.reference}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="mt-4 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          בקשה שיוצאת לספק כוללת את הנכס, התאריך, השעה, השירות והערות התפעול —
          ולא את שם האורח, הטלפון, המחיר או מצב התשלום. ההערה התפעולית היא הטקסט
          החופשי היחיד שהספק קורא, אז אל תכתבו בה פרטי אורח.
        </p>
      </Card>

      {/* ─────────────────────────────────────────────── amendments ── */}
      {detail.amendments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle as="h2">תיקונים</CardTitle>
          </CardHeader>

          <ul className="mt-4 flex flex-col divide-y divide-border">
            {detail.amendments.map((amendment) => (
              <li key={amendment.id} className="flex flex-col gap-1 py-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge
                    tone={
                      amendment.status === 'awaiting_consent'
                        ? 'accent'
                        : 'neutral'
                    }
                  >
                    {amendment.status === 'awaiting_consent'
                      ? 'ממתין להסכמת האורח'
                      : amendment.status}
                  </Badge>
                  <span className="text-foreground">{amendment.reason}</span>
                  <Money agorot={amendment.deltaAgorot} />
                </div>
                <span className="text-xs text-muted-foreground">
                  {new Date(amendment.createdAt).toLocaleString('he-IL')}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ─────────────────────────────────────────── guest and notes ── */}
      {(order.guestNotes || order.internalNotes) && (
        <Card>
          <CardHeader>
            <CardTitle as="h2">הערות</CardTitle>
          </CardHeader>
          {order.guestNotes && (
            <p className="mt-3 text-sm text-foreground">
              מהאורח: {order.guestNotes}
            </p>
          )}
          {order.internalNotes && (
            <p className="mt-2 text-sm text-muted-foreground">
              פנימי: {order.internalNotes}
            </p>
          )}
        </Card>
      )}

      {/* ────────────────────────────────────────────────── actions ── */}
      {mayManage && (
        <Card>
          <CardHeader>
            <CardTitle as="h2">פעולות</CardTitle>
          </CardHeader>
          <div className="mt-4">
            <OrderActions
              orderId={order.id}
              status={order.status}
              paymentStatus={order.paymentStatus}
              totalShekels={(order.totalAgorot / 100).toString()}
              mayApprove={mayManage}
              mayRecordPayment={mayManage}
            />
          </div>
        </Card>
      )}

      <Link
        href="/store/orders"
        className="text-sm text-primary underline underline-offset-4"
      >
        חזרה לרשימת ההזמנות
      </Link>
    </>
  )
}

function Row({
  label,
  agorot,
  emphasis = false,
}: {
  label: string
  agorot: number
  emphasis?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>
        <Money agorot={agorot} emphasis={emphasis} />
      </dd>
    </div>
  )
}
