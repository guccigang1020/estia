import type { Metadata } from 'next'

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import {
  CaseEvidenceList,
  InspectionComparison,
} from '@/components/incidents/case-evidence'
import {
  CaseCosts,
  CaseDecisions,
  SettlementPreview,
} from '@/components/incidents/case-money'
import { CaseWorkflowControls } from '@/components/incidents/case-workflow'
import { LiabilityDecisionForm } from '@/components/incidents/liability-form'
import { DomainGap, GrantCode } from '@/components/shell-screens/domain-gap'
import {
  FactRow,
  Panel,
  PanelNote,
  ScreenFrame,
  Withheld,
} from '@/components/shell-screens/screen'
import { Badge } from '@/components/ui/badge'
import { toSafeResponse } from '@/lib/errors'
import {
  INCIDENT_CASE_STATUS_LABEL,
  INCIDENT_CASE_TYPE_LABEL,
  INCIDENT_ORIGIN_LABEL,
  QUESTION_AUDIENCE_LABEL,
  checkTransition,
  isAnswered,
} from '@/lib/incidents'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../../_lib/context'
import { requireGrant } from '../../../_lib/guard'
import { CASE_TABLES, loadCaseDetail } from '../_lib/queries'

export const metadata: Metadata = { title: 'תיק נזק' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. One case: what happened, what it cost,
 * and who decided.
 *
 * ── The order of the panels is the argument ───────────────────────────────
 *
 * Facts, then evidence, then the comparison, then the money, then the
 * decision. In that order and never the other way round, because the decision
 * panel is where a person commits their name to a judgement about somebody
 * else's money, and everything above it is what they are supposed to have read
 * first. A screen that opened with "charge the guest ₪1,410?" and offered the
 * evidence below it would be a screen that makes the default the answer.
 *
 * ── What the comparison panel is allowed to say ───────────────────────────
 *
 * Differences. Never a conclusion, never a colour that means guilt, never a
 * suggested amount. `src/lib/incidents/liability.ts` makes a decision
 * impossible to produce from a comparison; this screen is where that rule is
 * either honoured or quietly undone, and it is honoured.
 *
 * GATING. `requireGrant('incident.view')` refuses the route. `_lib/queries.ts`
 * checks the same grant again against the property this case names, and treats
 * an unreachable case as absent rather than refused — "you may not see case
 * 4131" confirms that case 4131 exists. Money is behind `expense.view` and the
 * deposit behind `payment.view`, both asked separately. Row level security
 * refuses regardless of all of it.
 */
export default async function CasePage({
  params,
}: {
  params: Promise<{ caseId: string }>
}) {
  const [actor, context, { caseId }] = await Promise.all([
    requireGrant('incident.view'),
    shellContext(),
    params,
  ])

  if (!context || context.status !== 'ready') return null

  let screen
  try {
    screen = await loadCaseDetail({
      db: await createClient(),
      actor,
      organizationId: context.workspace.organizationId,
      caseId,
    })
  } catch (cause) {
    const safe = toSafeResponse(cause, crypto.randomUUID())
    return (
      <ScreenFrame title="תיק נזק" lead="">
        <ActionError error={safe.error} />
      </ScreenFrame>
    )
  }

  if (screen.state === 'not_provisioned') {
    return (
      <ScreenFrame
        title="תיק נזק"
        lead="הראיות, העלויות וההכרעה בתיק אחד."
        width="prose"
      >
        <DomainGap
          title="אחסון תיקי הנזק עדיין לא קיים במסד הנתונים"
          body={
            <p>
              אין עדיין טבלאות שבהן תיק כזה יכול להתקיים, ולכן אין תיק להציג.
              אין משמעות הדבר שהתיק הזה נמחק או שאינך רשאי לראותו.
            </p>
          }
          missingTables={CASE_TABLES}
          alreadyBuilt={[
            <>המסך הזה, על שלושת המסלולים שלו: ראיות, כסף והכרעה</>,
            <>
              ההרשאה <GrantCode>incident.resolve</GrantCode>, שהיא מה שמפריד בין
              מי שמטפל בתיק לבין מי שמכריע בו
            </>,
          ]}
        />
      </ScreenFrame>
    )
  }

  const detail = screen.data
  // Absent rather than refused: a refusal that names the case confirms it
  // exists, which is a disclosure in itself.
  if (detail === null) notFound()

  const { file, facts, money } = detail
  const { incident } = file
  const openQuestions = file.questions.filter(
    (question) => !isAnswered(question),
  )
  const closeCheck = checkTransition(facts, 'closed')
  const currentDecision = file.decisions[0] ?? null

  return (
    <ScreenFrame
      title={incident.title}
      lead={`${INCIDENT_CASE_TYPE_LABEL[incident.caseType]} · נמצא ב${INCIDENT_ORIGIN_LABEL[incident.origin]}`}
      banner={
        <nav aria-label="פירורי לחם" className="text-sm">
          <Link
            href="/incidents/cases"
            className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            ← לרשימת תיקי הנזק
          </Link>
        </nav>
      }
    >
      {/* ─────────────────────────────────────────────────────── the facts */}
      <Panel
        title="התיק"
        description="מה קרה, איפה, ומאיזו בדיקה או דיווח זה הגיע."
        action={
          <Badge tone="accent">
            {INCIDENT_CASE_STATUS_LABEL[incident.status]}
          </Badge>
        }
      >
        <dl className="flex flex-col">
          <FactRow label="סוג">
            {INCIDENT_CASE_TYPE_LABEL[incident.caseType]}
          </FactRow>
          <FactRow label="מקור">
            {INCIDENT_ORIGIN_LABEL[incident.origin]}
          </FactRow>
          <FactRow label="הזמנה">
            {incident.bookingId === null ? (
              'אין הזמנה קשורה'
            ) : detail.maySeeBooking ? (
              <Link
                href={`/bookings/${incident.bookingId}`}
                className="text-primary underline-offset-4 hover:underline"
                dir="ltr"
              >
                {incident.bookingId}
              </Link>
            ) : (
              // The stay is withheld without `booking.view`, and no guest name
              // is read on this screen at all.
              <Withheld />
            )}
          </FactRow>
          <FactRow label="דיווח התקלה">
            {incident.taskId === null ? (
              'נפתח ישירות'
            ) : (
              <Link
                href="/incidents"
                className="text-primary underline-offset-4 hover:underline"
              >
                נפתח מדיווח תקלה
              </Link>
            )}
          </FactRow>
        </dl>

        {incident.description !== null && (
          <p className="mt-4 max-w-prose text-sm text-foreground">
            {incident.description}
          </p>
        )}
      </Panel>

      {/* ──────────────────────────────────────────────── open questions */}
      <Panel
        title="שאלות פתוחות"
        count={openQuestions.length}
        description="שאלה שנשאלה ולא נענתה. תיק לא ייסגר כל עוד יש כזו — כדי ש״חיכינו לתשובה מהאורח״ ישרוד את מי שחיכה."
      >
        {file.questions.length === 0 ? (
          <PanelNote>לא נשאלה שאלה בתיק הזה.</PanelNote>
        ) : (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {file.questions.map((question) => (
              <li key={question.id} className="flex flex-col gap-1 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium text-foreground">
                    {question.question}
                  </span>
                  <Badge tone={isAnswered(question) ? 'neutral' : 'accent'}>
                    {QUESTION_AUDIENCE_LABEL[question.audience]}
                    {isAnswered(question) ? ' · נענה' : ' · ממתין'}
                  </Badge>
                </div>
                {question.answer !== null && (
                  <blockquote className="border-s-2 border-border ps-3 text-muted-foreground">
                    {question.answer}
                  </blockquote>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* ─────────────────────────────────────────────────────── evidence */}
      <Panel
        title="ראיות"
        count={detail.evidence.total}
        description="הפניות לקבצים והצהרות. הקובץ עצמו נשמר באחסון ולא כאן, וההפניה נושאת את מי צירף אותה ומתי."
      >
        <CaseEvidenceList evidence={file.evidence} tally={detail.evidence} />
      </Panel>

      {/* ────────────────────────────────────────────────── the comparison */}
      <Panel
        title="השוואת בדיקות"
        description="מה נראה אחרת בין בדיקה לבדיקה. הפרשים בלבד — לא מסקנות, לא אשמה ולא סכום."
      >
        <InspectionComparison steps={detail.comparison} />
      </Panel>

      {/* ────────────────────────────────────────────────────────── money */}
      <Panel
        title="עלויות"
        description="הערכה, הצעת מחיר וחשבונית הם שלושה מספרים שונים, וכל ויכוח על פיקדון הוא ויכוח על איזה מהם מוצג."
      >
        <CaseCosts lines={file.costLines} money={money} />
      </Panel>

      {/* ────────────────────────────────────────────────────── settlement */}
      {detail.maySeeDeposit && (
        <Panel
          title="פיקדון והסדר"
          description="מה היה קורה לפיקדון אילו ההכרעה הייתה מיושמת. חישוב בלבד — הכסף עצמו זז במסלול התשלומים."
        >
          {currentDecision === null ? (
            <PanelNote>
              אין עדיין הכרעה, ולכן אין מה להסדיר. החישוב יופיע כאן ברגע שאדם
              יכריע מי נושא בעלות.
            </PanelNote>
          ) : detail.depositHeldAgorot === null ? (
            <PanelNote>
              סכום ההכרעה על האורח הוא{' '}
              {money === null ? (
                <Withheld />
              ) : (
                <strong>{currentDecision.guestChargeAgorot} אגורות</strong>
              )}
              . כמה פיקדון מוחזק כנגד השהות הזו נקרא ממודול התשלומים, והקריאה
              הזו עדיין אינה קיימת — ולכן המסך אומר זאת במקום להציג ״0״, שהיה
              אומר בטעות שאין ממה לגבות.
            </PanelNote>
          ) : (
            <SettlementPreview
              guestChargeAgorot={currentDecision.guestChargeAgorot}
              depositHeldAgorot={detail.depositHeldAgorot}
            />
          )}
        </Panel>
      )}

      {/* ─────────────────────────────────────────────────────── decision */}
      <Panel
        title="הכרעת אחריות"
        description="מי נושא בעלות, על סמך מה, ומי הכריע. הכרעה נרשמת על שם אדם — תהליך אוטומטי או השוואת תמונות אינם יכולים לקבוע אותה."
      >
        <div className="flex flex-col gap-6">
          <CaseDecisions
            decisions={file.decisions}
            mayReadMoney={money !== null}
          />

          {detail.mayDecide && incident.status !== 'closed' ? (
            <div className="border-t border-border pt-6">
              <h3 className="mb-4 font-display text-base font-bold text-foreground">
                {currentDecision ? 'החלף את ההכרעה' : 'רשום הכרעה'}
              </h3>
              <LiabilityDecisionForm
                caseId={incident.id}
                assessedAgorot={money?.assessedAgorot ?? 0}
                supersedesDecisionId={currentDecision?.id ?? null}
                evidenceIds={file.evidence.map((item) => item.id)}
              />
            </div>
          ) : (
            !detail.mayDecide && (
              <PanelNote>
                ההרשאה שלך כוללת טיפול בתיק ולא הכרעה בו. הכרעת אחריות דורשת{' '}
                <span dir="ltr" className="font-mono text-xs">
                  incident.resolve
                </span>
                .
              </PanelNote>
            )
          )}
        </div>
      </Panel>

      {/* ─────────────────────────────────────────────────────── workflow */}
      <Panel
        title="מצב התיק"
        description="לאן אפשר להעביר את התיק מכאן, ומה מונע את סגירתו."
      >
        <CaseWorkflowControls
          caseId={incident.id}
          status={incident.status}
          available={detail.available}
          mayWork={detail.mayWork}
          mayClose={detail.mayDecide}
          // The server's own refusal sentence, so a crafted request produces
          // exactly the text the reader was already shown.
          closeRefusal={closeCheck.ok ? null : closeCheck.message}
        />
      </Panel>
    </ScreenFrame>
  )
}
