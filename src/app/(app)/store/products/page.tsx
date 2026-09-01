import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { CatalogueList } from '@/components/store/catalogue-list'
import { StoreLock } from '@/components/store/store-lock'
import { StoreHeader, StoreNav } from '@/components/store/store-chrome'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../../_lib/context'
import { requireStoreGrant } from '../_lib/gate'
import { loadCatalogue, type CatalogueView } from '../_lib/queries'
import { NewProductForm } from './new-product-form'

export const metadata: Metadata = { title: 'מוצרים · חנות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The things the business sells that are
 * not somebody's time.
 *
 * `physical`, `experience`, `property_addon` and `custom` live here; `service`
 * lives on the next screen. The split is the owner's own mental model — "a
 * bottle of wine" and "a masseuse" are different kinds of thing to think about
 * — and it is a FILTER over one catalogue rather than two catalogues, so
 * nothing can be in one and missing from the other.
 */
export default async function StoreProductsPage() {
  const [access, context] = await Promise.all([
    requireStoreGrant('product.view'),
    shellContext(),
  ])

  if (access.kind === 'locked') {
    return (
      <StoreLock
        entitlement={access.entitlement}
        title="החנות אינה כלולה בחבילה שלכם"
        body="כאן היה הקטלוג של מה שאתם מוכרים לאורחים."
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

  const products =
    catalogue?.items.filter((item) => item.itemType !== 'service') ?? []

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <StoreHeader
        title="מוצרים"
        lead="דברים שאתם מוכרים לאורחים — על השולחן, בנכס, ולפני ההגעה."
      />
      <StoreNav current="/store/products" />

      {failure ? (
        <ActionError error={failure.error} />
      ) : !catalogue ? null : (
        <>
          <NewProductForm defaultItemType="experience" />

          <CatalogueList
            items={products}
            categories={catalogue.categories}
            mode={catalogue.settings.mode}
            mayPrice={catalogue.mayPrice}
            emptyTitle="עדיין לא הוספת מוצרים או שירותים"
            emptyBody="התחילו מהדבר שאתם כבר מוכרים בטלפון. שולחן שוק, בקבוק יין לחדר, חימום בריכה — כל אחד מהם הוא שורה אחת כאן, ואחריה האורחים יכולים לבקש אותו מתוך ההזמנה שלהם."
          />
        </>
      )}
    </div>
  )
}
