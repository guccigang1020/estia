import type { Metadata } from 'next'

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { ActionError } from '@/components/booking/action-error'
import { ExpenseTable } from '@/components/finance/expense-table'
import { StatusFilterBar } from '@/components/finance/status-filter'
import { EmptyState } from '@/components/states/empty-state'
import { resolveEmptyReason } from '@/components/states/empty-presets'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'
import { EXPENSE_KINDS } from '@/lib/finance'
import { formatAgorot } from '@/lib/plans/plan'

import { ALL_PROPERTIES, shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import {
  describeStatusFilter,
  hasActiveStatusFilter,
  parseStatusFilter,
} from '../_lib/filters'
import { EXPENSE_KIND_LABEL } from '../_lib/labels'
import {
  FINANCE_PAGE_SIZE,
  countExpenseRules,
  expenseTotals,
  listExpenseRules,
  type ExpenseRuleListItem,
} from '../_lib/queries'
import { financeRepository } from '../_lib/wiring'

export const metadata: Metadata = { title: 'הוצאות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What the business spends.
 *
 * WHAT IS ON THIS SCREEN. Rows from `public.expense_rules`, with the shares
 * recorded against them in `public.expense_allocations`. There is no `expenses`
 * table and this screen is not a ledger: the schema models cost as a rule that
 * says what recurs plus an allocation that says which booking carried a share
 * of it, and a row-per-month view would have to invent every one of those rows.
 *
 * FIXED AND VARIABLE ARE NOT SUMMED, and the reason is not tidiness. A fixed
 * rule's amount is a figure per period — ₪3,100 a month — and a variable rule's
 * is a rate per stay or a percentage of revenue. Adding them produces a number
 * whose unit is nothing, so the summary states the fixed commitment, counts the
 * variable rules, and states what has actually been attributed separately.
 *
 * GATING, IN FOUR PLACES. `requireGrant('expense.view')` refuses the route.
 * `can()` per row is asked with the property the rule's *scope* names — which
 * for an organization-wide rule is nothing at all, and a resource carrying no
 * location is reachable only by an organization-wide scope, by the engine's own
 * rule. So a manager scoped to one property sees that property's rules and not
 * the organization's. `redact()` withholds the per-booking shares from a reader
 * without `booking.view_profitability` — an operations manager may see that the
 * pool retainer is ₪1,450 a month and not which stay was charged for it. And
 * `expense_rules_select` carries `has_permission(organization_id,
 * 'expense.view')`, so the database refuses regardless of all three.
 *
 * THE AMOUNT ITSELF IS NOT REDACTED. What the business spends on laundry is
 * exactly what `expense.view` is the right to see; withholding it from somebody
 * holding that grant would leave a screen of labels.
 */
export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [actor, context, params] = await Promise.all([
    requireGrant('expense.view'),
    shellContext(),
    searchParams,
  ])

  // `requireGrant` redirects when the context is not ready, so this is
  // narrowing for the type system rather than a second decision.
  if (!context || context.status !== 'ready') return null

  const filter = parseStatusFilter(params, EXPENSE_KINDS)
  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId
  const propertyName =
    propertyId === null
      ? null
      : (context.properties.find((property) => property.id === propertyId)
          ?.name ?? null)

  // The controls are offered only when the routes behind them would admit them.
  const linkBookings = holdsGrant(actor, 'booking.view')
  const mayCreate = holdsGrant(actor, 'expense.create')

  let rules: readonly ExpenseRuleListItem[] = []
  let total = 0
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const { db, repo } = await financeRepository()
    ;[rules, total] = await Promise.all([
      listExpenseRules({
        repo,
        db,
        actor,
        organizationId: actor.organizationId,
        propertyId,
        filter,
      }),
      countExpenseRules(repo, actor.organizationId),
    ])
  } catch (cause) {
    // A screen that renders nothing because a query failed must not look like
    // a business with no costs. The failure is stated instead.
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const totals = expenseTotals(rules)
  const needingApproval = rules.filter((rule) => rule.approvalRequired)
  const emptyReason = resolveEmptyReason({
    visibleCount: rules.length,
    totalCount: total,
    hasActiveFilters: hasActiveStatusFilter(filter, propertyId),
  })

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            הוצאות
          </h1>
          {mayCreate && (
            <Button href="/finance/expenses/new">הוצאה חדשה</Button>
          )}
        </div>
        <p className="max-w-prose text-muted-foreground">
          {propertyName
            ? `הכללים שחלים על ״${propertyName}״, ובנוסף הכללים שחלים על כל הארגון.`
            : 'הכללים שקובעים מה העסק מוציא.'}{' '}
          {total === 1 ? 'כלל אחד סה״כ' : `${total} כללים סה״כ`}. הוצאה נשמרת
          כאן ככלל ולא כשורה בחודש, כדי שעריכה של כלל היום לא תשנה כמה עלתה
          הזמנה שכבר הסתיימה.
        </p>
      </header>

      <StatusFilterBar
        path="/finance/expenses"
        legend="סינון הוצאות"
        statuses={EXPENSE_KINDS}
        labels={EXPENSE_KIND_LABEL}
        selected={filter.status}
        anyLabel="קבועות ומשתנות"
      />

      {failure ? (
        <ActionError error={failure.error} />
      ) : emptyReason ? (
        <EmptyState
          illustration={emptyReason === 'no_results' ? 'search' : 'invoice'}
          title={
            emptyReason === 'no_results'
              ? 'אין כללי הוצאה שתואמים לסינון'
              : 'עוד לא הוגדרו כללי הוצאה'
          }
          body={
            emptyReason === 'no_results'
              ? `הסינון הפעיל (${describeStatusFilter(
                  filter,
                  EXPENSE_KIND_LABEL,
                  propertyName,
                )}) לא מחזיר תוצאות. כללים אחרים קיימים במערכת — שינוי או ניקוי הסינון יחזיר אותם.`
              : 'כאן יופיע כל מה שהעסק מוציא: ניקיון, כביסה, חשמל, ארנונה ועמלת סליקה — כל אחד עם התדירות שלו והשיטה שבה הוא מיוחס להזמנות. השיטה היא שקובעת אילו הזמנות ייראו רווחיות.'
          }
          action={
            emptyReason === 'no_results' ? (
              <Button href="/finance/expenses" variant="secondary">
                נקה סינון
              </Button>
            ) : mayCreate ? (
              <Button href="/finance/expenses/new">הגדר הוצאה ראשונה</Button>
            ) : null
          }
        />
      ) : (
        <>
          {needingApproval.length > 0 && (
            <p
              role="status"
              className="rounded-lg border border-border-strong bg-accent-soft px-4 py-3 text-sm text-accent-foreground"
            >
              <span className="font-semibold">
                {needingApproval.length === 1
                  ? 'כלל אחד דורש אישור'
                  : `${needingApproval.length} כללים דורשים אישור`}
              </span>{' '}
              — הכסף לא יוצא לפני שמישהו חותם עליו. זה תנאי של הכלל עצמו, ולא
              תקלה.
            </p>
          )}

          <dl className="grid gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:grid-cols-3 sm:p-5">
            {/* Three figures, and deliberately not one total: a monthly
                commitment, a count of rules that are computed per stay, and
                what has actually been attributed. Adding the first two would
                produce a number whose unit is nothing. */}
            <Figure
              label="התחייבות קבועה לתקופה"
              value={formatAgorot(totals.fixedAgorot)}
            />
            <Figure
              label="כללים משתנים"
              value={
                totals.variableCount === 1
                  ? 'כלל אחד'
                  : `${totals.variableCount} כללים`
              }
            />
            <Figure
              label="יוחס להזמנות בפועל"
              value={
                totals.allocatedAgorot === null
                  ? 'לא זמין לצפייה'
                  : formatAgorot(totals.allocatedAgorot)
              }
            />
            <p className="text-xs text-muted-foreground sm:col-span-3">
              הסכום הקבוע הוא סיכום הכללים המוצגים לפי התדירות שכל אחד מהם מוגדר
              בה, ולא הוצאה חודשית אחת. כללים משתנים אינם מסוכמים כאן כי הסכום
              שלהם נגזר מכל הזמנה בנפרד.
            </p>
          </dl>

          <ExpenseTable rules={rules} linkBookings={linkBookings} />

          {/* Said out loud rather than left for somebody to discover that the
              list quietly stops. */}
          {rules.length === FINANCE_PAGE_SIZE && (
            <p
              role="status"
              className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
            >
              מוצגים {FINANCE_PAGE_SIZE} הכללים האחרונים. צמצם את הסינון כדי
              לראות כללים נוספים.
            </p>
          )}
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
