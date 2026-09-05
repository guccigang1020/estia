import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { FindingList } from '@/components/website/finding-list'
import { SiteHeader, SiteNav } from '@/components/website/site-chrome'
import { SiteLock } from '@/components/website/site-lock'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { requireSiteGrant, studioTabs } from '../_lib/gate'
import {
  loadStudio,
  prePublishFindings,
  type StudioOverview,
} from '../_lib/queries'

export const metadata: Metadata = { title: 'בדיקות האתר' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What the four passes found.
 *
 * ── This screen shows what it could NOT check ────────────────────────────
 *
 * The tempting design drops the unmeasurable checks and shows a tidy list. It
 * would also be a lie: a report showing only what it could measure implies it
 * measured everything, and the first time somebody's site loads slowly they
 * would rightly ask why a "technical" pass said nothing.
 *
 * So `not_assessed` findings are rendered, in their own group, saying what was
 * not assessed and why. Three of them exist today — readability, conversion
 * rate and load time — and each names the missing source rather than a
 * generic apology.
 *
 * ── The pre-publish pass is shown separately ─────────────────────────────
 *
 * Because it answers a different question: not "how is the site?" but "will
 * the publish button work?". It calls the same `publishBlockers` the publish
 * operation calls, so the screen and the button cannot disagree.
 */
export default async function WebsiteQualityPage() {
  const access = await requireSiteGrant('site.view')

  if (access.kind === 'locked') {
    return (
      <SiteLock
        entitlement={access.entitlement}
        title="בדיקות האתר אינן כלולות בחבילה שלכם"
        body="כאן היו מוצגים ממצאי איכות התוכן, ההמרה והצד הטכני של האתר."
        bullets={[
          'ממצאים על תוכן חסר ועל משפטים שאי אפשר לאמת.',
          'בדיקת נתיב ההזמנה ופרטי הקשר.',
          'כותרות חיפוש, כתובות כפולות וטקסט חלופי לתמונות.',
        ]}
      />
    )
  }

  let overview: StudioOverview | null = null
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    overview = await loadStudio({ db, actor: access.actor })
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const prePublish = overview?.site ? prePublishFindings(overview) : []

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <SiteHeader
        title="בדיקות האתר"
        lead="ממצאים לקרוא ולהחליט לגביהם, לא ציון."
        status={overview?.site?.status}
      />
      <SiteNav current="/website/quality" entries={studioTabs(access.actor)} />

      {failure ? (
        <ActionError error={failure.error} />
      ) : !overview?.site ? (
        <Card>
          <CardHeader>
            <CardTitle as="h2">אין עדיין אתר</CardTitle>
          </CardHeader>
          <p className="mt-3 text-sm text-muted-foreground">
            צרו אתר במסך הסקירה, ואז יהיה מה לבדוק.
          </p>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle as="h2">לפני פרסום</CardTitle>
            </CardHeader>
            <p className="mt-3 text-sm text-muted-foreground">
              אלה הדברים שיעצרו את הפרסום עצמו. הבדיקה כאן היא בדיוק אותה בדיקה
              שהכפתור עושה, כדי שהמסך והכפתור לא יגידו דברים שונים.
            </p>
            <div className="mt-4">
              <FindingList findings={prePublish} />
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle as="h2">תוכן, המרה וטכני</CardTitle>
            </CardHeader>
            <div className="mt-4">
              <FindingList findings={overview.findings} />
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
