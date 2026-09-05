import type { Metadata } from 'next'
import Link from 'next/link'

import { ActionError } from '@/components/booking/action-error'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { SiteHeader, SiteNav, StatTile } from '@/components/website/site-chrome'
import { SiteLock } from '@/components/website/site-lock'
import { FindingSummary } from '@/components/website/finding-list'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'
import { SITE_STATUS_SUMMARY } from '@/lib/website'

import { shellContext } from '../_lib/context'
import { requireSiteGrant, studioTabs } from './_lib/gate'
import { loadStudio, type StudioOverview } from './_lib/queries'
import { CreateSiteForm } from './create-site-form'

export const metadata: Metadata = { title: 'סטודיו האתר' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What the website is doing today.
 *
 * ── The three states this screen has ─────────────────────────────────────
 *
 *   1. **The plan does not include the website.** The gate returns `locked`
 *      and `SiteLock` explains what the section is for. Not a permission
 *      error — the owner holds `site.view`.
 *
 *   2. **There is no site yet.** The first-run state, which offers to create
 *      one. Not an error and not an empty table: most businesses arrive here
 *      having never had a website, and the screen's whole job is the first
 *      step.
 *
 *   3. **There is a site.** What is live, what is not yet published, and what
 *      the quality passes found.
 *
 * ── What the tiles deliberately do not say ───────────────────────────────
 *
 * There is no "site score". The quality passes produce counts and several of
 * their checks report `not_assessed` on purpose; averaging those into a number
 * would be exactly the fiction the module's rule forbids. So the tile says how
 * many findings there are, by severity, and the quality screen says which.
 */
export default async function WebsiteStudioPage() {
  const [access, context] = await Promise.all([
    requireSiteGrant('site.view'),
    shellContext(),
  ])

  if (access.kind === 'locked') {
    return (
      <SiteLock
        entitlement={access.entitlement}
        title="האתר אינו כלול בחבילה שלכם"
        body="כאן היה נבנה אתר התדמית שלכם — עם הנתונים שכבר קיימים במערכת, ועם הזמנות ישירות בלי עמלה."
        bullets={[
          'אתר בעברית, מותאם לנייד, שנבנה מנתוני הנכסים והיחידות שלכם.',
          'הזמנה ישירה מהאתר, מול מנוע הזמינות והתמחור של המערכת.',
          'פרסום מבוקר עם גרסאות, ואפשרות לחזור אחורה בלי לאבד כלום.',
        ]}
      />
    )
  }

  if (!context || context.status !== 'ready') return null

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
        title="סטודיו האתר"
        lead="האתר הפומבי שלכם, שנבנה מהנתונים שכבר קיימים במערכת."
        status={overview?.site?.status}
      />
      <SiteNav current="/website" entries={studioTabs(access.actor)} />

      {failure ? (
        <ActionError error={failure.error} />
      ) : !overview ? null : !overview.site ? (
        <CreateSiteForm
          properties={overview.properties.map((row) => ({
            id: String(row.id),
            name: String(row.name ?? ''),
          }))}
        />
      ) : (
        <>
          <section
            aria-label="מספרים"
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          >
            <StatTile
              label="מצב"
              value={
                overview.site.status === 'published' ? 'באוויר' : 'לא באוויר'
              }
              hint={SITE_STATUS_SUMMARY[overview.site.status]}
            />
            <StatTile
              label="עמודים"
              value={overview.pages.filter((page) => page.isActive).length}
              hint={
                overview.pages.length >
                overview.pages.filter((page) => page.isActive).length
                  ? `מתוך ${overview.pages.length} שנוצרו`
                  : undefined
              }
            />
            <StatTile
              label="טענות מאומתות"
              value={overview.sections.reduce(
                (total, section) => total + section.claims.length,
                0,
              )}
              // The sentence that explains the whole module in one line.
              hint="כל משפט באתר מקושר לשורה במערכת או לאדם שכתב אותו"
            />
            <StatTile
              label="ממצאי בדיקה"
              value={<FindingSummary counts={overview.counts} />}
              hint={
                overview.counts.notAssessed > 0
                  ? 'חלק מהבדיקות אינן ניתנות למדידה במוצר ומדווחות ככאלה'
                  : undefined
              }
            />
          </section>

          {overview.drift.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle as="h2">
                  {overview.drift.length} משפטים באתר אינם תואמים עוד לנתונים
                </CardTitle>
              </CardHeader>
              <p className="mt-3 text-sm text-muted-foreground">
                שיניתם נתונים במערכת מאז שהתוכן נשמר. האתר עדיין מציג את מה
                שפורסם — זה נכון, אבל לא מעודכן. פרסום מחדש יסנכרן.
              </p>
              <ul className="mt-3 flex flex-col gap-1 text-sm">
                {overview.drift.slice(0, 5).map((entry) => (
                  <li key={entry.claim.key} className="text-muted-foreground">
                    · {entry.claim.key}: ״{entry.claim.text}״ ←{' '}
                    {entry.currentValue ?? 'נמחק'}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle as="h2">הכתובת הפומבית</CardTitle>
            </CardHeader>
            <p className="mt-3 text-sm text-muted-foreground">
              {overview.site.status === 'published' ? (
                <>
                  האתר באוויר בכתובת{' '}
                  <Link
                    href={`/s/${overview.site.slug}`}
                    className="text-primary underline underline-offset-4"
                  >
                    /s/{overview.site.slug}
                  </Link>
                  . מבקרים רואים את הגרסה שפורסמה, לא את מה שאתם עורכים.
                </>
              ) : (
                <>
                  הכתובת שנשמרה היא /s/{overview.site.slug}, אבל האתר עדיין לא
                  באוויר ומבקר שיגיע אליה יקבל ״לא נמצא״.
                </>
              )}
            </p>

            {overview.live ? (
              <p className="mt-2 text-sm text-muted-foreground">
                גרסה {overview.live.versionNumber}, פורסמה ב־
                {new Date(overview.live.publishedAt).toLocaleDateString(
                  'he-IL',
                )}
                .
              </p>
            ) : null}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle as="h2">מה הלאה</CardTitle>
            </CardHeader>
            <ul className="mt-3 flex flex-col gap-2 text-sm text-muted-foreground">
              {overview.pages.length === 0 ? (
                <li>
                  ·{' '}
                  <Link
                    href="/website/content"
                    className="text-primary underline underline-offset-4"
                  >
                    הוסיפו עמוד ראשון
                  </Link>{' '}
                  — בלי עמוד פעיל אין מה לפרסם.
                </li>
              ) : null}
              {overview.counts.blockers > 0 ? (
                <li>
                  ·{' '}
                  <Link
                    href="/website/quality"
                    className="text-primary underline underline-offset-4"
                  >
                    {overview.counts.blockers} ממצאים חוסמים פרסום
                  </Link>{' '}
                  — כולם על משפטים שאי אפשר לאמת מול הנתונים.
                </li>
              ) : null}
              <li>
                ·{' '}
                <Link
                  href="/website/preview"
                  className="text-primary underline underline-offset-4"
                >
                  תצוגה מקדימה
                </Link>{' '}
                — לראות מה מבקר יראה לפני שמפרסמים.
              </li>
            </ul>
          </Card>
        </>
      )}
    </div>
  )
}
