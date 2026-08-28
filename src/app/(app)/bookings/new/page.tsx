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
 * siblings, and they are shown read-only because the server reads them again
 * rather than trusting anything the browser sends back.
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
            המחיר אינו שדה בטופס. הוא נקרא מהיחידה עצמה בשרת, כדי שלא יהיה מספר
            שאי אפשר להסביר מאיפה הגיע.
          </CardDescription>
        </CardHeader>

        <div className="mt-6">
          {failure ? (
            <ActionError error={failure.error} />
          ) : (
            <CreateBookingForm units={units} />
          )}
        </div>
      </Card>
    </div>
  )
}
