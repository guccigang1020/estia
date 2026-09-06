/**
 * "Custom roles are not in your package", said as an offer.
 *
 * The pattern and the argument are `automations/_components/plan-lock.tsx`'s,
 * and both are worth restating because this is the fourth copy in the product
 * and copies invite the question "why not one component".
 *
 * `authorize()` returns two different noes. `missing_permission` is a
 * conversation with an administrator; `plan_does_not_include` is a
 * conversation with whoever owns the package. Rendering the first for the
 * second sends somebody to a person who cannot help them. Here the engine
 * answers the second, because `ENTITLEMENT_FOR_GRANT` maps `role.create` and
 * `permission.edit` to `custom_roles` — so an owner holding every permission
 * in the catalogue still gets this panel on a package that does not sell it,
 * and they are exactly the person who can do something about it.
 *
 * ── Why this is not the automations component imported ────────────────────
 *
 * Its heading, its bullet list and its argument are about automations. What is
 * shared between the four is a shape, not content — and a shared component
 * with the heading and the bullets passed in as props is that shape with extra
 * steps, plus a props file nobody reads. The behaviour that actually matters
 * is copied deliberately and is stated here:
 *
 *   · the billing link is rendered only for somebody `/settings/billing` would
 *     admit. A general manager holds `role.assign` and not
 *     `organization.billing.manage`, and a link they cannot follow lands them
 *     on `?denied=organization.billing.manage` — which reads as the refusal
 *     this panel exists to avoid.
 *   · no price is quoted. `agreedPrice` and `isGrandfathered` exist in
 *     `plans/plan.ts` because a customer's real price can differ from the
 *     list, and quoting the list at somebody on a negotiated one is a number
 *     they will hold the business to.
 *
 * No `"use client"`: values in, markup out.
 */

import { entitlementLabel } from '@/components/nav/labels'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { Entitlement } from '@/lib/plans/entitlements'

export function CustomRolesPlanLock({
  entitlement,
  mayReachBilling,
}: {
  /** The feature that would unlock this, or null when the engine named none. */
  entitlement: Entitlement | null
  /** Whether `/settings/billing` would admit this reader. Checked by the page. */
  mayReachBilling: boolean
}) {
  const feature = entitlement === null ? null : entitlementLabel(entitlement)

  return (
    <section
      // `status`, not `alert`: nothing has gone wrong and nothing needs doing
      // this second. It is a statement about the package.
      role="status"
      aria-labelledby="custom-roles-plan-lock-title"
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
          id="custom-roles-plan-lock-title"
          className="font-display text-xl font-bold tracking-tight text-foreground sm:text-2xl"
        >
          תפקידים מותאמים אינם כלולים בחבילה הנוכחית
        </h2>
        <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">
          זו אינה שאלה של הרשאה. ההרשאות שלך תקינות והמסך הזה פתוח בפניך — מה
          שחסר הוא היכולת בחבילה של העסק. עשרים התפקידים שהמערכת מגיעה איתם
          ממשיכים לעבוד במלואם.
        </p>
      </div>

      <ul className="flex flex-col gap-2 text-sm text-foreground">
        {[
          'הרכבת תפקיד משלכם מתוך אותו קטלוג הרשאות שהמנוע קורא בכל בקשה',
          'תפקיד שמתאים למבנה של העסק — ״אחראי משמרת״, ״מנהל אירועים״ — ולא רק לרשימה שהמערכת הביאה',
          'שינוי ההרשאות של התפקיד בלי לגעת באף אדם, וכל שינוי נרשם ביומן הביקורת',
          'תפקיד מותאם לעולם אינו מקנה יותר ממה שיש למי שיצר אותו — הכלל נאכף גם במסד הנתונים',
        ].map((line) => (
          <li key={line} className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className="mt-2 size-1.5 shrink-0 rounded-full bg-accent"
            />
            <span>{line}</span>
          </li>
        ))}
      </ul>

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
