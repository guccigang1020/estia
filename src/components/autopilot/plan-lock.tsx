/**
 * "Autopilot is not in your package", said as an offer.
 *
 * ── Why a fourth plan lock ───────────────────────────────────────────────
 *
 * Three exist — finance, distribution and automations — and all three make the
 * argument this one inherits: `authorize()` returns two different noes,
 * `missing_permission` is a conversation with an administrator and
 * `plan_does_not_include` is a conversation with whoever owns the package, and
 * rendering the first for the second sends somebody to a person who cannot
 * help them.
 *
 * What is different here is that this is the DEFAULT state of the product.
 * 0046 refuses to put `autopilot` on any plan — the rehearsal at the bottom of
 * the migration raises if one carries it — because the brief opens by saying
 * Autopilot must not be available automatically to every organization. It
 * reaches a customer through `organization_subscriptions.entitlement_grants`,
 * written by the platform console, one customer at a time. So almost every
 * person who ever opens `/autopilot` will see this screen, and it has to be
 * the good version.
 *
 * ── It says what ESTIA would do, in the customer's own operation ─────────
 *
 * Not a feature list. The lines the caller passes are things that happen in a
 * guesthouse — a late laundry van, a deposit nobody chased, a code nobody
 * sent — because "intelligent operations layer" is a phrase that sells nothing
 * to somebody deciding at 22:00 whether tomorrow is covered.
 *
 * ── It does not quote a price, and it checks before linking ──────────────
 *
 * Both for the reasons `automations/_components/plan-lock.tsx` sets out.
 * `agreedPrice` and `isGrandfathered` exist because an organization's real
 * price can differ from the catalogue, and quoting the list price at somebody
 * holding a negotiated one is a number they will hold the business to. And the
 * billing link is rendered only for a reader the billing route would admit,
 * because a link that redirects back with `?denied=` reads as the refusal this
 * component exists to avoid.
 *
 * ── Why it does not mention the capability state ─────────────────────────
 *
 * `autopilot_capability` can say `suspended`, with a note naming why ESTIA
 * withdrew it. That is a real thing to tell a customer and it is not this
 * component's to tell: it arrives as `note`, from the caller, or not at all.
 * Inventing "your access was suspended" from a missing entitlement would be
 * this screen guessing at the platform's reasons.
 *
 * No `"use client"`: values in, markup out.
 */

import { entitlementLabel } from '@/components/nav/labels'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { Entitlement } from '@/lib/plans/entitlements'

export type AutopilotPlanLockProps = {
  /** The feature that would unlock this, or null when the engine named none. */
  entitlement: Entitlement | null
  /** What ESTIA would do, in the reader's own operation. */
  includes: readonly string[]
  /** Whether `/settings/billing` would admit this reader. Checked by the page. */
  mayReachBilling: boolean
  /** The platform's own note, when there is one. Never composed here. */
  platformNote?: string | null
}

export function AutopilotPlanLock({
  entitlement,
  includes,
  mayReachBilling,
  platformNote = null,
}: AutopilotPlanLockProps) {
  const feature = entitlement === null ? null : entitlementLabel(entitlement)

  return (
    <section
      // `status`, not `alert`: nothing has gone wrong and nothing needs doing
      // this second. It is a statement about the package.
      role="status"
      aria-labelledby="autopilot-plan-lock-title"
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
          id="autopilot-plan-lock-title"
          className="font-display text-xl font-bold tracking-tight text-foreground sm:text-2xl"
        >
          ESTIA Autopilot אינה כלולה בחבילה הנוכחית
        </h2>
        <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">
          זו אינה שאלה של הרשאה. ההרשאות שלך תקינות והמסך הזה פתוח בפניך — מה
          שחסר הוא היכולת בחבילה של העסק. Autopilot אינה חלק מאף חבילה: היא
          נפתחת ללקוח אחד בכל פעם, מול ESTIA, ואפשר להוסיף אותה לחבילה הקיימת
          בלי להחליף חבילה.
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

      <p className="rounded-lg bg-muted px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        גם כשהיא נפתחת, היא מתחילה בסימולציה: שבועיים שבהם ESTIA רושמת מה הייתה
        עושה ולא עושה דבר. אף הודעה אינה יוצאת החוצה עד שמישהו קורא את הרישום
        ומחליט.
      </p>

      {platformNote !== null && platformNote.length > 0 && (
        <p className="text-sm text-foreground">
          <span className="font-medium">הערה מ־ESTIA:</span> {platformNote}
        </p>
      )}

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
