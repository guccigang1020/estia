import type { Metadata } from 'next'
import Link from 'next/link'

import { ActionError } from '@/components/booking/action-error'
import { EmptyState } from '@/components/states/empty-state'
import { StoreLock } from '@/components/store/store-lock'
import { StoreHeader, StoreNav } from '@/components/store/store-chrome'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../../_lib/context'
import { requireStoreGrant } from '../_lib/gate'
import { loadCatalogue, type CatalogueView } from '../_lib/queries'

export const metadata: Metadata = { title: 'קטגוריות · חנות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. How the store is arranged.
 *
 * ── The count beside each category is the point ──────────────────────────
 *
 * §10 forbids rendering an empty store section, so a category with nothing in
 * it simply does not appear in the guest's portal. That is correct behaviour
 * and it is invisible from here unless the screen says so — which is why every
 * row carries its count and an empty one says out loud that guests will not
 * see it. An owner who created "ספא" three weeks ago and put nothing in it
 * deserves to know why it never showed up.
 */
export default async function StoreCategoriesPage() {
  const [access, context] = await Promise.all([
    requireStoreGrant('product.view'),
    shellContext(),
  ])

  if (access.kind === 'locked') {
    return (
      <StoreLock
        entitlement={access.entitlement}
        title="החנות אינה כלולה בחבילה שלכם"
        body="כאן היו הקטגוריות שמארגנות את מה שאתם מוכרים."
      />
    )
  }

  if (!context || context.status !== 'ready') return null

  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId

  let catalogue: CatalogueView | null = null
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    catalogue = await loadCatalogue({ db, actor: access.actor, propertyId })
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <StoreHeader
        title="קטגוריות"
        lead="הכותרות שהאורח רואה בחנות, בסדר שאתם קובעים."
      />
      <StoreNav current="/store/categories" />

      {failure ? (
        <ActionError error={failure.error} />
      ) : !catalogue ? null : catalogue.categories.length === 0 ? (
        <EmptyState
          illustration="invoice"
          as="h2"
          title="עדיין לא יצרת קטגוריות"
          body="בלי קטגוריות, כל מה שאתם מוכרים מופיע לאורח ברשימה אחת תחת ״מה אפשר להוסיף לשהות״. זה בסדר גמור לחנות קטנה. קטגוריות מתחילות להיות שימושיות סביב עשרה פריטים."
          action={
            <Link
              href="/store/products"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              חזרה לקטלוג
            </Link>
          }
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle as="h2">
              {catalogue.categories.length === 1
                ? 'קטגוריה אחת'
                : `${catalogue.categories.length} קטגוריות`}
            </CardTitle>
          </CardHeader>

          <ul className="mt-4 flex flex-col divide-y divide-border">
            {catalogue.categories.map((category) => {
              const count = catalogue.items.filter(
                (item) => item.categoryId === category.id,
              ).length
              const activeCount = catalogue.items.filter(
                (item) =>
                  item.categoryId === category.id && item.status === 'active',
              ).length

              return (
                <li key={category.id} className="flex flex-col gap-1.5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    {category.icon && <span aria-hidden>{category.icon}</span>}
                    <span className="font-display text-base font-bold text-foreground">
                      {category.name}
                    </span>
                    {!category.isActive && <Badge>מושהית</Badge>}
                    <span className="text-xs text-muted-foreground">
                      סדר {category.sortOrder}
                    </span>
                  </div>

                  {category.description && (
                    <p className="text-sm text-muted-foreground">
                      {category.description}
                    </p>
                  )}

                  {/* The sentence this screen exists for. */}
                  <p className="text-xs text-muted-foreground">
                    {activeCount === 0
                      ? 'אין בה פריטים פעילים, ולכן היא לא תופיע לאורחים כלל.'
                      : `${activeCount} פריטים פעילים${
                          count > activeCount ? ` (מתוך ${count} בקטגוריה)` : ''
                        }`}
                  </p>
                </li>
              )
            })}
          </ul>
        </Card>
      )}
    </div>
  )
}
