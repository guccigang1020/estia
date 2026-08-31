import type { Metadata } from 'next'

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { ActionError } from '@/components/booking/action-error'
import { Money } from '@/components/finance/money'
import { InventoryFilterBar } from '@/components/operations/inventory-filter'
import { INVENTORY_STATE_LABEL } from '@/components/operations/inventory-state'
import {
  InventoryTable,
  MovementList,
} from '@/components/operations/inventory-table'
import { EmptyState } from '@/components/states/empty-state'
import { resolveEmptyReason } from '@/components/states/empty-presets'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { INVENTORY_STATES } from '@/lib/contracts/states'
import { toSafeResponse } from '@/lib/errors'
import { sumAgorot } from '@/lib/finance'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireGrant } from '../_lib/guard'
import {
  describeInventoryFilter,
  hasActiveInventoryFilter,
  parseInventoryFilter,
} from './_lib/filters'
import {
  INVENTORY_PAGE_SIZE,
  countInventoryItems,
  itemsBelowReorderPoint,
  listInventoryItems,
  listMovements,
  type InventoryListItem,
  type InventoryMovement,
} from './_lib/queries'

export const metadata: Metadata = { title: 'מלאי' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Stock by item and location.
 *
 * WHAT IS ON THIS SCREEN. Rows from `public.inventory_items` for the
 * organization the shell resolved, narrowed to the selected property and to the
 * membership's scope, and under them the last movements from
 * `public.inventory_movements` for those same items. Every value is a column, a
 * subtraction of two columns on one row, or a Hebrew name for a state.
 *
 * THE QUANTITY IS NOT TYPED. 0011 derives `inventory_items.quantity` from the
 * movements by trigger, because a count somebody can overwrite is a count that
 * silently disagrees with the ledger that produced it. So this screen shows the
 * item's quantity and the ledger beside it and never adds up a balance of its
 * own.
 *
 * GATING. `requireGrant('inventory.view')` refuses the route — a cleaner holds
 * no inventory grant at all and lands on the dashboard with the missing grant
 * named. The membership's scope is pushed into the query, `can()` narrows again
 * per row, and `redact()` removes the unit cost and the stock value without
 * `expense.view`: a housekeeping supervisor counts the linen and orders more,
 * and what the business paid per set is not her screen.
 *
 * THE TEAM-SCOPED READER SEES NOTHING, HONESTLY. `inventory_items` has no
 * `team_id`, so a team-scoped membership — the handyman, who does hold
 * `inventory.view` — reaches no row, exactly as `can()` would say. That is not
 * the same statement as "this business has no stock", and the empty state says
 * which of the two it is.
 */
export default async function InventoryPage({
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

  const filter = parseInventoryFilter(params)
  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId
  const propertyName =
    propertyId === null
      ? null
      : (context.properties.find((property) => property.id === propertyId)
          ?.name ?? null)

  const maySeeMoney = holdsGrant(actor, 'expense.view')

  let items: readonly InventoryListItem[] = []
  let movements: readonly InventoryMovement[] = []
  let reachable = 0
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    ;[items, reachable] = await Promise.all([
      listInventoryItems({ db, actor, propertyId, filter }),
      countInventoryItems({ db, actor, propertyId }),
    ])
    // Read for the items already on screen, so a reader whose scope reaches
    // four items sees four items' worth of history and not somebody else's.
    movements = await listMovements(db, actor.organizationId, items)
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const short = itemsBelowReorderPoint(items)
  // `undefined` rather than zero when the values were redacted: a reader who
  // may not see one item's cost may certainly not see the sum of ten. A single
  // withheld row withholds the total, because a partial sum presented as a
  // total is worse than no total.
  const totalValue = items.some((item) => item.valueAgorot === undefined)
    ? undefined
    : sumAgorot(items.map((item) => item.valueAgorot ?? 0))
  const emptyReason = resolveEmptyReason({
    visibleCount: items.length,
    totalCount: reachable,
    hasActiveFilters: hasActiveInventoryFilter(filter, propertyId),
  })

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          מלאי
        </h1>
        <p className="max-w-prose text-muted-foreground">
          {propertyName
            ? `הפריטים והכמויות ב״${propertyName}״.`
            : 'הפריטים והכמויות בכל הנכסים שבטווח שלך.'}{' '}
          הכמות נגזרת מתנועות המלאי ואינה נכתבת ידנית, כך שהיא תמיד מסתדרת עם מה
          שנרשם.
        </p>
      </header>

      <InventoryFilterBar
        path="/inventory"
        states={INVENTORY_STATES}
        selected={filter.state}
      />

      {failure ? (
        <ActionError error={failure.error} />
      ) : emptyReason ? (
        <EmptyState
          illustration={emptyReason === 'no_results' ? 'search' : 'unit'}
          title={
            emptyReason === 'no_results'
              ? 'אין פריטים שתואמים לסינון'
              : reachable === 0
                ? 'אין פריטי מלאי בטווח שלך'
                : 'אין פריטי מלאי'
          }
          body={
            emptyReason === 'no_results'
              ? `הסינון הפעיל (${describeInventoryFilter(
                  filter,
                  INVENTORY_STATE_LABEL,
                  propertyName,
                )}) לא מחזיר תוצאות. פריטים אחרים קיימים במערכת — שינוי או ניקוי הסינון יחזיר אותם.`
              : 'כאן יופיעו הדברים הפיזיים שהעסק רץ עליהם — מצעים, מגבות, מתכלים וציוד — עם הכמות, מה מהם משוריין כבר, איפה הם נמצאים ומתי נספרו. מלאי משויך לנכס וליחידה, ולא לצוות, ולכן חברות בצוות בלבד אינה מגיעה אליו.'
          }
          action={
            emptyReason === 'no_results' ? (
              <Button href="/inventory" variant="secondary">
                נקה סינון
              </Button>
            ) : null
          }
        />
      ) : (
        <>
          {short.length > 0 && (
            <p
              // `alert`: a shortage noticed when a cleaner opens an empty
              // cupboard has already cost a changeover.
              role="alert"
              className="rounded-lg border border-warning bg-surface px-4 py-3 text-sm text-foreground"
            >
              <span className="font-semibold text-warning">
                {short.length === 1
                  ? 'פריט אחד מתחת לנקודת ההזמנה'
                  : `${short.length} פריטים מתחת לנקודת ההזמנה`}
              </span>{' '}
              — {short.map((item) => item.name).join(', ')}. יש להזמין לפני
              ההחלפה הבאה.
            </p>
          )}

          <dl className="grid gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:grid-cols-3 sm:p-5">
            <div className="flex flex-col gap-1">
              <dt className="text-xs text-muted-foreground">פריטים</dt>
              <dd className="font-display text-xl font-bold tabular-nums text-foreground">
                {items.length}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-xs text-muted-foreground">משוריין</dt>
              <dd className="font-display text-xl font-bold tabular-nums text-foreground">
                {items.reduce(
                  (total, item) => total + item.quantityReserved,
                  0,
                )}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-xs text-muted-foreground">שווי המלאי</dt>
              <dd className="font-display text-xl font-bold text-foreground">
                <Money agorot={totalValue} emphasis />
              </dd>
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-3">
              {maySeeMoney
                ? 'השווי הוא סיכום השורות המוצגות בלבד, לפי עלות היחידה שנרשמה. פריט שלא נרשמה לו עלות אינו נספר בשווי.'
                : 'שווי המלאי אינו זמין לך. הרשאת "צפייה בהוצאות" היא שפותחת אותו, ובלעדיה השדה ריק ולא אפס.'}
            </p>
          </dl>

          <InventoryTable
            items={items}
            caption="פריטי המלאי שבטווח שלך, ממוינים לפי מיקום ואז לפי שם"
          />

          {items.length === INVENTORY_PAGE_SIZE && (
            <p
              role="status"
              className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
            >
              מוצגים {INVENTORY_PAGE_SIZE} פריטים. צמצם את הסינון כדי לראות
              פריטים נוספים.
            </p>
          )}

          <section className="flex flex-col gap-3">
            <h2 className="font-display text-lg font-bold tracking-tight text-foreground">
              תנועות אחרונות
            </h2>
            <p className="max-w-prose text-sm text-muted-foreground">
              יומן התנועות הוא רשומה שאי אפשר לערוך: תיקון נרשם כתנועה נגדית ולא
              כמחיקה, כך ש״חשבנו שיש ארבעים ויש שלושים ושתיים״ נשאר רשום.
            </p>

            {movements.length === 0 ? (
              <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
                לא נרשמו תנועות לפריטים המוצגים. הכמויות שלמעלה הן הכמויות
                שנקבעו כשהפריטים נוצרו.
              </p>
            ) : (
              <MovementList movements={movements} />
            )}
          </section>
        </>
      )}
    </div>
  )
}
