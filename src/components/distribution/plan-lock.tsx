/**
 * "Your package does not include this", said as an offer rather than as a
 * refusal.
 *
 * ── The distinction this component exists to protect ──────────────────────
 *
 * Two sentences look identical on screen and are opposite situations:
 *
 *   · **"you may not"** — a permission the person's role does not carry. The
 *     way out is their administrator, and the honest thing is to say which
 *     grant is missing so somebody can grant it.
 *   · **"your package does not include this"** — the person's role is fine and
 *     the feature is not bought. The way out is the billing screen, and telling
 *     them they lack a permission sends them to the wrong person, who then
 *     cannot help them, and the business concludes the product is broken.
 *
 * `authorize()` has always distinguished the two — `plan_does_not_include`
 * carries the `Entitlement` — and the menu already renders the difference as a
 * `locked` item. This is the same distinction one level further in, for the
 * person who arrived at the route directly, from a bookmark, or through a link
 * a colleague sent them.
 *
 * ── It is not a security boundary and does not pretend to be ──────────────
 *
 * Nothing is hidden here that a permission would otherwise reveal: the screen
 * behind it never renders, no query is built, and the same refusal is made
 * again by `authorize()` on every action and by row level security underneath.
 * What this changes is the wording, and only the wording.
 *
 * ── What it does not say ──────────────────────────────────────────────────
 *
 * A price. `SEED_PLANS` carries the catalogue's figures and this component
 * deliberately does not read them: an organization's agreed price can differ
 * from the catalogue's — `agreedPrice` and `isGrandfathered` in `plans/plan.ts`
 * exist precisely because it does — and quoting the list price at somebody
 * holding a negotiated one is a number they will hold the business to.
 *
 * A link to a billing screen, either. `MENU` marks `billing` as `planned` and
 * the route does not exist, so a prominent "upgrade" button here would be a
 * confident path to a 404 — which is a worse experience than the refusal it was
 * meant to soften. The action offered is the one page that genuinely lists what
 * this organization's package includes, which is the dashboard, and it is
 * reachable by every active member.
 *
 * No `"use client"`: a name in, markup out.
 */

import { EmptyState } from '@/components/states/empty-state'
import { Button } from '@/components/ui/button'
import { entitlementLabel } from '@/components/nav/labels'
import type { Entitlement } from '@/lib/plans/entitlements'

export function PlanLock({
  entitlement,
  title,
  body,
}: {
  /**
   * The feature that would unlock the screen, or `null` when the engine could
   * not name one — which is a state worth rendering honestly rather than
   * guessing a feature name into.
   */
  entitlement: Entitlement | null
  /** What the person came here to do, in their words. */
  title: string
  /** What the module would give them. Written as value, not as a feature list. */
  body: string
}) {
  const feature = entitlement === null ? null : entitlementLabel(entitlement)

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <EmptyState
        as="h1"
        illustration="invoice"
        title={title}
        body={
          feature === null
            ? `${body} התכונה אינה כלולה בחבילה הנוכחית של העסק. זו אינה שאלה של הרשאה — ההרשאות שלך תקינות.`
            : `${body} התכונה ״${feature}״ אינה כלולה בחבילה הנוכחית של העסק — זו אינה שאלה של הרשאה, וההרשאות שלך תקינות. אפשר להוסיף אותה לחבילה הקיימת בלי להחליף חבילה.`
        }
        action={
          <Button href="/dashboard" variant="secondary">
            מה כלול בחבילה שלנו
          </Button>
        }
      />

      {/* Said separately from the body so it cannot be mistaken for part of the
          sales pitch: the person should not go and ask for a permission they
          already hold. */}
      <p
        role="status"
        className="mx-auto max-w-prose text-center text-sm text-muted-foreground"
      >
        אין צורך לבקש הרשאה — ההרשאה קיימת. מה שחסר הוא התכונה בחבילה.
      </p>
    </div>
  )
}
