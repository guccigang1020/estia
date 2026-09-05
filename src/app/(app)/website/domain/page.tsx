import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { SiteHeader, SiteNav } from '@/components/website/site-chrome'
import { SiteLock } from '@/components/website/site-lock'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'
import { DOMAIN_STATUS_LABEL } from '@/lib/website'

import { requireSiteGrant, studioTabs } from '../_lib/gate'
import { loadStudio, type StudioOverview } from '../_lib/queries'
import { DomainForm } from './domain-form'

export const metadata: Metadata = { title: 'דומיין' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. A hostname the business owns.
 *
 * ── A different entitlement, metered separately ──────────────────────────
 *
 * `site.manage_domain` carries `custom_domain`, not `website`. A customer can
 * hold a fully working website on the system's own address without paying for
 * a domain, and `ENTITLEMENT_FOR_GRANT` already says so — so this is the one
 * screen in the module that locks on its own while everything else works.
 *
 * ── And a different grant for READING ────────────────────────────────────
 *
 * The verification token is a credential: anybody holding it can prove control
 * of a hostname to this system. So `site_domains_select` in 0042 is gated on
 * `site.manage_domain` rather than on `site.view` — a copywriter gets no rows
 * from the database, not merely a hidden column on a screen.
 *
 * ── Verification is not implemented, and the screen says so ──────────────
 *
 * A domain is recorded as `pending` with a token to publish. Nothing in this
 * codebase performs a DNS lookup, so nothing here claims to: the screen states
 * what the business must do and that the check is not yet automatic, rather
 * than showing a spinner that will never resolve.
 */
export default async function WebsiteDomainPage() {
  const access = await requireSiteGrant('site.manage_domain')

  if (access.kind === 'locked') {
    return (
      <SiteLock
        entitlement={access.entitlement}
        title="דומיין משלכם אינו כלול בחבילה שלכם"
        body="האתר שלכם עובד ומפורסם בכתובת המערכת. חיבור דומיין פרטי דורש שדרוג."
        bullets={[
          'כתובת משלכם, למשל villa.co.il, במקום כתובת המערכת.',
          'אימות בעלות דרך רשומת DNS.',
          'כל שאר הסטודיו ממשיך לעבוד בדיוק כמו קודם.',
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
        title="דומיין"
        lead="הכתובת שבה האתר יופיע לעולם."
        status={overview?.site?.status}
      />
      <SiteNav current="/website/domain" entries={studioTabs(access.actor)} />

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
          <DomainForm siteId={overview.site.id} />

          <Card>
            <CardHeader>
              <CardTitle as="h2">הדומיינים שלכם</CardTitle>
            </CardHeader>

            {overview.domains.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                אין עדיין דומיין. האתר זמין בכתובת /s/{overview.site.slug}, וזו
                כתובת עובדת לכל דבר.
              </p>
            ) : (
              <ul className="mt-4 flex flex-col divide-y divide-border">
                {overview.domains.map((domain) => (
                  <li key={domain.id} className="flex flex-col gap-2 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span dir="ltr" className="text-sm text-foreground">
                        {domain.hostname}
                      </span>
                      <Badge
                        tone={
                          domain.status === 'verified' ? 'brand' : 'neutral'
                        }
                      >
                        {DOMAIN_STATUS_LABEL[domain.status]}
                      </Badge>
                    </div>

                    {domain.status !== 'verified' ? (
                      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                        <p>
                          הוסיפו אצל ספק הדומיין רשומת TXT בשם{' '}
                          <code dir="ltr">_estia</code> עם הערך:
                        </p>
                        <code
                          dir="ltr"
                          className="break-all rounded bg-muted px-2 py-1"
                        >
                          {domain.verificationToken}
                        </code>
                        {/* Said plainly. A spinner that never resolves is worse
                            than a sentence saying the check is manual. */}
                        <p>
                          האימות האוטומטי עדיין אינו פעיל במוצר. אחרי שהוספתם את
                          הרשומה, פנו אלינו כדי להשלים את החיבור. עד אז הכתובת
                          הזו לא תגיש את האתר.
                        </p>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        מאומת. האתר מוגש גם בכתובת הזו.
                      </p>
                    )}

                    {domain.failureReason ? (
                      <p className="text-xs text-muted-foreground">
                        סיבת הכישלון: {domain.failureReason}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
