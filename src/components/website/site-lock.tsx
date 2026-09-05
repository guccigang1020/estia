/**
 * What an organization sees when it holds the right and has not bought the
 * feature.
 *
 * The same argument `src/components/store/store-lock.tsx` makes and the same
 * shape, for the same reason: `requireGrant` flattens every refusal into
 * "המסך שביקשת דורש הרשאה שאין לך", and for a plan refusal that sentence is
 * false in the way that costs money. The owner DOES hold `site.view`; what
 * their package does not carry is `website`. Telling them they lack a
 * permission sends them to an administrator who cannot help.
 *
 * ── Three different locks, one component ─────────────────────────────────
 *
 * The module has three entitlements behind it — `website`, `custom_domain`
 * and `ai_content` — and they lock different amounts of it. The bullets are
 * therefore passed in rather than hard-coded: the domain screen's lock must
 * not promise a website to somebody who already has one.
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

const ENTITLEMENT_LABEL: Partial<Record<Entitlement, string>> = {
  website: 'אתר תדמית והזמנות ישירות',
  custom_domain: 'דומיין משלכם',
  ai_content: 'ניסוח תוכן אוטומטי',
}

export function SiteLock({
  entitlement,
  title,
  body,
  bullets,
  /** Rendered inside the studio's frame rather than as a whole page. */
  inline = false,
}: {
  entitlement: Entitlement | null
  title: string
  body: string
  bullets: readonly string[]
  inline?: boolean
}) {
  const card = (
    <Card tone="featured">
      <CardHeader>
        <CardTitle as={inline ? 'h2' : 'h1'}>{title}</CardTitle>
        <CardDescription>{body}</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5 pt-4 text-sm">
        <ul className="flex flex-col gap-2 text-muted-foreground">
          {bullets.map((bullet) => (
            <li key={bullet}>· {bullet}</li>
          ))}
        </ul>

        {/* Named honestly. A lock that will not say what unlocks it is a lock
            somebody rings support about. */}
        <p className="text-muted-foreground">
          {entitlement
            ? `החבילה שלכם אינה כוללת את היכולת ״${ENTITLEMENT_LABEL[entitlement] ?? entitlement}״.`
            : 'החבילה שלכם אינה כוללת את האתר.'}
        </p>

        <Link
          href="/settings/billing"
          className="self-start text-primary underline underline-offset-4"
        >
          מעבר למסך החבילה
        </Link>
      </CardContent>
    </Card>
  )

  if (inline) return card

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      {card}
    </div>
  )
}
