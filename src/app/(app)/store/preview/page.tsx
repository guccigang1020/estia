import type { Metadata } from 'next'
import Link from 'next/link'

import { ActionError } from '@/components/booking/action-error'
import { EmptyState } from '@/components/states/empty-state'
import { GuestStore } from '@/components/store/guest-store'
import { StoreLock } from '@/components/store/store-lock'
import { StoreHeader, StoreNav } from '@/components/store/store-chrome'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { toSafeResponse } from '@/lib/errors'
import {
  asIsoDate,
  asNumber,
  asString,
  asStringOrNull,
  toRow,
} from '@/lib/persistence'
import {
  guestStoreView,
  type BookingFacts,
  type GuestStoreView,
} from '@/lib/store'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../../_lib/context'
import { requireStoreGrant } from '../_lib/gate'

export const metadata: Metadata = { title: 'תצוגה מקדימה · חנות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The store as a guest would see it.
 *
 * ══ IT CANNOT CREATE A REAL ORDER ═══════════════════════════════════════════
 *
 * `readOnly` disables every add button, and that is the visible half. The
 * structural half is that this screen never reaches the guest write path at
 * all: it renders the same component with no session and no submission key, so
 * there is nothing for it to submit even if a button were somehow pressed.
 *
 * ── Which booking it previews against ───────────────────────────────────
 *
 * A real one — the next arrival at the selected property. Eligibility is
 * booking-aware, so a preview against a fabricated booking would show a
 * different store from the one any guest sees, which is worse than no preview:
 * the owner would tune the catalogue against a fiction.
 *
 * Where there is no upcoming booking, the screen says so rather than inventing
 * a stay. That is the honest answer and it is also a useful one: a store can
 * only be previewed as somebody, and there is nobody yet.
 */
export default async function StorePreviewPage() {
  const [access, context] = await Promise.all([
    requireStoreGrant('product.view'),
    shellContext(),
  ])

  if (access.kind === 'locked') {
    return (
      <StoreLock
        entitlement={access.entitlement}
        title="החנות אינה כלולה בחבילה שלכם"
        body="כאן הייתה התצוגה של החנות כפי שהאורח רואה אותה."
      />
    )
  }

  if (!context || context.status !== 'ready') return null

  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId

  let booking: BookingFacts | null = null
  let view: GuestStoreView | null = null
  let bookingReference = ''
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()

    // The next arrival, read through the ordinary RLS-bound client — this is
    // a member of staff, so the booking policies admit them.
    let query = db
      .from('bookings')
      .select('*')
      .eq('organization_id', access.actor.organizationId)
      .is('deleted_at', null)
      .gte('check_in', new Date().toISOString().slice(0, 10))
      .order('check_in')
      .limit(1)

    if (propertyId) query = query.eq('property_id', propertyId)

    const { data } = await query

    const first = Array.isArray(data) && data.length > 0 ? toRow(data[0]) : null

    if (first) {
      bookingReference = asString(first, 'reference')
      booking = {
        id: asString(first, 'id'),
        organizationId: asString(first, 'organization_id'),
        propertyId: asString(first, 'property_id'),
        reference: bookingReference,
        status: asString(first, 'status'),
        checkIn: asIsoDate(first, 'check_in'),
        checkOut: asIsoDate(first, 'check_out'),
        adults: asNumber(first, 'adults'),
        children: asNumber(first, 'children'),
        infants: asNumber(first, 'infants'),
        propertyCapabilities: [],
        balanceAgorot: asNumber(first, 'total_agorot'),
        isConfirmed: ['confirmed', 'checked_in', 'in_house'].includes(
          asString(first, 'status'),
        ),
        isPaid: false,
        occasion: asStringOrNull(first, 'event_type'),
      }

      view = await guestStoreView({ db, booking, now: new Date() })
    }
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <StoreHeader
        title="תצוגה מקדימה"
        lead="החנות כפי שאורח רואה אותה, מול הזמנה אמיתית."
        action={
          <Link
            href="/store/settings"
            className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground"
          >
            הגדרות החנות
          </Link>
        }
      />
      <StoreNav current="/store/settings" />

      {failure ? (
        <ActionError error={failure.error} />
      ) : !booking ? (
        <EmptyState
          illustration="calendar"
          as="h2"
          title="אין הזמנה קרובה להציג עליה"
          body="החנות נבנית סביב הזמנה מסוימת — מה שמוצע תלוי בנכס, בתאריכים ובמספר האורחים. כשתהיה הזמנה עתידית, אפשר יהיה לראות כאן בדיוק מה האורח שלה יראה."
        />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle as="h2">מוצג מול ההזמנה {bookingReference}</CardTitle>
            </CardHeader>
            <p className="mt-2 text-sm text-muted-foreground">
              {booking.checkIn} עד {booking.checkOut} · {booking.adults} מבוגרים
              {booking.children > 0 && `, ${booking.children} ילדים`}. מה שמוצג
              תלוי בהזמנה הזו — הזמנה אחרת תראה משהו אחר.
            </p>
          </Card>

          {!view || view.sections.length === 0 ? (
            <EmptyState
              illustration="invoice"
              as="h2"
              title="האורח לא היה רואה כלום"
              body="או שהחנות כבויה, או שהחנות לאורח מכובה, או שאין פריט פעיל אחד שאפשר להציע להזמנה הזו. בדקו את ההגדרות ואת מצב הפריטים בקטלוג."
              action={
                <Link
                  href="/store/settings"
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
                >
                  מעבר להגדרות
                </Link>
              }
            />
          ) : (
            <GuestStore
              bookingId={booking.id}
              settings={view.settings}
              sections={view.sections}
              cards={view.cards}
              readOnly
            />
          )}
        </>
      )}
    </div>
  )
}
