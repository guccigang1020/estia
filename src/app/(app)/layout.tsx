import type { ReactNode } from 'react'

import Link from 'next/link'

import { signOutAction } from '@/app/(auth)/actions'
import { SignOutButton } from '@/components/auth/sign-out-button'
import { DemoSwitcher } from '@/components/demo/demo-switcher'
import { MobileNav } from '@/components/nav/mobile-nav'
import { Sidebar } from '@/components/nav/sidebar'
import { TopBar } from '@/components/nav/top-bar'
import {
  buildMenu,
  buildQuickCreate,
  primaryDestinations,
} from '@/components/nav/menu'

import { selectPropertyAction, selectWorkspaceAction } from './_lib/actions'
import { ALL_PROPERTIES } from './_lib/context'
import { requireContext } from './_lib/guard'

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The authenticated application shell.
 *
 * WHAT THIS GUARANTEES. Nothing below it renders without a signed-in user:
 * `requireContext()` revalidates the session against the auth server and
 * redirects when there is none. That is authentication, and it is the same
 * pattern as `(auth)/(protected)/layout.tsx` — one gate, not a second one
 * invented here.
 *
 * WHAT IT DOES NOT GUARANTEE. It says nothing about what the person may DO.
 * The menu it renders is derived from their grants, but that derivation is a
 * convenience for the reader and is never an access decision: each route below
 * calls `requireGrant()` for itself. If this layout handed the menu a wrong
 * answer, the routes would still refuse.
 *
 * THREE STATES ARE NOT ERRORS. A signed-in person can legitimately have no
 * workspace at all (they signed up and nobody has created an organization
 * yet), a suspended membership, or an organization whose subscription row is
 * missing. None of those is a crash and none of them gets a menu — they get a
 * frame with an explanation, rendered by the page below.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const context = await requireContext()

  const skipLink = (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:start-3 focus:z-50 focus:rounded-full focus:bg-primary focus:px-5 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
    >
      דילוג לתוכן הראשי
    </a>
  )

  if (context.status !== 'ready') {
    // No workspace, no navigation. Offering a menu here would be offering
    // routes that resolve to nothing.
    return (
      <>
        {skipLink}
        <div className="flex min-h-svh flex-col bg-background">
          <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-5">
            <Link
              href="/"
              dir="ltr"
              className="font-display text-lg font-bold tracking-[0.22em] text-primary"
            >
              ESTIA
            </Link>
            <SignOutButton action={signOutAction} />
          </header>
          <main id="main" className="flex-1">
            {children}
          </main>
        </div>

        {/* Mounted here too: "no workspace" and "no subscription" are states
            worth being able to walk into and back out of, and the switcher is
            the only way out of them. It renders nothing when the demo flag is
            off — see `DemoSwitcher`, which returns null before reading
            anything at all. */}
        <DemoSwitcher />
      </>
    )
  }

  const sections = buildMenu(context.actor)
  const destinations = primaryDestinations(sections)
  const quickCreate = buildQuickCreate(context.actor)

  const propertyLabel =
    context.selectedPropertyId === ALL_PROPERTIES
      ? 'כל הנכסים'
      : `נכס ${context.selectedPropertyId.slice(0, 8)}`

  const fullName =
    typeof context.user.user_metadata?.full_name === 'string'
      ? context.user.user_metadata.full_name
      : null

  return (
    <>
      {skipLink}

      <div className="flex min-h-svh flex-1 bg-background">
        <Sidebar
          sections={sections}
          workspaceName={context.workspace.name}
          contextLabel={propertyLabel}
        />

        {/* `min-w-0` so a wide table inside a page scrolls itself instead of
            stretching the shell and pushing the sidebar off-screen. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            workspaces={context.workspaces}
            activeOrganizationId={context.workspace.organizationId}
            workspaceName={context.workspace.name}
            properties={context.properties}
            selectedPropertyId={context.selectedPropertyId}
            allPropertiesValue={ALL_PROPERTIES}
            quickCreate={quickCreate}
            person={{
              name: fullName,
              email: context.user.email,
              roles: context.roles.map((role) => role.name),
            }}
            selectWorkspaceAction={selectWorkspaceAction}
            selectPropertyAction={selectPropertyAction}
            signOutAction={signOutAction}
          />

          {/* The bottom padding clears the mobile bar; it is dropped at `lg`
              where the bar is not rendered at all. */}
          <main id="main" className="flex-1 pb-24 lg:pb-0">
            {children}
          </main>
        </div>
      </div>

      <MobileNav
        sections={sections}
        destinations={destinations}
        workspaceName={context.workspace.name}
        propertyLabel={propertyLabel}
      />

      <DemoSwitcher />
    </>
  )
}
