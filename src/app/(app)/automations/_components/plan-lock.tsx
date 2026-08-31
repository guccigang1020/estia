/**
 * "Your package does not include this", said as an offer.
 *
 * Two plan locks already exist — `components/finance/plan-lock.tsx` and
 * `components/distribution/plan-lock.tsx` — and both make the argument this one
 * inherits: `authorize()` returns two different noes, `missing_permission` is a
 * conversation with an administrator and `plan_does_not_include` is a
 * conversation with whoever owns the package, and rendering the first for the
 * second sends somebody to a person who cannot help them.
 *
 * This is a third rather than an import for two reasons that are about
 * behaviour, not about taste.
 *
 * ── It offers the billing screen, and it checks first ─────────────────────
 *
 * Both existing locks say in their headers that they deliberately offer no
 * upgrade link because `MENU` marked billing as `planned` and the route did not
 * exist. It exists now — `/settings/billing`, gated on
 * `organization.billing.manage` — so the honest offer is available, and a plan
 * lock that ends in "ask somebody" when the person reading it is the somebody
 * is a dead end for exactly the customer most likely to buy.
 *
 * The grant is checked before the link is rendered, never after. A general
 * manager holds `automation.view` and not `organization.billing.manage`, so
 * they get the sentence naming who to ask; an owner holds both and gets the
 * link. A link rendered for the first would land them on a redirect back to the
 * dashboard carrying `?denied=organization.billing.manage`, which reads as the
 * refusal this whole component exists to avoid.
 *
 * ── It does not quote a price ─────────────────────────────────────────────
 *
 * `SEED_PLANS` carries the catalogue's figures and this deliberately does not
 * read them: `agreedPrice` and `isGrandfathered` exist in `plans/plan.ts`
 * because an organization's real price can differ from the list, and quoting
 * the list price at somebody holding a negotiated one is a number they will
 * hold the business to.
 *
 * No `"use client"`: values in, markup out.
 */

import { entitlementLabel } from '@/components/nav/labels'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { Entitlement } from '@/lib/plans/entitlements'

export type AutomationPlanLockProps = {
  /** The feature that would unlock this, or null when the engine named none. */
  entitlement: Entitlement | null
  /** What the module would do, in the reader's terms. */
  includes: readonly string[]
  /** Whether `/settings/billing` would admit this reader. Checked by the page. */
  mayReachBilling: boolean
}

export function AutomationPlanLock({
  entitlement,
  includes,
  mayReachBilling,
}: AutomationPlanLockProps) {
  const feature = entitlement === null ? null : entitlementLabel(entitlement)

  return (
    <section
      // `status`, not `alert`: nothing has gone wrong and nothing needs doing
      // this second. It is a statement about the package.
      role="status"
      aria-labelledby="automation-plan-lock-title"
      className="flex w-full flex-col gap-5 rounded-xl border border-border-strong bg-surface-raised px-5 py-7 shadow-soft sm:px-8 sm:py-9"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone="accent">לא כלול בחבילה</Badge>
        {feature !== null && (
          <span className="text-sm text-muted-foreground">
            היכולת נקראת{' '}
            <span className="font-semibold text-foreground">{feature}</span>
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2.5">
        <h2
          id="automation-plan-lock-title"
          className="font-display text-xl font-bold tracking-tight text-foreground sm:text-2xl"
        >
          אוטומציות אינן כלולות בחבילה הנוכחית
        </h2>
        <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">
          זו אינה שאלה של הרשאה. ההרשאות שלך תקינות והמסך הזה פתוח בפניך — מה
          שחסר הוא היכולת בחבילה של העסק. אפשר להוסיף אותה לחבילה הקיימת בלי
          להחליף חבילה.
        </p>
      </div>

      <ul className="flex flex-col gap-2 text-sm text-foreground">
        {includes.map((line) => (
          <li key={line} className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className="mt-2 size-1.5 shrink-0 rounded-full bg-accent"
            />
            <span>{line}</span>
          </li>
        ))}
      </ul>

      {/* The link is rendered only for somebody the billing route would let in.
          See the header. */}
      {mayReachBilling ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button href="/settings/billing" variant="primary">
            לצפייה בחבילה ובחיוב
          </Button>
          <span className="text-xs text-muted-foreground">
            שינוי החבילה נעשה מול ESTIA, ומסך החיוב מראה מה כלול היום.
          </span>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          שינוי חבילה נעשה על ידי בעלי הארגון. אין צורך לבקש הרשאה — ההרשאה
          קיימת.
        </p>
      )}
    </section>
  )
}
