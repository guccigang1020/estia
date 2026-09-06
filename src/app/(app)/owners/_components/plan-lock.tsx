/**
 * "Your package does not include the owner portal", said as an offer.
 *
 * A fourth plan lock, and the reason it is not an import of one of the three
 * that exist is behaviour rather than taste. `components/finance/plan-lock.tsx`
 * belongs to the finance screens and takes their props;
 * `automations/_components/plan-lock.tsx` belongs to another screen group's
 * `_lib`, and importing a refusal component across screen groups makes one
 * group's refusal policy the other's dependency. The one line that matters —
 * which entitlement is missing — is read from the catalogue's own
 * `ENTITLEMENT_FOR_GRANT` by the gate in both places, so the two cannot
 * disagree about the answer even though they are two components.
 *
 * ── It offers the billing screen, and it checks first ─────────────────────
 *
 * The grant is checked before the link is rendered, never after. A finance
 * manager holds `owner_statement.view` and not `organization.billing.manage`,
 * so they get the sentence naming who to ask; an owner holds both and gets the
 * link. Rendering the link for the first would land them on a redirect back to
 * the dashboard carrying `?denied=organization.billing.manage`, which reads as
 * the refusal this component exists to avoid.
 *
 * ── It does not quote a price ─────────────────────────────────────────────
 *
 * `plans/plan.ts` carries `agreedPrice` and `isGrandfathered` because an
 * organization's real price can differ from the catalogue's, and quoting the
 * list price at somebody holding a negotiated one is a number they will hold
 * the business to.
 *
 * No `"use client"`: values in, markup out.
 */

import { entitlementLabel } from '@/components/nav/labels'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { Entitlement } from '@/lib/plans/entitlements'

/** What the module buys, in the reader's terms. Concrete, never a brochure. */
export const OWNER_PORTAL_INCLUDES: readonly string[] = [
  'גישה נפרדת לכל בעלים, שרואה את הנכס שלו בלבד — לא נכסים של בעלים אחרים, ולא את הדוח של שותף לאותו נכס.',
  'דוח תקופתי שמסתדר עם הכספים: הכנסה, ניכויים, הוצאות, דמי ניהול וחלק הבעלים — כל שורה מוסברת, והסכום הוא סכום השורות.',
  'הפקה שסוגרת את הדוח כמסמך. דוח שהופק אינו ניתן לעריכה, ותיקון נעשה בהפקת דוח מתקן.',
  'בעלים אינו רואה אורח: לא שם, לא טלפון, לא דוא״ל, ולא מי מכר את הלילה או כמה הרוויח עליו.',
  'בקשות שדורשות את הכרעת הבעלים — תחזוקה חריגה, שדרוג, החזר חריג, שיפוץ מתוכנן — באותו מנגנון אישורים של שאר המערכת.',
]

export type OwnerPlanLockProps = {
  /** The feature that would unlock this, or null when the engine named none. */
  entitlement: Entitlement | null
  /** Whether `/settings/billing` would admit this reader. Checked by the page. */
  mayReachBilling: boolean
}

export function OwnerPlanLock({
  entitlement,
  mayReachBilling,
}: OwnerPlanLockProps) {
  const feature = entitlement === null ? null : entitlementLabel(entitlement)

  return (
    <section
      // `status`, not `alert`: nothing has gone wrong and nothing needs doing
      // this second. It is a statement about the package.
      role="status"
      aria-labelledby="owner-plan-lock-title"
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
          id="owner-plan-lock-title"
          className="font-display text-xl font-bold tracking-tight text-foreground sm:text-2xl"
        >
          פורטל הבעלים אינו כלול בחבילה הנוכחית
        </h2>
        <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">
          זו אינה שאלה של הרשאה. כל ההרשאות שקשורות לבעלי נכסים פתוחות רק בחבילה
          שכוללת את פורטל הבעלים, ולכן אף תפקיד בארגון — כולל בעלי הארגון — לא
          יוכל לפתוח את המסך הזה עד שהחבילה תשתנה. אפשר להוסיף את היכולת לחבילה
          הקיימת בלי להחליף חבילה.
        </p>
      </div>

      <ul className="flex flex-col gap-2 text-sm text-foreground">
        {OWNER_PORTAL_INCLUDES.map((line) => (
          <li key={line} className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className="mt-2 size-1.5 shrink-0 rounded-full bg-accent"
            />
            <span>{line}</span>
          </li>
        ))}
      </ul>

      {/* Rendered only for somebody the billing route would let in. */}
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
