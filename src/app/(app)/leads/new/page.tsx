import type { Metadata } from 'next'

import Link from 'next/link'

import { RecordEnquiryForm } from '@/components/leads/record-enquiry-form'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { holdsGrant } from '@/lib/authz/can'

import { shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'

export const metadata: Metadata = { title: 'פנייה חדשה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Writing down an enquiry.
 *
 * WHAT THIS SCREEN IS FOR, AND WHY IT COULD NOT EXIST BEFORE. `bookings`
 * requires a unit and two dates, so "somebody rang about August, no dates
 * fixed" had nowhere to go — `leads/_lib/queries.ts` named that as the
 * strongest argument for a `leads` table and it was right.
 * `0074_leads_and_guest_merges.sql` built the table; this is the form.
 *
 * GATING. `requireGrant('lead.create')` refuses the route, and
 * `recordEnquiryAction` refuses again with `assertCan` before it writes — so
 * posting the action directly is refused whatever this page rendered.
 *
 * `lead.create` IS NOT `lead.view`. A referral agent holds the first and not
 * the second: `permissions.ts` says a `referral_agent` may create a lead and
 * see nothing else. So the breadcrumb back to the pipeline is shown only to a
 * reader who may open it, exactly as the guest form does for `guest.view`.
 *
 * WHAT THE FORM IS GIVEN. The properties in scope, so an enquiry can name one
 * — which matters more than it looks: an enquiry with no property is visible
 * only to a reader whose scope is the whole organization, because `can()`
 * treats an absent property under a `properties` scope as out of reach.
 * `_lib/enquiries.ts` sets out that reconciliation in full.
 */
export default async function NewEnquiryPage() {
  const [actor, context] = await Promise.all([
    requireGrant('lead.create'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') return null

  const mayList = holdsGrant(actor, 'lead.view')

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      {mayList && (
        <nav aria-label="פירורי לחם" className="text-sm">
          <Link
            href="/leads"
            className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            ← חזרה לצנרת המכירות
          </Link>
        </nav>
      )}

      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          פנייה חדשה
        </h1>
        <p className="max-w-prose text-muted-foreground">
          מישהו שאל ועדיין אין הזמנה. אין צורך בתאריכים, ביחידה או במחיר — רק
          בדרך לחזור אליו. פנייה שאי אפשר לרשום היא פנייה שנעלמת.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle as="h2">מי פנה, ועל מה</CardTitle>
          <CardDescription>
            אם מספר הטלפון תואם לאורח קיים, הפנייה תוצמד לפרופיל שלו אוטומטית —
            ולא ייפתח כרטיס שני לאותו אדם. התאמה לפי מייל בלבד תוצג כהצעה
            לבדיקה, ולעולם לא תבוצע מעצמה.
          </CardDescription>
        </CardHeader>

        <div className="mt-6">
          <RecordEnquiryForm properties={context.properties} />
        </div>
      </Card>
    </div>
  )
}
