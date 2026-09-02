import type { Metadata } from 'next'

import { LaundrySectionNav } from '@/components/laundry/section-nav'
import { LaundryShell } from '@/components/laundry/shell'
import { LaundryDatasetGap, LaundryPlanLock } from '@/components/laundry/states'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/components/ui/cn'
import { TERMINAL_LAUNDRY_STATUSES } from '@/lib/contracts/states'
import {
  buildForecast,
  busiestDay,
  isoDay,
  type ForecastEntry,
} from '@/lib/laundry'

import {
  FORECAST_HORIZONS,
  horizonLabel,
  readHorizon,
  relativeDay,
  shortDate,
  weekdayOf,
} from '../_lib/labels'
import { loadOrders } from '../_lib/queries'
import { laundryView } from '../_lib/view'

export const metadata: Metadata = { title: 'צפי כביסה' }

const FORECAST_LIMIT = 200

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What is coming.
 *
 * "בשבעה הימים הקרובים: 112 מגבות רחצה ו-74 מערכות מצעים."
 *
 * ── Why this screen is the one that pays for the module ───────────────────
 *
 * Every other screen here describes the present. This is the only one whose
 * information can still be acted on: a shortage discovered on Friday morning
 * is a problem, and the same shortage seen on Tuesday is a phone call.
 *
 * ── The horizon is a choice, and the engine has no opinion ────────────────
 *
 * The four values offered come from `FORECAST_HORIZONS` in `_lib/labels.ts`
 * and from a check constraint in `0029_laundry.sql`. `buildForecast` itself
 * accepts any positive integer — asserted over a random draw in
 * `src/lib/laundry/no-hardcoded-numbers.test.ts` — so nothing about the
 * engine's arithmetic depends on which one somebody picks.
 *
 * ── Where the demand comes from ───────────────────────────────────────────
 *
 * Confirmed bookings, through the requirements that were built from them. The
 * open runs already on the books ARE that demand expressed once; reading them
 * rather than re-deriving from bookings is what keeps the forecast and the
 * requirement list from disagreeing about the same Friday. When a booking has
 * no run yet it is not in the curve, and the screen says how many it counted
 * so a zero is never mistaken for a quiet week.
 */
export default async function LaundryForecastPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const view = await laundryView('laundry.view', 'forecast')
  if (!view) return null

  const { vocabulary } = view
  const settings = view.context.settings.settings
  const mode = settings.mode

  if (view.locked) {
    return (
      <LaundryShell heading={vocabulary.forecast} tagline={vocabulary.tagline}>
        <LaundryPlanLock
          entitlement={view.entitlement}
          mayReachBilling={view.mayReachBilling}
        />
      </LaundryShell>
    )
  }

  const params = await searchParams
  const raw = params.days
  const horizonDays = readHorizon(
    Array.isArray(raw) ? raw[0] : raw,
    settings.forecastHorizonDays,
  )

  const { orders, gap } = await loadOrders(
    view.repo,
    view.actor,
    view.propertyId,
    FORECAST_LIMIT,
  )

  if (gap !== null) {
    return (
      <LaundryShell heading={vocabulary.forecast} tagline={vocabulary.tagline}>
        <LaundryDatasetGap table={gap.table} detail={gap.detail} />
      </LaundryShell>
    )
  }

  const from = isoDay(new Date())

  // One forecast entry per order line, carrying the CALCULATED figure as the
  // canonical requirement. The laundry buffer is deliberately not fed in: a
  // demand curve inflated by spare ordered against damage makes a business buy
  // linen for a shortage it does not have. See `forecast.ts`.
  const entries: ForecastEntry[] = orders
    .filter((order) => !TERMINAL_LAUNDRY_STATUSES.includes(order.status))
    .flatMap((order) =>
      order.lines.map((line) => ({
        bookingId: line.sourceBookingId ?? order.id,
        propertyId: line.propertyId,
        requiredOn: isoDay(line.requiredBy),
        requirements: [
          {
            category: 'linen' as const,
            itemId: line.itemId,
            label: line.label,
            unit: line.unit,
            quantity: line.quantity.calculated,
            section: 'towels' as const,
            requiresPhoto: false,
            instructions: null,
            minutes: 0,
            sources: [],
          },
        ],
      })),
    )

  // The forecast filters on the item profiles, so an item without a
  // laundry-managed profile never reaches the curve.
  const forecast = buildForecast({
    settings,
    profiles: view.context.profiles,
    entries,
    from,
    horizonDays,
    propertyId: view.propertyId,
  })

  const busiest = busiestDay(forecast)
  const now = new Date()
  const peak = Math.max(1, ...forecast.days.map((day) => day.units))

  return (
    <LaundryShell heading={vocabulary.forecast} tagline={vocabulary.tagline}>
      <LaundrySectionNav mode={mode} current="forecast" />

      <nav aria-label="טווח הצפי">
        <ul className="flex flex-wrap gap-2">
          {FORECAST_HORIZONS.map((days) => (
            <li key={days}>
              <a
                href={`/laundry/forecast?days=${days}`}
                aria-current={days === horizonDays ? 'page' : undefined}
                className={cn(
                  'inline-flex items-center rounded-full border px-4 py-1.5 text-sm font-semibold transition-colors',
                  days === horizonDays
                    ? 'border-primary bg-primary-soft text-primary'
                    : 'border-border bg-surface text-muted-foreground hover:text-foreground',
                )}
              >
                {horizonLabel(days)}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <section
        aria-label="הכותרת"
        className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-5 py-6 shadow-soft"
      >
        <p className="font-display text-lg font-bold leading-relaxed text-foreground sm:text-xl">
          {forecast.headline}
        </p>
        <p className="text-xs text-muted-foreground">
          מחושב מ-{forecast.bookingCount} דרישות פתוחות, בין {shortDate(from)}{' '}
          ל-{shortDate(forecast.to)}
          {view.propertyName !== null && ` · נכס ״${view.propertyName}״`}.
          {/* A zero must never be mistaken for a quiet week. The count above is
              what makes the difference visible. */}
          {forecast.bookingCount === 0 &&
            ' לא נמצאו דרישות בטווח הזה — ייתכן שטרם נוצרו דרישות מההזמנות.'}
        </p>
      </section>

      {forecast.totals.length > 0 && (
        <section aria-labelledby="totals-title" className="flex flex-col gap-4">
          <h2
            id="totals-title"
            className="font-display text-xl font-bold tracking-tight text-foreground"
          >
            סך הכול בטווח
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {forecast.totals.map((item) => (
              <li
                key={item.itemId}
                className="flex items-baseline justify-between gap-3 rounded-xl border border-border bg-surface px-5 py-4 shadow-soft"
              >
                <span className="min-w-0 truncate text-sm text-foreground">
                  {item.label}
                </span>
                <span className="shrink-0 font-display text-xl font-bold tabular-nums text-foreground">
                  {item.quantity}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="days-title" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2
            id="days-title"
            className="font-display text-xl font-bold tracking-tight text-foreground"
          >
            יום אחר יום
          </h2>
          {busiest !== null && busiest.units > 0 && (
            <p className="text-sm text-muted-foreground">
              היום העמוס: {weekdayOf(`${busiest.date}T00:00:00.000Z`)}{' '}
              {shortDate(`${busiest.date}T00:00:00.000Z`)} — {busiest.units}{' '}
              יחידות
            </p>
          )}
        </div>

        <ul className="flex flex-col gap-2">
          {forecast.days.map((day) => {
            const instant = `${day.date}T00:00:00.000Z`
            const share = Math.round((day.units / peak) * 100)

            return (
              <li
                key={day.date}
                className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-5 py-4 shadow-soft"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">
                    {weekdayOf(instant)} {shortDate(instant)}
                    <span className="mr-2 text-xs font-normal text-muted-foreground">
                      {relativeDay(instant, now)}
                    </span>
                  </span>
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {day.units === 0 ? 'פנוי' : `${day.units} יחידות`}
                  </span>
                </div>

                {/* A bar, so the shape of the week is visible at a glance.
                    Demand is not spread evenly and a total divided by seven
                    has never described a real Friday. */}
                <div
                  aria-hidden="true"
                  className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${share}%` }}
                  />
                </div>

                {day.items.length > 0 && (
                  <ul className="flex flex-wrap gap-2">
                    {day.items.map((item) => (
                      <li key={item.itemId}>
                        <Badge>
                          {item.label}: {item.quantity}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      </section>
    </LaundryShell>
  )
}
