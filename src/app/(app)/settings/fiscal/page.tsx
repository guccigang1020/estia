import type { Metadata } from 'next'

import { redirect } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { DocumentList } from '@/components/fiscal/document-list'
import { ProviderStatus } from '@/components/fiscal/provider-status'
import { ReconciliationSummary } from '@/components/fiscal/reconciliation-summary'
import { DomainGap, GrantCode } from '@/components/shell-screens/domain-gap'
import {
  Panel,
  PanelNote,
  ScreenFrame,
} from '@/components/shell-screens/screen'
import { toSafeResponse } from '@/lib/errors'
import { FISCAL_STATUS_LABEL } from '@/lib/fiscal'
import { formatAgorot } from '@/lib/plans/plan'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import { FISCAL_TABLES, loadFiscalScreen } from './_lib/queries'

export const metadata: Metadata = { title: 'מסמכים חשבונאיים' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The accounting connection, and what it
 * has and has not produced.
 *
 * ══ THIS SCREEN IS FOR A BUSINESS WITH NO VENDOR CONNECTED ═════════════════
 *
 * Which is every business using this product today, and most of them
 * permanently: an Israeli guesthouse issues its documents in its accountant's
 * system and has no intention of moving. So "not connected" renders as a plain
 * fact with an explanation, not as a setup step somebody failed. The screen is
 * complete in that state.
 *
 * ══ THE §148 PANEL IS THE REASON THE SCREEN EXISTS ═════════════════════════
 *
 * A payment can be recorded and its accounting document still missing, and
 * that pair is not an error — it is the ordinary consequence of two separate
 * systems. The second panel is that queue: money that arrived whose paperwork
 * did not follow. It shows a sum in agorot and a count, never a percentage and
 * never a health score, because every row on it is a document somebody has to
 * go and produce.
 *
 * ══ WHAT THIS SCREEN NEVER PRINTS ══════════════════════════════════════════
 *
 * A document number ESTIA made up. `DocumentList` prints the provider's number
 * or the sentence "טרם התקבל מספר מסמך מהספק", and there is no third branch —
 * the domain refuses to describe a document as issued without a number, and
 * the component has no way to override it.
 *
 * ══ THE TABLES MAY NOT EXIST YET ═══════════════════════════════════════════
 *
 * They are created by a migration this worker does not write. Until it runs,
 * the screen renders `DomainGap` naming them — never an empty list, which
 * would tell a business the capability works and has produced nothing.
 *
 * GATING. `requireGrant('invoice.view')` refuses the route; the same grant is
 * checked per row against the property in `_lib/queries.ts`; row level
 * security refuses regardless of both.
 */
export default async function FiscalSettingsPage() {
  const [actor, context] = await Promise.all([
    requireGrant('invoice.view'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') redirect('/dashboard')

  let screen
  try {
    screen = await loadFiscalScreen(
      await createClient(),
      actor,
      context.actor.organizationId,
    )
  } catch (cause) {
    const safe = toSafeResponse(cause, crypto.randomUUID())
    return (
      <ScreenFrame title="מסמכים חשבונאיים" lead="">
        <ActionError error={safe.error} />
      </ScreenFrame>
    )
  }

  if (screen.state === 'not_provisioned') {
    return (
      <ScreenFrame
        title="מסמכים חשבונאיים"
        lead="החיבור למערכת הפקת המסמכים, והמסמכים שהופקו דרכו."
        width="prose"
      >
        <DomainGap
          title="אחסון המסמכים החשבונאיים עדיין לא קיים במסד הנתונים"
          body={
            <p>
              מודול המסמכים החשבונאיים בנוי — הוא יודע לתאר מסמך, לסרב ביושר
              כשאין ספק מחובר, ולהפריד בין מצב התשלום למצב המסמך. מה שחסר הוא
              הטבלאות עצמן. עד שהן ייווצרו המסך לא יציג רשימה ריקה, כי רשימה
              ריקה הייתה אומרת שהיכולת עובדת ואין בה כלום.
            </p>
          }
          missingTables={FISCAL_TABLES}
          alreadyBuilt={[
            <>
              המודול <GrantCode>src/lib/fiscal</GrantCode> על כל בדיקותיו
            </>,
            <>
              ההרשאה <GrantCode>invoice.view</GrantCode> שכבר שומרת על המסך הזה
            </>,
            <>המסך הזה — הוא יתמלא ביום שבו ההגירה תרוץ, ללא שינוי קוד</>,
          ]}
        />
      </ScreenFrame>
    )
  }

  const view = screen.data
  const now = new Date()

  return (
    <ScreenFrame
      title="מסמכים חשבונאיים"
      lead="החיבור למערכת הפקת המסמכים, ומה הופק דרכו בפועל. מצב התשלום ומצב המסמך הם שני דברים נפרדים, וכך הם מוצגים."
      width="prose"
    >
      <Panel
        title="החיבור"
        description="לאיזו מערכת הפקת מסמכים החשבון מחובר, ומה היא יודעת לעשות."
      >
        <ProviderStatus
          provider={view.provider.provider}
          documentsExpected={view.provider.documentsExpected}
          capabilities={view.provider.capabilities}
          connectedAt={view.provider.connectedAt}
        />
      </Panel>

      <Panel
        title="ממתינים לטיפול"
        count={view.needsPerson.length}
        description={
          view.needsPerson.length === 0
            ? 'מסמכים שההפקה שלהם נכשלה, סורבה או שאינה ידועה.'
            : `כסף שנרשם ושהמסמך החשבונאי עבורו עדיין לא הופק: ${formatAgorot(view.pendingAgorot)}.`
        }
      >
        {view.needsPerson.length === 0 ? (
          <PanelNote>
            אין כרגע מסמך שדורש טיפול. התשלומים עצמם מוצגים במסך הכספים.
          </PanelNote>
        ) : (
          <DocumentList items={view.needsPerson} now={now} />
        )}
      </Panel>

      <Panel
        title="כל המסמכים"
        count={view.documents.length}
        description="הרישומים שהמערכת מחזיקה על מסמכים שהופקו אצל הספק. המספר והמסמך עצמם שייכים לספק."
      >
        {view.documents.length === 0 ? (
          <PanelNote>
            טרם נרשם מסמך חשבונאי בחשבון הזה.
            {view.provider.documentsExpected
              ? ''
              : ' זהו מצב תקין לעסק שמפיק את מסמכיו במערכת הנהלת החשבונות שלו.'}
          </PanelNote>
        ) : (
          <>
            <DocumentList items={view.documents} now={now} />
            <dl className="mt-5 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
              {Object.entries(view.counts)
                .filter(([, count]) => count > 0)
                .map(([status, count]) => (
                  <div key={status} className="flex gap-2">
                    <dt>
                      {
                        FISCAL_STATUS_LABEL[
                          status as keyof typeof FISCAL_STATUS_LABEL
                        ]
                      }
                    </dt>
                    <dd className="tabular-nums">{count}</dd>
                  </div>
                ))}
            </dl>
          </>
        )}
      </Panel>

      <Panel
        title="השוואה מול הספק"
        description="השוואה בין מה שרשום כאן לבין רשימת המסמכים אצל הספק. היא מדווחת על הפרשים ואינה מתקנת דבר בעצמה."
      >
        {view.lastRun === null ? (
          <PanelNote>
            טרם בוצעה השוואה. ללא ספק מחובר אין למי לפנות, ולכן זהו מצב צפוי.
          </PanelNote>
        ) : (
          <ReconciliationSummary
            provider={view.lastRun.provider}
            from={view.lastRun.from}
            to={view.lastRun.to}
            ranAt={view.lastRun.ranAt}
            differenceCount={view.lastRun.differenceCount}
            differenceAgorot={view.lastRun.differenceAgorot}
            refusalReason={view.lastRun.refusalReason}
          />
        )}
      </Panel>
    </ScreenFrame>
  )
}
