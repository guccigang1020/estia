/**
 * The desktop sidebar.
 *
 * A Server Component: it renders links and nothing that reacts, so none of it
 * needs to reach the browser as JavaScript. Only the individual `NavLink`s are
 * client-side, and only because knowing the current pathname is a hook.
 *
 * `border-e` — the sidebar's edge is on its inline END, which in Hebrew is the
 * left. `border-r` would draw the line on the correct side today and the wrong
 * side the moment the product renders left-to-right.
 */

import Link from 'next/link'

import { NavMenu } from './nav-menu'
import type { ResolvedMenuSection } from './menu'

export function Sidebar({
  sections,
  workspaceName,
  contextLabel,
}: {
  sections: readonly ResolvedMenuSection[]
  workspaceName: string
  contextLabel: string
}) {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-e border-border bg-surface lg:flex">
      <div className="flex h-14 items-center border-b border-border px-5">
        <Link
          href="/dashboard"
          dir="ltr"
          className="font-display text-lg font-bold tracking-[0.22em] text-primary"
        >
          ESTIA
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-5">
        <NavMenu sections={sections} />
      </div>

      {/*
        The context repeated at the foot of the sidebar. It is already on the
        top bar; it is here as well because this is the strip a person's eye
        rests on while reading the menu, and the cost of stating it twice is
        nothing next to the cost of a booking filed under the wrong business.
      */}
      <div className="border-t border-border px-5 py-3">
        <p className="truncate text-sm font-semibold text-foreground">
          {workspaceName}
        </p>
        <p className="truncate text-xs text-muted-foreground">{contextLabel}</p>
      </div>
    </aside>
  )
}
