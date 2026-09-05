import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { SitePageBody } from '@/components/website/public-site'
import { SiteHeader, SiteNav } from '@/components/website/site-chrome'
import { SiteLock } from '@/components/website/site-lock'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'
import { buildSnapshot, cssVariables } from '@/lib/website'

import { requireSiteGrant, studioTabs } from '../_lib/gate'
import { loadStudio, type StudioOverview } from '../_lib/queries'

export const metadata: Metadata = { title: 'תצוגה מקדימה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The DRAFT, as a visitor would see it.
 *
 * ── Why this builds a snapshot rather than rendering the draft directly ──
 *
 * Because a preview that renders the draft through a different path is a
 * preview that can disagree with the live site, and the day it does is the day
 * somebody publishes something they did not see. So the preview runs the
 * SAME `buildSnapshot` the publish operation runs, and feeds the result to the
 * SAME `SitePageBody` the public route uses. What is on this page is what
 * publishing would produce, by construction.
 *
 * It also means the preview can REFUSE, exactly as publishing would, and for
 * the same reason: a draft carrying an unsourced claim has no snapshot, so
 * there is nothing to preview, and the screen says which claim rather than
 * rendering a page that could never go live.
 *
 * ── Nothing is written ───────────────────────────────────────────────────
 *
 * `buildSnapshot` is pure. This screen creates no version, moves no pointer,
 * and a person with only `site.view` can open it — which is the point: a
 * manager reviews before a publisher publishes.
 */
export default async function WebsitePreviewPage() {
  const access = await requireSiteGrant('site.view')

  if (access.kind === 'locked') {
    return (
      <SiteLock
        entitlement={access.entitlement}
        title="תצוגה מקדימה אינה כלולה בחבילה שלכם"
        body="כאן הייתם רואים בדיוק מה מבקר יראה, לפני שמפרסמים."
        bullets={[
          'הדף כפי שייבנה בפרסום, ולא הדמיה נפרדת.',
          'סירוב מיידי אם יש משפט שאי אפשר לאמת.',
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

  const built =
    overview?.site !== null && overview !== null
      ? buildSnapshot({
          site: overview.site,
          organizationName: overview.site.name,
          pages: overview.pages,
          sections: overview.sections,
          media: overview.media,
          units: overview.units.map((row) => ({
            id: String(row.id),
            propertyId: String(row.property_id),
            status: String(row.status),
          })),
          now: new Date(),
        })
      : null

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <SiteHeader
        title="תצוגה מקדימה"
        lead="הטיוטה כפי שהיא תיבנה בפרסום. לא הדמיה — אותו קוד בדיוק."
        status={overview?.site?.status}
      />
      <SiteNav current="/website/preview" entries={studioTabs(access.actor)} />

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
      ) : !built ? null : !built.ok ? (
        <Card>
          <CardHeader>
            <CardTitle as="h2">אי אפשר להציג — ואי אפשר לפרסם</CardTitle>
          </CardHeader>
          <p className="mt-3 text-sm text-muted-foreground">
            יש באתר משפטים שאינם ניתנים לאימות מול הנתונים שלכם. אתר לא מפרסם
            טענה שאי אפשר לבדוק, ולכן גם התצוגה המקדימה נעצרת כאן.
          </p>
          <ul className="mt-3 flex flex-col gap-1 text-sm text-muted-foreground">
            {built.blockers.map((blocker) => (
              <li key={blocker.claim.key}>
                · ״{blocker.claim.key}״ — {blocker.claim.text}
              </li>
            ))}
          </ul>
        </Card>
      ) : built.snapshot.pages.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle as="h2">אין עמוד פעיל להציג</CardTitle>
          </CardHeader>
          <p className="mt-3 text-sm text-muted-foreground">
            הוסיפו עמוד במסך התוכן, או הפעילו עמוד שכיביתם.
          </p>
        </Card>
      ) : (
        <section className="flex flex-col gap-4">
          {built.snapshot.pages.map((page) => (
            <Card key={page.slug}>
              <CardHeader>
                <CardTitle as="h2">
                  {page.title}
                  <span className="ms-2 text-sm font-normal text-muted-foreground">
                    /{page.slug}
                  </span>
                </CardTitle>
              </CardHeader>

              <div
                dir="rtl"
                style={{
                  ...cssVariables(built.snapshot.design),
                  background: 'var(--site-bg)',
                  color: 'var(--site-ink)',
                  gap: 'var(--site-section-gap)',
                }}
                className="mt-4 flex flex-col rounded-lg border border-border p-6"
              >
                <SitePageBody
                  snapshot={built.snapshot}
                  page={page}
                  basePath={`/s/${built.snapshot.slug}`}
                />
              </div>
            </Card>
          ))}
        </section>
      )}
    </div>
  )
}
