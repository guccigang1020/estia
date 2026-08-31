import type { Metadata } from 'next'

import Link from 'next/link'

import { ActionError } from '@/components/booking/action-error'
import { CreateGuestForm } from '@/components/guests/create-guest-form'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { holdsGrant } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import { listGuestTags } from '../_lib/queries'

export const metadata: Metadata = { title: 'אורח חדש' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Opening a guest card.
 *
 * GATING. `requireGrant('guest.create')` refuses the route, and
 * `createGuestAction` refuses again with `assertCan` before it writes — so
 * reaching this URL without the grant lands on the dashboard with the missing
 * grant named, and posting the action directly is refused regardless.
 *
 * `guest.create` IS NOT `guest.view`. An external sales agent holds the first
 * and not the second: `roles.ts` puts `guest.create` on the
 * `availability_booking` calendar rung — entering a customer's details is
 * writing, not reading — while the guest-data ladder starts at `none`. So this
 * page is reachable by somebody who may not open the card they are about to
 * create, and two things follow. The breadcrumb back to the list is only shown
 * to a reader who may see the list, and the form is told whether to navigate
 * on success or to say what happened instead.
 *
 * WHAT THE FORM IS GIVEN. The tags already in use, so the business's working
 * vocabulary does not fork into "חוזרת" and "חוזר" by typo. Nothing else: the
 * guest table has no lookups, no rate card and no computed value, so there is
 * nothing else honest to preload.
 */
export default async function NewGuestPage() {
  const [actor, context] = await Promise.all([
    requireGrant('guest.create'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') return null

  const mayList = holdsGrant(actor, 'guest.view')

  let tags: readonly string[] = []
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    // Only for a reader who may see guests at all. Deriving the tag list from
    // rows a person may not read would hand them a summary of exactly the
    // records the grant withholds — a tag is short, and "ירח דבש" about a
    // customer list is still information about that customer list.
    if (mayList) {
      const db = await createClient()
      tags = await listGuestTags(db, actor.organizationId)
    }
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      {mayList && (
        <nav aria-label="פירורי לחם" className="text-sm">
          <Link
            href="/guests"
            className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            ← חזרה לרשימת האורחים
          </Link>
        </nav>
      )}

      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          אורח חדש
        </h1>
        <p className="max-w-prose text-muted-foreground">
          כרטיס אורח נפתח מעצמו עם ההזמנה הראשונה. הטופס הזה נועד למי שמתקשר
          לפני שיש הזמנה — כדי שכשההזמנה תגיע, לא תתחיל מדף ריק.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle as="h2">פרטי האורח</CardTitle>
          <CardDescription>
            רק השם חובה. שדה שלא תמלא יישמר ריק ולא כמחרוזת ריקה, כדי שיהיה אפשר
            להבדיל בין ״לא נרשם״ לבין ״נרשם ריק״.
          </CardDescription>
        </CardHeader>

        <div className="mt-6">
          {failure ? (
            <ActionError error={failure.error} />
          ) : (
            <CreateGuestForm knownTags={tags} mayList={mayList} />
          )}
        </div>
      </Card>
    </div>
  )
}
