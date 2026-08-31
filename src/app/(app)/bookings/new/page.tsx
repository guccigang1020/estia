import type { Metadata } from 'next'

import Link from 'next/link'

import { ActionError } from '@/components/booking/action-error'
import { CreateBookingForm } from '@/components/booking/create-booking-form'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { can } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'

import { ALL_PROPERTIES, shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import { listBookableUnits, type BookableUnit } from '../_lib/queries'
import { bookingWiring } from '../_lib/wiring'

export const metadata: Metadata = { title: 'הזמנה חדשה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Opening a booking.
 *
 * GATING. `requireGrant('booking.create')` refuses the route outright, and
 * `createBookingAction` refuses again with `assertCan` before it reads a row —
 * so reaching this URL without the grant lands on the dashboard with the
 * missing grant named, and posting the action directly is refused regardless.
 *
 * WHAT THE FORM IS GIVEN. Active units for the organization and the selected
 * property, with their stored prices, capacity and minimum stay. Nothing on
 * this screen is invented: the rates are `units.base_price_agorot` and its
 * siblings, and the server reads them again rather than trusting the browser.
 *
 * WHO MAY NAME A PRICE. A villa or צימר is not a hotel with a rate card — the
 * owner quotes a number for this stay, and two identical stays selling for
 * different amounts is the normal case. So the nightly rate is editable, and
 * `booking.override_price` decides for whom. It is asked here **per unit**
 * rather than once: a grant can be scoped to a property, so a reservation
 * manager may set the price in one house and not in another, and one boolean
 * for the whole form would be wrong in whichever direction it guessed.
 *
 * The answer only decides what the screen offers. `createBookingAction`
 * asserts the same grant, and `booking.create` asserts it a third time before
 * it prices anything, because hiding a control is not authorization.
 *
 * WHY ONLY ACTIVE UNITS. `checkAvailability` refuses a unit whose rules row
 * does not resolve, and `loadRules` returns null for any status other than
 * `active` — deny by default, because a permissive default here would sell a
 * unit nobody has configured for sale. Offering an inactive unit in the picker
 * would offer a choice guaranteed to be rejected.
 */
export default async function NewBookingPage() {
  const [actor, context] = await Promise.all([
    requireGrant('booking.create'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') return null

  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId

  let units: readonly BookableUnit[] = []
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const { db } = await bookingWiring()
    units = await listBookableUnits(db, actor.organizationId, propertyId)
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const mayPriceByUnit: Record<string, boolean> = {}
  for (const unit of units) {
    mayPriceByUnit[unit.id] = can(actor, 'booking.override_price', {
      organizationId: actor.organizationId,
      unitId: unit.id,
      propertyId: unit.propertyId,
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <nav aria-label="פירורי לחם" className="text-sm">
        <Link
          href="/bookings"
          className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          ← חזרה לרשימת ההזמנות
        </Link>
      </nav>

      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          הזמנה חדשה
        </h1>
        <p className="max-w-prose text-muted-foreground">
          התאריכים נבדקים מול היומן פעמיים: כאן לפני השליחה, ושוב בשרת בתוך אותה
          טרנזקציה שכותבת את ההזמנה. אם מישהו יקדים אותך בשנייה שביניהן, תקבל
          הודעה ברורה ולא שגיאת מערכת.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle as="h2">פרטי השהות</CardTitle>
          <CardDescription>
            המחיר מתחיל במחיר השמור ביחידה, ואפשר לשנות אותו להזמנה הזו. הסכום
            הסופי הוא תמיד סכימת השורות, כדי שתמיד אפשר יהיה להסביר אותו.
          </CardDescription>
        </CardHeader>

        <div className="mt-6">
          {failure ? (
            <ActionError error={failure.error} />
          ) : (
            <CreateBookingForm units={units} mayPriceByUnit={mayPriceByUnit} />
          )}
        </div>
      </Card>
    </div>
  )
}
