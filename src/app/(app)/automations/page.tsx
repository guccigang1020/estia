import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { financeRepository } from '../finance/_lib/wiring'
import { DryRunPanel } from './_components/dry-run-panel'
import { AutomationPlanLock } from './_components/plan-lock'
import { RuleCard } from './_components/rule-card'
import { candidateEvents, simulate, type Candidate } from './_lib/dry-run'
import { requireAutomationGrant } from './_lib/gate'
import { loadDryRunInputs, type DryRunInputs } from './_lib/queries'
import {
  headline,
  ruleViews,
  shippedRules,
  type DryRunHeadline,
  type RuleView,
} from './_lib/rules'

export const metadata: Metadata = { title: 'אוטומציות' }

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
 * ── There is no toggle, and the screen says why ───────────────────────────
 *
 * No migration creates an `automation_rules` table and `library.ts` says so in
 * its own header: a template is a definition that gets copied, and
 * per-organization enablement needs storage this deployment does not have. So
 * the rules are the shipped set in the shipped state, and the absence of a
 * switch is stated once rather than rendered as a control that would forget
 * itself on reload.
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

  let inputs: DryRunInputs | null = null
  let views: readonly RuleView[] = []
  let totals: DryRunHeadline | null = null
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const { db, repo } = await financeRepository()
    inputs = await loadDryRunInputs({ db, repo, actor, propertyId })
    const candidates: readonly Candidate[] = candidateEvents(
      actor.organizationId,
      inputs.rows,
      new Date(),
    )
    const dryRun = await simulate(actor, shippedRules(), candidates)
    views = ruleViews(actor, dryRun, candidates)
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
                אלה הכללים ש-ESTIA מגיעה איתם, במצב שבו הם מגיעים: כל מה שמדבר
                אל אורח, מוציא כסף או מפיק מסמך מגיע כבוי עד שמאשרים את הנוסח.
                עריכה וכיבוי לכל ארגון בנפרד דורשים אחסון שעדיין אינו קיים
                במוצר, ולכן אין כאן מתגים — מתג שלא נשמר גרוע ממתג שאינו קיים.
              </p>
            </div>

            <ul className="flex flex-col gap-4">
              {views.map((view) => (
                <li key={view.rule.id}>
                  <RuleCard view={view} />
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
