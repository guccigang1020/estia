import type { Metadata } from 'next'

import { Button } from '@/components/ui/button'
import {
  AUTOMATION_ENTITLEMENT,
  TEMPLATE_CATEGORIES,
  TEMPLATE_CATEGORY_LABEL,
  ruleReadiness,
  templatesFor,
} from '@/lib/automation'
import { holdsGrant } from '@/lib/authz/can'

import { requireGrant } from '../_lib/guard'
import { TemplateCard } from './_components/template-card'

export const metadata: Metadata = { title: 'תבניות אוטומציה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The template library.
 *
 * WHAT IS ON THIS SCREEN. The rules ESTIA ships, grouped the way a hotelier
 * thinks about their business rather than the way the event catalogue is
 * ordered — the stay, the money, the operation, the governance. Each entry says
 * why a business would want it, what it actually does in WHEN · IF · THEN, and
 * what would have to be true for it to work here.
 *
 * GATING. `requireGrant('template.manage')` refuses the route. That grant
 * carries **no entitlement** in `ENTITLEMENT_FOR_GRANT`, deliberately, and the
 * consequence is the point of this screen existing separately from
 * `/automations`: the library is core product on every package. A customer on
 * Basic can read what the module would do for them, priced in their own words,
 * before anybody asks them for money. Hiding the catalogue behind the feature
 * it sells is how a product loses the upgrade it was one screen from.
 *
 * Nothing here is a plan lock, because nothing here is refused on the plan.
 * What the package changes is the *answer* on each card — `ruleReadiness`
 * returns `module_locked` and the adoption path says which conversation that
 * is — and the wording is an upgrade rather than a refusal in every one of
 * those sentences.
 *
 * ── There is no adopt button ──────────────────────────────────────────────
 *
 * No migration creates a rules table, so copying a template into an
 * organization is not a write this deployment can perform. `_lib/adoption.ts`
 * says so as the last step rather than rendering a control that would appear to
 * work and would not.
 *
 * ── No data is read ───────────────────────────────────────────────────────
 *
 * This screen touches no table. `AUTOMATION_TEMPLATES` is a constant and
 * `ruleReadiness` is a pure function of the actor, so there is nothing to fail,
 * nothing to page and no empty state that could mean two things. The dry run —
 * the part that reads real rows — lives on `/automations`, and the link at the
 * bottom is offered only to somebody that route would admit.
 */
export default async function TemplatesPage() {
  const actor = await requireGrant('template.manage')

  const moduleAvailable = actor.entitlements.has(AUTOMATION_ENTITLEMENT)

  // Offered only when the route behind it would admit them. `automation.view`
  // and not the entitlement: a reader holding the grant on a package without
  // the module reaches `/automations` and is shown the upgrade, which is a real
  // destination. A reader without the grant would be redirected, so they are
  // not offered the link at all.
  const linkAutomations = actor.grants.has('automation.view')
  const mayReachBilling = holdsGrant(actor, 'organization.billing.manage')

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-8 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          תבניות אוטומציה
        </h1>
        <p className="max-w-prose text-muted-foreground">
          אלה הכללים שכל עסק אירוח כותב לעצמו בסוף, כבר מנוסחים ומכוונים לאירוע
          הנכון. כל תבנית אומרת מה היא עושה, למה, ומה צריך להתקיים כדי שהיא
          תעבוד אצלך.
        </p>
      </header>

      {!moduleAvailable && (
        <section
          // `status`, not `alert`. Nothing has gone wrong.
          role="status"
          className="flex flex-col gap-3 rounded-xl border border-accent-strong/40 bg-accent-soft px-5 py-4"
        >
          <p className="text-sm leading-relaxed text-foreground">
            <span className="font-semibold">
              הספרייה פתוחה בפניך במלואה, וההרצה שלה אינה כלולה בחבילה הנוכחית.
            </span>{' '}
            זו אינה שאלה של הרשאה — ההרשאות שלך תקינות. כל כרטיס למטה אומר בדיוק
            מה היה קורה אם המודול היה בחבילה.
          </p>
          {mayReachBilling && (
            <div>
              <Button href="/settings/billing" variant="secondary">
                לצפייה בחבילה ובחיוב
              </Button>
            </div>
          )}
        </section>
      )}

      {TEMPLATE_CATEGORIES.map((category) => {
        const entries = templatesFor(category)
        if (entries.length === 0) return null

        return (
          <section
            key={category}
            aria-labelledby={`category-${category}`}
            className="flex flex-col gap-4"
          >
            <div className="flex flex-wrap items-baseline gap-3">
              <h2
                id={`category-${category}`}
                className="font-display text-xl font-bold tracking-tight text-foreground"
              >
                {TEMPLATE_CATEGORY_LABEL[category]}
              </h2>
              <span className="text-sm text-muted-foreground">
                {entries.length === 1
                  ? 'תבנית אחת'
                  : `${entries.length} תבניות`}
              </span>
            </div>

            <ul className="flex flex-col gap-4">
              {entries.map((template) => (
                <li key={template.rule.id}>
                  <TemplateCard
                    template={template}
                    readiness={ruleReadiness(actor, template.rule)}
                  />
                </li>
              ))}
            </ul>
          </section>
        )
      })}

      {linkAutomations && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-5 py-4 shadow-soft">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            מסך האוטומציות מריץ את כל הכללים האלה על ההזמנות, המשימות והתשלומים
            שקיימים אצלך באמת — בלי לבצע דבר — ומראה על אילו שורות הם היו
            פועלים.
          </p>
          <Button href="/automations" variant="secondary">
            להרצה יבשה על הנתונים שלך
          </Button>
        </div>
      )}
    </div>
  )
}
