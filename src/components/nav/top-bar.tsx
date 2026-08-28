/**
 * The top bar.
 *
 * A Server Component that composes client `Popover` triggers around
 * server-rendered panels. Everything with a form in it — switching workspace,
 * signing out — is server-rendered and posts to a Server Action.
 *
 * Two controls are deliberately inert, and say so on their face:
 *
 *   · Global search. There is no search index in the product yet. A box that
 *     accepts a query and answers nothing is worse than an honest label, so
 *     this is a non-interactive control marked "בקרוב" rather than an input
 *     that swallows what someone types.
 *   · Notifications. There is no notification system yet, so the panel says
 *     there is nothing — and there is no badge. An invented "3" on a bell is
 *     precisely the fabricated data the charter forbids.
 */

import Link from 'next/link'

import { SignOutButton } from '@/components/auth/sign-out-button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/components/ui/cn'

import {
  PropertySwitcher,
  WorkspaceSwitcher,
  type PropertyChoice,
  type WorkspaceChoice,
} from './context-switchers'
import { NavIcon } from './icons'
import { Popover } from './popover'
import type { ResolvedMenuItem } from './menu'

export type TopBarProps = {
  workspaces: readonly WorkspaceChoice[]
  activeOrganizationId: string
  workspaceName: string
  properties: readonly PropertyChoice[]
  selectedPropertyId: string
  allPropertiesValue: string
  quickCreate: readonly ResolvedMenuItem[]
  person: {
    name: string | null
    email: string | undefined
    roles: readonly string[]
  }
  selectWorkspaceAction: (formData: FormData) => Promise<void>
  selectPropertyAction: (formData: FormData) => Promise<void>
  signOutAction: () => Promise<void>
}

const ICON_BUTTON =
  'inline-flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

function SearchControl() {
  return (
    <>
      {/* Phone: an icon, because a search field would eat the whole bar. */}
      <span
        aria-disabled="true"
        title="חיפוש גלובלי — בקרוב"
        className={cn(ICON_BUTTON, 'cursor-default opacity-60 sm:hidden')}
      >
        <NavIcon name="search" />
        <span className="sr-only">חיפוש גלובלי — בקרוב</span>
      </span>

      {/* Desktop: the shape of the eventual field, honestly labelled. */}
      <span
        aria-disabled="true"
        className="hidden h-10 max-w-64 flex-1 cursor-default items-center gap-2 rounded-full border border-border bg-muted/60 px-4 text-sm text-muted-foreground sm:inline-flex"
      >
        <NavIcon name="search" className="size-4 shrink-0" />
        <span className="truncate">חיפוש</span>
        <Badge tone="neutral" className="ms-auto px-2 py-0.5 text-[0.6875rem]">
          בקרוב
        </Badge>
      </span>
    </>
  )
}

function QuickCreate({ items }: { items: readonly ResolvedMenuItem[] }) {
  if (items.length === 0) return null

  return (
    <Popover
      label="יצירה מהירה"
      icon="plus"
      triggerClassName={ICON_BUTTON}
      panelClassName="w-60"
    >
      <div className="flex flex-col py-1">
        <p className="px-3 pb-1 pt-2 text-xs font-semibold text-muted-foreground">
          יצירה מהירה
        </p>
        <ul className="flex flex-col">
          {items.map((item) => (
            <li key={item.id}>
              {item.state === 'available' && item.href ? (
                <Link
                  href={item.href}
                  className="flex items-center px-3 py-2 text-sm text-foreground hover:bg-muted"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-disabled="true"
                  className="flex items-center justify-between gap-2 px-3 py-2 text-sm text-muted-foreground/70"
                >
                  <span className="truncate">{item.label}</span>
                  <Badge
                    tone="neutral"
                    className="shrink-0 px-2 py-0.5 text-[0.6875rem]"
                  >
                    בקרוב
                  </Badge>
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Popover>
  )
}

function Notifications() {
  return (
    <Popover
      label="התראות"
      icon="bell"
      triggerClassName={ICON_BUTTON}
      panelClassName="w-72"
    >
      <div className="flex flex-col gap-1 px-4 py-5 text-center">
        <p className="text-sm font-semibold text-foreground">אין התראות</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          כשיהיו צ׳ק-אין להיום, תשלום שנכשל או משימה שאיחרה — הם יופיעו כאן.
        </p>
      </div>
    </Popover>
  )
}

function ProfileMenu({
  person,
  workspaceName,
  signOutAction,
}: {
  person: TopBarProps['person']
  workspaceName: string
  signOutAction: () => Promise<void>
}) {
  return (
    <Popover
      label="החשבון שלי"
      icon="user"
      triggerClassName={ICON_BUTTON}
      panelClassName="w-72"
    >
      <div className="flex flex-col">
        <div className="flex flex-col gap-1 border-b border-border px-4 py-3">
          {person.name ? (
            <p className="truncate text-sm font-semibold text-foreground">
              {person.name}
            </p>
          ) : null}
          <p dir="ltr" className="truncate text-xs text-muted-foreground">
            {person.email}
          </p>
          <p className="truncate pt-1 text-xs text-muted-foreground">
            {workspaceName}
          </p>
          {person.roles.length > 0 ? (
            <p className="flex flex-wrap gap-1 pt-1">
              {person.roles.map((role) => (
                <Badge key={role} tone="brand" className="px-2 py-0.5">
                  {role}
                </Badge>
              ))}
            </p>
          ) : null}
        </div>

        <Link
          href="/account"
          className="px-4 py-2.5 text-sm text-foreground hover:bg-muted"
        >
          החשבון שלי
        </Link>

        <div className="border-t border-border px-4 py-3">
          <SignOutButton action={signOutAction} />
        </div>
      </div>
    </Popover>
  )
}

export function TopBar(props: TopBarProps) {
  const {
    workspaces,
    activeOrganizationId,
    workspaceName,
    properties,
    selectedPropertyId,
    allPropertiesValue,
    quickCreate,
    person,
    selectWorkspaceAction,
    selectPropertyAction,
    signOutAction,
  } = props

  const switchers = (
    <>
      <WorkspaceSwitcher
        workspaces={workspaces}
        activeOrganizationId={activeOrganizationId}
        action={selectWorkspaceAction}
      />
      <span aria-hidden="true" className="text-border-strong">
        /
      </span>
      <PropertySwitcher
        properties={properties}
        selectedPropertyId={selectedPropertyId}
        allValue={allPropertiesValue}
        action={selectPropertyAction}
      />
    </>
  )

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur-md">
      <div className="flex h-14 items-center gap-2 px-3 sm:px-5">
        <Link
          href="/dashboard"
          dir="ltr"
          className="font-display text-base font-bold tracking-[0.2em] text-primary lg:hidden"
        >
          ESTIA
        </Link>

        {/* Desktop keeps the context inline with everything else. */}
        <div className="hidden min-w-0 items-center gap-1 lg:flex">
          {switchers}
        </div>

        <div className="ms-auto flex items-center gap-1 sm:gap-2">
          <SearchControl />
          <QuickCreate items={quickCreate} />
          <Notifications />
          <ProfileMenu
            person={person}
            workspaceName={workspaceName}
            signOutAction={signOutAction}
          />
        </div>
      </div>

      {/*
        Phone: the context gets its own row rather than being cut to an
        ellipsis beside five other controls. It is never hidden behind a menu,
        because "which property am I in" must be answerable at a glance.
      */}
      <div className="flex items-center gap-1 overflow-x-auto border-t border-border px-2 py-1.5 lg:hidden">
        {switchers}
      </div>
    </header>
  )
}
