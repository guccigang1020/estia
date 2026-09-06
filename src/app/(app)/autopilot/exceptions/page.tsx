import type { Metadata } from 'next'

import { firstParam } from '@/app/(auth)/_lib/search-params'
import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { ActionApprovalCard } from '@/components/autopilot/action-approval-card'
import { AutopilotEmptyState } from '@/components/autopilot/empty-state'
import { ExceptionCard } from '@/components/autopilot/exception-card'
import { AutopilotPlanLock } from '@/components/autopilot/plan-lock'
import { ActionError } from '@/components/booking/action-error'
import {
  Panel,
  PanelNote,
  ScreenFrame,
} from '@/components/shell-screens/screen'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { createClient } from '@/lib/supabase/server'

import { groupByRootCause, incidentSize } from '../_lib/incidents'
import { AUTOPILOT_PAGE_SIZE, type AutopilotReadArgs } from '../_lib/reads'
import { settle } from '../_lib/settle'
import { requireExceptionCentre } from './_lib/access'
import {
  actionsByException,
  loadActionsForExceptions,
  loadExceptions,
  parseStateFilter,
} from './_lib/queries'

export const metadata: Metadata = { title: 'מרכז החריגות' }

const STATE_KEY = 'state'

const MODULE_INCLUDES = [
  'איחור של המכבסה, חוסר במצעים והכנה שלא תספיק — מוצגים כתקלה אחת עם התוצאות שלה, לא כשלוש התראות.',
  'לכל חריגה יש מועד אחרון, אחראי, והעובדות שעליהן היא מבוססת.',
  'ESTIA מזהה את אותה תקלה שוב ושוב בלי להציף — שורה אחת עם מונה, לא שבעים התראות.',
]

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Every open exception, by root cause.
 *
 * ── The grouping is the feature ──────────────────────────────────────────
 *
 * A flat list of exceptions is a list of symptoms. The laundry van is late, so
 * the linen is short, so the preparation will not finish, so the arrival is at
 * risk — four true rows, one thing to fix, and a manager reading the flat list
 * at 06:00 starts with the arrival risk, which is the one link they can do
 * nothing about.
 *
 * `caused_by` in 0046 points at the ROOT for exactly this, and
 * `groupByRootCause` follows it. The root gets the card; its consequences sit
 * beneath it in a collapsed block with a count, so the blast radius is visible
 * without four alarms competing for the top of the screen.
 *
 * ── Every column the brief asks for, and each is a column ────────────────
 *
 * Severity (`risk`), deadline (`due_at`), entity (`resource_type` /
 * `resource_id`), reason (`detail`), evidence (`evidence`), suggested action
 * (the linked `autopilot_actions` row), owner (`owner_user_id`) and status
 * (`state`). Not one of them is inferred here.
 *
 * ── Two grants, and the second one is not implied ────────────────────────
 *
 * The exceptions need `autopilot.view`. The prepared actions beneath them need
 * `autopilot.activity_view`, which is a larger authority — see
 * `_lib/access.ts`. A reader holding only the first gets every exception and
 * one sentence saying why no suggestions are shown, rather than forty rows
 * silently claiming ESTIA proposed nothing.
 *
 * ── The filter is a link, so there is no client component ────────────────
 *
 * `?state=all` is a query parameter and the two options are two `<a>`s. A
 * `<select>` with an `onChange` would need a client boundary, a router push
 * and a loading state to do what a link does.
 */
export default async function AutopilotExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [access, params] = await Promise.all([
    requireExceptionCentre(),
    searchParams,
  ])
  const { actor, organizationId, propertyId, propertyName } = access

  const filter = parseStateFilter(firstParam(params[STATE_KEY]))
  const mayReadActivity = holdsGrant(actor, 'autopilot.activity_view')
  const mayApprove = holdsGrant(actor, 'autopilot.approve')

  const db = await createClient()
  const args: AutopilotReadArgs = { db, actor, organizationId, propertyId }

  const [exceptions, actions] = await Promise.all([
    settle(() => loadExceptions(args, filter)),
    settle(() => loadActionsForExceptions(args)),
  ])

  const rows = exceptions.ok ? exceptions.value : []
  const incidents = groupByRootCause(rows)
  const suggestions = actionsByException(actions.ok ? actions.value : [])
  const atCeiling = rows.length >= AUTOPILOT_PAGE_SIZE

  return (
    <ScreenFrame
      title="מרכז החריגות"
      lead={
        propertyName
          ? `כל מה שאינו כפי שהוא אמור להיות ב״${propertyName}״, מקובץ לפי הסיבה ולא לפי התסמין.`
          : 'כל מה שאינו כפי שהוא אמור להיות, מקובץ לפי הסיבה ולא לפי התסמין.'
      }
      banner={
        access.kind === 'allow' ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              href="/autopilot/exceptions"
              variant={filter === 'open' ? 'primary' : 'ghost'}
              size="sm"
            >
              פתוחות
            </Button>
            <Button
              href="/autopilot/exceptions?state=all"
              variant={filter === 'all' ? 'primary' : 'ghost'}
              size="sm"
            >
              הכול, כולל שנסגרו
            </Button>
            <span className="text-xs text-muted-foreground">
              {incidents.length} תקלות · {rows.length} שורות
            </span>
          </div>
        ) : undefined
      }
    >
      {access.kind === 'locked' ? (
        <AutopilotPlanLock
          entitlement={access.entitlement}
          includes={MODULE_INCLUDES}
          mayReachBilling={holdsGrant(actor, 'organization.billing.manage')}
        />
      ) : !exceptions.ok ? (
        <Panel title="חריגות">
          <ActionError error={exceptions.error} />
        </Panel>
      ) : rows.length === 0 ? (
        <AutopilotEmptyState
          tone="calm"
          title={filter === 'open' ? 'אין חריגה פתוחה' : 'לא נרשמה אף חריגה'}
          body={
            filter === 'open'
              ? 'שום דבר לא סומן כחורג מהמצופה. אם Autopilot עדיין בסימולציה או כבויה, זו הסיבה — ומסך ההגדרות אומר באיזה מצב היא נמצאת.'
              : 'הטבלה ריקה. ESTIA לא רשמה אף חריגה בארגון הזה, וזה מצב תקין לעסק שהיכולת נפתחה לו זה עתה.'
          }
          action={
            <div className="flex flex-wrap gap-3">
              <Button href="/autopilot/settings" variant="secondary">
                מצב Autopilot והגדרות
              </Button>
              {filter === 'open' && (
                <Button href="/autopilot/exceptions?state=all" variant="ghost">
                  להצגת חריגות שנסגרו
                </Button>
              )}
            </div>
          }
        />
      ) : (
        <>
          {!mayReadActivity && (
            <PanelNote>
              הפעולות ש־ESTIA הכינה לכל חריגה דורשות הרשאת{' '}
              <span dir="ltr">autopilot.activity_view</span>, שאינה ברשותך.
              החריגות עצמן מוצגות במלואן.
            </PanelNote>
          )}

          {mayReadActivity && !actions.ok && (
            <ActionError error={actions.error} />
          )}

          {atCeiling && (
            <PanelNote tone="attention">
              מוצגות {AUTOPILOT_PAGE_SIZE} השורות הראשונות. ייתכן שיש עוד —
              צמצום לנכס אחד מלמעלה יראה את השאר.
            </PanelNote>
          )}

          <div className="flex flex-col gap-4">
            {incidents.map((incident) => {
              const prepared = suggestions.get(incident.root.id) ?? []

              return (
                <ExceptionCard key={incident.root.id} incident={incident}>
                  {prepared.length === 0 ? (
                    mayReadActivity && (
                      <p className="text-xs text-muted-foreground">
                        ESTIA לא הכינה פעולה לחריגה הזו.
                        {incidentSize(incident) > 1 &&
                          ' הטיפול בסיבה שלמעלה סוגר גם את מה שהיא גררה.'}
                      </p>
                    )
                  ) : (
                    <div className="flex flex-col gap-3">
                      {prepared.map((action) => (
                        <ActionApprovalCard
                          key={action.id}
                          action={action}
                          mayApprove={mayApprove}
                        />
                      ))}
                    </div>
                  )}
                </ExceptionCard>
              )
            })}
          </div>
        </>
      )}
    </ScreenFrame>
  )
}
