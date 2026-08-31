/**
 * A screen the organization's package does not include.
 *
 * ── Why this is not the ordinary refusal ──────────────────────────────────
 *
 * `authorize()` returns two different noes and the difference matters to the
 * person reading: `missing_permission` means "your role does not allow this,
 * and somebody in your business can change that", and `plan_does_not_include`
 * means "nobody in your business can do this until the package changes". The
 * shell's own refusal — a redirect to the dashboard reading "המסך שביקשת דורש
 * הרשאה שאין לך" — is the first sentence, and showing it for the second sends
 * an owner to ask their administrator for a permission that does not exist on
 * their plan.
 *
 * So a route whose whole grant family is gated on an entitlement refuses on the
 * permission and renders the plan half here, where it can say which feature is
 * missing and what it would open.
 *
 * Colour is never the only signal, and the feature is always named.
 *
 * No `"use client"`: text in, markup out.
 */

import { entitlementLabel } from '@/components/nav/labels'
import { Badge } from '@/components/ui/badge'
import type { Entitlement } from '@/lib/plans/entitlements'

export type PlanLockProps = {
  entitlement: Entitlement
  /** What the screen would be, in one sentence, for somebody deciding. */
  title: string
  body: string
  /** The concrete things the feature adds. Three or four, never a brochure. */
  includes: readonly string[]
}

export function PlanLock({
  entitlement,
  title,
  body,
  includes,
}: PlanLockProps) {
  return (
    <section
      // `status`, not `alert`: nothing has gone wrong and nothing needs doing
      // this second. It is a statement about the package.
      role="status"
      aria-labelledby="plan-lock-title"
      className="mx-auto flex w-full max-w-prose flex-col gap-5 rounded-xl border border-border-strong bg-surface px-6 py-10 shadow-soft sm:px-10 sm:py-12"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone="accent">לא כלול בחבילה</Badge>
        <span className="text-sm text-muted-foreground">
          היכולת נקראת{' '}
          <span className="font-semibold text-foreground">
            {entitlementLabel(entitlement)}
          </span>
        </span>
      </div>

      <div className="flex flex-col gap-2.5">
        <h2
          id="plan-lock-title"
          className="font-display text-xl font-bold tracking-tight text-foreground sm:text-2xl"
        >
          {title}
        </h2>
        <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">
          {body}
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

      {/* No upgrade button. There is no billing screen behind it yet, and a
          control that navigates nowhere is worse than a sentence that says who
          to ask. */}
      <p className="text-xs text-muted-foreground">
        שינוי חבילה נעשה מול בעלי הארגון. עד אז המסך הזה נשאר סגור — לא בגלל
        הרשאה חסרה, אלא בגלל מה שהחבילה כוללת.
      </p>
    </section>
  )
}
