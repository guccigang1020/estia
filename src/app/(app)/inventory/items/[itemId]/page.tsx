import type { Metadata } from 'next'

import { INVENTORY_STATE_LABEL } from '@/components/operations/inventory-state'
import { EmptyState } from '@/components/states/empty-state'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { formatDayMonth } from '@/lib/booking'
import type { InventoryState } from '@/lib/contracts/states'
import { safetyBufferFor, significantRows } from '@/lib/inventory'
import { SupabaseInventoryRepository } from '@/lib/persistence/inventory'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../../_lib/context'
import { requireGrant } from '../../../_lib/guard'
import { ForecastTable } from '../../_components/forecast-table'
import { ModuleOff } from '../../_components/module-state'
import { loadInventoryModule, totalOwned } from '../../_lib/module'

export const metadata: Metadata = { title: 'פריט מלאי' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. One item, everything about it.
 *
 * THREE ANSWERS, IN ONE PLACE. Where the units are right now (clean, dirty, in
 * the wash, on the way back, damaged, lost), who has been promised them, and
 * what the timeline says will happen to them.
 *
 * AN ITEM HERE IS A GROUP OF ROWS. 0011 gives each `inventory_items` row a
 * single `state`, so sixty towels of which thirty are in the wash are two
 * rows. That is right for a ledger and wrong for a person, who asks "how many
 * towels do I have, and how many can Friday use". The adapter groups by
 * `(property, sku or name)` — the identity the CSV import also uses — and this
 * screen shows the group.
 *
 * THE ID IN THE URL IS THE ALLOCATABLE ROW. That is the row a reservation
 * increments and the row the CHECK constrains, so a link built from any other
 * member would point at stock sitting in a laundry van.
 */
export default async function InventoryItemPage({
  params,
}: {
  params: Promise<{ itemId: string }>
}) {
  const [actor, context, { itemId }] = await Promise.all([
    requireGrant('inventory.view'),
    shellContext(),
    params,
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

  const item = stock.items.find((candidate) => candidate.itemId === itemId)

  if (item === undefined) {
    return (
      <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
        <EmptyState
          illustration="search"
          title="הפריט לא נמצא בטווח שלך"
          body="ייתכן שהפריט שייך לנכס שמחוץ להיקף החברות שלך, שהוא נמחק, או שהוא נמצא תחת שורה אחרת של אותו פריט. זו אינה אותה אמירה כמו ״הפריט אינו קיים״."
          action={<Button href="/inventory/items">חזרה לרשימה</Button>}
        />
      </div>
    )
  }

  const buffer = safetyBufferFor(stock.settings, item)
  const rows = significantRows(
    stock.forecast.rows.filter((row) => row.itemId === itemId),
    { today: stock.today },
  )

  let reservations: Awaited<
    ReturnType<SupabaseInventoryRepository['loadReservations']>
  > = []
  if (stock.capabilities.reservations) {
    const repository = new SupabaseInventoryRepository(await createClient())
    reservations = await repository.loadReservations({
      organizationId: actor.organizationId,
      propertyIds: [item.propertyId],
      from: stock.today,
      to: stock.forecast.to,
    })
    reservations = reservations.filter(
      (reservation) => reservation.itemId === itemId,
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          {stock.propertyNames.get(item.propertyId) ?? item.propertyId}
          {item.location !== null && ` · ${item.location}`}
        </p>
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          {item.label}
        </h1>
        <p className="max-w-prose text-muted-foreground">
          נמדד ב{item.unitOfMeasure}. הכמות נגזרת מיומן התנועות ואינה נכתבת
          ידנית, כך שהיא תמיד מסתדרת עם מה שנרשם.
        </p>
      </header>

      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="נקי וזמין" value={item.onHandClean} />
        <Fact label="משוריין" value={item.reservedTotal} />
        <Fact label="סך הכול בבעלות" value={totalOwned(item)} />
        <Fact label="מלאי ביטחון" value={buffer} />
      </dl>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-lg font-bold text-foreground">
          איפה היחידות נמצאות
        </h2>
        <ul className="grid gap-2 sm:grid-cols-3">
          {Object.entries(item.byState)
            .filter(([, quantity]) => (quantity ?? 0) > 0)
            .map(([state, quantity]) => (
              <li
                key={state}
                className="rounded-lg border border-border bg-surface px-4 py-3 text-sm shadow-soft"
              >
                <span className="text-muted-foreground">
                  {INVENTORY_STATE_LABEL[state as InventoryState]}
                </span>
                <span className="ms-2 font-bold tabular-nums text-foreground">
                  {quantity}
                </span>
              </li>
            ))}
        </ul>
        <p className="max-w-prose text-xs text-muted-foreground">
          רק ״זמין״ נחשב לתחזית. יחידות במכבסה או בדרך חזרה הן רכוש העסק ואינן
          התשובה ליום שישי, ופגום ואבוד אינם מלאי כלל.
        </p>
      </section>

      {stock.capabilities.reservations && (
        <section className="flex flex-col gap-3">
          <h2 className="font-display text-lg font-bold text-foreground">
            שריונים פעילים
          </h2>
          {reservations.length === 0 ? (
            <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
              אין שריון פעיל לפריט הזה בטווח התחזית. ״משוריין{' '}
              {item.reservedTotal}״ שלמעלה הוא הסכום הכולל בעמודת המלאי, ושריון
              שהסתיים כבר אינו נספר כאן.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {reservations.map((reservation) => (
                <li
                  key={reservation.id}
                  className="rounded-lg border border-border bg-surface px-4 py-3 text-sm shadow-soft"
                >
                  <span className="font-semibold tabular-nums text-foreground">
                    {reservation.quantity}
                  </span>{' '}
                  מ־{formatDayMonth(reservation.neededFrom)} עד{' '}
                  {formatDayMonth(reservation.neededTo)}
                  {reservation.bookingId !== null && (
                    <span className="text-muted-foreground"> · להזמנה</span>
                  )}
                  {reservation.note !== null && (
                    <span className="text-muted-foreground">
                      {' '}
                      · {reservation.note}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-lg font-bold text-foreground">
          תחזית לפריט
        </h2>
        {rows.length === 0 ? (
          <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
            אין תנועה צפויה לפריט הזה בטווח התחזית.
          </p>
        ) : (
          <ForecastTable
            rows={rows}
            today={stock.today}
            propertyNames={stock.propertyNames}
            caption={`תחזית יומית עבור ${item.label}`}
          />
        )}
      </section>

      <nav aria-label="פעולות" className="flex flex-wrap gap-3">
        <Button href="/inventory/items" variant="secondary">
          כל הפריטים
        </Button>
        <Button href="/inventory/adjustments" variant="ghost">
          תנועות ותיקונים
        </Button>
      </nav>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-4 shadow-soft">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-display text-2xl font-bold tabular-nums text-foreground">
        {value}
      </dd>
    </div>
  )
}
