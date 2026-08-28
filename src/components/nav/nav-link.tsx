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

import { cn } from '@/components/ui/cn'

export function NavLink({
  href,
  label,
  onNavigate,
}: {
  href: string
  label: string
  /** Lets the mobile drawer close itself when a destination is chosen. */
  onNavigate?: () => void
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
      <span className="truncate">{label}</span>
    </Link>
  )
}
