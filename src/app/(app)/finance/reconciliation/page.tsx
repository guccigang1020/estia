import type { Metadata } from 'next'

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { ActionError } from '@/components/booking/action-error'
import { ReconciliationTable } from '@/components/finance/reconciliation-table'
import { StatusFilterBar } from '@/components/finance/status-filter'
import { EmptyState } from '@/components/states/empty-state'
import { resolveEmptyReason } from '@/components/states/empty-presets'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'
import { formatAgorot } from '@/lib/plans/plan'

import { ALL_PROPERTIES, shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import {
  describeStatusFilter,
  hasActiveStatusFilter,
  parseStatusFilter,
} from '../_lib/filters'
import { RECONCILIATION_OUTCOME_LABEL } from '../_lib/labels'
import {
  RECONCILIATION_OUTCOMES,
  countPayments,
  listPayments,
  reconcilePayments,
  reconciliationTotals,
  type ReconciliationRow,
} from '../_lib/queries'
import { financeRepository } from '../_lib/wiring'

export const metadata: Metadata = { title: 'התאמות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Money that arrived, against money that
 * was expected.
 *
 * WHAT IS ON THIS SCREEN. Every payment the reader may see, grouped by the
 * booking it belongs to, beside what that booking was billed. Three figures per
 * row and none of them is derived here: `_lib/queries.ts` computes them once
 * with `sumAgorot` over integer agorot, and this page places them.
 *
 * ── `unknown` IS THE REASON THE SCREEN EXISTS ────────────────────────────
 *
 * A processor that stops answering leaves a payment that is neither a success
 * nor a failure — the card may or may not have been charged. Counted as
 * arrived, the booking looks settled and nobody chases it; counted as missing,
 * a guest who has already paid is chased twice. So it is counted as neither:
 * `unresolvedAgorot` is its own figure, those rows sort above every difference,
 * and the badge for them does not share a word or a tone with "פער".
 *
 * The dataset's unresolved money is `pending` carrying
 * `requires_attention = 'reconcile_unknown'` rather than the `unknown` status.
 * Both are counted, because they are the same sentence to whoever is reading:
 * the automation has stopped and will not start again on its own.
 *
 * ── This is not the processor reconciliation ─────────────────────────────
 *
 * `reconcile()` in `src/lib/finance/reconciliation.ts` compares our ledger with
 * a *processor's* settlement file, which is a different question and needs a
 * file nobody has uploaded. This is the reconciliation a business does every
 * week from its own two sides: the stay was quoted at ₪4,200 and ₪1,260
 * arrived. When a settlement file is ingested, that report belongs beside this
 * one and not instead of it.
 *
 * ── The filter is derived, and says so ───────────────────────────────────
 *
 * `outcome` is not a column. It is computed from the payments and the booking's
 * billed total, so the filter is applied to the rows after they are built
 * rather than pushed into the query — the one place in this module where that
 * is true, and it is written down rather than left to be discovered. The page
 * ceiling therefore applies to the *payments* read, not to the rows below.
 *
 * GATING. `requireGrant('payment.view')` refuses the route, `can()` per row
 * with `family: 'finance'` narrows to the properties this membership reaches,
 * the expectation is read only with `booking.view_price` — a reader without it
 * still sees what arrived, and sees "–" where the stay's price would be — and
 * `payments_select` refuses at the database regardless.
 */
export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [actor, context, params] = await Promise.all([
    requireGrant('payment.view'),
    shellContext(),
    searchParams,
  ])

  if (!context || context.status !== 'ready') return null

  const filter = parseStatusFilter(params, RECONCILIATION_OUTCOMES)
  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId
  const propertyName =
    propertyId === null
      ? null
      : (context.properties.find((property) => property.id === propertyId)
          ?.name ?? null)

  const linkBookings = holdsGrant(actor, 'booking.view')

  let rows: readonly ReconciliationRow[] = []
  let paymentCount = 0
  let total = 0
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const { db, repo } = await financeRepository()

    // Every status, always. A reconciliation that read only the paid ones would
    // be a report that cannot find the thing it exists to find.
    const [payments, count] = await Promise.all([
      listPayments({
        repo,
        actor,
        organizationId: actor.organizationId,
        propertyId,
        filter: { status: null },
      }),
      countPayments(repo, actor.organizationId, propertyId),
    ])

    paymentCount = payments.length
    total = count
    rows = await reconcilePayments({
      db,
      actor,
      organizationId: actor.organizationId,
      payments,
    })
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const visible =
    filter.status === null
      ? rows
      : rows.filter((row) => row.outcome === filter.status)

  // The totals are of every row, not of the filtered view: a bookkeeper
  // filtering to "פער" is narrowing what they look at, not restating what the
  // business is owed.
  const totals = reconciliationTotals(rows)
  const unresolved = rows.filter((row) => row.outcome === 'unresolved')

  const emptyReason = resolveEmptyReason({
    visibleCount: visible.length,
    totalCount: total,
    hasActiveFilters: hasActiveStatusFilter(filter, propertyId),
  })

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          התאמות
        </h1>
        <p className="max-w-prose text-muted-foreground">
          {propertyName
            ? `הכסף שנכנס ב״${propertyName}״ מול מה שנדרש.`
            : 'הכסף שנכנס מול מה שנדרש, לפי הזמנה.'}{' '}
          {rows.length === 1
            ? 'הזמנה אחת עם תנועות כסף'
            : `${rows.length} הזמנות עם תנועות כסף`}
          , מתוך {paymentCount === 1 ? 'תשלום אחד' : `${paymentCount} תשלומים`}.
        </p>
      </header>

      <StatusFilterBar
        path="/finance/reconciliation"
        legend="סינון התאמות"
        statuses={RECONCILIATION_OUTCOMES}
        labels={RECONCILIATION_OUTCOME_LABEL}
        selected={filter.status}
        anyLabel="כל המצבים"
      />

      {failure ? (
        <ActionError error={failure.error} />
      ) : emptyReason ? (
        <EmptyState
          illustration={emptyReason === 'no_results' ? 'search' : 'invoice'}
          title={
            emptyReason === 'no_results'
              ? 'אין הזמנות שתואמות לסינון'
              : 'עוד אין כסף להתאים'
          }
          body={
            emptyReason === 'no_results'
              ? `הסינון הפעיל (${describeStatusFilter(
                  filter,
                  RECONCILIATION_OUTCOME_LABEL,
                  propertyName,
                )}) לא מחזיר תוצאות. הזמנות אחרות קיימות במערכת — שינוי או ניקוי הסינון יחזיר אותן.`
              : 'כאן תראה מול כל הזמנה כמה נדרש, כמה באמת נכנס, ומה נשאר פתוח. במיוחד — כמה כסף תקוע במצב שהסולק לא ענה עליו, שהוא לא כישלון ולא הצלחה ואף אחד לא יכול לסגור אותו לבד.'
          }
          action={
            emptyReason === 'no_results' ? (
              <Button href="/finance/reconciliation" variant="secondary">
                נקה סינון
              </Button>
            ) : null
          }
        />
      ) : (
        <>
          {unresolved.length > 0 && (
            <p
              // `alert`, not a polite status: this is money nobody can account
              // for, and it is the reason somebody opened this screen.
              role="alert"
              className="rounded-lg border border-danger bg-surface px-4 py-3 text-sm text-foreground"
            >
              <span className="font-semibold text-danger">
                {unresolved.length === 1
                  ? 'הזמנה אחת ממתינה לבירור'
                  : `${unresolved.length} הזמנות ממתינות לבירור`}
              </span>{' '}
              — {formatAgorot(totals.unresolvedAgorot)} שהסולק לא השיב עליהם. לא
              ידוע אם החיוב בוצע, ולכן הסכום אינו נספר לא כנגבה ולא כחסר. יש
              לבדוק מול הסולק ולסגור ידנית.
            </p>
          )}

          <dl className="grid gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:grid-cols-4 sm:p-5">
            <Figure
              label="נדרש"
              value={
                totals.expectedAgorot === null
                  ? 'לא זמין לצפייה'
                  : formatAgorot(totals.expectedAgorot)
              }
            />
            <Figure
              label="התקבל בפועל"
              value={formatAgorot(totals.receivedAgorot)}
            />
            <Figure
              label="פער"
              value={
                totals.differenceAgorot === null
                  ? 'לא זמין לצפייה'
                  : formatAgorot(totals.differenceAgorot)
              }
            />
            <Figure
              label="ממתין לבירור"
              value={formatAgorot(totals.unresolvedAgorot)}
            />
            <p className="text-xs text-muted-foreground sm:col-span-4">
              ״התקבל״ הוא מה שנגבה בפועל פחות מה שהוחזר, מתוך השורות המוצגות
              בלבד. ״ממתין לבירור״ אינו חלק מ״התקבל״ ואינו חלק מ״פער״ — הוא כסף
              שלא ידוע אם הוא קיים.
            </p>
          </dl>

          <ReconciliationTable rows={visible} linkBookings={linkBookings} />
        </>
      )}
    </div>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-display text-xl font-bold tabular-nums text-foreground">
        {value}
      </dd>
    </div>
  )
}
