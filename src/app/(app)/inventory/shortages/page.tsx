import type { Metadata } from 'next'

import { EmptyState } from '@/components/states/empty-state'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { alertsWorthRaising } from '@/lib/inventory'

import { shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import { ForecastUnavailable, ModuleOff } from '../_components/module-state'
import { ShortageList } from '../_components/shortage-list'
import { loadInventoryModule } from '../_lib/module'

export const metadata: Metadata = { title: 'מחסורים' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Everything that is short, and what can
 * be done about each one.
 *
 * TWO SEVERITIES AND THEY MEAN DIFFERENT THINGS. `critical` is "there will not
 * be enough". `warning` is "there will be enough, and the remainder drops under
 * the floor kept for the booking not yet taken". Eating into the buffer is a
 * decision a manager is entitled to make; not being told is not — so the second
 * is present and quiet, and never dressed up as the first.
 *
 * EVERY ALERT SHOWS ITS ARITHMETIC. `נדרשים 30, צפויים נקיים 24, חסרים 6`.
 * A card that printed only the six is a number a person either believes or
 * ignores, and after the first wrong one they ignore all of them.
 *
 * THE ACTIONS ARE THE ORGANIZATION'S, NOT A CATALOGUE. Ordering laundry needs
 * the circulation capability; a cross-property transfer needs `advanced` and
 * the transfer flag; a purchase request needs `tracked`. A button that the
 * action would then refuse teaches a person to distrust the screen, so the
 * engine filters and this renders what it was given.
 *
 * SUGGESTED, NEVER PERFORMED. A transfer in particular is a proposal with a
 * named approver: solving one property's shortage by emptying another's
 * cupboard is not a solution.
 */
export default async function InventoryShortagesPage() {
  const [actor, context] = await Promise.all([
    requireGrant('inventory.view'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') return null

  const stock = await loadInventoryModule({ actor, context })

  if (!stock.capabilities.enabled) {
    return (
      <ModuleOff
        provisioned={stock.provisioned}
        mayConfigure={holdsGrant(actor, 'inventory.edit')}
      />
    )
  }

  const { forecast, settings } = stock
  const worthRaising = alertsWorthRaising(forecast.alerts, settings)
  const later = forecast.alerts.filter((alert) => !worthRaising.includes(alert))

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          מחסורים
        </h1>
        <p className="max-w-prose text-muted-foreground">
          כל התראה מציגה את החשבון שממנו נולדה — נדרש, צפוי נקי, חסר — ואת
          הפעולות שהארגון הזה באמת יכול לבצע. אין כאן מספר שאי אפשר לבדוק.
        </p>
      </header>

      {!forecast.computed ? (
        <ForecastUnavailable reason={forecast.skippedReason ?? 'module_off'} />
      ) : forecast.alerts.length === 0 ? (
        <EmptyState
          illustration="unit"
          title="אין מחסורים בטווח התחזית"
          body={`נבדקו ${forecast.rows.length} שילובים של יום ופריט מ־${forecast.from} עד ${forecast.to}, ואף אחד מהם אינו חסר. זו תשובה על התקופה שנבדקה בלבד.`}
          action={
            <Button href="/inventory/forecast" variant="secondary">
              לתחזית המלאה
            </Button>
          }
        />
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="font-display text-lg font-bold text-foreground">
              דורש טיפול עכשיו
            </h2>
            <p className="max-w-prose text-sm text-muted-foreground">
              עד {settings.shortageWarningHorizonDays} ימים קדימה. זה הטווח
              שהארגון הגדיר כשווה התראה — רשימת אזהרות לתשעים יום היא קיר שאיש
              אינו קורא, והתראה שלא נקראת גרועה מהיעדר התראה.
            </p>
            {worthRaising.length === 0 ? (
              <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
                אין מחסור בטווח ההתראה. יש מחסורים רחוקים יותר, למטה.
              </p>
            ) : (
              <ShortageList alerts={worthRaising} />
            )}
          </section>

          {later.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="font-display text-lg font-bold text-foreground">
                רחוק יותר בתחזית
              </h2>
              <p className="max-w-prose text-sm text-muted-foreground">
                מחושב ומוצג, אך אינו מרים התראה. יש זמן.
              </p>
              <ShortageList alerts={later} />
            </section>
          )}

          {forecast.transfers.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="font-display text-lg font-bold text-foreground">
                העברות אפשריות
              </h2>
              <p className="max-w-prose text-sm text-muted-foreground">
                הצעות בלבד. אף פריט לא זז בלי אישור של מי שרשאי לרוקן את המחסן
                שממנו הוא יוצא.
              </p>
              <ul className="flex flex-col gap-2">
                {forecast.transfers.map((transfer, index) => (
                  <li
                    key={`${transfer.itemId}:${transfer.fromPropertyId}:${index}`}
                    className="rounded-lg border border-border bg-surface px-4 py-3 text-sm shadow-soft"
                  >
                    <span className="font-semibold text-foreground">
                      {transfer.quantity} × {transfer.label}
                    </span>{' '}
                    מ״{transfer.fromPropertyName ?? transfer.fromPropertyId}״ אל
                    ״{transfer.toPropertyName ?? transfer.toPropertyId}״ עד{' '}
                    {transfer.neededBy}.
                    <span className="text-muted-foreground">
                      {' '}
                      במקור יישארו {transfer.sourceSurplusAfter} מעל רצפת
                      הביטחון שלו.
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}
