import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { EmptyState } from '@/components/states/empty-state'
import { StoreLock } from '@/components/store/store-lock'
import { Money, StoreHeader, StoreNav } from '@/components/store/store-chrome'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { toSafeResponse } from '@/lib/errors'
import { StoreRepository, type StorePromoCode } from '@/lib/store'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { requireStoreGrant } from '../_lib/gate'

export const metadata: Metadata = { title: 'קודי הנחה · חנות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Codes that take money off an order.
 *
 * ── Read with `order.view`, changed with `order.discount_manage` ─────────
 *
 * The gate here asks for `order.view`, which a receptionist holds: they take
 * the telephone call and need to know whether CHOREF10 is still alive. Writing
 * one is `order.discount_manage`, which they do not hold, and the database
 * refuses it whatever this screen renders.
 *
 * ── The counter is the honest part ───────────────────────────────────────
 *
 * A code with a limit and no visible counter is a code that gets used four
 * hundred times, so every row shows uses against the ceiling and an exhausted
 * one says so rather than merely looking ordinary.
 */
export default async function StorePromotionsPage() {
  const [access, context] = await Promise.all([
    requireStoreGrant('order.view'),
    shellContext(),
  ])

  if (access.kind === 'locked') {
    return (
      <StoreLock
        entitlement={access.entitlement}
        title="החנות אינה כלולה בחבילה שלכם"
        body="כאן היו קודי ההנחה שאתם נותנים על תוספות."
      />
    )
  }

  if (!context || context.status !== 'ready') return null

  const now = new Date()
  let codes: readonly StorePromoCode[] = []
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    codes = await new StoreRepository(db).promoCodes(
      access.actor.organizationId,
    )
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <StoreHeader
        title="קודי הנחה"
        lead="הנחות על תוספות. חלות על ההזמנה בחנות, לא על מחיר השהות."
      />
      <StoreNav current="/store/promotions" />

      {failure ? (
        <ActionError error={failure.error} />
      ) : codes.length === 0 ? (
        <EmptyState
          illustration="invoice"
          as="h2"
          title="אין קודי הנחה"
          body="קוד הנחה מוריד סכום או אחוז מהזמנת חנות, ואפשר להגביל אותו בתאריכים, במספר שימושים ובפריטים מסוימים. אפשר לנהל חנות בלי אף קוד."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle as="h2">
              {codes.length === 1 ? 'קוד אחד' : `${codes.length} קודים`}
            </CardTitle>
          </CardHeader>

          <ul className="mt-4 flex flex-col divide-y divide-border">
            {codes.map((code) => {
              const exhausted =
                code.maxUses !== null && code.uses >= code.maxUses
              const expired =
                code.validUntil !== null &&
                Date.parse(code.validUntil) <= now.getTime()
              const notYet =
                code.validFrom !== null &&
                Date.parse(code.validFrom) > now.getTime()

              const live = code.isActive && !exhausted && !expired && !notYet

              return (
                <li key={code.id} className="flex flex-col gap-1.5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      dir="ltr"
                      className="font-mono text-base font-bold text-foreground"
                    >
                      {code.code}
                    </span>
                    <Badge tone={live ? 'brand' : 'neutral'}>
                      {live
                        ? 'פעיל'
                        : exhausted
                          ? 'נוצל במלואו'
                          : expired
                            ? 'פג תוקף'
                            : notYet
                              ? 'טרם התחיל'
                              : 'כבוי'}
                    </Badge>
                    <span className="text-sm text-foreground">
                      {code.discountKind === 'percent'
                        ? `${code.percent}%`
                        : code.amountAgorot !== null && (
                            <Money agorot={code.amountAgorot} />
                          )}
                    </span>
                  </div>

                  {code.description && (
                    <p className="text-sm text-muted-foreground">
                      {code.description}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      נוצל {code.uses}
                      {code.maxUses !== null
                        ? ` מתוך ${code.maxUses}`
                        : ' פעמים · ללא הגבלה'}
                    </span>
                    {code.minOrderAgorot > 0 && (
                      <span>
                        מהזמנה של <Money agorot={code.minOrderAgorot} /> ומעלה
                      </span>
                    )}
                    <span>
                      {code.itemIds.length === 0
                        ? 'חל על כל הפריטים'
                        : `חל על ${code.itemIds.length} פריטים`}
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
