import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { CatalogueList } from '@/components/store/catalogue-list'
import { StoreLock } from '@/components/store/store-lock'
import { StoreHeader, StoreNav } from '@/components/store/store-chrome'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { toSafeResponse } from '@/lib/errors'
import { showsVocabulary } from '@/lib/store'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../../_lib/context'
import { requireStoreGrant } from '../_lib/gate'
import { loadCatalogue, type CatalogueView } from '../_lib/queries'
import { NewProductForm } from '../products/new-product-form'

export const metadata: Metadata = { title: 'שירותים · חנות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The things somebody has to turn up and
 * do.
 *
 * A filter over the same catalogue as `/store/products` — see that file's
 * header for why it is a filter and not a second table.
 *
 * ── The providers panel, and who does not see it ─────────────────────────
 *
 * `store_providers_select` demands `provider.manage`, which a receptionist
 * does not hold. They get an empty list here and the screen says so as a
 * statement about permissions rather than about the business — "no providers"
 * would be a lie to somebody who simply may not read them.
 */
export default async function StoreServicesPage() {
  const [access, context] = await Promise.all([
    requireStoreGrant('product.view'),
    shellContext(),
  ])

  if (access.kind === 'locked') {
    return (
      <StoreLock
        entitlement={access.entitlement}
        title="החנות אינה כלולה בחבילה שלכם"
        body="כאן היו השירותים שאתם מציעים לאורחים, והספקים שמבצעים אותם."
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

  const services =
    catalogue?.items.filter((item) => item.itemType === 'service') ?? []

  const showsProviders =
    catalogue !== null && showsVocabulary(catalogue.settings.mode, 'provider')

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <StoreHeader
        title="שירותים"
        lead="מה שמישהו מגיע ועושה — צוות שלכם או ספק מבחוץ."
      />
      <StoreNav current="/store/services" />

      {failure ? (
        <ActionError error={failure.error} />
      ) : !catalogue ? null : (
        <>
          <NewProductForm defaultItemType="service" />

          <CatalogueList
            items={services}
            categories={catalogue.categories}
            mode={catalogue.settings.mode}
            mayPrice={catalogue.mayPrice}
            emptyTitle="עדיין לא הוספת שירותים"
            emptyBody="שירות הוא משהו שמישהו מגיע ועושה — תקליטן, מעסה, קייטרינג. אפשר לקבוע לו זמן התראה, כמה אפשר ביום, ומי הספק שמבצע אותו."
          />

          {showsProviders && (
            <Card>
              <CardHeader>
                <CardTitle as="h2">ספקים</CardTitle>
              </CardHeader>

              {catalogue.providers.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  {/* Two different sentences, and the difference matters: one
                      is about the business, the other about this reader. */}
                  אין ספקים רשומים, או שהם אינם גלויים לך. רשימת הספקים דורשת
                  הרשאת ניהול ספקים.
                </p>
              ) : (
                <ul className="mt-4 flex flex-col divide-y divide-border">
                  {catalogue.providers.map((provider) => (
                    <li
                      key={provider.id}
                      className="flex flex-wrap items-center justify-between gap-3 py-3"
                    >
                      <span className="flex flex-col">
                        <span className="font-medium text-foreground">
                          {provider.name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {provider.serviceTypes.join(' · ') ||
                            'לא הוגדרו סוגי שירות'}
                        </span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {provider.leadTimeHours} שעות התראה ·{' '}
                        {provider.defaultChannel}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <p className="mt-4 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                בקשת שירות שיוצאת לספק כוללת את הנכס, התאריך, השעה, השירות
                והערות תפעוליות — ולא את שם האורח, הטלפון שלו, המחיר, מצב התשלום
                או הסוכן שמכר את השהות.
              </p>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
