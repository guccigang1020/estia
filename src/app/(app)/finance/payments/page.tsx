import type { Metadata } from 'next'

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { ActionError } from '@/components/booking/action-error'
import { PaymentTable } from '@/components/finance/payment-table'
import { StatusFilterBar } from '@/components/finance/status-filter'
import { EmptyState } from '@/components/states/empty-state'
import { resolveEmptyReason } from '@/components/states/empty-presets'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { PAYMENT_STATUSES } from '@/lib/contracts/states'
import { toSafeResponse } from '@/lib/errors'
import { PAYMENT_STATUS_LABEL } from '@/lib/finance'
import { formatAgorot } from '@/lib/plans/plan'

import { ALL_PROPERTIES, shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import {
  describeStatusFilter,
  hasActiveStatusFilter,
  parseStatusFilter,
} from '../_lib/filters'
import {
  FINANCE_PAGE_SIZE,
  countPayments,
  listPayments,
  paymentTotals,
  paymentsNeedingAttention,
  type PaymentListItem,
} from '../_lib/queries'
import { financeRepository } from '../_lib/wiring'

export const metadata: Metadata = { title: 'תשלומים' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The payments list.
 *
 * WHAT IS ON THIS SCREEN. Rows from `public.payments` for the organization the
 * shell resolved, narrowed to the selected property, read through the
 * request-scoped Supabase client under row level security. Every value shown
 * is a column or a Hebrew name for one. The three figures above the table are
 * `sumAgorot` over the rows on screen — the domain's own sum, computed in
 * `_lib/queries.ts` — and not a ledger balance, because a ledger balance is a
 * number this screen was never given.
 *
 * GATING, IN FOUR PLACES, AND NONE OF THEM IS THE MENU.
 * `requireGrant('payment.view')` refuses the route. `can()` per row narrows to
 * the properties this membership reaches. `redact()` removes the payer's name
 * without `guest.view_name` and the amounts without `booking.view_price`. And
 * `payments_select` carries `has_permission(organization_id, 'payment.view')`
 * plus `property_in_scope`, so the database refuses regardless of all three.
 * Hiding a column is the courtesy; RLS is the enforcement.
 *
 * ── `unknown` is not `failed`, and this screen is where that matters ──────
 *
 * A processor that timed out leaves money in a state where the card may or may
 * not have been charged. Folding that into "נכשל" tells a bookkeeper it
 * definitely was not, which is the one thing nobody knows. So the status keeps
 * its own tone and its own label, `requires_attention` is rendered as an
 * instruction on the row, and the count is stated above the table — because a
 * row that needs a human is not something to be found by scrolling.
 *
 * THE EMPTY STATE IS TWO STATES. `resolveEmptyReason` is given the filtered
 * count *and* the unfiltered one, so "you have never taken a payment" is never
 * shown to somebody whose filter merely matched nothing.
 */
export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [actor, context, params] = await Promise.all([
    requireGrant('payment.view'),
    shellContext(),
    searchParams,
  ])

  // `requireGrant` redirects when the context is not ready, so this is
  // narrowing for the type system rather than a second decision.
  if (!context || context.status !== 'ready') return null

  const filter = parseStatusFilter(params, PAYMENT_STATUSES)
  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId
  const propertyName =
    propertyId === null
      ? null
      : (context.properties.find((property) => property.id === propertyId)
          ?.name ?? null)

  // The control is offered only when the route behind it would admit them.
  const linkBookings = holdsGrant(actor, 'booking.view')

  let payments: readonly PaymentListItem[] = []
  let total = 0
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const { repo } = await financeRepository()
    ;[payments, total] = await Promise.all([
      listPayments({
        repo,
        actor,
        organizationId: actor.organizationId,
        propertyId,
        filter,
      }),
      countPayments(repo, actor.organizationId, propertyId),
    ])
  } catch (cause) {
    // A screen that renders nothing because a query failed must not look like
    // a business with no payments. The failure is stated instead.
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const totals = paymentTotals(payments)
  const attention = paymentsNeedingAttention(payments)
  const emptyReason = resolveEmptyReason({
    visibleCount: payments.length,
    totalCount: total,
    hasActiveFilters: hasActiveStatusFilter(filter, propertyId),
  })

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          תשלומים
        </h1>
        <p className="text-muted-foreground">
          {propertyName
            ? `כל התשלומים שנרשמו ב״${propertyName}״.`
            : 'כל התשלומים שנרשמו בארגון, בכל הנכסים שבטווח שלך.'}{' '}
          {total === 1 ? 'תשלום אחד סה״כ' : `${total} תשלומים סה״כ`}.
        </p>
      </header>

      <StatusFilterBar
        path="/finance/payments"
        legend="סינון תשלומים"
        statuses={PAYMENT_STATUSES}
        labels={PAYMENT_STATUS_LABEL}
        selected={filter.status}
        anyLabel="כל הסטטוסים"
      />

      {failure ? (
        <ActionError error={failure.error} />
      ) : emptyReason ? (
        <EmptyState
          illustration={emptyReason === 'no_results' ? 'search' : 'invoice'}
          title={
            emptyReason === 'no_results'
              ? 'אין תשלומים שתואמים לסינון'
              : 'עוד לא נרשמו תשלומים'
          }
          body={
            emptyReason === 'no_results'
              ? `הסינון הפעיל (${describeStatusFilter(
                  filter,
                  PAYMENT_STATUS_LABEL,
                  propertyName,
                )}) לא מחזיר תוצאות. תשלומים אחרים קיימים במערכת — שינוי או ניקוי הסינון יחזיר אותם.`
              : 'כאן יופיע כל כסף שנכנס — מקדמה, יתרה, פיקדון או החזר — עם האמצעי שדרכו שולם, ההזמנה שהוא שייך לה והמצב שבו הוא נמצא מול הסולק.'
          }
          action={
            emptyReason === 'no_results' ? (
              <Button href="/finance/payments" variant="secondary">
                נקה סינון
              </Button>
            ) : null
          }
        />
      ) : (
        <>
          {attention.length > 0 && (
            <p
              // `alert`, not a polite status: this is money nobody can account
              // for, and it is the reason somebody opened this screen.
              role="alert"
              className="rounded-lg border border-danger bg-surface px-4 py-3 text-sm text-foreground"
            >
              <span className="font-semibold text-danger">
                {attention.length === 1
                  ? 'תשלום אחד דורש בירור ידני'
                  : `${attention.length} תשלומים דורשים בירור ידני`}
              </span>{' '}
              — הסולק לא השיב, ולכן לא ידוע אם החיוב בוצע. אלה אינם תשלומים
              שנכשלו, והמערכת לא תסגור אותם בעצמה.
            </p>
          )}

          {totals !== null && (
            <dl className="grid gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:grid-cols-3 sm:p-5">
              {/* Three figures, not one. "התשלומים על המסך מסתכמים ב-₪48,000"
                  means nothing when a third of them failed: what was asked
                  for, what was taken and what went back are three facts. */}
              <Total label="נדרש" value={totals.askedAgorot} />
              <Total label="נגבה בפועל" value={totals.capturedAgorot} />
              <Total label="הוחזר" value={totals.refundedAgorot} />
              <p className="text-xs text-muted-foreground sm:col-span-3">
                הסכומים הם סיכום השורות המוצגות בלבד, ולא מאזן הארגון.
              </p>
            </dl>
          )}

          <PaymentTable payments={payments} linkBookings={linkBookings} />

          {/* Said out loud rather than left for somebody to discover that the
              list quietly stops. */}
          {payments.length === FINANCE_PAGE_SIZE && (
            <p
              role="status"
              className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
            >
              מוצגים {FINANCE_PAGE_SIZE} התשלומים האחרונים. צמצם את הסינון כדי
              לראות תשלומים נוספים.
            </p>
          )}
        </>
      )}
    </div>
  )
}

function Total({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-display text-xl font-bold tabular-nums text-foreground">
        {formatAgorot(value)}
      </dd>
    </div>
  )
}
