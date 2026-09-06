import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { ActionApprovalCard } from '@/components/autopilot/action-approval-card'
import { AutopilotEmptyState } from '@/components/autopilot/empty-state'
import { ExceptionCard } from '@/components/autopilot/exception-card'
import { AutopilotPlanLock } from '@/components/autopilot/plan-lock'
import {
  DOMAIN_LABEL,
  LEVEL_LABEL,
  OUTCOME_LABEL,
  RISK_LABEL,
  RUN_MODE_LABEL,
  SUPPRESSION_LABEL,
} from '@/components/autopilot/labels'
import { formatMoment } from '@/components/autopilot/time'
import {
  Panel,
  PanelNote,
  Row,
  RowList,
  ScreenFrame,
  Withheld,
} from '@/components/shell-screens/screen'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { formatDayMonth } from '@/lib/booking/dates'
import { formatAgorot } from '@/lib/plans/plan'
import { createClient } from '@/lib/supabase/server'

import { requireAutopilotView } from './_lib/access'
import { groupByRootCause } from './_lib/incidents'
import {
  headerStrip,
  listOpenBalances,
  listStaysToday,
  propertyToday,
  stayArgs,
} from './_lib/queries'
import {
  listActions,
  listExceptions,
  loadCapability,
  loadSettings,
  type AutopilotReadArgs,
} from './_lib/reads'
import { settle } from './_lib/settle'
import { needsAttention, triage } from './_lib/triage'

export const metadata: Metadata = { title: 'ESTIA Autopilot' }

/** What ESTIA would do, in a guesthouse's own words. For the plan lock. */
const MODULE_INCLUDES = [
  'המכבסה מאחרת — ESTIA יודעת שזה יגרום לחוסר במצעים לפני שהחוסר קורה, ומראה את זה כתקלה אחת ולא כארבע.',
  'אורח מגיע היום ולא שילם את היתרה — התזכורת מוכנה, עם הסכום, ומחכה לאישור.',
  'ניקיון לא התחיל והכניסה בעוד שעה — ההסלמה מגיעה לאחראי, לא לרשימת משימות.',
  'כל פעולה נרשמת עם הסיבה והעובדות שעליהן הסתמכה, כך שאפשר לשאול ״למה ESTIA עשתה את זה״ ולקבל תשובה.',
  'רמת האוטומציה נבחרת על ידך, פעולה אחר פעולה, ואפשר לעצור הכול בכפתור אחד.',
]

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Autopilot's command centre.
 *
 * ── What is on this screen ───────────────────────────────────────────────
 *
 * Five sections in the order a person needs them, and the order is the whole
 * argument: what needs a decision from you, what is going wrong, what is being
 * dealt with, what could earn money, and — last, because it is reassurance
 * rather than work — what ESTIA already handled.
 *
 * A revenue tile is not here and neither is an occupancy percentage.
 * `dashboard/page.tsx` refuses to open with numbers and explains why; the four
 * figures across the top are the length of a list underneath them (arrivals,
 * departures, properties named by an at-risk exception) or the domain's own
 * sum (what today's stays still owe). None of them is a statistic somebody
 * would repeat to their accountant.
 *
 * ── The empty state is the screen, not the absence of one ────────────────
 *
 * On a calm morning this page must not be blank. Blank is ambiguous in the
 * worst direction: it reads identically whether the business is fine, the
 * detectors have not run, Autopilot is switched off, or a query failed. So
 * when nothing needs attention the screen says "הכול בשליטה ✓" and then shows
 * what makes that true — today's arrivals, what ESTIA handled, and what it is
 * watching. A claim with its evidence under it, exactly as everywhere else.
 *
 * ── Gating, in four places, and none of them is the menu ─────────────────
 *
 * `requireAutopilotView` refuses the route, or renders the plan offer for a
 * customer whose package does not carry the add-on — which is most of them, by
 * design, because 0046 forbids putting `autopilot` on a plan. Each read asks
 * `holdsGrant` for its own grant: the exceptions need `autopilot.view` and the
 * prepared actions need `autopilot.activity_view`, which is a different and
 * larger authority, so a reader with only the first gets exceptions and an
 * honest sentence where the actions would be. Each row is checked again with
 * `can()` against the property it names. And row level security refuses
 * regardless of all three.
 *
 * ── One failure does not blank the board ─────────────────────────────────
 *
 * The six reads settle independently and a failure renders inside its own
 * section. A section that failed must never look like a section with nothing
 * to do — see `_lib/settle.ts`.
 *
 * ── Nothing here decides anything ────────────────────────────────────────
 *
 * The sections come from `triage()`, which reads stored enums and no clock.
 * The grouping comes from `groupByRootCause()`, which follows `caused_by`. No
 * risk is inferred, no readiness computed, no action authorised. This file
 * chooses headings and order.
 */
export default async function AutopilotPage() {
  const access = await requireAutopilotView()
  const { actor, organizationId, propertyId, propertyName } = access

  const mayReachBilling = holdsGrant(actor, 'organization.billing.manage')
  const mayReadActivity = holdsGrant(actor, 'autopilot.activity_view')

  const today = propertyToday()
  const db = await createClient()
  const args: AutopilotReadArgs = {
    db,
    actor,
    organizationId,
    propertyId,
  }

  const [settings, capability, exceptions, actions, stays] = await Promise.all([
    settle(() => loadSettings(args)),
    settle(() => loadCapability(args)),
    settle(() => listExceptions(args)),
    settle(() => listActions(args, { since: `${today}T00:00:00Z` })),
    settle(() => listStaysToday(stayArgs(args, today))),
  ])

  const balances = await settle(() =>
    listOpenBalances(stayArgs(args, today), stays.ok ? stays.value : []),
  )

  const openExceptions = exceptions.ok ? exceptions.value : []
  const todaysActions = actions.ok ? actions.value : []
  const board = triage(openExceptions, todaysActions)
  const strip = headerStrip(
    stays.ok ? stays.value : [],
    balances.ok ? balances.value : null,
    openExceptions,
  )

  const calm =
    !needsAttention(board) && exceptions.ok && (actions.ok || !mayReadActivity)

  return (
    <ScreenFrame
      title="ESTIA Autopilot"
      lead={
        propertyName
          ? `מה שדורש אותך היום ב״${propertyName}״, ומה ש־ESTIA כבר טיפלה בו.`
          : 'מה שדורש אותך היום בכל הנכסים שבטווח שלך, ומה ש־ESTIA כבר טיפלה בו.'
      }
      banner={
        access.kind === 'allow' ? (
          <StatusStrip
            today={today}
            strip={strip}
            level={settings.ok ? LEVEL_LABEL[settings.value.level] : null}
            runMode={settings.ok ? settings.value.runMode : null}
            enabled={settings.ok ? settings.value.enabled : null}
            pausedUntil={settings.ok ? settings.value.pausedUntil : null}
            configured={settings.ok ? settings.value.configured : null}
            trialEndsAt={capability.ok ? capability.value.trialEndsAt : null}
          />
        ) : undefined
      }
    >
      {access.kind === 'locked' ? (
        <AutopilotPlanLock
          entitlement={access.entitlement}
          includes={MODULE_INCLUDES}
          mayReachBilling={mayReachBilling}
          platformNote={capability.ok ? capability.value.note : null}
        />
      ) : (
        <>
          {calm && (
            <AutopilotEmptyState
              tone="calm"
              title="הכול בשליטה ✓"
              body="אין כרגע דבר שדורש החלטה, ואין חריגה פתוחה שהמערכת סימנה כבעייתית. מה שמופיע למטה הוא מה שהופך את המשפט הזה לבדיק."
              action={
                <div className="flex flex-wrap gap-3">
                  <Button href="/autopilot/exceptions" variant="secondary">
                    מרכז החריגות
                  </Button>
                  {mayReadActivity && (
                    <Button href="/autopilot/activity" variant="ghost">
                      יומן הפעילות
                    </Button>
                  )}
                </div>
              }
            />
          )}

          {/* ── 1 · needs you ───────────────────────────────────────────── */}
          <Panel
            title="דורש החלטה ממך"
            description="פעולות ש־ESTIA הכינה ומחכות לאדם. הסיבה והעובדות נשמרו ברגע ההחלטה ולא מחושבות מחדש עכשיו."
            count={actions.ok ? board.decisions.length : undefined}
          >
            {!mayReadActivity ? (
              <PanelNote>
                צפייה בפעולות ש־ESTIA הכינה דורשת הרשאת{' '}
                <span dir="ltr">autopilot.activity_view</span>, שאינה ברשותך.
                החריגות עצמן מוצגות למטה.
              </PanelNote>
            ) : !actions.ok ? (
              <ActionError error={actions.error} />
            ) : board.decisions.length === 0 ? (
              <PanelNote>אין פעולה שממתינה להחלטה שלך.</PanelNote>
            ) : (
              <div className="flex flex-col gap-3">
                {board.decisions.map((action) => (
                  <ActionApprovalCard
                    key={action.id}
                    action={action}
                    mayApprove={holdsGrant(actor, 'autopilot.approve')}
                  />
                ))}
              </div>
            )}
          </Panel>

          {/* ── 2 · at risk ─────────────────────────────────────────────── */}
          <Panel
            title="בסיכון"
            description="תקלות פתוחות שהמערכת סימנה כעלולות להיכשל. כל אחת מוצגת עם הסיבה שלה ומה שהיא גוררת — לא כארבע התראות נפרדות."
            count={exceptions.ok ? board.atRisk.length : undefined}
            action={
              <Button
                href="/autopilot/exceptions"
                variant="secondary"
                size="sm"
              >
                סדר לי את היום
              </Button>
            }
          >
            {!exceptions.ok ? (
              <ActionError error={exceptions.error} />
            ) : board.atRisk.length === 0 ? (
              <PanelNote>אין חריגה פתוחה שסומנה בסיכון.</PanelNote>
            ) : (
              <div className="flex flex-col gap-4">
                {groupByRootCause(board.atRisk).map((incident) => (
                  <ExceptionCard key={incident.root.id} incident={incident} />
                ))}
              </div>
            )}
          </Panel>

          {/* ── 3 · in progress ─────────────────────────────────────────── */}
          <Panel
            title="בטיפול"
            description="מה שמישהו כבר לקח על עצמו, ומה ש־ESTIA תיכננה ועוד לא ביצעה."
            count={
              exceptions.ok
                ? board.inProgressExceptions.length +
                  board.inProgressActions.length
                : undefined
            }
          >
            {!exceptions.ok ? (
              <ActionError error={exceptions.error} />
            ) : board.inProgressExceptions.length === 0 &&
              board.inProgressActions.length === 0 ? (
              <PanelNote>אין כרגע דבר בטיפול.</PanelNote>
            ) : (
              <div className="flex flex-col gap-4">
                {groupByRootCause(board.inProgressExceptions).map(
                  (incident) => (
                    <ExceptionCard key={incident.root.id} incident={incident} />
                  ),
                )}

                {board.inProgressActions.length > 0 && (
                  <RowList>
                    {board.inProgressActions.map((action) => (
                      <Row key={action.id}>
                        <span className="text-sm text-foreground">
                          {action.kindLabel}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {OUTCOME_LABEL[action.outcome]}
                          {action.scheduledFor !== null && (
                            <> · מתוזמן ל־{formatMoment(action.scheduledFor)}</>
                          )}
                        </span>
                      </Row>
                    ))}
                  </RowList>
                )}
              </div>
            )}
          </Panel>

          {/* ── 4 · opportunities ───────────────────────────────────────── */}
          <Panel
            title="הזדמנויות"
            description="מכירה וייעול. אחרונים בסדר העדיפויות של ESTIA, תמיד — עסק שיכול להעדיף הכנסה על פני אורח שנעול בחוץ הוא לא עסק שראוי לעזור לו לבנות."
            count={exceptions.ok ? board.opportunities.length : undefined}
          >
            {!exceptions.ok ? (
              <ActionError error={exceptions.error} />
            ) : board.opportunities.length === 0 ? (
              <PanelNote>לא זוהתה הזדמנות פתוחה.</PanelNote>
            ) : (
              <RowList>
                {board.opportunities.map((row) => (
                  <Row key={row.id}>
                    <span className="flex flex-wrap items-baseline gap-2">
                      <Badge tone="neutral">{DOMAIN_LABEL[row.domain]}</Badge>
                      <span className="text-sm text-foreground">
                        {row.title}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {row.propertyName ?? 'כלל־ארגוני'}
                    </span>
                  </Row>
                ))}
              </RowList>
            )}
          </Panel>

          {/* ── 5 · handled ────────────────────────────────────────────── */}
          <Panel
            title="ESTIA טיפלה"
            description="מה שקרה היום בלי שנדרשת. פעולה שנמנעה במכוון מופיעה כאן גם היא — סירוב נכון הוא המערכת עובדת, לא המערכת שותקת."
            count={actions.ok ? board.handled.length : undefined}
            action={
              mayReadActivity ? (
                <Button href="/autopilot/activity" variant="ghost" size="sm">
                  יומן מלא
                </Button>
              ) : undefined
            }
          >
            {!mayReadActivity ? (
              <PanelNote>
                יומן הפעולות דורש הרשאת{' '}
                <span dir="ltr">autopilot.activity_view</span>. מי שרואה את
                החריגות של היום אינו רואה בכך את כל מה ש־ESTIA שלחה בשם העסק.
              </PanelNote>
            ) : !actions.ok ? (
              <ActionError error={actions.error} />
            ) : board.handled.length === 0 ? (
              <PanelNote>
                {settings.ok && settings.value.level === 'off'
                  ? 'Autopilot כבויה, ולכן לא בוצעה שום פעולה. זו הגדרה, לא תקלה.'
                  : 'ESTIA לא ביצעה היום שום פעולה.'}
              </PanelNote>
            ) : (
              <RowList>
                {board.handled.map((action) => (
                  <Row key={action.id}>
                    <span className="flex flex-wrap items-baseline gap-2">
                      <span className="text-sm text-foreground">
                        {action.kindLabel}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {OUTCOME_LABEL[action.outcome]}
                        {action.outcome === 'suppressed' &&
                          action.suppressedReason !== null && (
                            <>
                              {' — '}
                              {SUPPRESSION_LABEL[action.suppressedReason]}
                            </>
                          )}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatMoment(action.executedAt ?? action.createdAt)}
                    </span>
                  </Row>
                ))}
              </RowList>
            )}
          </Panel>

          {/* What is being watched, on a calm day. Not a section of work. */}
          {calm && board.watching.length > 0 && (
            <Panel
              title="ESTIA עוקבת"
              description="פתוח, ולא מסומן כבעייתי. כאן כדי שלא ייעלם, ולא כדי שתעשה איתו משהו עכשיו."
              count={board.watching.length}
            >
              <RowList>
                {board.watching.map((row) => (
                  <Row key={row.id}>
                    <span className="text-sm text-foreground">{row.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {RISK_LABEL[row.risk]} · {DOMAIN_LABEL[row.domain]}
                    </span>
                  </Row>
                ))}
              </RowList>
            </Panel>
          )}

          {/* Today's arrivals, so the calm claim has something under it. */}
          <Panel
            title="הגעות ועזיבות היום"
            description={`התאריך הקובע הוא ${formatDayMonth(today)} לפי שעון הנכס.`}
            count={stays.ok ? stays.value.length : undefined}
          >
            {!stays.ok ? (
              <ActionError error={stays.error} />
            ) : stays.value.length === 0 ? (
              <PanelNote>אין הגעות, עזיבות או אורחים בבית היום.</PanelNote>
            ) : (
              <RowList>
                {stays.value.map((stay) => (
                  <Row key={stay.id}>
                    <span className="flex flex-wrap items-baseline gap-2">
                      <span className="text-sm text-foreground">
                        {stay.guestName === undefined ? (
                          <Withheld />
                        ) : (
                          (stay.guestName ?? stay.reference)
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {stay.unitName ?? stay.reference}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {stay.role === 'arriving'
                        ? 'מגיע'
                        : stay.role === 'departing'
                          ? 'עוזב'
                          : 'בבית'}
                      {stay.arrivalTime !== null && ` · ${stay.arrivalTime}`}
                    </span>
                  </Row>
                ))}
              </RowList>
            )}
          </Panel>
        </>
      )}
    </ScreenFrame>
  )
}

/* --------------------------------------------------------------- strip -- */

/**
 * The four figures, and what state Autopilot is in while it produced them.
 *
 * The state is beside the figures rather than on the settings screen, because
 * "ESTIA טיפלה — 0" means two completely different things depending on whether
 * the run mode is `simulation`, and a person reading a zero deserves to know
 * which one they are looking at without navigating.
 */
function StatusStrip({
  today,
  strip,
  level,
  runMode,
  enabled,
  pausedUntil,
  configured,
  trialEndsAt,
}: {
  today: string
  strip: {
    arrivals: number
    departures: number
    propertiesAtRisk: number
    outstandingAgorot: number | null
  }
  level: string | null
  runMode: 'live' | 'simulation' | null
  enabled: boolean | null
  pausedUntil: string | null
  configured: boolean | null
  trialEndsAt: string | null
}) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5">
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="הגעות היום" value={String(strip.arrivals)} />
        <Figure label="עזיבות היום" value={String(strip.departures)} />
        <Figure
          label="נכסים בסיכון"
          value={String(strip.propertiesAtRisk)}
          note="נכסים שיש בהם חריגה פתוחה שסומנה בסיכון"
        />
        <Figure
          label="יתרה פתוחה"
          value={
            strip.outstandingAgorot === null
              ? null
              : formatAgorot(strip.outstandingAgorot)
          }
          note="על השהיות שבבית היום"
        />
      </dl>

      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          התאריך הקובע:{' '}
          <span dir="ltr" className="font-medium text-foreground">
            {today}
          </span>
        </span>
        {level !== null && <Badge tone="neutral">רמה: {level}</Badge>}
        {runMode !== null && (
          <Badge tone={runMode === 'simulation' ? 'accent' : 'brand'}>
            {RUN_MODE_LABEL[runMode]}
          </Badge>
        )}
        {enabled === false && <Badge tone="accent">מתג הכיבוי פעיל</Badge>}
        {pausedUntil !== null && (
          <span>מושהה עד {formatMoment(pausedUntil)}</span>
        )}
        {configured === false && (
          <span>
            עוד לא הוגדרה. ברירת המחדל היא כבוי ובסימולציה — הגדרה, לא תקלה.
          </span>
        )}
        {trialEndsAt !== null && (
          <span>תקופת התנסות עד {formatMoment(trialEndsAt)}</span>
        )}
      </p>
    </div>
  )
}

function Figure({
  label,
  value,
  note,
}: {
  label: string
  /** Null renders as withheld, never as a zero somebody would believe. */
  value: string | null
  note?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-display text-2xl font-bold tabular-nums text-foreground">
        {value === null ? (
          <Withheld className="text-base font-normal" />
        ) : (
          value
        )}
      </dd>
      {note !== undefined && (
        <p className="text-[0.6875rem] text-muted-foreground">{note}</p>
      )}
    </div>
  )
}
