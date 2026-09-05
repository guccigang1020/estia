import type { Metadata } from 'next'

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { InsightScreen } from '@/components/insights/insight-screen'
import { InsightsPlanLock } from '@/components/insights/plan-lock'
import { holdsGrant } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'
import { INSIGHT_RULES } from '@/lib/insights'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireAnyInsightGrant } from './_lib/gate'
import {
  describePeriod,
  parseInsightPeriod,
  periodIssue,
  recentMonths,
} from './_lib/period'
import {
  loadInsights,
  scopePropertyNames,
  withheldNames,
  type LoadedInsights,
} from './_lib/queries'
import { insightsWiring } from './_lib/wiring'

export const metadata: Metadata = { title: 'תובנות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The insights screen.
 *
 * WHAT IS ON THIS SCREEN. Claims about the business, each with the arithmetic
 * that produced it. Not one figure is calculated here or anywhere under
 * `src/lib/insights`: the values come from `computeDashboard`, the operands
 * under them from `aggregateFacts`, the rounding from `rounding.ts` and the
 * formatting from `formatMetricValue`. This file chooses the window and the
 * property; the domain decides everything else.
 *
 * THE DIFFERENCE FROM `/reports`. A report answers a question somebody asked
 * and states a figure. An insight notices something — occupancy rose and the
 * rise is worth six occupied nights; three of ten occupied nights were never
 * sold, which is why the average rate looks soft; four inventory nights were
 * closed on purpose and are correctly out of the denominator — and attaches
 * the fraction it came from plus a link to the rows. An insight nobody can
 * check is an opinion, and this product does not publish opinions about
 * somebody's revenue.
 *
 * GATING, IN FOUR INDEPENDENT PLACES.
 *
 *   1. `requireAnyInsightGrant` refuses the route unless the reader holds
 *      `automation.view` or `report.financial.view` — the menu's own
 *      declaration for this item — and renders the upgrade offer instead of
 *      redirecting for the one refusal that is about the package.
 *   2. `computeDashboard` then refuses each metric separately against
 *      `METRICS[id].requires`. A general manager holds neither
 *      `report.financial.view` nor `finance.view`, so every currency metric is
 *      **absent from the response** rather than zeroed.
 *   3. `buildInsightReport` drops every insight whose inputs did not survive
 *      step 2, and says whether the refusal was a permission or a package.
 *   4. Row level security refuses the rows underneath all three.
 *
 * WHY ONE SCREEN AND NOT TWO. `/reports` had to split into a financial and an
 * operating half because `requireGrant` takes one grant and no single grant is
 * held by everybody entitled to read *some* of the figures. This gate takes
 * several, and the per-insight refusal above it is stated on the page rather
 * than hidden — so an accountant and a general manager open the same URL and
 * each is told, by name, which insights the other one gets.
 *
 * THE LOCK RENDERS THE COUNT AND NOTHING ELSE. A general manager on Pro holds
 * `automation.view` and their package does not include `automation`, so they
 * land on the plan lock. It states how many insights their own rows produced
 * in this window and the titles of those insights — measured with their own
 * grants, disclosing not one figure. That is the automations screen's dry-run
 * argument applied here: a plan lock that shows nothing is a brochure.
 */
export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [access, context, params] = await Promise.all([
    requireAnyInsightGrant(),
    shellContext(),
    searchParams,
  ])

  // The gate redirects when the context is not ready, so this is narrowing for
  // the type system rather than a second decision.
  if (!context || context.status !== 'ready') return null

  const { actor } = access
  const period = parseInsightPeriod(params)
  const periodLabel = describePeriod(period.range)

  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId

  let loaded: LoadedInsights | null = null
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const { source } = await insightsWiring()
    loaded = await loadInsights({
      actor,
      source,
      range: period.range,
      comparison: period.comparison,
      propertyId,
    })
  } catch (cause) {
    // A refused scope arrives here too — `MetricScopeError` is an `AppError`
    // carrying its own Hebrew wording, and `toSafeResponse` keeps it rather
    // than replacing it with a generic failure. A read that failed must never
    // render as a business that produced nothing.
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  if (access.kind === 'locked') {
    const found = loaded?.report.insights ?? []
    return (
      <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
        <header className="flex flex-col gap-2">
          <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            תובנות
          </h1>
          <p className="text-muted-foreground">
            תובנה היא טענה על העסק שמגיעה עם החישוב שהפיק אותה.
          </p>
        </header>

        <InsightsPlanLock
          entitlement={access.entitlement}
          found={found.length}
          total={INSIGHT_RULES.length}
          titles={found.map((insight) => insight.title)}
          periodLabel={periodLabel}
          mayReachBilling={holdsGrant(actor, 'organization.billing.manage')}
        />
      </div>
    )
  }

  // Offered only where the route behind them would admit this reader — the
  // grant beside each is the argument to that route's own `requireGrant`.
  const crossLinks = [
    ...(holdsGrant(actor, 'report.financial.view')
      ? [{ href: '/reports', label: 'לדוח הכספי' }]
      : []),
    ...(holdsGrant(actor, 'availability.view')
      ? [{ href: '/reports/operations', label: 'לדוח התפעולי' }]
      : []),
  ]

  return (
    <InsightScreen
      title="תובנות"
      intro="כל תובנה כאן נושאת את החישוב שהפיק אותה — המונה, המכנה והתקופה — ומגיעה מאותו מילון מדדים שמזין את הדוחות ואת לוח הבית."
      action="/insights"
      range={period.range}
      comparison={period.comparison}
      months={recentMonths(new Date())}
      periodLabel={periodLabel}
      issue={periodIssue(params)}
      report={loaded?.report ?? null}
      failure={failure?.error ?? null}
      scope={loaded?.response.scope ?? null}
      propertyNames={scopePropertyNames(
        context.properties,
        loaded?.response ?? null,
      )}
      withheld={loaded ? withheldNames(loaded.response) : []}
      crossLinks={crossLinks}
    />
  )
}
