import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { SiteHeader, SiteNav } from '@/components/website/site-chrome'
import { SiteLock } from '@/components/website/site-lock'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { requireSiteGrant, studioTabs } from '../_lib/gate'
import { loadStudio, type StudioOverview } from '../_lib/queries'
import { SeoForm } from './seo-form'

export const metadata: Metadata = { title: 'חיפוש' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. How the site appears in search.
 *
 * ── `site.manage_seo`, and why it is not `site.edit_content` ─────────────
 *
 * Writing a paragraph and deciding whether a page may be indexed are different
 * jobs done by different people. A marketing employee writes the copy; whether
 * the terms page is visible to Google is a decision with legal edges, and the
 * asymmetry is enforced by the policy in 0042 rather than by this screen
 * omitting a field.
 *
 * ── What this screen does NOT promise ────────────────────────────────────
 *
 * A ranking. There is no keyword tool here, no difficulty score and no
 * position estimate, because this product has no search data and a number
 * produced without it would be invented. The technical quality pass says the
 * same thing in its own words, and both of them are the same discipline.
 */
export default async function WebsiteSeoPage() {
  const access = await requireSiteGrant('site.manage_seo')

  if (access.kind === 'locked') {
    return (
      <SiteLock
        entitlement={access.entitlement}
        title="נתוני החיפוש אינם כלולים בחבילה שלכם"
        body="כאן הייתם קובעים איך כל עמוד מופיע בתוצאות החיפוש."
        bullets={[
          'כותרת ותיאור לכל עמוד.',
          'כתובת קנונית, ושליטה על מה נכנס לאינדוקס.',
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

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <SiteHeader
        title="חיפוש"
        lead="איך כל עמוד מופיע בגוגל. אין כאן ציון והבטחה לדירוג — אין במוצר נתוני חיפוש."
        status={overview?.site?.status}
      />
      <SiteNav current="/website/seo" entries={studioTabs(access.actor)} />

      {failure ? (
        <ActionError error={failure.error} />
      ) : !overview?.site ? (
        <Card>
          <CardHeader>
            <CardTitle as="h2">אין עדיין אתר</CardTitle>
          </CardHeader>
          <p className="mt-3 text-sm text-muted-foreground">
            צרו אתר במסך הסקירה.
          </p>
        </Card>
      ) : overview.pages.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle as="h2">אין עמודים</CardTitle>
          </CardHeader>
          <p className="mt-3 text-sm text-muted-foreground">
            הוסיפו עמוד במסך התוכן, ואז אפשר יהיה לקבוע לו נתוני חיפוש.
          </p>
        </Card>
      ) : (
        <section className="flex flex-col gap-4">
          {overview.pages.map((page) => (
            <SeoForm
              key={page.id}
              siteId={overview.site!.id}
              pageId={page.id}
              pageTitle={page.title}
              pageSlug={page.slug}
              seo={page.seo}
            />
          ))}
        </section>
      )}
    </div>
  )
}
