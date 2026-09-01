import type { Metadata } from 'next'

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { firstParam } from '@/app/(auth)/_lib/search-params'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { FORECAST_WINDOWS, significantRows } from '@/lib/inventory'

import { shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import { ForecastTable } from '../_components/forecast-table'
import { ForecastUnavailable, ModuleOff } from '../_components/module-state'
import { loadInventoryModule } from '../_lib/module'

export const metadata: Metadata = { title: 'תחזית מלאי' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The timeline.
 *
 * THE WHOLE POINT OF THE MODULE IS ON THIS SCREEN. Date, item, required,
 * expected clean, reserved, shortage — over today, seven, fourteen or thirty
 * days. Every number is either a column, a sum of columns, or the difference
 * of two numbers printed in the same row. There is no score and no verdict.
 *
 * WHY A TIMELINE AND NOT A TOTAL. Fifty towels, twenty-five needed on Friday,
 * thirty on Saturday, and Friday's still in the machine: a total says 50 ≥ 30
 * and reports nothing, and the answer is that Saturday is five short. The walk
 * is in `src/lib/inventory/forecast.ts` and its canonical test is that case.
 *
 * FLAT DAYS ARE DROPPED. `significantRows` keeps a day where something is
 * required, arriving, short or under the floor — and today, always. Thirty
 * unchanged rows per item is a table nobody scrolls, and a table nobody
 * scrolls is a forecast nobody reads.
 *
 * THE WINDOW IS IN THE URL. `?days=7`, so a filtered view is a link somebody
 * can send. A value outside the offered set falls back to the organization's
 * own horizon rather than reaching the engine.
 */
export default async function InventoryForecastPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [actor, context, params] = await Promise.all([
    requireGrant('inventory.view'),
    shellContext(),
    searchParams,
  ])

  if (!context || context.status !== 'ready') return null

  const asked = Number(firstParam(params.days) ?? '')
  const window = FORECAST_WINDOWS.includes(asked) ? asked : 14

  const stock = await loadInventoryModule({
    actor,
    context,
    horizonDays: window,
  })

  if (!stock.capabilities.enabled) {
    return (
      <ModuleOff
        provisioned={stock.provisioned}
        mayConfigure={holdsGrant(actor, 'inventory.edit')}
      />
    )
  }

  const rows = significantRows(stock.forecast.rows, { today: stock.today })

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          תחזית מלאי
        </h1>
        <p className="max-w-prose text-muted-foreground">
          מה יהיה נקי בכל יום, ומול מה. החישוב הולך יום אחר יום מפני שפריטים
          חוזרים בין הזמנות — מהאורח, מהמכבסה ומנכס אחר — וסכום כולל מפספס בדיוק
          את זה.
        </p>
      </header>

      <nav aria-label="טווח התחזית" className="flex flex-wrap gap-2">
        {FORECAST_WINDOWS.map((days) => (
          <Button
            key={days}
            href={`/inventory/forecast?days=${days}`}
            variant={days === window ? 'primary' : 'ghost'}
            size="sm"
          >
            {days === 0 ? 'היום' : `${days} ימים`}
          </Button>
        ))}
      </nav>

      {stock.failure !== null && (
        <p
          role="alert"
          className="rounded-lg border border-danger bg-surface px-4 py-3 text-sm text-foreground"
        >
          {stock.failure}
        </p>
      )}

      {!stock.forecast.computed ? (
        <ForecastUnavailable
          reason={stock.forecast.skippedReason ?? 'module_off'}
        />
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          אין תנועה צפויה בטווח הזה. זו אמירה על התקופה ולא על המלאי — הרחבת
          הטווח או שריון מלאי להזמנות קרובות ימלאו את הטבלה.
        </p>
      ) : (
        <>
          <dl className="grid gap-4 sm:grid-cols-3">
            <Summary label="ימים בטווח" value={rows.length} />
            <Summary
              label="ימים עם מחסור"
              value={rows.filter((row) => row.shortage > 0).length}
            />
            <Summary
              label="סך המחסור"
              value={rows.reduce((sum, row) => sum + row.shortage, 0)}
            />
          </dl>

          <ForecastTable
            rows={rows}
            today={stock.today}
            propertyNames={stock.propertyNames}
            caption="תחזית מלאי לפי יום ופריט: נדרש, צפוי נקי, משוריין וחסר"
          />

          <p className="max-w-prose text-xs text-muted-foreground">
            ״צפוי נקי״ הוא מה שיהיה זמין באותו יום: הפתיחה, ועוד מה שחוזר.
            {stock.settings.linenTurnaroundDays === null
              ? ' לא הוגדר זמן מחזור כביסה, ולכן לא נספר שום חזרה — התחזית מחמירה בכוונה, כי הבטחה של מגבות שעדיין במכונה גרועה מהתראה מיותרת.'
              : ` זמן מחזור הכביסה שהוגדר הוא ${stock.settings.linenTurnaroundDays} ימים, וזה מה שמונע ממגבות של יום שישי להיות זמינות בשבת.`}
          </p>
        </>
      )}
    </div>
  )
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-4 shadow-soft">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-display text-xl font-bold tabular-nums text-foreground">
        {value}
      </dd>
    </div>
  )
}
