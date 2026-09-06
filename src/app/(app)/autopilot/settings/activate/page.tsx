import type { Metadata } from 'next'

import { firstParam } from '@/app/(auth)/_lib/search-params'
import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import {
  DISPOSITION_LABEL,
  LEVEL_LABEL,
  LEVEL_MEANING,
  RUN_MODE_LABEL,
  RUN_MODE_MEANING,
  SAFETY_LEVEL_LABEL,
  SAFETY_LEVEL_MEANING,
} from '@/components/autopilot/labels'
import { AutopilotPlanLock } from '@/components/autopilot/plan-lock'
import { CeilingNote } from '@/components/autopilot/policy-matrix-cell'
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
import { ACTION_SAFETY_LEVELS, AUTOPILOT_LADDER } from '@/lib/contracts/states'
import type { Entitlement } from '@/lib/plans/entitlements'
import { createClient } from '@/lib/supabase/server'

import {
  loadPropertyLevels,
  loadSafetyRules,
  loadSettings,
  type AutopilotReadArgs,
} from '../../_lib/reads'
import { settle } from '../../_lib/settle'
import { ceilingFor } from '../_lib/ceiling'
import { actionsBySafety, missingModule } from '../_lib/queries'
import { requireActivationWizard } from './_lib/access'
import {
  parseLevel,
  parseRunMode,
  parseStep,
  previousStep,
  nextStep,
  stepHref,
  stepIndex,
  STEP_LEAD,
  STEP_TITLE,
  WIZARD_STEPS,
  type WizardChoices,
} from './_lib/wizard'

export const metadata: Metadata = { title: 'הפעלת ESTIA Autopilot' }

const MODULE_INCLUDES = [
  'הפעלה מדורגת: רמה, תחומים, פעולות, מאשרים, נכסים, התראות — ואז סימולציה.',
  'שום דבר לא מופעל לפני שקוראים מה ESTIA הייתה עושה על הנתונים האמיתיים שלכם.',
]

/**
 * The modules Autopilot can watch, and what each one means it will notice.
 *
 * A subset of `ENTITLEMENTS` and not all of them: `custom_domain` and
 * `multi_brand` are real features that Autopilot has nothing to say about, and
 * listing them here would promise a watch that no detector implements.
 */
const WATCHED_MODULES: readonly {
  entitlement: Entitlement
  watches: string
}[] = [
  { entitlement: 'operations', watches: 'ניקיון, הכנה, משימות ומלאי' },
  { entitlement: 'laundry', watches: 'הזמנות כביסה ואספקה שמאחרת' },
  { entitlement: 'payments', watches: 'מקדמות, יתרות וסליקה שנכשלה' },
  { entitlement: 'commerce', watches: 'הזמנות מהחנות וספקים שלא ענו' },
  { entitlement: 'agent_network', watches: 'שריונים שפגו ועמלות' },
  { entitlement: 'dynamic_pricing', watches: 'מחירים מול ביקוש' },
  { entitlement: 'channels', watches: 'סנכרון ערוצים' },
]

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The activation wizard, in eight steps.
 *
 * ── No client component, and the URL is the state ────────────────────────
 *
 * Each step is a link and a full server render. A person can close the laptop
 * at step five and reopen the link tomorrow; the review step can be sent to
 * whoever actually holds `autopilot.configure`, which in a guesthouse is very
 * often somebody else. A `useState` wizard would lose all of that and gain a
 * loading spinner.
 *
 * ── The order of the steps is an argument ────────────────────────────────
 *
 * Level, then modules, then the actions themselves, then who approves, then
 * where, then when to be told, then simulation, then confirm. Simulation is
 * second to last on purpose: it is not a technical check to be skipped, it is
 * the way this product is meant to be switched on, and it sits between "here
 * is everything you chose" and "write it down".
 *
 * ── The gate is `autopilot.configure`, and it refuses at the start ───────
 *
 * Not at the end. A wizard that collects eight screens of decisions and then
 * says "you may not do this" has wasted the one thing a guesthouse owner has
 * least of — see `_lib/access.ts`.
 *
 * ── The last step writes nothing, and says so ────────────────────────────
 *
 * The configuration operation does not exist yet. What the confirm step shows
 * is exactly the row that would be written, read back against the row that IS
 * written, so the difference is visible. A confirm button that appeared to
 * save and did not would be worse than the sentence.
 */
export default async function AutopilotActivatePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [access, params] = await Promise.all([
    requireActivationWizard(),
    searchParams,
  ])
  const { actor, organizationId, propertyId } = access

  const step = parseStep(firstParam(params.step))
  const choices: WizardChoices = {
    level: parseLevel(firstParam(params.level)),
    runMode: parseRunMode(firstParam(params.mode)),
  }

  const db = await createClient()
  const args: AutopilotReadArgs = { db, actor, organizationId, propertyId }

  const [settings, rules, propertyLevels] = await Promise.all([
    settle(() => loadSettings(args)),
    settle(() => loadSafetyRules(db)),
    settle(() => loadPropertyLevels(args)),
  ])

  const back = previousStep(step)
  const forward = nextStep(step)
  const grouped = actionsBySafety()
  const safetyRules = rules.ok ? rules.value : []

  return (
    <ScreenFrame
      title="הפעלת ESTIA Autopilot"
      width="prose"
      lead={STEP_LEAD[step]}
      banner={
        access.kind === 'allow' ? (
          <ol className="flex flex-wrap items-center gap-2 text-xs">
            {WIZARD_STEPS.map((option, index) => (
              <li key={option}>
                <Badge
                  tone={
                    option === step
                      ? 'brand'
                      : index < stepIndex(step)
                        ? 'accent'
                        : 'neutral'
                  }
                >
                  {index + 1}. {STEP_TITLE[option]}
                </Badge>
              </li>
            ))}
          </ol>
        ) : undefined
      }
    >
      {access.kind === 'locked' ? (
        <AutopilotPlanLock
          entitlement={access.entitlement}
          includes={MODULE_INCLUDES}
          mayReachBilling={holdsGrant(actor, 'organization.billing.manage')}
        />
      ) : (
        <>
          <Panel title={STEP_TITLE[step]}>
            {step === 'level' && (
              <RowList>
                {AUTOPILOT_LADDER.map((level) => (
                  <Row key={level}>
                    <span className="flex flex-col gap-1">
                      <span className="flex items-baseline gap-2">
                        <Badge
                          tone={level === choices.level ? 'brand' : 'neutral'}
                        >
                          {LEVEL_LABEL[level]}
                        </Badge>
                        {level === choices.level && (
                          <span className="text-xs text-muted-foreground">
                            נבחר
                          </span>
                        )}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {LEVEL_MEANING[level]}
                      </span>
                    </span>
                    <Button
                      href={stepHref('level', choices, { level })}
                      variant={
                        level === choices.level ? 'primary' : 'secondary'
                      }
                      size="sm"
                    >
                      בחירה
                    </Button>
                  </Row>
                ))}
              </RowList>
            )}

            {step === 'modules' && (
              <RowList>
                {WATCHED_MODULES.map((module) => {
                  const held = actor.entitlements.has(module.entitlement)
                  return (
                    <Row key={module.entitlement}>
                      <span className="flex flex-col gap-0.5">
                        <span className="text-sm text-foreground">
                          {entitlementLabel(module.entitlement)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {module.watches}
                        </span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {held
                          ? 'בחבילה — ESTIA תשגיח'
                          : 'לא בחבילה — לא יוזכר בשום הצעה'}
                      </span>
                    </Row>
                  )
                })}
              </RowList>
            )}

            {step === 'actions' && (
              <div className="flex flex-col gap-6">
                {ACTION_SAFETY_LEVELS.map((level) => {
                  const specs = grouped.get(level) ?? []
                  if (specs.length === 0) return null
                  const ceiling = ceilingFor(specs[0], safetyRules)

                  return (
                    <section key={level} className="flex flex-col gap-2">
                      <h3 className="font-display text-base font-bold text-foreground">
                        {SAFETY_LEVEL_LABEL[level]}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {SAFETY_LEVEL_MEANING[level]}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        המקסימום שאפשר להגדיר כאן:{' '}
                        <span className="font-medium text-foreground">
                          {DISPOSITION_LABEL[ceiling.maxDisposition]}
                        </span>
                      </p>
                      {ceiling.rule !== null && (
                        <CeilingNote reason={ceiling.rule.reason} />
                      )}
                      <ul className="flex flex-col gap-1">
                        {specs.map((spec) => {
                          const missing = missingModule(
                            spec,
                            actor.entitlements,
                          )
                          return (
                            <li
                              key={spec.kind}
                              className="flex flex-wrap items-baseline gap-2 text-sm"
                            >
                              <span className="text-foreground">
                                {spec.label}
                              </span>
                              {missing !== null && (
                                <span className="text-xs text-muted-foreground">
                                  דורש {entitlementLabel(missing)} — לא ייכלל
                                </span>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    </section>
                  )
                })}
              </div>
            )}

            {step === 'approvals' && (
              <dl className="flex flex-col">
                <FactRow label="מי מאשר פעולה מוכנה">
                  מחזיקי ההרשאה autopilot.approve
                </FactRow>
                <FactRow label="האם את/ה מחזיק/ה בה">
                  {holdsGrant(actor, 'autopilot.approve') ? 'כן' : 'לא'}
                </FactRow>
                <FactRow label="מי יכול לעצור הכול">
                  מחזיקי autopilot.pause — הרשאה נפרדת, בכוונה
                </FactRow>
                <FactRow label="מה קורה אם אין מאשר">
                  הפעולה ממתינה. היא אינה מתבצעת לבד אחרי זמן מה, ואין פה ״אישור
                  בשתיקה״.
                </FactRow>
              </dl>
            )}

            {step === 'properties' && (
              <>
                {!propertyLevels.ok ? (
                  <ActionError error={propertyLevels.error} />
                ) : propertyLevels.value.length === 0 ? (
                  <PanelNote>
                    אין כרגע נכס עם הגדרה משלו — כל הנכסים יפעלו ברמת הארגון.
                    אפשר להוריד נכס בודד לרמה נמוכה יותר אחרי ההפעלה.
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
                        </span>
                      </Row>
                    ))}
                  </RowList>
                )}
              </>
            )}

            {step === 'notifications' && !settings.ok && (
              <ActionError error={settings.error} />
            )}
            {step === 'notifications' && settings.ok && (
              <dl className="flex flex-col">
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
                <FactRow label="טווח מבט קדימה">
                  {settings.value.lookaheadHours} שעות
                </FactRow>
                <FactRow label="מה יפריע באמצע היום">
                  רק חריגה שסומנה קריטית. השאר מחכה לסיכום.
                </FactRow>
              </dl>
            )}

            {step === 'simulation' && (
              <div className="flex flex-col gap-4">
                <p className="text-sm leading-relaxed text-foreground">
                  {RUN_MODE_MEANING.simulation}
                </p>
                <RowList>
                  {(['simulation', 'live'] as const).map((mode) => (
                    <Row key={mode}>
                      <span className="flex flex-col gap-0.5">
                        <span className="flex items-baseline gap-2">
                          <Badge
                            tone={
                              mode === choices.runMode ? 'brand' : 'neutral'
                            }
                          >
                            {RUN_MODE_LABEL[mode]}
                          </Badge>
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {RUN_MODE_MEANING[mode]}
                        </span>
                      </span>
                      <Button
                        href={stepHref('simulation', choices, {
                          runMode: mode,
                        })}
                        variant={
                          mode === choices.runMode ? 'primary' : 'secondary'
                        }
                        size="sm"
                      >
                        בחירה
                      </Button>
                    </Row>
                  ))}
                </RowList>
                <PanelNote>
                  ההמלצה היא סימולציה לשבועיים. מסד הנתונים אוכף את זה מצדו:
                  שורת פעולה שנוצרה בסימולציה אינה יכולה להיות מסומנת כבוצעה,
                  וזה אילוץ בסכימה ולא בדיקה בקוד.
                </PanelNote>
              </div>
            )}

            {step === 'confirm' && (
              <div className="flex flex-col gap-4">
                <dl className="flex flex-col">
                  <FactRow label="רמה שנבחרה">
                    {LEVEL_LABEL[choices.level]}
                  </FactRow>
                  <FactRow label="משמעות">
                    {LEVEL_MEANING[choices.level]}
                  </FactRow>
                  <FactRow label="מצב הרצה">
                    {RUN_MODE_LABEL[choices.runMode]}
                  </FactRow>
                  <FactRow label="רמה קיימת במסד">
                    {settings.ok
                      ? `${LEVEL_LABEL[settings.value.level]} · ${RUN_MODE_LABEL[settings.value.runMode]}`
                      : 'לא נקראה'}
                  </FactRow>
                  <FactRow label="נשמר בפועל">
                    {settings.ok && settings.value.configured
                      ? 'קיימת שורת הגדרות לארגון'
                      : 'אין שורת הגדרות — חלות ברירות המחדל'}
                  </FactRow>
                </dl>

                <PanelNote tone="attention">
                  אין כאן כפתור שמירה. נתיב הכתיבה של ההגדרות — האופרציה שמאמתת
                  את הבחירה, בודקת את ההרשאה, כותבת ביקורת ומעלה גרסה — עדיין לא
                  נבנה, וכפתור שנראה שומר ואינו שומר גרוע מהיעדרו. מה שמופיע
                  למעלה הוא בדיוק מה שייכתב כשהוא ייבנה.
                </PanelNote>
              </div>
            )}
          </Panel>

          <nav className="flex flex-wrap items-center justify-between gap-3">
            {back === null ? (
              <Button href="/autopilot/settings" variant="ghost">
                חזרה להגדרות
              </Button>
            ) : (
              <Button href={stepHref(back, choices)} variant="ghost">
                לשלב הקודם
              </Button>
            )}

            {forward !== null && (
              <Button href={stepHref(forward, choices)} variant="primary">
                לשלב הבא — {STEP_TITLE[forward]}
              </Button>
            )}
          </nav>
        </>
      )}
    </ScreenFrame>
  )
}
