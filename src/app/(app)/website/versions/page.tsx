import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { SiteHeader, SiteNav } from '@/components/website/site-chrome'
import { SiteLock } from '@/components/website/site-lock'
import { holdsGrant } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { requireSiteGrant, studioTabs } from '../_lib/gate'
import {
  loadStudio,
  prePublishFindings,
  type StudioOverview,
} from '../_lib/queries'
import { PublishControls } from './publish-controls'

export const metadata: Metadata = { title: 'גרסאות האתר' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What was live, and what is.
 *
 * ── The sentence this screen exists to make true ─────────────────────────
 *
 *   רולבק לגרסה 3 יוצר גרסה 7. הוא לא מוחק את 4, 5 ו־6.
 *
 * Said on screen, in Hebrew, because a person about to roll back at 21:00
 * because a price is wrong needs to know they are not throwing away a week of
 * work. The database enforces it — `tg_site_versions_immutable` refuses UPDATE
 * and DELETE for everybody including `service_role` — and the screen says it,
 * because a guarantee nobody is told about does not reduce anybody's fear.
 *
 * ── Two grants, and the buttons differ ───────────────────────────────────
 *
 * `site.publish` puts a reviewed draft live. `site.rollback` replaces what is
 * live with something older, at speed. They are separate grants because they
 * are separate acts with separate blast radii, and this screen offers each
 * only to whoever holds it.
 */
export default async function WebsiteVersionsPage() {
  const access = await requireSiteGrant('site.view')

  if (access.kind === 'locked') {
    return (
      <SiteLock
        entitlement={access.entitlement}
        title="גרסאות האתר אינן כלולות בחבילה שלכם"
        body="כאן היו מוצגות כל הגרסאות שפורסמו, עם אפשרות לחזור לכל אחת מהן."
        bullets={[
          'כל פרסום נשמר כגרסה שלמה שאפשר לחזור אליה.',
          'חזרה לגרסה קודמת אינה מוחקת דבר.',
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

  const blockers = overview?.site
    ? prePublishFindings(overview).filter(
        (finding) =>
          finding.severity === 'blocker' && finding.status === 'open',
      )
    : []

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <SiteHeader
        title="גרסאות האתר"
        lead="כל פרסום נשמר. חזרה לגרסה קודמת יוצרת גרסה חדשה ולא מוחקת דבר."
        status={overview?.site?.status}
      />
      <SiteNav current="/website/versions" entries={studioTabs(access.actor)} />

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
      ) : (
        <>
          <PublishControls
            siteId={overview.site.id}
            status={overview.site.status}
            canPublish={holdsGrant(access.actor, 'site.publish')}
            canRollback={holdsGrant(access.actor, 'site.rollback')}
            blockers={blockers.map((finding) => finding.title)}
            rollbackTargets={overview.rollbackTargets.map((version) => ({
              id: version.id,
              versionNumber: version.versionNumber,
              publishedAt: version.publishedAt,
              label: version.label,
            }))}
          />

          <Card>
            <CardHeader>
              <CardTitle as="h2">היסטוריית פרסומים</CardTitle>
            </CardHeader>

            {overview.versions.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                האתר עדיין לא פורסם מעולם.
              </p>
            ) : (
              <ul className="mt-4 flex flex-col divide-y divide-border">
                {overview.versions.map((version) => (
                  <li
                    key={version.id}
                    className="flex flex-wrap items-baseline justify-between gap-2 py-3"
                  >
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">
                          גרסה {version.versionNumber}
                        </span>
                        {version.id === overview.site?.publishedVersionId ? (
                          <Badge tone="brand">באוויר</Badge>
                        ) : null}
                        {version.restoredFromVersionId ? (
                          <Badge>שחזור</Badge>
                        ) : null}
                      </div>
                      {version.label ? (
                        <span className="text-xs text-muted-foreground">
                          {version.label}
                        </span>
                      ) : null}
                      <span className="text-xs text-muted-foreground">
                        {version.snapshot?.pages?.length ?? 0} עמודים ·{' '}
                        {version.snapshot?.factManifest?.length ?? 0} טענות
                        מאומתות
                      </span>
                    </div>

                    <span className="text-xs text-muted-foreground">
                      {new Date(version.publishedAt).toLocaleString('he-IL')}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <p className="mt-4 text-xs text-muted-foreground">
              גרסה שפורסמה לא ניתנת לעריכה או למחיקה — גם לא על ידי מנהל מערכת.
              היא התיעוד של מה שהיה באוויר.
            </p>
          </Card>
        </>
      )}
    </div>
  )
}
