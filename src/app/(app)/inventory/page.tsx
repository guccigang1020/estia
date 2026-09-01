import type { Metadata } from 'next'

import { INVENTORY_STATE_LABEL } from '@/components/operations/inventory-state'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import type { InventoryState } from '@/lib/contracts/states'
import { significantRows } from '@/lib/inventory'

import { shellContext } from '../_lib/context'
import { requireGrant } from '../_lib/guard'
import { ForecastTable } from './_components/forecast-table'
import { ModuleOff } from './_components/module-state'
import { ShortageList } from './_components/shortage-list'
import {
  belowReorderPoint,
  loadInventoryModule,
  totalInState,
  totalOwned,
} from './_lib/module'

export const metadata: Metadata = { title: 'מלאי' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The stock dashboard.
 *
 * WHAT CHANGED. This route used to be the item list. It is now the answer to
 * "what should I do about stock today", and the list moved to
 * `/inventory/items` — same columns, same redactions, same empty states, the
 * route it links back to being the only edit. The reason is what a person
 * opens the screen for: nobody opens a stock module to read forty rows of
 * quantities, they open it because they are worried about Saturday.
 *
 * SIX PANELS, IN THE ORDER SOMEBODY WOULD ASK. Shortages now, shortages
 * projected, stock below its reorder point, what is in the wash and on its way
 * back, what is damaged or lost, and the upcoming demand. The first two come
 * from the forecast; the middle three are present-tense readings of
 * `inventory_items`; the last is the timeline itself.
 *
 * NEVER AN INVENTORY WIDGET WHEN THE MODULE IS OFF. `capabilities.enabled` is
 * checked before anything renders — the summary tiles included, because those
 * are the ones most likely to be left in by accident. An organization in `off`
 * gets `ModuleOff`, which is a real page saying that bookings, preparation, the
 * cleaner's plan, the laundry calculation and finance are untouched.
 *
 * A FAILURE HERE IS NOT A FAILURE OF THE PRODUCT. If the stock read fails the
 * page still renders, with a sentence saying so and saying what is unaffected.
 * A stack trace on the inventory screen must not read as "the system is down".
 *
 * GATING. `requireGrant('inventory.view')` refuses the route; a cleaner holds
 * no inventory grant at all and lands on the dashboard with the grant named.
 * The membership's property scope is pushed into every read below it.
 */
export default async function InventoryDashboard() {
  const [actor, context] = await Promise.all([
    requireGrant('inventory.view'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') return null

  const stock = await loadInventoryModule({ actor, context, horizonDays: 14 })

  if (!stock.capabilities.enabled) {
    return (
      <ModuleOff
        provisioned={stock.provisioned}
        mayConfigure={holdsGrant(actor, 'inventory.edit')}
      />
    )
  }

  const { forecast, items } = stock
  const critical = forecast.alerts.filter(
    (alert) => alert.severity === 'critical' && alert.daysAhead <= 0,
  )
  const projected = forecast.alerts.filter(
    (alert) => alert.severity === 'critical' && alert.daysAhead > 0,
  )
  const warnings = forecast.alerts.filter(
    (alert) => alert.severity === 'warning',
  )
  const low = belowReorderPoint(items)
  const inLaundry =
    totalInState(items, 'laundry') + totalInState(items, 'dirty')
  const returning = totalInState(items, 'returning')
  const damaged = totalInState(items, 'damaged') + totalInState(items, 'lost')
  const owned = items.reduce((sum, item) => sum + totalOwned(item), 0)
  const upcoming = significantRows(forecast.rows, { today: stock.today })
    .filter((row) => row.required > 0)
    .slice(0, 12)

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          מלאי
        </h1>
        <p className="max-w-prose text-muted-foreground">
          המצב היום ומה צפוי בשבועיים הקרובים. התחזית הולכת יום אחר יום ואינה
          מסכמת סכומים — פריטים חוזרים בין הזמנות, ולכן ״יש חמישים ונדרשים
          שלושים״ אינה תשובה.
        </p>
      </header>

      {stock.failure !== null && (
        <p
          role="alert"
          className="rounded-lg border border-danger bg-surface px-4 py-3 text-sm text-foreground"
        >
          {stock.failure}
        </p>
      )}

      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="מחסור עכשיו"
          value={critical.length}
          tone={critical.length > 0 ? 'danger' : 'quiet'}
          note="פריטים שחסרים היום"
        />
        <Tile
          label="מחסור צפוי"
          value={projected.length}
          tone={projected.length > 0 ? 'warning' : 'quiet'}
          note="נמצא לפני שקרה"
        />
        <Tile
          label="מתחת לנקודת הזמנה"
          value={low.length}
          tone={low.length > 0 ? 'warning' : 'quiet'}
          note="לפי הספירה הנוכחית"
        />
        <Tile
          label="בכביסה ובדרך"
          value={inLaundry + returning}
          tone="quiet"
          note={`${returning} כבר בדרך חזרה`}
        />
      </dl>

      <dl className="grid gap-4 sm:grid-cols-3">
        <Tile
          label="פגום או אבוד"
          value={damaged}
          tone={damaged > 0 ? 'warning' : 'quiet'}
          note="קיים ולא שמיש, או נעלם"
        />
        <Tile
          label="פריטים"
          value={items.length}
          tone="quiet"
          note={`${owned} יחידות בסך הכול`}
        />
        <Tile
          label="התראות מלאי ביטחון"
          value={warnings.length}
          tone="quiet"
          note="מספיק, אבל יורד מתחת לרצפה"
        />
      </dl>

      <nav aria-label="מסכי מלאי" className="flex flex-wrap gap-3">
        <Button href="/inventory/forecast">תחזית מלאה</Button>
        <Button href="/inventory/shortages" variant="secondary">
          מחסורים
        </Button>
        <Button href="/inventory/items" variant="secondary">
          פריטים
        </Button>
        <Button href="/inventory/entry" variant="ghost">
          הוספת מלאי
        </Button>
        <Button href="/inventory/adjustments" variant="ghost">
          תנועות ותיקונים
        </Button>
      </nav>

      {forecast.alerts.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-display text-lg font-bold text-foreground">
            מה דורש טיפול
          </h2>
          <ShortageList alerts={forecast.alerts.slice(0, 5)} />
          {forecast.alerts.length > 5 && (
            <Button href="/inventory/shortages" variant="ghost" size="sm">
              עוד {forecast.alerts.length - 5} התראות
            </Button>
          )}
        </section>
      )}

      {low.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-display text-lg font-bold text-foreground">
            מתחת לנקודת ההזמנה
          </h2>
          <ul className="flex flex-col gap-2">
            {low.map((item) => (
              <li
                key={item.itemId}
                className="rounded-lg border border-warning bg-surface px-4 py-3 text-sm"
              >
                <span className="font-semibold text-foreground">
                  {item.label}
                </span>{' '}
                — נקיים {item.onHandClean}, נקודת הזמנה {item.minQuantity}
                {item.parLevel !== null && `, רמת יעד ${item.parLevel}`}.
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-lg font-bold text-foreground">
          ביקוש קרוב
        </h2>
        {upcoming.length === 0 ? (
          <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
            {stock.capabilities.forecast
              ? 'אין שריון מלאי להזמנות בשבועיים הקרובים. הביקוש מגיע משריונים, ולכן הזמנה שלא שוריין לה מלאי אינה מופיעה כאן — וזו אמירה על השריון ולא על ההזמנה.'
              : 'התחזית אינה פעילה בארגון הזה. הספירה, נקודת ההזמנה וההתראה על מלאי נמוך ממשיכות לעבוד.'}
          </p>
        ) : (
          <ForecastTable
            rows={upcoming}
            today={stock.today}
            propertyNames={stock.propertyNames}
            caption="הימים הקרובים שבהם נדרש מלאי, עם החשבון המלא"
          />
        )}
      </section>

      {items.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-display text-lg font-bold text-foreground">
            איפה המלאי נמצא
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            הכמות שמופיעה כ״נקי״ היא רק מה שבמצב זמין. ארבעים סטים בטנדר של
            המכבסה הם רכוש העסק ואינם התשובה ליום שישי, ולכן הם נספרים בנפרד.
          </p>
          <ul className="grid gap-3 sm:grid-cols-2">
            {items.slice(0, 12).map((item) => (
              <li
                key={item.itemId}
                className="rounded-xl border border-border bg-surface p-4 text-sm shadow-soft"
              >
                <p className="font-semibold text-foreground">{item.label}</p>
                <p className="text-muted-foreground">
                  נקי {item.onHandClean} · משוריין {item.reservedTotal} · סך
                  הכול {totalOwned(item)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {/* Hebrew names, never the enum. `out_of_service` rendered
                      at a housekeeper is the failure the label map exists to
                      prevent. */}
                  {Object.entries(item.byState)
                    .filter(([, quantity]) => (quantity ?? 0) > 0)
                    .map(
                      ([state, quantity]) =>
                        `${INVENTORY_STATE_LABEL[state as InventoryState]}: ${quantity}`,
                    )
                    .join(' · ')}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function Tile({
  label,
  value,
  note,
  tone,
}: {
  label: string
  value: number
  note: string
  tone: 'danger' | 'warning' | 'quiet'
}) {
  const colour =
    tone === 'danger'
      ? 'text-danger'
      : tone === 'warning'
        ? 'text-warning'
        : 'text-foreground'

  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-4 shadow-soft">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`font-display text-2xl font-bold tabular-nums ${colour}`}>
        {value}
      </dd>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  )
}
