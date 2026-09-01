import type { Metadata } from 'next'

import { MovementList } from '@/components/operations/inventory-table'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { formatDayMonth } from '@/lib/booking'
import {
  DISCREPANCY_RESOLUTION_LABEL,
  explainDiscrepancy,
} from '@/lib/inventory'
import { SupabaseInventoryRepository } from '@/lib/persistence/inventory'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import { AdjustmentForm } from '../_components/adjustment-form'
import { ModuleOff } from '../_components/module-state'
import { loadInventoryModule } from '../_lib/module'
import {
  listInventoryItems,
  listMovements,
  type InventoryListItem,
} from '../_lib/queries'
import { NO_INVENTORY_FILTER } from '../_lib/filters'

export const metadata: Metadata = { title: 'תנועות ותיקונים' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The ledger, and the way to add to it.
 *
 * A CORRECTION IS A MOVEMENT, NEVER AN EDIT. 0011 derives the quantity from
 * `inventory_movements` by trigger and refuses UPDATE and DELETE on that table
 * with a statement trigger — against `service_role` and the table owner too,
 * which RLS cannot do. So "we thought we had forty and we have thirty-two"
 * stays in the record as a signed row with a sentence attached.
 *
 * DISCREPANCIES ARE THE OTHER HALF, AND ONLY IN `advanced`. Expected twelve
 * back and collected nine is a fact long before anybody knows what it means,
 * and it is left `unresolved` rather than written off: defaulting to "we
 * miscounted" is how guest loss stops being visible. A business that has not
 * asked for the fifteen minutes a changeover costs to count linen back in
 * never sees this section at all.
 *
 * `inventory.adjust` GATES THE FORM AND NOT THE PAGE. A reader with
 * `inventory.view` alone sees the history — which is the point of a ledger —
 * and is not offered a way to add to it.
 */
export default async function InventoryAdjustmentsPage() {
  const [actor, context] = await Promise.all([
    requireGrant('inventory.view'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') return null

  const stock = await loadInventoryModule({ actor, context, horizonDays: 0 })

  if (!stock.capabilities.enabled) {
    return (
      <ModuleOff
        provisioned={stock.provisioned}
        mayConfigure={holdsGrant(actor, 'inventory.edit')}
      />
    )
  }

  const db = await createClient()
  const repository = new SupabaseInventoryRepository(db)

  let listed: readonly InventoryListItem[] = []
  let movements: Awaited<ReturnType<typeof listMovements>> = []
  try {
    listed = await listInventoryItems({
      db,
      actor,
      propertyId: stock.propertyId,
      filter: NO_INVENTORY_FILTER,
    })
    movements = await listMovements(db, actor.organizationId, listed, 50)
  } catch {
    // The ledger is a read. A failure here leaves the form standing, because
    // recording a correction does not depend on being able to show history.
    listed = []
  }

  const discrepancies = stock.capabilities.discrepancies
    ? await repository.loadDiscrepancies({
        organizationId: actor.organizationId,
        propertyIds: stock.propertyId === null ? [] : [stock.propertyId],
        limit: 50,
      })
    : []

  const names = new Map(stock.items.map((item) => [item.itemId, item.label]))
  const mayAdjust = holdsGrant(actor, 'inventory.adjust')

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          תנועות ותיקונים
        </h1>
        <p className="max-w-prose text-muted-foreground">
          יומן המלאי הוא רשומה שאי אפשר לערוך. תיקון נרשם כתנועה נגדית ולא
          כמחיקה, כך ש״חשבנו שיש ארבעים ויש שלושים ושתיים״ נשאר רשום עם הנימוק
          שלו.
        </p>
      </header>

      {mayAdjust ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-display text-lg font-bold text-foreground">
            רישום תיקון
          </h2>
          <AdjustmentForm
            items={stock.items.map((item) => ({
              itemId: item.itemId,
              label: item.label,
              propertyId: item.propertyId,
              onHandClean: item.onHandClean,
              unitOfMeasure: item.unitOfMeasure,
            }))}
          />
        </section>
      ) : (
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          יש לך הרשאת צפייה במלאי אך לא הרשאת תיקון כמויות. ההיסטוריה למטה פתוחה
          — זו כל מטרתו של יומן.
        </p>
      )}

      {stock.capabilities.discrepancies && (
        <section className="flex flex-col gap-3">
          <h2 className="font-display text-lg font-bold text-foreground">
            פערי ספירה
          </h2>
          {discrepancies.length === 0 ? (
            <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
              לא נרשמו פערים בין מה שיצא למה שחזר. פער של אפס אינו פער ואינו
              נרשם, ולכן רשימה ריקה כאן היא אמירה טובה.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {discrepancies.map((discrepancy) => (
                <li
                  key={discrepancy.id}
                  className="rounded-lg border border-border bg-surface px-4 py-3 text-sm shadow-soft"
                >
                  <p className="text-foreground">
                    {explainDiscrepancy({
                      ...discrepancy,
                      label: names.get(discrepancy.itemId) ?? 'פריט',
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatDayMonth(discrepancy.detectedOn)} ·{' '}
                    {DISCREPANCY_RESOLUTION_LABEL[discrepancy.resolution]}
                    {discrepancy.resolutionNote !== null &&
                      ` · ${discrepancy.resolutionNote}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-lg font-bold text-foreground">
          יומן התנועות
        </h2>
        {movements.length === 0 ? (
          <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
            לא נרשמו תנועות לפריטים שבטווח שלך. הכמויות הנוכחיות הן אלה שנקבעו
            כשהפריטים נוצרו.
          </p>
        ) : (
          <MovementList movements={movements} />
        )}
      </section>

      <nav aria-label="מסכים נוספים" className="flex flex-wrap gap-3">
        <Button href="/inventory" variant="secondary">
          לוח המלאי
        </Button>
        <Button href="/inventory/items" variant="ghost">
          כל הפריטים
        </Button>
      </nav>
    </div>
  )
}
