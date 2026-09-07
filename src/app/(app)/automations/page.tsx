import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import {
  AUTOMATION_TEMPLATES,
  parametersFor,
  reachesOutsideTheBusiness,
  resolveRules,
  type ResolvedRule,
} from '@/lib/automation'
import { mayManageAutomation } from '@/lib/automation/operations'
import { AutomationRuleRepository } from '@/lib/automation/repository'
import {
  AutomationRunRepository,
  type RecordedDecision,
} from '@/lib/automation/runs'
import { holdsGrant } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { financeRepository } from '../finance/_lib/wiring'
import { DecisionsPanel } from './_components/decisions-panel'
import { DryRunPanel } from './_components/dry-run-panel'
import { AutomationPlanLock } from './_components/plan-lock'
import { RuleCard } from './_components/rule-card'
import { RuleSwitch } from './_components/rule-switch'
import { candidateEvents, simulate, type Candidate } from './_lib/dry-run'
import { requireAutomationGrant } from './_lib/gate'
import { loadDryRunInputs, type DryRunInputs } from './_lib/queries'
import {
  configuredRules,
  headline,
  ruleViews,
  type DryRunHeadline,
  type RuleView,
} from './_lib/rules'

export const metadata: Metadata = { title: 'אוטומציות' }

/**
 * How many recorded decisions the panel reads.
 *
 * Read in one glance, like the dry run's own ceiling and for the same reason: a
 * screen whose job is to be believed is not improved by being exhaustive, and
 * the panel states the number rather than leaving somebody to discover the list
 * stopped growing.
 */
const DECISION_SAMPLE = 40

/**
 * The Hebrew name of every rule the library carries, by template id.
 *
 * The decision record stores the id, not the name — a name is presentation and
 * it would be stale the day somebody rewords a template. Resolved here against
 * the live library so a row always reads the way the rule card above it does.
 */
const RULE_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  AUTOMATION_TEMPLATES.map((template) => [
    template.rule.id,
    template.rule.name,
  ]),
)

/** What the module buys, for the plan lock. Concrete things, never a brochure. */
const MODULE_INCLUDES = [
  'כללים שרצים על אירועים אמיתיים של העסק — אישור הזמנה, כישלון סליקה, משימה שאיחרה.',
  'מניעת כפילות מובנית: אותו אירוע לא יפעיל את אותה פעולה פעמיים.',
  'כל פעולה שאוטומציה מבצעת נרשמת ביומן הפעילות בדיוק כמו פעולה של אדם.',
  'אוטומציה פועלת תחת ההרשאות של מי שהיא רצה בשמו, ולא מעליהן.',
]

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The automation section.
 *
 * WHAT IS ON THIS SCREEN. The rules ESTIA ships, what each one listens for,
 * what it does, whether it could actually run here — and, before any of that,
 * what the whole set would have done to rows that are genuinely in this
 * database. The dry run is the first thing rendered and the rule list is read
 * underneath it, because the order is the argument: a person deciding whether
 * to let software act on their business wants to watch it not act first.
 *
 * GATING, AND THE ONE SENTENCE IT MUST NOT SAY.
 * `requireAutomationGrant('automation.view')` refuses the route for a missing
 * permission exactly as `requireGrant` would — the same `routeAccess` decision,
 * the same redirect — and renders instead of redirecting for the one refusal
 * that is about the package. `automation` sits only in the Management plan, so
 * Basic, Direct and Pro all land here: an owner on Pro holds every grant this
 * screen asks for and their package does not include the module, and telling
 * them "you may not" would send them to an administrator who cannot help.
 *
 * Below the gate the reads are gated again and separately. The dry run reads
 * bookings, tasks and payments through the three screens' own queries, each
 * behind its own grant, with `can()` per row and `redact()` per field — see
 * `_lib/queries.ts`. Somebody previewing this page without `payment.view` sees
 * the operations rules counted and the money rules reported as unreadable,
 * which is the truth rather than a confident zero.
 *
 * ── The dry run renders under the lock, and that is deliberate ────────────
 *
 * A plan lock that shows nothing is a brochure, and a brochure is the weakest
 * possible version of "your package does not include this". `simulate()`
 * performs nothing — its performer records and never acts — and the engine
 * refuses every action on the plan anyway, which is why the panel's headline
 * figure becomes "how many would have run had the package included it". That
 * number is measured on the customer's own rows. Nothing the module would have
 * *done* happens here, and nothing a permission withholds is shown either.
 *
 * ── There ARE toggles now, and the screen says what they do not do ────────
 *
 * `0067_automation_rules.sql` gives per-organization state, so the rules below
 * are the library laid under whatever this business decided — and the dry run
 * runs over THAT set rather than over the shipped one, because a preview that
 * ignored the customer's own switches would be a preview of somebody else's
 * product.
 *
 * ── The rules are now RUN, and they still do not act ──────────────────────
 *
 * `(app)/_lib/events.ts` subscribes automations to the domain event stream, and
 * `0075_automation_runs.sql` records what every listening rule decided about
 * every event: which rule, which event, what it decided, why, and what it WOULD
 * have done. `DecisionsPanel` below is that record, and it is the first thing on
 * this screen that is neither a preview nor a definition — it is what happened.
 *
 * ── The half that performs is now REACHABLE, and still shut ──────────────
 *
 * `automation/performing.ts` used to be called by nothing. It is called by
 * `(app)/_lib/automation-performing.ts` now, subscribed to the same stream
 * after the evaluation half. That changes what is possible and not what
 * happens: it refuses before it reaches the engine unless a named person has
 * consented for the organization in `automation_execution_consent` AND a
 * handler exists for EVERY action the enabled rules need.
 *
 * There is exactly one handler — `create_task`. So a rule that only opens a
 * task could act for a business that consented, and every rule that touches
 * anything outside the business is refused WHOLE rather than performed by
 * halves. `library.ts` ships all of those off anyway; the refusal is what
 * holds if somebody switches one on.
 *
 * So enabling a rule means it will be EVALUATED and its decision recorded, and
 * — for an organization that has consented on the settings screen, which none
 * has — it may now also open a task. It still does not mean anything is sent
 * to a guest. The banner below says that in Hebrew, the decisions panel says it
 * again above its first row, and the switch says it a third time where the
 * decision is actually made. A screen that let a toggle imply an engine would
 * be the one dishonest thing in a module built entirely around telling a zero
 * from a silence.
 */
export default async function AutomationsPage() {
  const [access, context] = await Promise.all([
    requireAutomationGrant('automation.view'),
    shellContext(),
  ])

  // `requireAutomationGrant` redirects when the context is not ready, so this
  // is narrowing for the type system rather than a second decision.
  if (!context || context.status !== 'ready') return null

  const { actor } = access
  const locked = access.kind === 'locked'

  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId
  const propertyName =
    propertyId === null
      ? null
      : (context.properties.find((property) => property.id === propertyId)
          ?.name ?? null)

  // Each control is offered only when the route behind it would admit them.
  // `template.manage` carries no entitlement in the catalogue, so the library
  // is core product and this link is honest on every package.
  const linkTemplates = holdsGrant(actor, 'template.manage')
  const mayReachBilling = holdsGrant(actor, 'organization.billing.manage')

  const mayManage = mayManageAutomation(actor, propertyId)

  let inputs: DryRunInputs | null = null
  let views: readonly RuleView[] = []
  let totals: DryRunHeadline | null = null
  let decisions: readonly RecordedDecision[] = []
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const { db, repo } = await financeRepository()

    // Read first, and never fall back to the shipped set if it fails. A screen
    // that renders switches from rules it could not read the state of would
    // show every rule at its default and invite somebody to "fix" one that was
    // already correct — and the write behind that click would be a real change
    // made on the strength of a wrong picture.
    const resolved = resolveRules(
      await new AutomationRuleRepository(db).stored(actor.organizationId),
      propertyId,
    )
    const states = new Map<string, ResolvedRule>(
      resolved.map((entry) => [entry.rule.id, entry]),
    )

    // The record of what the rules decided on real events. Read here rather
    // than in its own boundary because a failure to read it is a failure of
    // this screen: a decision list that quietly rendered empty would say "your
    // rules have never decided anything", which is a claim about the business
    // made out of a claim about ESTIA. Zero and unreadable are different.
    decisions = await new AutomationRunRepository(db).recent(
      actor.organizationId,
      propertyId,
      DECISION_SAMPLE,
    )

    inputs = await loadDryRunInputs({ db, repo, actor, propertyId })
    const candidates: readonly Candidate[] = candidateEvents(
      actor.organizationId,
      inputs.rows,
      new Date(),
    )
    const dryRun = await simulate(actor, configuredRules(resolved), candidates)
    views = ruleViews(actor, dryRun, candidates, states)
    totals = headline(views, dryRun)
  } catch (cause) {
    // A dry run that failed must not render as a dry run that found nothing.
    // Zero is a claim about the business; a failure is a claim about ESTIA.
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          אוטומציות
        </h1>
        <p className="text-muted-foreground">
          כל אוטומציה היא משפט אחד: מתי, בתנאי מה, ואז מה.{' '}
          {propertyName
            ? `ההרצה היבשה למטה רצה על הנתונים של ״${propertyName}״.`
            : 'ההרצה היבשה למטה רצה על הנתונים של כל הנכסים שבטווח שלך.'}
        </p>
      </header>

      {access.kind === 'locked' && (
        <AutomationPlanLock
          entitlement={access.entitlement}
          includes={MODULE_INCLUDES}
          mayReachBilling={mayReachBilling}
        />
      )}

      {failure ? (
        <ActionError error={failure.error} />
      ) : (
        <>
          {inputs !== null && totals !== null && (
            <DryRunPanel headline={totals} inputs={inputs} locked={locked} />
          )}

          {/* Under the preview and above the rules, because that is the order
              somebody uses them in: watch what would happen, then read what did
              get decided, then change a switch. */}
          <DecisionsPanel
            decisions={decisions}
            sample={DECISION_SAMPLE}
            propertyName={propertyName}
            ruleNames={RULE_NAMES}
          />

          <section
            aria-labelledby="rules-title"
            className="flex flex-col gap-4"
          >
            <div className="flex flex-col gap-2">
              <h2
                id="rules-title"
                className="font-display text-xl font-bold tracking-tight text-foreground"
              >
                {views.length === 1
                  ? 'כלל אחד'
                  : `${views.length} הכללים שהמערכת מכירה`}
              </h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                אלה הכללים ש-ESTIA מגיעה איתם, במצב שבו הם נמצאים כאן: כל מה
                שמדבר אל אורח, מוציא כסף או מפיק מסמך מגיע כבוי עד שמאשרים את
                הנוסח, וכל שינוי שעשיתם מוצג כאן במקום ברירת המחדל.{' '}
                {propertyName
                  ? `המתגים למטה נכתבים לנכס ״${propertyName}״ בלבד.`
                  : 'המתגים למטה נכתבים לכל הנכסים בארגון.'}
              </p>

              {/* The absence, once, in full, before the first switch. The
                  switch says it again — the belief is formed at the click. */}
              <p className="rounded-lg border border-border-strong bg-muted px-4 py-3 text-sm leading-relaxed text-foreground">
                <span className="font-semibold">
                  מה שמתג כאן עושה, ומה שהוא עדיין לא עושה:
                </span>{' '}
                ההחלטה איזה כלל דולק נשמרת, נרשמת ביומן הפעילות עם השם והזמן,
                וההרצה היבשה שלמעלה מתחשבת בה. מעכשיו הכלל גם מוכרע באמת: על כל
                אירוע שקורה בעסק המערכת בודקת אם הכלל דלוק ואם התנאים שלו
                התקיימו, ורושמת את ההחלטה — זה מה שמופיע בלוח ״מה הכללים
                החליטו״. מה שעדיין לא קורה הוא הביצוע: לאף אחת משמונה הפעולות
                אין מבצע, והפעלת ביצוע בפועל דורשת אישור נפרד של אדם בשם מלא לכל
                ארגון, שכבוי בכל הארגונים. כלל שדולק כאן יוכרע וייכתב, ולא ישלח
                דבר.
              </p>
            </div>

            <ul className="flex flex-col gap-4">
              {views.map((view) => (
                <li key={view.rule.id}>
                  <RuleCard
                    view={view}
                    control={
                      // No switch under a plan lock, and deliberately not a
                      // disabled one: `mayManageAutomation` answers false for
                      // a missing package exactly as it does for a missing
                      // permission, and the switch's own refusal line names
                      // the role. Showing it here would send an owner whose
                      // role is perfectly correct to an administrator who
                      // cannot help — the one sentence `_lib/gate.ts` exists
                      // to stop this screen saying. The lock panel above
                      // already says the true one.
                      view.state === null || locked ? null : (
                        <RuleSwitch
                          templateId={view.rule.id}
                          ruleName={view.rule.name}
                          enabled={view.rule.enabled}
                          source={view.state.source}
                          storedVersion={view.state.stored?.version ?? null}
                          propertyId={propertyId}
                          propertyName={propertyName}
                          parameters={parametersFor(view.rule.id)}
                          values={view.state.parameters}
                          overrideCount={
                            view.state.overriddenAtProperties.length
                          }
                          canManage={mayManage}
                          reachesGuest={reachesOutsideTheBusiness(view.rule)}
                        />
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          </section>

          {linkTemplates && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-5 py-4 shadow-soft">
              <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                ספריית התבניות מציגה את אותם כללים לפי נושא, ומה כל אחד מהם צריך
                כדי לעבוד כאן.
              </p>
              <Button href="/templates" variant="secondary">
                לספריית התבניות
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
