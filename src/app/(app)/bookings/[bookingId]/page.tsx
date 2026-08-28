import type { Metadata } from 'next'

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { CancelBooking } from '@/components/booking/cancel-booking'
import { BookingPriceLines } from '@/components/booking/price-lines'
import { BookingStatusBadge } from '@/components/booking/status-badge'
import { StatusActions } from '@/components/booking/status-actions'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { can } from '@/lib/authz/can'
import {
  BOOKING_STATUS_LABEL,
  bookingResource,
  findTransition,
  legalNextStatuses,
} from '@/lib/booking/state-machine'
import { formatDayMonthYear } from '@/lib/booking/dates'
import { nightsBetween } from '@/lib/booking/types'
import type { BookingStatus } from '@/lib/booking/types'
import { toSafeResponse } from '@/lib/errors'
import { formatAgorot } from '@/lib/plans/plan'

import { requireGrant } from '../../_lib/guard'
import { bookingWiring } from '../_lib/wiring'

export const metadata: Metadata = { title: 'הזמנה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. One booking.
 *
 * WHAT IS REAL HERE. The whole page is one `BookingSnapshot` from
 * `SupabaseBookingRepository.loadBooking` — the same object the operations act
 * on, including its `version`, which the action controls send back so that
 * optimistic locking means something. The price lines are rows from
 * `booking_price_lines`; the total shown beside them is `sumLines` over those
 * rows and not the stored column, and the two are compared out loud.
 *
 * WHICH BUTTONS EXIST. `legalNextStatuses(actor, { booking, now })`. That
 * function asks the state machine, which checks legality *and* the specific
 * permission each move needs, in that order — so a cleaner is told they may
 * not release a deposit rather than being told the deposit has already gone,
 * which is a fact about the booking they were not entitled to learn.
 *
 * WHY A MISSING BOOKING IS A 404 AND NOT A REFUSAL. `bookings_select` is
 * scoped to `my_organizations()`, so a booking in another tenant is
 * indistinguishable from one that does not exist — and that is the intended
 * answer. Saying "you may not see this booking" to someone probing ids would
 * confirm the booking exists, which is the leak.
 */
export default async function BookingDetailPage({
  params,
}: {
  params: Promise<{ bookingId: string }>
}) {
  const [actor, { bookingId }] = await Promise.all([
    requireGrant('booking.view'),
    params,
  ])

  let booking
  try {
    const { repository } = await bookingWiring()
    booking = await repository.loadBooking(actor.organizationId, bookingId)
  } catch (cause) {
    const safe = toSafeResponse(cause, crypto.randomUUID())
    return (
      <Shell>
        <ActionError error={safe.error} />
      </Shell>
    )
  }

  if (!booking) notFound()

  const resource = bookingResource(booking)
  const now = new Date()

  const maySeePrice = can(actor, 'booking.view_price', resource)
  const maySeeSource = can(actor, 'booking.view_source', resource)
  const mayCancel = can(actor, 'booking.cancel', resource)

  // Every move the state machine will actually admit for this actor, from this
  // status, at this moment. `cancelled` is never among them — the state
  // machine routes it to `booking.cancel`, which is the control below.
  const nextStatuses = legalNextStatuses(actor, { booking, now })
  const reasonRequired = nextStatuses.filter((status) =>
    requiresReason(booking!.status, status),
  )

  const nights = nightsBetween(booking)

  return (
    <Shell>
      <nav aria-label="פירורי לחם" className="text-sm">
        <Link
          href="/bookings"
          className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          ← חזרה לרשימת ההזמנות
        </Link>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            {booking.guestName.length > 0 ? (
              booking.guestName
            ) : (
              <span className="text-muted-foreground">
                שם האורח אינו זמין בהרשאות שלך
              </span>
            )}
          </h1>
          <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
            <span>
              הזמנה{' '}
              <span dir="ltr" className="font-mono text-sm">
                {booking.reference}
              </span>
            </span>
            <BookingStatusBadge status={booking.status} />
          </p>
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* --------------------------------------------------------- stay */}
        <Card>
          <CardHeader>
            <CardTitle as="h2">השהות</CardTitle>
            <CardDescription>
              הטווח הוא חצי-פתוח: יום העזיבה פנוי לאורח הבא.
            </CardDescription>
          </CardHeader>

          <dl className="mt-5 flex flex-col gap-3 text-sm">
            <Row label="הגעה">{formatDayMonthYear(booking.checkIn)}</Row>
            <Row label="עזיבה">{formatDayMonthYear(booking.checkOut)}</Row>
            <Row label="לילות">
              {nights === 1 ? 'לילה אחד' : `${nights} לילות`}
            </Row>
            <Row label="אורחים">{booking.guestCount}</Row>
            <Row label="יחידה">
              <span dir="ltr" className="font-mono text-xs">
                {booking.unitId}
              </span>
            </Row>
          </dl>
        </Card>

        {/* -------------------------------------------------- attribution */}
        <Card>
          <CardHeader>
            <CardTitle as="h2">מקור ההזמנה</CardTitle>
            <CardDescription>
              נרשם עם ההזמנה. בלעדיו אי אפשר ליישב מחלוקת עמלה מאוחר יותר.
            </CardDescription>
          </CardHeader>

          {maySeeSource ? (
            <dl className="mt-5 flex flex-col gap-3 text-sm">
              <Row label="מקור">{SOURCE_LABEL[booking.attribution.source]}</Row>
              <Row label="ערוץ">{booking.attribution.sourceChannel ?? '—'}</Row>
              <Row label="סוכן מוכר">
                {booking.attribution.agentUserId ? (
                  <span dir="ltr" className="font-mono text-xs">
                    {booking.attribution.agentUserId}
                  </span>
                ) : (
                  'ללא'
                )}
              </Row>
              <Row label="קמפיין">
                {booking.attribution.campaignId ?? 'ללא'}
              </Row>
            </dl>
          ) : (
            <p className="mt-5 text-sm text-muted-foreground">
              מקור ההזמנה אינו זמין לצפייה בהרשאות שלך.
            </p>
          )}
        </Card>

        {/* --------------------------------------------------------- money */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle as="h2">מחיר</CardTitle>
            <CardDescription>
              הסכום הוא סכימת השורות, ולא מספר שנשמר בנפרד — כדי שתמיד אפשר יהיה
              להסביר אותו.
            </CardDescription>
          </CardHeader>

          <div className="mt-5">
            {maySeePrice ? (
              <BookingPriceLines
                lines={booking.lines}
                storedTotalAgorot={booking.totalAgorot}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                מחירי ההזמנה אינם זמינים לצפייה בהרשאות שלך.
              </p>
            )}
          </div>

          {maySeePrice && booking.depositRequiredAgorot > 0 && (
            <dl className="mt-5 flex flex-col gap-3 border-t border-border pt-5 text-sm">
              <Row label="פיקדון נדרש">
                {formatAgorot(booking.depositRequiredAgorot)}
              </Row>
              <Row label="פיקדון מוחזק כרגע">
                {formatAgorot(booking.depositHeldAgorot)}
              </Row>
            </dl>
          )}
        </Card>

        {/* ------------------------------------------------------- actions */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle as="h2">מעברי מצב</CardTitle>
            <CardDescription>
              מוצגים רק מעברים שמכונת המצבים מתירה מהמצב ״
              {BOOKING_STATUS_LABEL[booking.status]}״ ושההרשאה שלך מכסה. השרת
              בודק את שניהם שוב בעצמו.
            </CardDescription>
          </CardHeader>

          <div className="mt-5">
            <StatusActions
              bookingId={booking.id}
              version={booking.version}
              nextStatuses={nextStatuses}
              reasonRequired={reasonRequired}
            />
          </div>

          {mayCancel && booking.status !== 'cancelled' && (
            <div className="mt-6 border-t border-border pt-5">
              <h3 className="mb-1 font-display text-base font-bold text-foreground">
                ביטול
              </h3>
              <p className="mb-4 text-sm text-muted-foreground">
                ביטול הוא פעולה נפרדת ממעבר מצב רגיל, והיא מחייבת נימוק.
              </p>
              <CancelBooking
                bookingId={booking.id}
                version={booking.version}
                guestName={
                  booking.guestName.length > 0 ? booking.guestName : 'האורח'
                }
                reference={booking.reference}
              />
            </div>
          )}
        </Card>
      </div>
    </Shell>
  )
}

/* ------------------------------------------------------------- helpers -- */

/**
 * Does this move demand a stated justification?
 *
 * Read off the transition rather than guessed, so the form asks for exactly
 * what the operation will refuse to proceed without.
 */
function requiresReason(from: BookingStatus, to: BookingStatus): boolean {
  return findTransition(from, to)?.requiresReason ?? false
}

/**
 * Hebrew for the attribution sources.
 *
 * A total record over `BookingSource`, so adding a channel to the contract
 * without naming it fails the build rather than rendering `booking_com`.
 */
const SOURCE_LABEL: Record<string, string> = {
  direct_website: 'אתר ישיר',
  direct_manual: 'ידני — טלפון, וואטסאפ או מקום',
  agent: 'סוכן',
  agency: 'סוכנות',
  airbnb: 'Airbnb',
  booking_com: 'Booking.com',
  vrbo: 'Vrbo',
  other_channel: 'ערוץ אחר',
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      {children}
    </div>
  )
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-end font-medium text-foreground">
        {children}
      </dd>
    </div>
  )
}
