/**
 * "Your package does not include this", said as an offer — and measured.
 *
 * The third such lock in the product, and it inherits the argument the first
 * two make: `authorize()` returns two different noes, `missing_permission` is
 * a conversation with an administrator and `plan_does_not_include` is a
 * conversation with whoever owns the package. Rendering the first for the
 * second sends somebody to a person who cannot help them.
 *
 * ── Who actually lands here, which is the reason it is not a brochure ─────
 *
 * `/insights` admits anyone holding `automation.view` **or**
 * `report.financial.view`. The person who reaches this lock is therefore the
 * one whose only door was automation: a general manager, who holds
 * `automation.view` and no financial grant at all, on a package below
 * Management. They are not missing a permission — they hold the one this
 * screen asks for — and telling them otherwise would be the exact failure the
 * finance and distribution locks were written to avoid.
 *
 * So the lock states a number measured on their own rows: how many insights
 * the screen found in this window. Following `automations/page.tsx`, whose dry
 * run makes the same argument — a plan lock that shows nothing is the weakest
 * possible version of "not included" — the *count* and the *titles* are shown
 * and not one figure, headline or piece of evidence. The titles are static
 * labels from the rule catalogue and disclose nothing; the count is real.
 *
 * ── It does not quote a price ─────────────────────────────────────────────
 *
 * `SEED_PLANS` carries the catalogue's figures and this deliberately does not
 * read them: an organization's real price can differ from the list, and
 * quoting the list price at somebody holding a negotiated one is a number they
 * will hold the business to.
 *
 * No `"use client"`: values in, markup out.
 */

import { entitlementLabel } from '@/components/nav/labels'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { Entitlement } from '@/lib/plans/entitlements'

/** What the screen buys, in the reader's terms. Concrete, never a brochure. */
export const INSIGHTS_INCLUDE: readonly string[] = [
  'כל תובנה נושאת את החישוב שלה: המונה, המכנה, התקופה וקישור למסך שבו שוכבות השורות.',
  'המספרים נלקחים ממילון המדדים של המוצר, ולכן הם זהים לאלה שבדוחות ובלוח הבית.',
  'תובנה שאין לה נתון מותר — או שהחבילה אינה כוללת אותו — נעדרת ומוסברת, ולעולם אינה מוצגת כאפס.',
  'תקופה בלי היסטוריה להשוואה נאמרת ככזאת, במקום להיות מצוירת כקו שטוח.',
]

export type InsightsPlanLockProps = {
  /** The feature that would unlock it, or null when the engine named none. */
  entitlement: Entitlement | null
  /** How many insights this reader's own rows produced in this window. */
  found: number
  /** How many rules exist, so the count has a denominator. */
  total: number
  /** The titles of the insights that fired. Static labels, never figures. */
  titles: readonly string[]
  /** The window, in words. */
  periodLabel: string
  /** Whether `/settings/billing` would admit this reader. Checked by the page. */
  mayReachBilling: boolean
}

export function InsightsPlanLock({
  entitlement,
  found,
  total,
  titles,
  periodLabel,
  mayReachBilling,
}: InsightsPlanLockProps) {
  const feature = entitlement === null ? null : entitlementLabel(entitlement)

  return (
    <section
      // `status`, not `alert`: nothing has gone wrong and nothing needs doing
      // this second. It is a statement about the package.
      role="status"
      aria-labelledby="insights-plan-lock-title"
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
          id="insights-plan-lock-title"
          className="font-display text-xl font-bold tracking-tight text-foreground sm:text-2xl"
        >
          תובנות אינן כלולות בחבילה הנוכחית
        </h2>
        <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">
          זו אינה שאלה של הרשאה. ההרשאה שבזכותה המסך הזה נפתח בפניך קיימת — מה
          שחסר הוא היכולת בחבילה של העסק. אפשר להוסיף אותה בלי להחליף חבילה.
        </p>
      </div>

      {/* Measured on this customer's own rows, with this reader's own grants,
          and showing not one figure. See the header. */}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
        <p className="text-sm font-semibold text-foreground">
          מה היה נמצא כאן ב{periodLabel}
        </p>
        <p className="text-sm text-muted-foreground">
          {found === 0
            ? `אף אחת מ־${total} התובנות לא מצאה דבר בנתונים של התקופה הזאת. גם זו תשובה, והיא נמדדה על השורות שלך.`
            : `${found} מתוך ${total} התובנות מצאו משהו בנתונים שלך. הכותרות למטה הן שמות התובנות בלבד — לא נבדק ולא מוצג כאן שום מספר.`}
        </p>

        {titles.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {titles.map((title) => (
              <li key={title}>
                <Badge tone="neutral">{title}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ul className="flex flex-col gap-2 text-sm text-foreground">
        {INSIGHTS_INCLUDE.map((line) => (
          <li key={line} className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className="mt-2 size-1.5 shrink-0 rounded-full bg-accent"
            />
            <span>{line}</span>
          </li>
        ))}
      </ul>

      {/* The link is rendered only for somebody the billing route would let
          in. A link rendered for anybody else lands them on a redirect
          carrying `?denied=organization.billing.manage`, which reads as the
          refusal this whole component exists to avoid. */}
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
