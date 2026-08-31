'use client'

/**
 * EXECUTION CONTEXT — CLIENT COMPONENT.
 *
 * A menu entry that knows whether it is the page you are on. That is the only
 * reason this is a Client Component: `usePathname` is a hook, and a layout
 * cannot know its own pathname on the server.
 *
 * `aria-current="page"` rather than colour alone. The active item is also
 * marked with a bar on the inline start edge, so the state survives a
 * greyscale screen and a colour-blind reader.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/components/ui/cn'

import { NavIcon } from './icons'

export function NavLink({
  href,
  label,
  onNavigate,
  note,
  icon,
}: {
  href: string
  label: string
  /** Lets the mobile drawer close itself when a destination is chosen. */
  onNavigate?: () => void
  /**
   * A short badge after the label — today, the entitlement that would unlock
   * a plan-locked destination.
   *
   * A locked item is still a link, because the route it leads to explains the
   * feature and offers it rather than refusing. The badge is what keeps that
   * honest: the customer is told before they press it that this is not
   * included, so arriving at an offer instead of the feature is not a
   * surprise.
   */
  note?: string
  icon?: 'lock'
}) {
  const pathname = usePathname()
  const active = pathname === href || pathname.startsWith(`${href}/`)

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate}
      className={cn(
        'relative flex items-center rounded-md py-2 pe-3 ps-3 text-sm transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        active
          ? 'bg-primary-soft font-semibold text-primary'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {active ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-1.5 start-0 w-1 rounded-full bg-primary"
        />
      ) : null}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {icon ? <NavIcon name="lock" className="size-3.5 shrink-0" /> : null}
        <span className="truncate">{label}</span>
      </span>
      {note ? (
        <Badge
          tone="neutral"
          className="ms-2 shrink-0 px-2 py-0.5 text-[0.6875rem]"
        >
          {note}
        </Badge>
      ) : null}
    </Link>
  )
}
