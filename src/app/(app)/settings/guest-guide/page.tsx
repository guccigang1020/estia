import type { Metadata } from 'next'

import { redirect } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { CompletenessReport } from '@/components/guest-guide/completeness-report'
import { EntryForm } from '@/components/guest-guide/entry-form'
import { PublishButton } from '@/components/guest-guide/publish-button'
import { RecommendationForm } from '@/components/guest-guide/recommendation-form'
import { RecommendationList } from '@/components/guest-guide/recommendation-list'
import { StagePanel } from '@/components/guest-guide/stage-panel'
import { DomainGap, GrantCode } from '@/components/shell-screens/domain-gap'
import {
  FactRow,
  Panel,
  PanelNote,
  ScreenFrame,
} from '@/components/shell-screens/screen'
import { toSafeResponse } from '@/lib/errors'
import {
  GUIDE_STATUS_LABEL,
  LANGUAGE_LABEL,
  STAGE_LABEL,
  STAGE_SUMMARY,
} from '@/lib/guest-guide/labels'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import { GUIDE_TABLES, loadGuideScreen, mayReadGuide } from './_lib/queries'

export const metadata: Metadata = { title: 'מדריך הנכס' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The property guide, per property.
 *
 * ══ WHAT THIS SCREEN NEVER PRINTS ══════════════════════════════════════════
 *
 * A door code, an alarm code, a lock-box location or a wi-fi password. Not
 * because the components are careful — because the values were never read.
 * `loadGuideScreen` asks the repository which entries HAVE a secret and never
 * what any of them is, so nothing in this page's serialised props contains
 * one. A screen that received the value and chose not to render it would still
 * have shipped it to the browser, where View Source finds it.
 *
 * The one reader of those values is the seam function described in this
 * module's report: SECURITY DEFINER, reached with a `bookings.guest_token`,
 * after a release decision. It is not in this codebase yet and it is not in
 * this file.
 *
 * ══ THE COMPLETENESS REPORT IS AT THE TOP, AND THAT IS THE FEATURE ═════════
 *
 * A guide with no wi-fi entry produces a message at 22:00 tonight, and the
 * only moment anybody can prevent it is while they are already looking at the
 * guide. So the first thing on the screen is what is missing — as sentences a
 * guest would say, never as a score. See `completeness.ts`.
 *
 * ══ THE TABLES MAY NOT EXIST YET ═══════════════════════════════════════════
 *
 * They are created by a migration this worker does not write. Until it runs
 * the screen renders `DomainGap` naming them — never an empty list, which
 * would tell a business the guide works and has nothing in it. The day the
 * migration runs this file lights up with no change.
 *
 * ══ ONE PROPERTY AT A TIME ═════════════════════════════════════════════════
 *
 * A guide belongs to a property — its door, its pool, its bins — and there is
 * no such thing as an organization's guide. So with the shell showing every
 * property this screen says so and asks for one, rather than merging four
 * houses' instructions into a list that would be wrong for all of them.
 *
 * GATING. `requireGrant('property.view')` refuses the route; `mayReadGuide`
 * checks the selected property again; row level security refuses regardless.
 */
export default async function GuestGuideSettingsPage() {
  const [actor, context] = await Promise.all([
    requireGrant('property.view'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') redirect('/dashboard')

  const lead =
    'התוכן שאורח רואה — לפני ההגעה, במהלך השהות ואחריה — ומתי כל פריט נחשף. ' +
    'קודים וסודות נשמרים בנפרד ואינם מוצגים במסך הזה.'

  if (context.selectedPropertyId === ALL_PROPERTIES) {
    return (
      <ScreenFrame title="מדריך הנכס" lead={lead} width="prose">
        <Panel
          title="בחר נכס"
          description="למדריך יש בעלים אחד: הנכס. אין מדריך לארגון."
        >
          {context.properties.length === 0 ? (
            <PanelNote>
              אין נכסים בהיקף שלך. מדריך נכתב לנכס מסוים, ולכן אין כאן מה להציג.
            </PanelNote>
          ) : (
            <PanelNote>
              בחר נכס בבורר שבראש המסך. הדלת, הבריכה והפחים של כל בית שונים,
              ומיזוג של ארבעה בתים לרשימה אחת היה שגוי עבור כולם.
            </PanelNote>
          )}
        </Panel>
      </ScreenFrame>
    )
  }

  const propertyId = context.selectedPropertyId

  if (!mayReadGuide(actor, context.actor.organizationId, propertyId)) {
    redirect('/dashboard')
  }

  let screen
  try {
    screen = await loadGuideScreen(
      await createClient(),
      actor,
      context.actor.organizationId,
      propertyId,
    )
  } catch (cause) {
    const safe = toSafeResponse(cause, crypto.randomUUID())
    return (
      <ScreenFrame title="מדריך הנכס" lead={lead}>
        <ActionError error={safe.error} />
      </ScreenFrame>
    )
  }

  if (screen.state === 'not_provisioned') {
    return (
      <ScreenFrame title="מדריך הנכס" lead={lead} width="prose">
        <DomainGap
          title="אחסון מדריך הנכס עדיין לא קיים במסד הנתונים"
          body={
            <p>
              המודול בנוי: הוא יודע לתאר ערך, לחשב מה חסר לפני שאורח ישאל,
              ולהחזיק קוד דלת בטבלה נפרדת שהמסך הזה אינו קורא כלל. מה שחסר הוא
              הטבלאות. עד שייווצרו המסך לא יציג רשימה ריקה, כי רשימה ריקה הייתה
              אומרת שהמדריך עובד ואין בו כלום.
            </p>
          }
          missingTables={GUIDE_TABLES}
          alreadyBuilt={[
            <>
              המודול <GrantCode>src/lib/guest-guide</GrantCode> על כל בדיקותיו
            </>,
            <>
              ההרשאות <GrantCode>property.view</GrantCode> ו-
              <GrantCode>property.update</GrantCode> ששומרות על המסך הזה
            </>,
            <>
              אוצר המילים <GrantCode>guide_release_mode</GrantCode>, שבעת הערכים
              הראשונים בו זהים ל-
              <GrantCode>guest_arrival_release</GrantCode> מ-0034
            </>,
            <>המסך הזה — הוא יתמלא ביום שבו ההגירה תרוץ, ללא שינוי קוד</>,
          ]}
        />
      </ScreenFrame>
    )
  }

  const view = screen.data

  return (
    <ScreenFrame
      title={
        view.propertyName === null
          ? 'מדריך הנכס'
          : `מדריך הנכס · ${view.propertyName}`
      }
      lead={lead}
      width="prose"
    >
      <Panel
        title="מה חסר"
        count={view.completeness.gaps.length}
        description="השאלות שאורחים ישאלו אם לא ייכתב כאן משהו. זו רשימה שנגמרת, לא ציון."
      >
        <CompletenessReport report={view.completeness} />
      </Panel>

      <Panel
        title="מצב הפרסום"
        description="אורח קורא גרסה שפורסמה. עריכה כאן אינה משנה מה אורח רואה עד לפרסום."
      >
        <dl>
          <FactRow label="מצב">
            {view.guide === null
              ? 'טרם נוצר מדריך לנכס הזה'
              : GUIDE_STATUS_LABEL[view.guide.status]}
          </FactRow>
          <FactRow label="שפות">
            {(view.guide?.languages ?? ['he'])
              .map((language) => LANGUAGE_LABEL[language])
              .join(', ')}
          </FactRow>
          <FactRow label="גרסאות שפורסמו">{view.versions.length}</FactRow>
          <FactRow label="הרשאת עריכה">
            {view.canEdit ? 'יש' : 'אין — צפייה בלבד'}
          </FactRow>
        </dl>

        {view.canEdit && view.guide !== null && (
          <div className="mt-5">
            <PublishButton
              propertyId={view.propertyId}
              expectedVersion={view.guide.version}
              languages={view.guide.languages}
              entryCount={view.stages.reduce(
                (total, stage) =>
                  total +
                  stage.entries.filter((entry) => entry.isActive).length,
                0,
              )}
              essentialGaps={view.completeness.counts.essential}
            />
          </div>
        )}
      </Panel>

      {view.stages.map((stage) => (
        <Panel
          key={stage.stage}
          title={STAGE_LABEL[stage.stage]}
          count={stage.entries.length}
          description={STAGE_SUMMARY[stage.stage]}
        >
          <StagePanel
            stage={stage.stage}
            entries={stage.entries}
            entryIdsWithSecret={view.entryIdsWithSecret}
            propertyId={view.propertyId}
            canEdit={view.canEdit}
          />
        </Panel>
      ))}

      {view.canEdit && (
        <Panel
          title="הוספת ערך"
          description="נושא, טקסט ומתי הוא נחשף. קוד או סוד מסומן כאן ומוזן בטופס נפרד לצד הערך עצמו."
        >
          <EntryForm propertyId={view.propertyId} entry={null} />
        </Panel>
      )}

      <Panel
        title="המלצות מקומיות"
        description="כל המלצה נכתבת על ידי בית האירוח או מצטטת גורם ששמו מופיע לצידה. אין כאן ייצור אוטומטי."
      >
        <RecommendationList
          groups={view.recommendations}
          citedSources={view.citedSources}
        />

        {view.canEdit && (
          <div className="mt-6 border-t border-border pt-6">
            <RecommendationForm propertyId={view.propertyId} />
          </div>
        )}
      </Panel>
    </ScreenFrame>
  )
}
