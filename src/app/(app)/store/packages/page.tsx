import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { EmptyState } from '@/components/states/empty-state'
import { StoreLock } from '@/components/store/store-lock'
import {
  ItemStatusBadge,
  Money,
  StoreHeader,
  StoreNav,
} from '@/components/store/store-chrome'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../../_lib/context'
import { requireStoreGrant } from '../_lib/gate'
import { loadCatalogue, type CatalogueView } from '../_lib/queries'

export const metadata: Metadata = { title: 'חבילות · חנות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Combinations priced as one.
 *
 * ── The number this screen exists to show honestly ───────────────────────
 *
 * A package's price is its OWN price and is deliberately not derived from its
 * members: ₪2,990 for parts that add to ₪3,540 is the offer, and computing the
 * total from the members would erase it. So the screen shows both figures side
 * by side and names the difference — which is the one thing an owner setting a
 * package price actually wants to see.
 */
export default async function StorePackagesPage() {
  const [access, context] = await Promise.all([
    requireStoreGrant('product.view'),
    shellContext(),
  ])

  if (access.kind === 'locked') {
    return (
      <StoreLock
        entitlement={access.entitlement}
        title="החנות אינה כלולה בחבילה שלכם"
        body="כאן היו החבילות — צירופים של כמה פריטים במחיר אחד."
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
        title="חבילות"
        lead="כמה פריטים במחיר אחד, שהוא לא הסכום שלהם."
      />
      <StoreNav current="/store/packages" />

      {failure ? (
        <ActionError error={failure.error} />
      ) : !catalogue ? null : catalogue.packages.length === 0 ? (
        <EmptyState
          illustration="invoice"
          as="h2"
          title="עדיין לא יצרת חבילות"
          body="חבילה היא צירוף שאתם מוכרים במחיר אחד — למשל שולחן שוק, תקליטן וארוחת בוקר בתור ״ערב חגיגה״. המחיר שלה הוא מחיר משלה, ולא הסכום של החלקים."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle as="h2">
              {catalogue.packages.length === 1
                ? 'חבילה אחת'
                : `${catalogue.packages.length} חבילות`}
            </CardTitle>
          </CardHeader>

          <ul className="mt-4 flex flex-col divide-y divide-border">
            {catalogue.packages.map((bundle) => {
              // The sum of the members, at TODAY's catalogue prices. This is a
              // comparison for the owner and never a figure a guest is
              // charged: a guest pays `priceAgorot`, and once they have
              // bought, the order's own snapshot is what stands.
              const partsAgorot = bundle.memberItemIds.reduce((sum, itemId) => {
                const member = catalogue.items.find(
                  (item) => item.id === itemId,
                )
                return sum + (member?.basePriceAgorot ?? 0)
              }, 0)

              const saving = partsAgorot - bundle.priceAgorot

              return (
                <li key={bundle.id} className="flex flex-col gap-2 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-display text-base font-bold text-foreground">
                      {bundle.name}
                    </span>
                    <ItemStatusBadge status={bundle.status} />
                  </div>

                  {bundle.shortDescription && (
                    <p className="text-sm text-muted-foreground">
                      {bundle.shortDescription}
                    </p>
                  )}

                  <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
                    <span className="font-semibold text-foreground">
                      <Money agorot={bundle.priceAgorot} emphasis />
                    </span>
                    {catalogue.mayPrice && partsAgorot > 0 && (
                      <span className="text-xs text-muted-foreground">
                        החלקים בנפרד: <Money agorot={partsAgorot} />
                        {saving > 0 && (
                          <>
                            {' · '}חיסכון לאורח: <Money agorot={saving} />
                          </>
                        )}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {bundle.memberItemIds.length} פריטים
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        </Card>
      )}
    </div>
  )
}
