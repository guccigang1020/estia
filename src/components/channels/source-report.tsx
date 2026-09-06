import { Money } from '@/components/finance/money'
import { EmptyState } from '@/components/states/empty-state'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * Bookings that somebody marked as coming from a channel.
 *
 * ══ THIS IS KEPT, NOT REPLACED ══════════════════════════════════════════════
 *
 * This section is the original `/channels` screen, moved into a component so
 * the channel manager can be built on the same route without deleting it. It
 * reads `bookings` and nothing else, and what it reports is genuinely true and
 * genuinely useful: how many stays came from each OTA, and what they were
 * worth, whether or not any integration exists.
 *
 * **It is not evidence of synchronisation, and it says so.** A business that
 * types its Booking.com arrivals in by hand has channel bookings and has no
 * channel manager, and the distinction between "we know about these bookings"
 * and "these calendars are kept in step" is exactly what a double booking is
 * made of. That sentence was the point of the original screen and it survives
 * the merge intact.
 */
export type SourceRow = {
  key: string
  label: string
  bookingCount: number
  /** The free-text `source_channel` values seen, deduplicated. */
  labels: readonly string[]
  /** `null` without `booking.view_price`, and never zero. */
  revenueAgorot: number | null
}

export function SourceReport({
  rows,
  totalBookings,
  otaBookings,
  readable,
}: {
  rows: readonly SourceRow[]
  totalBookings: number
  otaBookings: number
  /** `false` means this reader may not see bookings — a different sentence. */
  readable: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">מה כבר נרשם מהערוצים</CardTitle>
      </CardHeader>
      <p className="mt-2 text-sm text-muted-foreground">
        הזמנות שסומנו כמגיעות מערוץ — כולל כאלה שהוקלדו ידנית. הן אמיתיות והן
        נספרות כאן, אבל ספירה של הזמנות אינה סנכרון: הזמנה שהוקלדה בדיעבד לא
        חסמה תאריכים בערוץ שממנו באה.
      </p>

      {!readable ? (
        <p className="mt-3 text-sm text-muted-foreground">
          אין לך הרשאה לראות הזמנות, ולכן אי אפשר להציג את הפילוח. זו אינה טענה
          שאין הזמנות מערוצים.
        </p>
      ) : otaBookings === 0 ? (
        <EmptyState
          className="mt-4"
          illustration="calendar"
          title="לא נרשמה אף הזמנה ממקור ערוץ"
          body={`מתוך ${
            totalBookings === 1 ? 'הזמנה אחת' : `${totalBookings} הזמנות`
          } בטווח שלך, אף אחת לא סומנה כמגיעה מערוץ. אם בפועל מגיעות אליך הזמנות מהערוצים, שווה לסמן את המקור בכל הזמנה — זה מה שיאפשר להשוות מאוחר יותר כמה עולה כל ערוץ.`}
        />
      ) : (
        <>
          <p className="mt-4 text-sm text-foreground">
            {otaBookings} מתוך {totalBookings} ההזמנות בטווח שלך סומנו כמגיעות
            מערוץ.
          </p>
          <ul className="mt-4 flex flex-col divide-y divide-border">
            {rows
              .filter((row) => row.bookingCount > 0)
              .map((row) => (
                <li
                  key={row.key}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <span className="flex flex-col gap-0.5">
                    <span className="font-semibold text-foreground">
                      {row.label}
                    </span>
                    {row.labels.length > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {row.labels.join(' · ')}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-4">
                    <span className="text-sm text-muted-foreground">
                      {row.bookingCount === 1
                        ? 'הזמנה אחת'
                        : `${row.bookingCount} הזמנות`}
                    </span>
                    <Money agorot={row.revenueAgorot} emphasis />
                  </span>
                </li>
              ))}
          </ul>
        </>
      )}
    </Card>
  )
}
