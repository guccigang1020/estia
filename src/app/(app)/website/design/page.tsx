import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { SiteHeader, SiteNav } from '@/components/website/site-chrome'
import { SiteLock } from '@/components/website/site-lock'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { requireSiteGrant, studioTabs } from '../_lib/gate'
import { loadStudio, type StudioOverview } from '../_lib/queries'
import { DesignForm } from './design-form'

export const metadata: Metadata = { title: 'עיצוב האתר' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. How the site looks.
 *
 * ── A different grant, and it is not a formality ─────────────────────────
 *
 * `site.edit_design`. A marketing employee who writes copy all week does not
 * get to change the palette, and a designer does not get to rewrite the
 * cancellation paragraph. The roles genuinely differ, so the grants do, and
 * `sites_update` in 0042 plus `saveDesign`'s own `permission` enforce it in
 * two independent places.
 *
 * ── Five palettes and no colour picker ───────────────────────────────────
 *
 * The honest trade, explained on screen rather than hidden: a stored colour
 * ends up on a page served to strangers, and a page that interpolates a stored
 * string into a `style` attribute is one stored string away from being
 * somebody else's script. So the choices are closed and their VALUES are
 * literals in `src/lib/website/design.ts`.
 */
export default async function WebsiteDesignPage() {
  const access = await requireSiteGrant('site.edit_design')

  if (access.kind === 'locked') {
    return (
      <SiteLock
        entitlement={access.entitlement}
        title="עיצוב האתר אינו כלול בחבילה שלכם"
        body="כאן הייתם בוחרים את ערכת הצבעים, הגופן והמראה הכללי של האתר הפומבי."
        bullets={[
          'חמש ערכות צבעים שנבחרו לאירוח ישראלי.',
          'גופן כותרות, עיגול פינות ומרווח.',
          'תצוגה מקדימה מיידית.',
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
        title="עיצוב האתר"
        lead="איך האתר נראה למבקר. השינויים נכנסים לאוויר רק בפרסום הבא."
        status={overview?.site?.status}
      />
      <SiteNav current="/website/design" entries={studioTabs(access.actor)} />

      {failure ? (
        <ActionError error={failure.error} />
      ) : !overview?.site ? (
        <Card>
          <CardHeader>
            <CardTitle as="h2">אין עדיין אתר</CardTitle>
          </CardHeader>
          <p className="mt-3 text-sm text-muted-foreground">
            צרו אתר במסך הסקירה, ואז אפשר יהיה לעצב אותו.
          </p>
        </Card>
      ) : (
        <DesignForm siteId={overview.site.id} design={overview.site.design} />
      )}
    </div>
  )
}
