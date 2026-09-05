/**
 * The studio's frame: a header, a section nav, a stat tile and a status pill.
 *
 * Server components, deliberately. Nothing in the studio's chrome needs state,
 * and a `'use client'` at the top of a shared chrome file quietly turns every
 * screen that imports it into a client bundle.
 *
 * The nav is derived from what the person may actually do — `available` is
 * passed per entry by the caller, which has the actor. Hiding an entry is a
 * convenience and never the enforcement; each route refuses on its own terms.
 */

import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/components/ui/cn'
import { SITE_STATUS_LABEL, type SiteStatus } from '@/lib/website'

export function SiteHeader({
  title,
  lead,
  status,
  action,
}: {
  title: string
  lead?: string
  status?: SiteStatus
  action?: React.ReactNode
}) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-2xl font-bold text-foreground">
            {title}
          </h1>
          {status ? <SiteStatusBadge status={status} /> : null}
        </div>
        {lead ? (
          <p className="max-w-2xl text-sm text-muted-foreground">{lead}</p>
        ) : null}
      </div>
      {action}
    </header>
  )
}

/**
 * The status, in one pill.
 *
 * `published` is the only one that gets the brand tone. A draft is not a
 * warning — most sites are drafts for weeks — so it is neutral, and
 * `unpublished` is neutral too because taking a site down is a decision
 * somebody made, not a fault.
 */
export function SiteStatusBadge({ status }: { status: SiteStatus }) {
  return (
    <Badge tone={status === 'published' ? 'brand' : 'neutral'}>
      {SITE_STATUS_LABEL[status]}
    </Badge>
  )
}

export type SiteNavEntry = {
  href: string
  label: string
  /** False renders the label without a link, greyed, rather than hiding it. */
  available: boolean
}

/**
 * The studio's own navigation.
 *
 * An entry the person may not use is SHOWN and not linked, rather than hidden.
 * The grants here genuinely differ by role — a copywriter has no design tab,
 * a designer has no SEO tab — and a tab that vanishes makes somebody think the
 * product lacks the feature. A tab that is visibly not theirs makes them ask
 * an administrator, which is the conversation that actually resolves it.
 */
export function SiteNav({
  current,
  entries,
}: {
  current: string
  entries: readonly SiteNavEntry[]
}) {
  return (
    <nav
      aria-label="ניווט בסטודיו"
      className="flex flex-wrap gap-1 border-b border-border pb-px"
    >
      {entries.map((entry) => {
        const active = entry.href === current
        const className = cn(
          'rounded-t-md px-3 py-2 text-sm transition-colors',
          active
            ? 'border-b-2 border-primary font-medium text-foreground'
            : 'text-muted-foreground',
        )

        if (!entry.available) {
          return (
            <span
              key={entry.href}
              className={cn(className, 'cursor-not-allowed opacity-50')}
              title="אין לך הרשאה למסך הזה"
            >
              {entry.label}
            </span>
          )
        }

        return (
          <Link
            key={entry.href}
            href={entry.href}
            aria-current={active ? 'page' : undefined}
            className={cn(className, !active && 'hover:text-foreground')}
          >
            {entry.label}
          </Link>
        )
      })}
    </nav>
  )
}

export function StatTile({
  label,
  value,
  hint,
}: {
  label: string
  value: React.ReactNode
  hint?: string
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-2xl font-bold text-foreground">
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}
