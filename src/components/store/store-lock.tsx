/**
 * What an organization sees when it holds the right and has not bought the
 * feature.
 *
 * ── Why this is a screen and not a redirect ──────────────────────────────
 *
 * `requireGrant` sends every refusal to the dashboard with one sentence —
 * "המסך שביקשת דורש הרשאה שאין לך" — and for a plan refusal that sentence is
 * false in the way that costs money. The owner DOES hold `product.view`; what
 * their package does not carry is `commerce`. Telling them they lack a
 * permission sends them to an administrator who cannot help, who then tells
 * them the product is broken.
 *
 * So the store's own gate returns `locked` and this renders. It offers nothing
 * the module would have done and fabricates no figures: it says what the
 * section is for, in the owner's own terms, and points at the one screen where
 * a package is changed.
 */

import Link from 'next/link'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import type { Entitlement } from '@/lib/plans/entitlements'

export function StoreLock({
  entitlement,
  title,
  body,
}: {
  entitlement: Entitlement | null
  title: string
  body: string
}) {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <Card tone="featured">
        <CardHeader>
          <CardTitle as="h1">{title}</CardTitle>
          <CardDescription>{body}</CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-5 pt-4 text-sm">
          <ul className="flex flex-col gap-2 text-muted-foreground">
            <li>· קטלוג של מוצרים, שירותים וחבילות שאתם מוכרים לאורחים.</li>
            <li>· חנות בתוך ההזמנה של האורח, שעובדת גם בלי סליקה מקוונת.</li>
            <li>· הזמנות עם אישור, משימות תפעול ובקשות לספקים.</li>
          </ul>

          {/* Named honestly. A lock that will not say what unlocks it is a
              lock somebody rings support about. */}
          <p className="text-muted-foreground">
            {entitlement
              ? `החבילה שלכם אינה כוללת את היכולת ״${entitlement}״.`
              : 'החבילה שלכם אינה כוללת את החנות.'}
          </p>

          <Link
            href="/settings/billing"
            className="self-start text-primary underline underline-offset-4"
          >
            מעבר למסך החבילה
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}
