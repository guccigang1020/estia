import type { Metadata } from 'next'

import { AutopilotEmptyState } from '@/components/autopilot/empty-state'
import { AutopilotPlanLock } from '@/components/autopilot/plan-lock'
import { ActionError } from '@/components/booking/action-error'
import {
  FactRow,
  Panel,
  PanelNote,
  Row,
  RowList,
  ScreenFrame,
} from '@/components/shell-screens/screen'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { addDays, formatDayMonth } from '@/lib/booking/dates'
import { createClient } from '@/lib/supabase/server'

import { propertyToday } from '../_lib/queries'
import { type AutopilotReadArgs } from '../_lib/reads'
import { settle } from '../_lib/settle'
import { requireValueScreen } from './_lib/access'
import {
  ESTIMATE_METHOD,
  estimateTimeSaved,
  formatMinutes,
} from './_lib/estimate'
import {
  countValue,
  loadValueActions,
  loadValueExceptions,
} from './_lib/queries'

export const metadata: Metadata = { title: 'מה ESTIA עשתה' }

/** The window. Thirty days, stated on screen rather than assumed. */
const WINDOW_DAYS = 30

const MODULE_INCLUDES = [
  'ספירה של מה ש־ESTIA באמת עשתה, לא של מה שהיא הייתה יכולה לעשות.',
  'גם מה שנמנע נספר — סירוב נכון הוא המערכת עובדת.',
  'הערכת זמן מוצגת כהערכה, עם החישוב פתוח, כדי שאפשר יהיה לחלוק עליה.',
]

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What ESTIA actually did.
 *
 * ── The estimate is labelled, and the method is on the screen ────────────
 *
 * "Time saved" is the figure every operations product inflates, and there is
 * no honest way to measure it here: nothing in the database records how long a
 * task took the human who did not do it. So the number is a count of actions
 * multiplied by a stated assumption per action kind, the assumption is printed
 * next to the count, and the total is labelled an estimate every time it
 * appears. A manager who thinks a payment reminder takes one minute rather
 * than five can do the sum and disagree with the right number — which is the
 * only kind of value figure worth showing twice.
 *
 * Simulated and suppressed actions are NOT counted as time saved. A simulation
 * saved nobody anything, and a refusal is ESTIA working correctly rather than
 * ESTIA doing somebody's job. Both are counted separately and shown, because
 * they are the two outcomes a customer has most of in their first fortnight
 * and hiding them would make the screen look empty exactly when it is working.
 *
 * ── Nothing here is a rate ───────────────────────────────────────────────
 *
 * No percentage, no month-on-month, no "efficiency". Every figure is the
 * length of a list of rows a person can go and read, and the window is printed
 * rather than implied.
 */
export default async function AutopilotValuePage() {
  const access = await requireValueScreen()
  const { actor, organizationId, propertyId, propertyName } = access

  const mayReadActivity = holdsGrant(actor, 'autopilot.activity_view')
  const today = propertyToday()
  const from = addDays(today, -WINDOW_DAYS)

  const db = await createClient()
  const args: AutopilotReadArgs = { db, actor, organizationId, propertyId }

  const [actions, exceptions] = await Promise.all([
    settle(() => loadValueActions(args, `${from}T00:00:00Z`)),
    settle(() => loadValueExceptions(args)),
  ])

  const actionRows = actions.ok ? actions.value : []
  const exceptionRows = exceptions.ok ? exceptions.value : []
  const counts = countValue(actionRows, exceptionRows)
  const estimate = estimateTimeSaved(actionRows)

  const nothingYet =
    actions.ok &&
    exceptions.ok &&
    actionRows.length === 0 &&
    exceptionRows.length === 0

  return (
    <ScreenFrame
      title="מה ESTIA עשתה"
      lead={
        propertyName
          ? `ב־${WINDOW_DAYS} הימים האחרונים ב״${propertyName}״, מ־${formatDayMonth(from)} ועד ${formatDayMonth(today)}.`
          : `ב־${WINDOW_DAYS} הימים האחרונים, מ־${formatDayMonth(from)} ועד ${formatDayMonth(today)}.`
      }
    >
      {access.kind === 'locked' ? (
        <AutopilotPlanLock
          entitlement={access.entitlement}
          includes={MODULE_INCLUDES}
          mayReachBilling={holdsGrant(actor, 'organization.billing.manage')}
        />
      ) : nothingYet ? (
        <AutopilotEmptyState
          tone="calm"
          title="עוד אין מה לספור"
          body="ESTIA לא רשמה פעולה ולא זיהתה חריגה בחלון הזה. זה המצב הנכון לעסק ש־Autopilot כבויה אצלו או שהופעלה זה עתה — ומסך ההגדרות אומר באיזה מהם מדובר."
          action={
            <Button href="/autopilot/settings" variant="secondary">
              מצב Autopilot והגדרות
            </Button>
          }
        />
      ) : (
        <>
          {!mayReadActivity && (
            <PanelNote>
              ספירת הפעולות דורשת הרשאת{' '}
              <span dir="ltr">autopilot.activity_view</span>, שאינה ברשותך.
              המספרים שמבוססים על פעולות אינם מוצגים — אפס היה טענה שקרית על
              העסק, ולא על ההרשאה.
            </PanelNote>
          )}

          {!actions.ok && <ActionError error={actions.error} />}
          {!exceptions.ok && <ActionError error={exceptions.error} />}

          <Panel
            title="מה נספר"
            description="כל מספר כאן הוא אורך של רשימת שורות שאפשר לפתוח ולקרוא. אין כאן אחוז ואין השוואה לתקופה שאיש לא בחר."
          >
            <dl className="flex flex-col">
              <FactRow label="פעולות שבוצעו בפועל">
                {mayReadActivity ? counts.automated : 'לא זמין לצפייה'}
              </FactRow>
              <FactRow label="פעולות שנמנעו במכוון">
                {mayReadActivity ? counts.suppressed : 'לא זמין לצפייה'}
              </FactRow>
              <FactRow label="פעולות שנרשמו בסימולציה">
                {mayReadActivity ? counts.simulated : 'לא זמין לצפייה'}
              </FactRow>
              <FactRow label="הודעות שיצאו החוצה">
                {mayReadActivity ? counts.remindersSent : 'לא זמין לצפייה'}
              </FactRow>
              <FactRow label="פעולות שנכשלו">
                {mayReadActivity ? counts.failed : 'לא זמין לצפייה'}
              </FactRow>
              <FactRow label="חריגות שזוהו">{counts.risksDetected}</FactRow>
              <FactRow label="מתוכן חוסרי מלאי">
                {counts.shortagesCaught}
              </FactRow>
              <FactRow label="חריגות שנסגרו">{counts.resolved}</FactRow>
            </dl>
          </Panel>

          {mayReadActivity && (
            <Panel
              title="הערכת זמן — הערכה, לא מדידה"
              description={ESTIMATE_METHOD}
            >
              {estimate.countedActions === 0 ? (
                <PanelNote>
                  לא בוצעה אף פעולה בחלון הזה, ולכן אין מה להעריך. פעולות
                  בסימולציה ופעולות שנמנעו אינן נספרות כאן במכוון — סימולציה לא
                  חסכה לאיש זמן.
                </PanelNote>
              ) : (
                <div className="flex flex-col gap-4">
                  <p className="text-sm text-foreground">
                    <span className="font-display text-2xl font-bold tabular-nums">
                      {formatMinutes(estimate.totalMinutes)}
                    </span>{' '}
                    <span className="text-muted-foreground">
                      — הערכה, על בסיס {estimate.countedActions} פעולות שבוצעו
                    </span>
                  </p>

                  <RowList>
                    {estimate.lines.map((line) => (
                      <Row key={line.kind}>
                        <span className="text-sm text-foreground">
                          {line.label}
                        </span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {line.count} × {line.minutesEach} דק׳ ={' '}
                          {formatMinutes(line.minutes)}
                        </span>
                      </Row>
                    ))}
                  </RowList>

                  <PanelNote>
                    מספר הדקות לכל סוג פעולה הוא הנחה מוצהרת, לא מדידה. אם
                    לדעתכם תזכורת לוקחת דקה ולא ארבע — החישוב פתוח למעלה ואפשר
                    לעשות אותו מחדש. מספר שאי אפשר לחלוק עליו הוא מספר שמפסיקים
                    להאמין לו.
                  </PanelNote>
                </div>
              )}
            </Panel>
          )}

          <Panel
            title="מה עומד מאחורי המספרים"
            description="הפירוט עצמו, לא סיכום שלו."
          >
            <div className="flex flex-wrap gap-3">
              <Button
                href="/autopilot/exceptions?state=all"
                variant="secondary"
              >
                כל החריגות
              </Button>
              {mayReadActivity && (
                <Button href="/autopilot/activity" variant="secondary">
                  יומן הפעולות
                </Button>
              )}
            </div>
          </Panel>
        </>
      )}
    </ScreenFrame>
  )
}
