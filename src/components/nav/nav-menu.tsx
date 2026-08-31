/**
 * The menu, rendered.
 *
 * No `"use client"` and no server-only API, on purpose: the desktop sidebar
 * renders this on the server, and the mobile drawer — which is a Client
 * Component because it holds open/closed state — renders the same markup on
 * the client. One implementation, two hosts, no chance of the two disagreeing
 * about what a locked item looks like.
 *
 * The three states come from `buildMenu` and are rendered honestly:
 *
 *   available — a real link.
 *   planned   — the route does not exist yet. A `<span>`, never an `<a>`, so
 *               there is nothing to click, nothing to prefetch and no 404 to
 *               reach. Labelled "בקרוב" in words, not implied by grey text.
 *   locked    — the person holds the right; the organization has not bought
 *               the feature. Named as such, because "upgrade to use this" and
 *               "you are not allowed" are different sentences and a customer
 *               deserves the right one.
 *
 * ── A locked item is a link when its route exists ─────────────────────────
 *
 * It was not, and that was a defect worth naming. Seven screens —
 * `/agents`, `/agencies`, `/quotes`, `/promotions`, `/channels`,
 * `/finance/owners` and `/automations` — render an upgrade offer on exactly
 * the plan-refusal branch, built for the customer who has not bought the
 * feature. Rendering their menu entry as an inert `<span>` meant that
 * customer could see the padlock and could not reach the offer behind it. The
 * only place in the product that asks to be paid for was unreachable from the
 * navigation.
 *
 * So: locked with a route is a real link carrying the padlock and the
 * entitlement badge, and locked without one stays inert, because there is
 * genuinely nothing to reach.
 */

import { Badge } from '@/components/ui/badge'
import { cn } from '@/components/ui/cn'

import { NavIcon } from './icons'
import { entitlementLabel } from './labels'
import { NavLink } from './nav-link'
import type { ResolvedMenuSection } from './menu'

function InertItem({
  label,
  note,
  icon,
}: {
  label: string
  note: string
  icon?: 'lock'
}) {
  return (
    <span
      aria-disabled="true"
      className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground/70"
    >
      <span className="flex min-w-0 items-center gap-2">
        {icon ? <NavIcon name="lock" className="size-3.5 shrink-0" /> : null}
        <span className="truncate">{label}</span>
      </span>
      <Badge tone="neutral" className="shrink-0 px-2 py-0.5 text-[0.6875rem]">
        {note}
      </Badge>
    </span>
  )
}

export function NavMenu({
  sections,
  onNavigate,
  className,
}: {
  sections: readonly ResolvedMenuSection[]
  onNavigate?: () => void
  className?: string
}) {
  return (
    <nav
      aria-label="ניווט ראשי"
      className={cn('flex flex-col gap-6', className)}
    >
      {sections.map((section) => (
        <div key={section.id} className="flex flex-col gap-1.5">
          <h2 className="flex items-center gap-2 px-3 text-xs font-semibold tracking-wide text-muted-foreground">
            <NavIcon name={section.icon} className="size-4 shrink-0" />
            {section.label}
          </h2>

          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => (
              <li key={item.id}>
                {item.state === 'available' && item.href ? (
                  <NavLink
                    href={item.href}
                    label={item.label}
                    onNavigate={onNavigate}
                  />
                ) : item.state === 'locked' ? (
                  item.href ? (
                    <NavLink
                      href={item.href}
                      label={item.label}
                      onNavigate={onNavigate}
                      icon="lock"
                      note={
                        item.entitlement
                          ? entitlementLabel(item.entitlement)
                          : 'לא בחבילה'
                      }
                    />
                  ) : (
                    <InertItem
                      label={item.label}
                      icon="lock"
                      note={
                        item.entitlement
                          ? `בחבילה: ${entitlementLabel(item.entitlement)}`
                          : 'לא בחבילה'
                      }
                    />
                  )
                ) : (
                  <InertItem label={item.label} note="בקרוב" />
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}
