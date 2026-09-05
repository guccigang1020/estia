import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { ClaimList, ClaimSummary } from '@/components/website/claim-list'
import { SiteHeader, SiteNav } from '@/components/website/site-chrome'
import { SiteLock } from '@/components/website/site-lock'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'
import { SITE_PAGE_KIND_LABEL, SITE_SECTION_KIND_LABEL } from '@/lib/website'

import { requireSiteGrant, studioTabs } from '../_lib/gate'
import { loadStudio, type StudioOverview } from '../_lib/queries'
import { ContentEditor } from './content-editor'

export const metadata: Metadata = { title: 'תוכן האתר' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Writing the site.
 *
 * ── Every sentence shows where it came from ──────────────────────────────
 *
 * `ClaimList` renders each claim beside its source. That visibility is not
 * decoration: a system that silently guarantees provenance is a system nobody
 * can check, and one that shows the source next to the sentence teaches the
 * rule by using it. A wrong binding becomes obvious instead of latent.
 *
 * ── What a person may type, and what they may not ────────────────────────
 *
 * They type prose. They do NOT type a fact with a source attached — there is
 * no field for it here and no field for it in `SECTION_INPUT`. Canonical
 * claims are read from the rows by `content.ts` when the section is saved, so
 * a form post claiming "the villa has a heated pool, source: property" has
 * nowhere to arrive.
 */
export default async function WebsiteContentPage() {
  const access = await requireSiteGrant('site.edit_content')

  if (access.kind === 'locked') {
    return (
      <SiteLock
        entitlement={access.entitlement}
        title="עריכת תוכן אינה כלולה בחבילה שלכם"
        body="כאן הייתם כותבים את העמודים של האתר, ומשייכים כל מקטע לנתונים שכבר קיימים במערכת."
        bullets={[
          'עמודים ומקטעים שנבנים מנתוני הנכס והיחידות.',
          'כל משפט מקושר לשורה במערכת או לאדם שכתב אותו.',
          'תצוגה מקדימה לפני שמפרסמים.',
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
        title="תוכן האתר"
        lead="עמודים ומקטעים. כל מקטע שמשויך לנכס מתמלא מהנתונים שלכם."
        status={overview?.site?.status}
      />
      <SiteNav current="/website/content" entries={studioTabs(access.actor)} />

      {failure ? (
        <ActionError error={failure.error} />
      ) : !overview?.site ? (
        <Card>
          <CardHeader>
            <CardTitle as="h2">אין עדיין אתר</CardTitle>
          </CardHeader>
          <p className="mt-3 text-sm text-muted-foreground">
            צרו אתר במסך הסקירה, ואז אפשר יהיה להוסיף לו עמודים.
          </p>
        </Card>
      ) : (
        <>
          <ContentEditor
            siteId={overview.site.id}
            pages={overview.pages.map((page) => ({
              id: page.id,
              title: page.title,
              slug: page.slug,
            }))}
            properties={overview.properties.map((row) => ({
              id: String(row.id),
              name: String(row.name ?? ''),
            }))}
            units={overview.units.map((row) => ({
              id: String(row.id),
              name: String(row.name ?? ''),
            }))}
          />

          {overview.pages.length === 0 ? null : (
            <section className="flex flex-col gap-4">
              {overview.pages.map((page) => {
                const sections = overview.sections.filter(
                  (section) => section.pageId === page.id,
                )

                return (
                  <Card key={page.id}>
                    <CardHeader>
                      <CardTitle as="h2">
                        {page.title}
                        <span className="ms-2 text-sm font-normal text-muted-foreground">
                          {SITE_PAGE_KIND_LABEL[page.kind]} · /{page.slug}
                          {page.isActive ? '' : ' · כבוי'}
                        </span>
                      </CardTitle>
                    </CardHeader>

                    {sections.length === 0 ? (
                      <p className="mt-3 text-sm text-muted-foreground">
                        אין מקטעים בעמוד הזה. עמוד ריק יתפרסם ריק.
                      </p>
                    ) : (
                      <div className="mt-4 flex flex-col gap-5">
                        {sections.map((section) => (
                          <div key={section.id} className="flex flex-col gap-2">
                            <div className="flex flex-wrap items-baseline justify-between gap-2">
                              <h3 className="text-sm font-medium text-foreground">
                                {SITE_SECTION_KIND_LABEL[section.kind]}
                              </h3>
                              <span className="text-xs text-muted-foreground">
                                <ClaimSummary claims={section.claims} />
                              </span>
                            </div>
                            <ClaimList
                              claims={section.claims}
                              drift={overview.drift.filter((entry) =>
                                section.claims.includes(entry.claim),
                              )}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                )
              })}
            </section>
          )}
        </>
      )}
    </div>
  )
}
