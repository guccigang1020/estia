import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { firstParam } from '@/app/(auth)/_lib/search-params'
import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { AutopilotEmptyState } from '@/components/autopilot/empty-state'
import { ConfidenceBadge } from '@/components/autopilot/confidence-badge'
import { EvidenceList } from '@/components/autopilot/evidence-list'
import {
  DISPOSITION_LABEL,
  OUTCOME_LABEL,
  RUN_MODE_LABEL,
  SAFETY_LEVEL_LABEL,
  SUPPRESSION_LABEL,
} from '@/components/autopilot/labels'
import { AutopilotPlanLock } from '@/components/autopilot/plan-lock'
import { formatMoment } from '@/components/autopilot/time'
import type { ActionView } from '@/components/autopilot/views'
import { ActionError } from '@/components/booking/action-error'
import { PanelNote, ScreenFrame } from '@/components/shell-screens/screen'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { createClient } from '@/lib/supabase/server'

import { AUTOPILOT_PAGE_SIZE, type AutopilotReadArgs } from '../_lib/reads'
import { settle } from '../_lib/settle'
import { requireActivityLog } from './_lib/access'
import {
  ACTIVITY_VIEWS,
  ACTIVITY_VIEW_LABEL,
  loadActivity,
  parseView,
} from './_lib/queries'

export const metadata: Metadata = { title: 'יומן ESTIA Autopilot' }

const VIEW_KEY = 'view'

const MODULE_INCLUDES = [
  'כל פעולה נרשמת עם השעה, הסיבה, האירוע שהפעיל אותה והעובדות שעליהן הסתמכה.',
  'גם פעולה שנמנעה נרשמת, עם הסיבה שבגללה נמנעה.',
  'הרישום אינו ניתן למחיקה — לא על ידי העסק ולא על ידי ESTIA.',
]

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Everything Autopilot has done.
 *
 * ── One question, answered on every row ──────────────────────────────────
 *
 * "למה ESTIA עשתה את זה?" Every row answers it from `reason` and `evidence` as
 * they were STORED, at the moment the decision was made. Nothing on this
 * screen joins back to the booking, the task or the payment to explain itself,
 * and that is not laziness: an action taken about a booking that has since
 * been cancelled must still say what it said at the time, or the log is a
 * record of what ESTIA would say today rather than of what it did.
 *
 * ── Nine facts per row, and each is a column ─────────────────────────────
 *
 * Time (`created_at` / `executed_at`), action (`action_kind` through the
 * catalogue), reason (`reason`), trigger (`trigger_event`), evidence
 * (`evidence`), mode (`run_mode`), approval (`approved_by` / `approved_at`),
 * result (`outcome`, with `suppressed_reason` or `error_code`), and the
 * affected entity (`property_id`, `exception_id`, `command`).
 *
 * ── Refusals are first-class ─────────────────────────────────────────────
 *
 * A log showing only successes would show an empty screen to the customer most
 * worried about what Autopilot might do. `suppressed`, `simulated` and
 * `cancelled` are rows here and their reason is printed in words — 0046 says a
 * refusal with no reason attached is the fastest way to lose a customer's
 * trust, and a blank cell is a refusal with no reason attached.
 *
 * ── The grant is `autopilot.activity_view` ───────────────────────────────
 *
 * Not `autopilot.view`. See `_lib/access.ts` for why gating on the wrong one
 * would render as "ESTIA has never done anything" rather than as a refusal.
 */
export default async function AutopilotActivityPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [access, params] = await Promise.all([
    requireActivityLog(),
    searchParams,
  ])
  const { actor, organizationId, propertyId, propertyName } = access

  const view = parseView(firstParam(params[VIEW_KEY]))

  const db = await createClient()
  const args: AutopilotReadArgs = { db, actor, organizationId, propertyId }

  const actions = await settle(() => loadActivity(args, view))
  const rows = actions.ok ? actions.value : []

  return (
    <ScreenFrame
      title="יומן ESTIA Autopilot"
      lead={
        propertyName
          ? `כל פעולה ש־ESTIA תיכננה ב״${propertyName}״ — כולל אלה שנמנעו — עם הסיבה שנרשמה באותו רגע.`
          : 'כל פעולה ש־ESTIA תיכננה — כולל אלה שנמנעו — עם הסיבה שנרשמה באותו רגע.'
      }
      banner={
        access.kind === 'allow' ? (
          <div className="flex flex-wrap items-center gap-2">
            {ACTIVITY_VIEWS.map((option) => (
              <Button
                key={option}
                href={
                  option === 'all'
                    ? '/autopilot/activity'
                    : `/autopilot/activity?view=${option}`
                }
                variant={option === view ? 'primary' : 'ghost'}
                size="sm"
              >
                {ACTIVITY_VIEW_LABEL[option]}
              </Button>
            ))}
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
      ) : !actions.ok ? (
        <ActionError error={actions.error} />
      ) : rows.length === 0 ? (
        <AutopilotEmptyState
          tone="calm"
          title={
            view === 'all' ? 'ESTIA עוד לא עשתה דבר' : 'אין רשומות בתצוגה הזו'
          }
          body={
            view === 'all'
              ? 'היומן ריק. זה המצב הנכון לעסק ש־Autopilot כבויה אצלו, או שנמצאת בסימולציה ועוד לא זיהתה דבר — ומסך ההגדרות אומר באיזה מהם מדובר.'
              : 'אין פעולות שעונות על הסינון הזה. תצוגת ״הכול״ מראה גם פעולות שנמנעו וגם סימולציות.'
          }
          action={
            <div className="flex flex-wrap gap-3">
              <Button href="/autopilot/settings" variant="secondary">
                מצב Autopilot והגדרות
              </Button>
              {view !== 'all' && (
                <Button href="/autopilot/activity" variant="ghost">
                  להצגת הכול
                </Button>
              )}
            </div>
          }
        />
      ) : (
        <>
          {rows.length >= AUTOPILOT_PAGE_SIZE && (
            <PanelNote tone="attention">
              מוצגות {AUTOPILOT_PAGE_SIZE} הרשומות האחרונות. צמצום לנכס אחד או
              לתצוגה צרה יותר יראה רשומות ישנות יותר.
            </PanelNote>
          )}

          <ul className="flex flex-col gap-3">
            {rows.map((action) => (
              <li key={action.id}>
                <ActivityRow action={action} />
              </li>
            ))}
          </ul>
        </>
      )}
    </ScreenFrame>
  )
}

/**
 * One row, and the question it has to answer.
 *
 * The reason is above the fold and the evidence is one click away, because the
 * reason is what somebody wants at 08:00 and the evidence is what they want
 * when they disagree with it.
 */
function ActivityRow({ action }: { action: ActionView }) {
  const happened = formatMoment(action.executedAt ?? action.createdAt)

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5">
      <header className="flex flex-wrap items-center gap-2">
        <span dir="ltr" className="text-xs tabular-nums text-muted-foreground">
          {happened ?? '—'}
        </span>
        <span className="font-medium text-foreground">{action.kindLabel}</span>
        <Badge tone="neutral">{OUTCOME_LABEL[action.outcome]}</Badge>
        {action.runMode === 'simulation' && (
          <Badge tone="accent">{RUN_MODE_LABEL.simulation}</Badge>
        )}
        <ConfidenceBadge confidence={action.confidence} />
        {action.propertyName !== null && (
          <span className="text-xs text-muted-foreground">
            {action.propertyName}
          </span>
        )}
      </header>

      <p className="text-sm leading-relaxed text-foreground">{action.reason}</p>

      {action.outcome === 'suppressed' && (
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          נמנעה:{' '}
          {action.suppressedReason === null
            ? (action.suppressedText ?? 'לא נרשמה סיבה')
            : SUPPRESSION_LABEL[action.suppressedReason]}
        </p>
      )}

      {action.outcome === 'failed' && (
        <p
          // A failure is the one thing on this screen somebody is waiting to
          // be told about, so it announces itself.
          role="alert"
          className="rounded-md border border-danger px-3 py-2 text-xs text-danger"
        >
          נכשלה
          {action.errorCode !== null && (
            <>
              {' — '}
              <span dir="ltr">{action.errorCode}</span>
            </>
          )}
          {action.errorDetail !== null && <> · {action.errorDetail}</>}
          {action.attempt > 1 && <> · ניסיון {action.attempt}</>}
        </p>
      )}

      {action.outcome === 'executed_unaudited' && (
        <p
          role="alert"
          className="rounded-md border border-danger px-3 py-2 text-xs text-danger"
        >
          הפעולה בוצעה במציאות והרישום שלה נכשל. אין כאן טעות בניסוח: העבודה
          קרתה, התיעוד לא, ושתי החלופות האחרות היו שקר.
        </p>
      )}

      <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <Fact label="מה הפעיל את זה">
          {action.triggerEvent === null ? (
            <span className="text-muted-foreground">
              לא אירוע — סריקה יזומה של ESTIA
            </span>
          ) : (
            <span dir="ltr">{action.triggerEvent}</span>
          )}
        </Fact>
        <Fact label="מצב הרצה">
          {RUN_MODE_LABEL[action.runMode]} ·{' '}
          {DISPOSITION_LABEL[action.disposition]}
        </Fact>
        <Fact label="רמת סיכון">{SAFETY_LEVEL_LABEL[action.safetyLevel]}</Fact>
        <Fact label="אישור">
          {action.approvedAt === null ? (
            <span className="text-muted-foreground">לא נדרש אישור אדם</span>
          ) : (
            <>
              {action.approvedByName ?? 'אושר'} ·{' '}
              {formatMoment(action.approvedAt)}
            </>
          )}
        </Fact>
        <Fact label="מה בוצע בפועל">
          {action.command === null ? (
            <span className="text-muted-foreground">
              נשאר בתוך ESTIA — לא נגע בשום רשומה עסקית
            </span>
          ) : (
            <span dir="ltr">{action.command}</span>
          )}
        </Fact>
        <Fact label="נוגע ל־">
          {action.exceptionId === null ? (
            <span className="text-muted-foreground">לא קשור לחריגה</span>
          ) : (
            <Link
              href="/autopilot/exceptions?state=all"
              className="underline hover:no-underline"
            >
              חריגה מקושרת
            </Link>
          )}
        </Fact>
      </dl>

      <details>
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
          למה ESTIA עשתה את זה — העובדות שנשמרו
        </summary>
        <div className="mt-3">
          <EvidenceList
            items={action.evidence}
            emptyNote="לא נשמרו עובדות תומכות לשורה הזו. הסיבה למעלה היא כל מה שנרשם."
          />
        </div>
      </details>

      {action.undoneAt !== null && (
        <p className="text-xs text-muted-foreground">
          בוטלה בדיעבד ב־{formatMoment(action.undoneAt)}. השורה נשארת — רישום של
          מה ש־ESTIA עשתה אינו נמחק.
        </p>
      )}
    </article>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </div>
  )
}
