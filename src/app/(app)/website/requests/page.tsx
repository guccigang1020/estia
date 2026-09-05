import type { Metadata } from 'next'
import Link from 'next/link'

import { ActionError } from '@/components/booking/action-error'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { SiteHeader, SiteNav } from '@/components/website/site-chrome'
import { SiteLock } from '@/components/website/site-lock'
import { holdsGrant } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'
import {
  BOOKING_REQUEST_STATUS_LABEL,
  type SiteBookingRequest,
} from '@/lib/website'

import { requireSiteGrant, studioTabs } from '../_lib/gate'
import { loadRequests, loadStudio, type StudioOverview } from '../_lib/queries'

export const metadata: Metadata = { title: 'פניות מהאתר' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Enquiries the public site produced.
 *
 * ── These are NOT bookings, and the screen never implies they are ────────
 *
 * A visitor with no account cannot hold a night. The exclusion constraint that
 * prevents a double booking is reached through `defineBookingOperations` with
 * an actor, so what arrives here is a request and somebody has to turn it into
 * a booking through the ordinary screen. The copy says so, because a list that
 * looked like a reservations queue would have somebody assuming the dates are
 * held.
 *
 * ── Read on `booking.view`, not on `site.view` ───────────────────────────
 *
 * The most important authorization decision in the module after the claims
 * constraint. An enquiry carries a name, a telephone number and an email
 * address — it is guest data that happened to arrive through a website, and a
 * copywriter holding `site.view` has no business reading it. The policy in
 * 0042 enforces it; this screen matches so somebody is not offered a tab that
 * returns nothing.
 */
export default async function WebsiteRequestsPage() {
  const access = await requireSiteGrant('site.view')

  if (access.kind === 'locked') {
    return (
      <SiteLock
        entitlement={access.entitlement}
        title="הזמנות ישירות אינן כלולות בחבילה שלכם"
        body="כאן היו מגיעות הפניות שמבקרים באתר שלכם שולחים, בלי עמלה לאף אחד."
        bullets={[
          'טופס הזמנה באתר, מול מנוע הזמינות והתמחור האמיתי.',
          'פנייה עם תאריכים, מספר אורחים ופרטי קשר.',
        ]}
      />
    )
  }

  let overview: StudioOverview | null = null
  let requests: readonly SiteBookingRequest[] = []
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    overview = await loadStudio({ db, actor: access.actor })
    if (overview.site) {
      requests = await loadRequests({
        db,
        actor: access.actor,
        siteId: overview.site.id,
      })
    }
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const mayRead = holdsGrant(access.actor, 'booking.view')

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <SiteHeader
        title="פניות מהאתר"
        lead="בקשות הזמנה שהגיעו מהאתר הפומבי. אלה פניות ולא הזמנות — התאריכים אינם נשמרים עד שמישהו סוגר אותן."
        status={overview?.site?.status}
      />
      <SiteNav current="/website/requests" entries={studioTabs(access.actor)} />

      {failure ? (
        <ActionError error={failure.error} />
      ) : !mayRead ? (
        <Card>
          <CardHeader>
            <CardTitle as="h2">אין לכם גישה לפניות</CardTitle>
          </CardHeader>
          <p className="mt-3 text-sm text-muted-foreground">
            פנייה מהאתר כוללת שם, טלפון ולעיתים כתובת דוא״ל — זה מידע על אורח,
            והגישה אליו נשלטת על ידי הרשאת ההזמנות ולא על ידי הרשאת האתר.
          </p>
        </Card>
      ) : !overview?.site ? (
        <Card>
          <CardHeader>
            <CardTitle as="h2">אין עדיין אתר</CardTitle>
          </CardHeader>
          <p className="mt-3 text-sm text-muted-foreground">
            צרו אתר במסך הסקירה.
          </p>
        </Card>
      ) : requests.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle as="h2">אין פניות</CardTitle>
          </CardHeader>
          <p className="mt-3 text-sm text-muted-foreground">
            {overview.site.status === 'published'
              ? 'האתר באוויר ועדיין לא הגיעו פניות.'
              : 'האתר עדיין לא באוויר, ולכן אף אחד לא יכול לשלוח פנייה.'}
          </p>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle as="h2">{requests.length} פניות</CardTitle>
          </CardHeader>

          <ul className="mt-4 flex flex-col divide-y divide-border">
            {requests.map((request) => (
              <li key={request.id} className="flex flex-col gap-1.5 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {request.contactName}
                  </span>
                  <Badge tone={request.status === 'new' ? 'brand' : 'neutral'}>
                    {BOOKING_REQUEST_STATUS_LABEL[request.status]}
                  </Badge>
                </div>

                <p className="text-sm text-muted-foreground">
                  {request.checkIn} – {request.checkOut} ·{' '}
                  {request.adults + request.children + request.infants} אורחים
                  {request.quotedTotalAgorot !== null
                    ? ` · הוצג להם ₪${(request.quotedTotalAgorot / 100).toLocaleString('he-IL')}`
                    : ''}
                </p>

                <p dir="ltr" className="text-sm text-muted-foreground">
                  {request.contactPhone}
                  {request.contactEmail ? ` · ${request.contactEmail}` : ''}
                </p>

                {request.message ? (
                  <p className="text-sm text-muted-foreground">
                    ״{request.message}״
                  </p>
                ) : null}

                <Link
                  href="/bookings"
                  className="self-start text-sm text-primary underline underline-offset-4"
                >
                  פתיחת הזמנה מהפנייה הזו
                </Link>
              </li>
            ))}
          </ul>

          <p className="mt-4 text-xs text-muted-foreground">
            הסכום שמוצג הוא מה שהמבקר ראה על המסך, כפי שנשמר ברגע הפנייה. הוא
            אינו מחושב מחדש, כדי שתוכלו לכבד את מה שהובטח.
          </p>
        </Card>
      )}
    </div>
  )
}
