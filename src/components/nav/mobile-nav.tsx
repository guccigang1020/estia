'use client'

/**
 * EXECUTION CONTEXT — CLIENT COMPONENT.
 *
 * Navigation below the `lg` breakpoint: a bottom bar for the destinations that
 * exist, and a drawer holding the full menu.
 *
 * Built for a 375px phone held in one hand, because that is what an Israeli
 * guesthouse owner actually uses — the bar sits at the bottom where a thumb
 * reaches, every target is at least 44px tall, and the safe-area inset is
 * respected so the last row is not under the home indicator.
 *
 * The bar is built from `primaryDestinations`, which returns only routes that
 * genuinely exist. A tab that leads nowhere is worse than a missing tab: it is
 * a promise the product does not keep, and on a phone it is most of the screen.
 */

import { useEffect, useState } from 'react'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@/components/ui/cn'

import { NavIcon, type NavIconName } from './icons'
import { NavMenu } from './nav-menu'
import type { ResolvedMenuSection } from './menu'

export type MobileDestination = {
  id: string
  label: string
  icon: NavIconName
  href: string
}

function BarLink({ destination }: { destination: MobileDestination }) {
  const pathname = usePathname()
  const active =
    pathname === destination.href || pathname.startsWith(`${destination.href}/`)

  return (
    <Link
      href={destination.href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-2 py-1.5 text-[0.6875rem] font-medium',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        active ? 'text-primary' : 'text-muted-foreground',
      )}
    >
      <NavIcon name={destination.icon} className="size-5" />
      <span className="truncate">{destination.label}</span>
    </Link>
  )
}

export function MobileNav({
  sections,
  destinations,
  workspaceName,
  propertyLabel,
}: {
  sections: readonly ResolvedMenuSection[]
  destinations: readonly MobileDestination[]
  workspaceName: string
  propertyLabel: string
}) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('keydown', onKeyDown)
    // The page behind a full-height drawer must not scroll under it; on iOS
    // that is the difference between a drawer and a confusing mess.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previous
    }
  }, [open])

  return (
    <>
      {/* ------------------------------------------------------- bottom bar */}
      <div
        className={cn(
          'fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 backdrop-blur-md lg:hidden',
          'pb-[env(safe-area-inset-bottom)]',
        )}
      >
        <div className="flex items-stretch gap-1 px-2 py-1">
          {destinations.slice(0, 4).map((destination) => (
            <BarLink key={destination.id} destination={destination} />
          ))}

          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-expanded={open}
            aria-haspopup="dialog"
            className={cn(
              'flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-2 py-1.5 text-[0.6875rem] font-medium text-muted-foreground',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            )}
          >
            <NavIcon name="menu" className="size-5" />
            <span>הכול</span>
          </button>
        </div>
      </div>

      {/* ------------------------------------------------------------ drawer */}
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="סגירת התפריט"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-foreground/40"
          />

          <div
            role="dialog"
            aria-modal="true"
            aria-label="תפריט מלא"
            /* `start-0`: the drawer enters from the inline start, which is the
               right in Hebrew. `left-0` would put it on the wrong edge. */
            className="absolute inset-y-0 start-0 flex w-[86%] max-w-sm flex-col bg-surface shadow-lift"
          >
            <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-4">
              <div className="min-w-0">
                <p className="truncate font-display text-base font-bold text-foreground">
                  {workspaceName}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {propertyLabel}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="סגירת התפריט"
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <NavIcon name="close" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto overscroll-contain px-2 py-4">
              <NavMenu sections={sections} onNavigate={() => setOpen(false)} />
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
