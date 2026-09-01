/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The one thing to do next.
 *
 * ── Why there is exactly one of these on a screen ─────────────────────────
 *
 * `nextAction` returns one action, and this renders it. A screen with four
 * equally weighted buttons has no next action, it has a menu — and a person on
 * a telephone, on a bus, three days before their holiday, does not want a
 * menu. Everything else on the page is a list, a summary or a quiet link.
 *
 * ── `calm` is not a lesser `urgent` ───────────────────────────────────────
 *
 * The tone is about who is waiting. `urgent` means the business is waiting on
 * the guest and the booking does not move until they act. `calm` means the
 * guest is waiting on the day — the address, the wifi, the checkout time —
 * and a red button for "here is the wifi password" teaches people that the
 * colour means nothing.
 *
 * ── An action with nowhere to go renders as a sentence ────────────────────
 *
 * When `path` is null there is no button. That is the `none` case, and it is a
 * real answer: everything is done, the address is not released yet, and the
 * honest thing to say is so — not to invent a control that leads somewhere
 * pointless just so the card has one.
 */

import Link from 'next/link'

import { Button } from '@/components/ui/button'
import type { GuestNextAction } from '@/lib/guest-journey/steps'

export function NextActionCard({
  action,
  token,
}: {
  action: GuestNextAction
  token: string
}) {
  const urgent = action.tone === 'urgent'
  const href =
    action.path === null
      ? null
      : action.path === ''
        ? `/g/${token}`
        : `/g/${token}/${action.path}`

  return (
    <section
      aria-labelledby="next-action-heading"
      className={
        urgent
          ? 'flex flex-col gap-3 rounded-2xl border-2 border-primary bg-surface-raised px-4 py-5 shadow-lift sm:px-5'
          : 'flex flex-col gap-3 rounded-2xl border border-border bg-surface px-4 py-5 sm:px-5'
      }
    >
      <h2
        id="next-action-heading"
        className="font-display text-lg font-bold text-foreground"
      >
        {action.label}
      </h2>

      <p className="text-sm text-muted-foreground">{action.description}</p>

      {href && (
        <Button
          href={href}
          variant={urgent ? 'primary' : 'secondary'}
          size="lg"
          className="w-full"
        >
          {action.label}
        </Button>
      )}
    </section>
  )
}

/**
 * The quiet links under the dominant action.
 *
 * Deliberately `secondary`, deliberately small, and deliberately only the ones
 * that lead somewhere real: a link to an arrival page that will refuse to show
 * an address is a link that wastes a tap and teaches the guest the portal is
 * unreliable.
 */
export function SecondaryLinks({
  token,
  links,
}: {
  token: string
  links: readonly { path: string; label: string }[]
}) {
  if (links.length === 0) return null

  return (
    <nav aria-label="עוד בהזמנה" className="flex flex-wrap gap-2">
      {links.map((link) => (
        <Link
          key={link.path}
          href={`/g/${token}/${link.path}`}
          className="rounded-full border border-border-strong bg-surface px-4 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {link.label}
        </Link>
      ))}
    </nav>
  )
}
