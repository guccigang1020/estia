import type { Metadata } from 'next'

import { AutopilotPlanLock } from '@/components/autopilot/plan-lock'
import {
  BOOKING_HANDLING_LABEL,
  CAPABILITY_STATE_LABEL,
  DISPOSITION_LABEL,
  LEVEL_LABEL,
  LEVEL_MEANING,
  RUN_MODE_LABEL,
  RUN_MODE_MEANING,
  SAFETY_LEVEL_LABEL,
  SAFETY_LEVEL_MEANING,
} from '@/components/autopilot/labels'
import {
  CeilingNote,
  PolicyMatrixCell,
} from '@/components/autopilot/policy-matrix-cell'
import { formatMoment } from '@/components/autopilot/time'
import { ActionError } from '@/components/booking/action-error'
import { entitlementLabel } from '@/components/nav/labels'
import {
  FactRow,
  Panel,
  PanelNote,
  Row,
  RowList,
  ScreenFrame,
} from '@/components/shell-screens/screen'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import {
  AUTOPILOT_DISPOSITIONS,
  AUTOPILOT_LADDER,
  ACTION_SAFETY_LEVELS,
} from '@/lib/contracts/states'
import { createClient } from '@/lib/supabase/server'

import {
  loadCapability,
  loadPolicies,
  loadPropertyLevels,
  loadSafetyRules,
  loadSettings,
  type AutopilotReadArgs,
} from '../_lib/reads'
import { settle } from '../_lib/settle'
import {
  requireAutopilotSettings,
  SETTINGS_CONTROL_GRANTS,
} from './_lib/access'
import { buildMatrix, cellState } from './_lib/ceiling'
import { actionsBySafety, allActionSpecs, missingModule } from './_lib/queries'

export const metadata: Metadata = { title: 'הגדרות ESTIA Autopilot' }

const MODULE_INCLUDES = [
  'רמה אחת לעסק, ואפשרות להחזיק נכס בודד נמוך יותר בזמן שמתרגלים.',
  'מטריצה שמראה, פעולה אחר פעולה, מה ESTIA תעשה — ומה ESTIA לעולם לא תעשה לבד.',
  'סימולציה שרושמת מה היה קורה בלי שקורה דבר, ואפשר לקרוא אותה לפני שמפעילים.',
  'מתג כיבוי שאינו מוחק את מה שהגדרתם, כי הרגע שבו צריך לכבות הוא הרגע שאין בו זמן להגדיר מחדש.',
]

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What the business let ESTIA do.
 *
 * ── The matrix shows the ceiling, and that is the point of the screen ────
 *
 * `autopilot_safety_rules` caps money, access, cancellation and every
 * business-impact action at `ask_approval` for every customer on every
 * package, and no tenant role may write the table. A matrix that drew `auto`
 * as an ordinary option for a refund would let somebody select it, save, watch
 * nothing change, and eventually conclude the product is broken. 0046 grants
 * every reader `select` on that table for exactly this reason and says so in
 * the policy's own comment.
 *
 * So a capped cell renders struck through, `aria-disabled`, with the rule's
 * stored sentence printed under the group — not a rule id, a sentence about
 * refunds and locked doors that ESTIA wrote.
 *
 * ── An unwritten cell is not `off` ───────────────────────────────────────
 *
 * A missing `autopilot_policies` row means the LEVEL's default, so that a
 * business can move the whole ladder without having written a row per action
 * first. The matrix therefore draws no selection for it and the row says "לפי
 * הרמה". Drawing `off` would show somebody a decision nobody made.
 *
 * ── Four different grants, and the door is the smallest ──────────────────
 *
 * `autopilot.view` opens the screen; `configure` changes the level, the mode
 * and the matrix; `override` writes a property's narrowing; `pause` works the
 * pause and the kill switch. Gating the route on configure would hide the kill
 * switch from the one person whose grant exists to reach it in a hurry — see
 * `_lib/access.ts`.
 *
 * ── There are no inputs on this screen, and it says why ──────────────────
 *
 * The configuration write path — the operation that validates a level change,
 * checks the grant, writes audit and bumps the version — does not exist yet;
 * `src/lib/autopilot` carries the catalogue, the stage types and the quiet
 * hours rule and no operations module. `automations/page.tsx` faced the same
 * gap and made the same choice: state the absence once, rather than render a
 * control that forgets itself on reload. Every value below is read from the
 * database and is what the engine will act on.
 */
export default async function AutopilotSettingsPage() {
  const access = await requireAutopilotSettings()
  const { actor, organizationId, propertyId, propertyName } = access

  const mayConfigure = holdsGrant(actor, SETTINGS_CONTROL_GRANTS.level)
  const mayPause = holdsGrant(actor, SETTINGS_CONTROL_GRANTS.pause)
  const mayOverride = holdsGrant(
    actor,
    SETTINGS_CONTROL_GRANTS.propertyOverride,
  )

  const db = await createClient()
  const args: AutopilotReadArgs = { db, actor, organizationId, propertyId }

  const [settings, capability, rules, policies, propertyLevels] =
    await Promise.all([
      settle(() => loadSettings(args)),
      settle(() => loadCapability(args)),
      settle(() => loadSafetyRules(db)),
      settle(() => loadPolicies(args)),
      settle(() => loadPropertyLevels(args)),
    ])

  const matrix = buildMatrix(
    allActionSpecs(),
    policies.ok ? policies.value : [],
    rules.ok ? rules.value : [],
  )
  const byKind = new Map(matrix.map((row) => [row.spec.kind, row]))
  const grouped = actionsBySafety()

  return (
    <ScreenFrame
      title="הגדרות ESTIA Autopilot"
      width="shell"
      lead={
        propertyName
          ? `מה ESTIA רשאית לעשות, ומה שאינה רשאית לעשות בשום מקרה. הצגה מסוננת ל״${propertyName}״ במקומות שבהם יש לנכס הגדרה משלו.`
          : 'מה ESTIA רשאית לעשות, ומה שאינה רשאית לעשות בשום מקרה.'
      }
    >
      {access.kind === 'locked' ? (
        <AutopilotPlanLock
          entitlement={access.entitlement}
          includes={MODULE_INCLUDES}
          mayReachBilling={holdsGrant(actor, 'organization.billing.manage')}
          platformNote={capability.ok ? capability.value.note : null}
        />
      ) : (
        <>
          {/* ── state ───────────────────────────────────────────────────── */}
          <Panel
            title="מצב נוכחי"
            description="מה שקובע בפועל מה יקרה בשעה הקרובה."
            action={
              <Button
                href="/autopilot/settings/activate"
                variant="secondary"
                size="sm"
              >
                אשף ההפעלה
              </Button>
            }
          >
            {!settings.ok ? (
              <ActionError error={settings.error} />
            ) : (
              <dl className="flex flex-col">
                <FactRow label="רמה">
                  {LEVEL_LABEL[settings.value.level]}
                </FactRow>
                <FactRow label="מה זה אומר">
                  {LEVEL_MEANING[settings.value.level]}
                </FactRow>
                <FactRow label="מצב הרצה">
                  {RUN_MODE_LABEL[settings.value.runMode]}
                </FactRow>
                <FactRow label="מה זה אומר">
                  {RUN_MODE_MEANING[settings.value.runMode]}
                </FactRow>
                <FactRow label="מתג כיבוי">
                  {settings.value.enabled ? 'פתוח' : 'סגור — הכול מושבת'}
                </FactRow>
                <FactRow label="השהיה">
                  {settings.value.pausedUntil === null
                    ? 'אין'
                    : `עד ${formatMoment(settings.value.pausedUntil) ?? settings.value.pausedUntil}`}
                </FactRow>
                {settings.value.pausedReason !== null && (
                  <FactRow label="סיבת ההשהיה">
                    {settings.value.pausedReason}
                  </FactRow>
                )}
                <FactRow label="טווח מבט קדימה">
                  {settings.value.lookaheadHours} שעות
                </FactRow>
                <FactRow label="סיכום בוקר">
                  {settings.value.dailyBriefEnabled
                    ? `כן, ב־${settings.value.dailyBriefAt}`
                    : 'כבוי'}
                </FactRow>
                <FactRow label="סיכום ערב">
                  {settings.value.eveningSummaryEnabled
                    ? `כן, ב־${settings.value.eveningSummaryAt}`
                    : 'כבוי'}
                </FactRow>
                <FactRow label="עודכן לאחרונה">
                  {formatMoment(settings.value.updatedAt) ?? 'מעולם'}
                </FactRow>

                {!settings.value.configured && (
                  <div className="pt-3">
                    <PanelNote>
                      לא נשמרה הגדרה לארגון הזה, ולכן חלות ברירות המחדל: כבוי,
                      בסימולציה. זו הגדרה מכוונת ולא תקלה — עסק שהיכולת נפתחה לו
                      הבוקר לא אמור להתעורר להודעות שנשלחו בלילה.
                    </PanelNote>
                  </div>
                )}
              </dl>
            )}
          </Panel>

          {/* ── the ladder ─────────────────────────────────────────────── */}
          <Panel
            title="הרמות"
            description="כל רמה מכילה את זו שלפניה. אפשר לעלות בהדרגה, ואפשר להחזיק נכס בודד נמוך יותר."
          >
            <RowList>
              {AUTOPILOT_LADDER.map((level) => (
                <Row key={level}>
                  <span className="flex flex-wrap items-baseline gap-2">
                    <Badge
                      tone={
                        settings.ok && settings.value.level === level
                          ? 'brand'
                          : 'neutral'
                      }
                    >
                      {LEVEL_LABEL[level]}
                    </Badge>
                    <span className="text-sm text-muted-foreground">
                      {LEVEL_MEANING[level]}
                    </span>
                  </span>
                </Row>
              ))}
            </RowList>
          </Panel>

          {/* ── the matrix ─────────────────────────────────────────────── */}
          <Panel
            title="מטריצת המדיניות"
            description="פעולה אחר פעולה: מה ESTIA תעשה, ומה חסום מלמעלה על ידי כלל בטיחות של ESTIA שאף לקוח אינו יכול להסיר."
            count={matrix.length}
          >
            {!rules.ok ? (
              <ActionError error={rules.error} />
            ) : (
              <div className="flex flex-col gap-8">
                {ACTION_SAFETY_LEVELS.map((level) => {
                  const specs = grouped.get(level) ?? []
                  if (specs.length === 0) return null

                  // Every action at one safety level shares the blanket rule
                  // that caps the level, so the sentence is printed once for
                  // the group rather than repeated on thirteen rows.
                  const groupRule =
                    byKind.get(specs[0].kind)?.ceiling.rule ?? null

                  return (
                    <section key={level} className="flex flex-col gap-3">
                      <header className="flex flex-col gap-1">
                        <h3 className="font-display text-base font-bold text-foreground">
                          {SAFETY_LEVEL_LABEL[level]}
                        </h3>
                        <p className="text-sm text-muted-foreground">
                          {SAFETY_LEVEL_MEANING[level]}
                        </p>
                        {groupRule !== null && (
                          <CeilingNote reason={groupRule.reason} />
                        )}
                      </header>

                      <div className="overflow-x-auto">
                        <div className="flex min-w-[36rem] flex-col gap-2">
                          <div className="grid grid-cols-[minmax(12rem,1fr)_repeat(4,6rem)] items-center gap-2 px-1 text-xs text-muted-foreground">
                            <span>פעולה</span>
                            {AUTOPILOT_DISPOSITIONS.map((option) => (
                              <span key={option} className="text-center">
                                {DISPOSITION_LABEL[option]}
                              </span>
                            ))}
                          </div>

                          {specs.map((spec) => {
                            const row = byKind.get(spec.kind)
                            if (row === undefined) return null
                            const missing = missingModule(
                              spec,
                              actor.entitlements,
                            )

                            return (
                              <div
                                key={spec.kind}
                                className="grid grid-cols-[minmax(12rem,1fr)_repeat(4,6rem)] items-center gap-2 rounded-lg px-1 py-1.5 odd:bg-muted/40"
                              >
                                <div className="flex flex-col gap-0.5">
                                  <span className="text-sm text-foreground">
                                    {spec.label}
                                  </span>
                                  <span
                                    dir="ltr"
                                    className="text-[0.625rem] text-muted-foreground"
                                  >
                                    {spec.kind}
                                  </span>
                                  {row.chosen === null && (
                                    <span className="text-[0.625rem] text-muted-foreground">
                                      לפי הרמה — לא נכתבה החלטה לפעולה הזו
                                    </span>
                                  )}
                                  {missing !== null && (
                                    <span className="text-[0.625rem] text-muted-foreground">
                                      דורש את המודול {entitlementLabel(missing)}
                                      , שאינו בחבילה — ESTIA לא תציע את זה
                                    </span>
                                  )}
                                  {row.overriddenAt.length > 0 && (
                                    <span className="text-[0.625rem] text-muted-foreground">
                                      {row.overriddenAt.length} נכסים עם הגדרה
                                      שונה
                                    </span>
                                  )}
                                </div>

                                {AUTOPILOT_DISPOSITIONS.map((option) => (
                                  <PolicyMatrixCell
                                    key={option}
                                    disposition={option}
                                    state={cellState(
                                      option,
                                      row.chosen,
                                      row.ceiling,
                                    )}
                                    blockedReason={
                                      row.ceiling.rule?.reason ?? undefined
                                    }
                                  />
                                ))}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    </section>
                  )
                })}
              </div>
            )}
          </Panel>

          {/* ── property narrowing ─────────────────────────────────────── */}
          <Panel
            title="נכסים מוחרגים"
            description="נכס יכול לשבת נמוך מהארגון ולעולם לא גבוה ממנו. ככה מרימים עסק בהדרגה בלי לפתוח את הכול בבת אחת."
            count={propertyLevels.ok ? propertyLevels.value.length : undefined}
          >
            {!propertyLevels.ok ? (
              <ActionError error={propertyLevels.error} />
            ) : propertyLevels.value.length === 0 ? (
              <PanelNote>
                אין נכס עם הגדרה משלו. כל הנכסים פועלים ברמת הארגון.
              </PanelNote>
            ) : (
              <RowList>
                {propertyLevels.value.map((row) => (
                  <Row key={row.propertyId}>
                    <span className="text-sm text-foreground">
                      {row.propertyName ?? 'נכס שאינו נגיש לצפייה'}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {LEVEL_LABEL[row.level]}
                      {row.note !== null && ` · ${row.note}`}
                    </span>
                  </Row>
                ))}
              </RowList>
            )}
          </Panel>

          {/* ── booking handling, pause, kill ──────────────────────────── */}
          <Panel
            title="עצירה וכיבוי"
            description="ההשהיה והמתג הם הרשאה נפרדת מהגדרה, כי מי שצריך לעצור ב־23:00 הוא לרוב לא מי שהגדיר."
          >
            <dl className="flex flex-col">
              <FactRow label="מתג הכיבוי">
                {settings.ok && settings.value.enabled
                  ? 'פתוח — ESTIA פועלת לפי המטריצה'
                  : 'סגור — שום פעולה לא תבוצע'}
              </FactRow>
              <FactRow label="מי רשאי לעצור">
                {mayPause
                  ? 'את/ה — ההרשאה ברשותך'
                  : 'לא את/ה. נדרשת הרשאת autopilot.pause'}
              </FactRow>
              <FactRow label="מי רשאי לשנות הגדרות">
                {mayConfigure
                  ? 'את/ה — ההרשאה ברשותך'
                  : 'לא את/ה. נדרשת הרשאת autopilot.configure'}
              </FactRow>
              <FactRow label="מי רשאי להחריג נכס">
                {mayOverride
                  ? 'את/ה — ההרשאה ברשותך'
                  : 'לא את/ה. נדרשת הרשאת autopilot.override'}
              </FactRow>
              <FactRow label="טיפול חריג בהזמנה">
                {BOOKING_HANDLING_LABEL.high_attention} ו־
                {BOOKING_HANDLING_LABEL.manual_only} מצמצמים לעולם, ולא מרחיבים
              </FactRow>
            </dl>

            <div className="mt-4">
              <PanelNote tone="attention">
                אין בעמוד הזה כפתורי שמירה, ולא במקרה: נתיב הכתיבה של ההגדרות —
                האופרציה שמאמתת שינוי רמה, בודקת הרשאה, כותבת ביקורת ומעלה גרסה
                — עדיין לא נבנה. כפתור שנראה עובד ואינו שומר גרוע מהיעדרו, וזו
                בדיוק ההחלטה שמסך האוטומציות תיעד אצלו.
              </PanelNote>
            </div>
          </Panel>

          {/* ── platform capability ────────────────────────────────────── */}
          <Panel
            title="מה ESTIA החליטה עליכם"
            description="החלטת הפלטפורמה על היכולת. נקראת כאן, ואינה השער — השער הוא החבילה."
          >
            {!capability.ok ? (
              <ActionError error={capability.error} />
            ) : (
              <dl className="flex flex-col">
                <FactRow label="מצב">
                  {CAPABILITY_STATE_LABEL[capability.value.state]}
                </FactRow>
                {capability.value.trialEndsAt !== null && (
                  <FactRow label="ההתנסות מסתיימת">
                    {formatMoment(capability.value.trialEndsAt)}
                  </FactRow>
                )}
                {capability.value.actionLimit !== null && (
                  <FactRow label="תקרת פעולות ליום">
                    {capability.value.actionLimit}
                  </FactRow>
                )}
                {capability.value.note !== null && (
                  <FactRow label="הערה">{capability.value.note}</FactRow>
                )}
              </dl>
            )}
          </Panel>
        </>
      )}
    </ScreenFrame>
  )
}
