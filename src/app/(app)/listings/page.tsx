import type { Metadata } from 'next'

import {
  FactRow,
  Panel,
  PanelNote,
  Row,
  RowList,
  ScreenFrame,
} from '@/components/shell-screens/screen'
import { Badge } from '@/components/ui/badge'
import {
  LISTING_AREA_LABEL,
  labelFor,
  whatToFixFirst,
} from '@/lib/listing-quality'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireGrant } from '../_lib/guard'
import { loadListingsScreen } from './_lib/queries'

export const metadata: Metadata = { title: 'איכות הליסטינג · ESTIA' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What a guest sees before booking, and
 * what is missing from it.
 *
 * THIS SCREEN WRITES NOTHING. Every fix it names is made on `/properties` or
 * `/units`, which own those forms and their validation. A quality report that
 * also edited what it judges would be a second answer to what a valid listing
 * is.
 *
 * THE SCORE IS COMPUTED ON READ AND NEVER STORED. There is no migration behind
 * this module. A stored score drifts from the rows it describes — a listing
 * improved this morning would show yesterday's number until something
 * recomputed it, and it would be confidently wrong in the one direction that
 * matters.
 *
 * WHAT IT REFUSES TO SCORE. Guest ratings, conversion and market position all
 * report `not_assessed` and weigh nothing, so they neither drag a score down
 * nor prop it up. Two of those are absent for the same reason: `review.view`
 * and `review.manage` are in the permission catalogue with no reviews table
 * behind them, and no analytics source exists. Saying so is the point — a
 * report that scored what it cannot measure is decoration, and decoration is
 * what makes people stop reading reports.
 *
 * GATING. `requireGrant('property.view')` refuses the route: this is
 * information about the business's own properties, and everything it reads is
 * already visible to somebody holding that grant. Row level security refuses
 * underneath regardless.
 */
export default async function ListingsPage() {
  const [actor, context] = await Promise.all([
    requireGrant('property.view'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') return null

  const propertyIds =
    context.selectedPropertyId === ALL_PROPERTIES
      ? context.properties.map((property) => property.id)
      : [context.selectedPropertyId]

  const db = await createClient()
  const screen = await loadListingsScreen(db, actor.organizationId, propertyIds)

  const lead =
    'מה שאורח רואה לפני שהוא מזמין, ומה חסר בו. הציון מחושב בכל טעינה מהשורות ' +
    'עצמן ואינו נשמר — ציון שמור נסחף מהנתונים שהוא מתאר.'

  if (screen.status === 'not_provisioned') {
    return (
      <ScreenFrame title="איכות הליסטינג" lead={lead} width="prose">
        <Panel title="הנתונים אינם זמינים">
          <PanelNote>
            אחת מהטבלאות שהמסך קורא אינה קיימת בבסיס הנתונים הזה.
          </PanelNote>
        </Panel>
      </ScreenFrame>
    )
  }

  const { reports, propertiesWithNoUnits } = screen

  return (
    <ScreenFrame title="איכות הליסטינג" lead={lead} width="prose">
      <Panel
        title="ליסטינגים"
        count={reports.length}
        description="החלשים ראשונים. ליסטינג שאי אפשר לשפוט אותו כלל יושב בסוף ולא בראש — הוא לא הגרוע ביותר, הוא זה שהמוצר יודע עליו הכי מעט."
      >
        {reports.length === 0 ? (
          <PanelNote>
            אין נכסים בהיקף שלך, ולכן אין מה לדרג. זה מצב של הרשאות ולא של
            איכות.
          </PanelNote>
        ) : (
          <RowList>
            {reports.map((report) => {
              const fixes = whatToFixFirst(report.checks, 3)
              const blind = report.score.assessed === 0
              return (
                <Row
                  key={`${report.propertyId}:${report.unitId ?? 'property'}`}
                  className="flex-col items-stretch gap-1.5"
                >
                  <FactRow label={report.name}>
                    <span className="flex items-center gap-2">
                      {blind ? (
                        <Badge>לא ניתן לשפוט</Badge>
                      ) : (
                        <span className="font-mono text-sm">
                          {report.score.score}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {report.score.assessed} נבדקו ·{' '}
                        {report.score.notAssessed} לא ניתנים למדידה
                      </span>
                    </span>
                  </FactRow>

                  {report.unitId === null && (
                    <PanelNote>
                      לנכס הזה אין עדיין יחידות, ולכן נבדק הנכס בלבד.
                    </PanelNote>
                  )}

                  {fixes.length === 0 ? (
                    <PanelNote>
                      אין כאן מה לתקן מבין הדברים שהמוצר יודע לבדוק.
                    </PanelNote>
                  ) : (
                    <ul className="space-y-1 text-xs">
                      {fixes.map((check) => (
                        <li key={check.code} className="flex gap-2">
                          <span className="shrink-0 text-muted-foreground">
                            {LISTING_AREA_LABEL[check.area]}
                          </span>
                          <span>{labelFor(check.code)}</span>
                          {check.observed !== null && (
                            <span className="shrink-0 text-muted-foreground">
                              ({check.observed})
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </Row>
              )
            })}
          </RowList>
        )}
      </Panel>

      {propertiesWithNoUnits > 0 && (
        <Panel title="נכסים בלי יחידות">
          <PanelNote>
            {propertiesWithNoUnits} נכסים נבדקו בלי יחידה. אורח מזמין יחידה, לא
            נכס — עד שתיווצר אחת אין מה להזמין, וגם הציון מתאר רק חצי מהתמונה.
          </PanelNote>
        </Panel>
      )}

      <Panel title="מה המסך הזה לא יודע לבדוק">
        <PanelNote>
          <strong>דירוגי אורחים</strong> — ההרשאות{' '}
          <span dir="ltr" className="font-mono text-xs">
            review.view
          </span>{' '}
          ו־
          <span dir="ltr" className="font-mono text-xs">
            review.manage
          </span>{' '}
          קיימות בקטלוג ואין להן טבלה. <strong>שיעור המרה</strong> — אין מקור
          אנליטיקה. <strong>מיקום מול השוק</strong> — אין נתוני שוק.
        </PanelNote>
        <PanelNote>
          שלושתם מדווחים כ״לא ניתן למדוד״ ומשקלם אפס, כדי שלא יורידו ציון ולא
          יעלו אותו. ספירת התמונות נשענת על{' '}
          <span dir="ltr" className="font-mono text-xs">
            site_media
          </span>{' '}
          — עסק שלא בנה אתר יקבל אפס שם גם אם יש לו תמונות במקום אחר, וזה מדווח
          כפי שהוא ולא מוחלק.
        </PanelNote>
      </Panel>
    </ScreenFrame>
  )
}
