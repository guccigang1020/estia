import type { ReactNode } from 'react'

import {
  ConsoleShell,
  type ConsoleNavItem,
} from '@/components/platform/console-chrome'
import { mayUse } from '@/lib/platform'

import { requirePlatformStaff } from './_lib/guard'

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The ESTIA platform console shell.
 *
 * ══ THIS IS NOT THE CUSTOMER'S APPLICATION AND SHARES NOTHING WITH IT ═════
 *
 * A separate route group, a separate layout, a separate guard. It does not
 * import `src/app/(app)/_lib/context.ts`, `src/components/nav/menu.ts` or
 * anything else the customer shell is built from, and nothing in the customer
 * shell imports this. The two directories are two applications that happen to
 * be deployed together.
 *
 * That separation is the feature. A customer's organization switcher must
 * never appear here — it is a control for choosing which tenant to act in, and
 * a person standing in this console is not in a tenant. And nothing here may
 * appear there: there is no menu entry pointing at `/platform` anywhere in
 * `src/components/nav`, and if there were, this layout would still refuse
 * every customer who followed it.
 *
 * ── What guarantees what ──────────────────────────────────────────────────
 *
 * `requirePlatformStaff()` is authentication AND the roster check, and nothing
 * below this layout renders without both. What it does NOT guarantee is what
 * the person may do: the navigation below is derived from their grants as a
 * convenience for the reader, and every page calls `requirePlatformGrant()`
 * for itself. A menu item shown by mistake is still refused by the route, and
 * the route's refusal is still not the last one — every query behind it is
 * admitted by a row level security policy that has never heard of this file.
 */
export default async function PlatformLayout({
  children,
}: {
  children: ReactNode
}) {
  const session = await requirePlatformStaff()

  const nav: readonly ConsoleNavItem[] = [
    { href: '/platform', label: 'מצב המערכת', available: true },
    {
      href: '/platform/organizations',
      label: 'חשבונות',
      available: mayUse(session, 'platform.organization.view'),
    },
    {
      href: '/platform/people',
      label: 'אנשים',
      available: mayUse(session, 'platform.organization.view'),
    },
    {
      href: '/platform/plans',
      label: 'חבילות ומנויים',
      available: mayUse(session, 'platform.organization.view'),
    },
    {
      href: '/platform/autopilot',
      label: 'טייס אוטומטי',
      available: mayUse(session, 'platform.organization.view'),
    },
    {
      href: '/platform/audit',
      label: 'יומן הפלטפורמה',
      available: mayUse(session, 'platform.organization.view'),
    },
  ]

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:start-3 focus:z-50 focus:rounded-full focus:bg-primary focus:px-5 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        דילוג לתוכן הראשי
      </a>

      <ConsoleShell
        staffName={session.displayName ?? 'צוות ESTIA'}
        roleName={session.roleName}
        nav={nav}
      >
        {children}
      </ConsoleShell>
    </>
  )
}
