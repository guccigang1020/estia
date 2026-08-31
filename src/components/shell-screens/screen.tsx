/**
 * The frame six screens share, and nothing else.
 *
 * WHY THIS EXISTS AT ALL. `/action-center`, `/activity`, `/inbox`, `/leads`,
 * `/settings/billing` and `/settings/security` are all the same shape: a
 * heading, a sentence saying what is on screen, and a stack of panels each of
 * which either has rows or says why it has none. Six copies of that markup is
 * six places for the RTL container widths to drift apart, and the drift is
 * invisible until somebody opens two of them side by side.
 *
 * WHY IT IS NOT A DESIGN SYSTEM. Everything below composes `Card`, `Badge` and
 * the tokens already in `src/components/ui`. No new colour, no new spacing
 * scale, no dependency. If this file were deleted the screens would still be
 * expressible; they would just repeat themselves.
 *
 * No `"use client"`: nothing here holds state, and every action arrives as a
 * node so a Server Component can pass a `<Button href>` straight in.
 */

import type { ComponentProps, ReactNode } from 'react'

import { CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/components/ui/cn'

/* --------------------------------------------------------------- frame -- */

export type ScreenFrameProps = {
  title: string
  /** One sentence saying what the reader is looking at. Always present. */
  lead: ReactNode
  /** Sits under the lead: a filter bar, a count, a refusal. */
  banner?: ReactNode
  children: ReactNode
  /** `max-w-shell` for a list screen, `max-w-3xl` for a settings screen. */
  width?: 'shell' | 'prose'
}

export function ScreenFrame({
  title,
  lead,
  banner,
  children,
  width = 'shell',
}: ScreenFrameProps) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8',
        width === 'shell' ? 'max-w-shell' : 'max-w-3xl',
      )}
    >
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          {title}
        </h1>
        <p className="max-w-prose text-muted-foreground">{lead}</p>
      </header>

      {banner}
      {children}
    </div>
  )
}

/* --------------------------------------------------------------- panel -- */

export type PanelProps = {
  title: string
  /** What the panel is reading, in the reader's words. */
  description?: ReactNode
  /**
   * How many rows are behind the title.
   *
   * Rendered beside the heading rather than inside it, so a screen reader
   * announces the section by name and the count separately.
   */
  count?: number
  /** The one control this section offers, if any. */
  action?: ReactNode
  children: ReactNode
} & Omit<ComponentProps<'section'>, 'title' | 'children'>

export function Panel({
  title,
  description,
  count,
  action,
  children,
  className,
  ...props
}: PanelProps) {
  return (
    // The card's own classes rather than `<Card>` itself: `Card` renders a
    // `div`, and a stack of panels has to be a stack of `section`s or the
    // document outline the headings below imply is not there.
    <section
      className={cn(
        'flex flex-col rounded-xl border border-border bg-surface p-6 shadow-soft sm:p-7',
        className,
      )}
      {...props}
    >
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <CardTitle as="h2">{title}</CardTitle>
            {count !== undefined && (
              <span className="text-sm tabular-nums text-muted-foreground">
                {count}
              </span>
            )}
          </div>
          {action}
        </div>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>

      <div className="mt-5">{children}</div>
    </section>
  )
}

/* ---------------------------------------------------------------- rows -- */

/**
 * A labelled fact.
 *
 * `dd` is `text-end` so a Hebrew label and an LTR value (an email, an id, a
 * date) sit at opposite edges the way the rest of the product renders them.
 */
export function FactRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2.5 last:border-b-0">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-end text-sm font-medium text-foreground">
        {children}
      </dd>
    </div>
  )
}

/**
 * What a screen prints where a value exists and this reader may not see it.
 *
 * The same sentence `finance/_lib/labels.ts` chose, restated as a component
 * rather than imported, because that module belongs to the finance screens and
 * a cross-module import for one string is a coupling nobody would expect. A
 * blank cell reads as "there is nothing here", which is a different and false
 * statement, and that is the mistake this exists to prevent.
 */
export function Withheld({ className }: { className?: string }) {
  return (
    <span className={cn('text-muted-foreground', className)}>
      לא זמין לצפייה
    </span>
  )
}

/**
 * A row list with dividers, for panels whose content is rows rather than facts.
 */
export function RowList({
  children,
  className,
  ...props
}: ComponentProps<'ul'>) {
  return (
    <ul
      className={cn('flex flex-col divide-y divide-border', className)}
      {...props}
    >
      {children}
    </ul>
  )
}

export function Row({ children, className, ...props }: ComponentProps<'li'>) {
  return (
    <li
      className={cn(
        'flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5 py-3 first:pt-0 last:pb-0',
        className,
      )}
      {...props}
    >
      {children}
    </li>
  )
}

/**
 * The sentence a panel prints instead of rows.
 *
 * Deliberately not `EmptyState`: that component is the whole-screen treatment
 * with an illustration and an action, and drawing six of them stacked would
 * turn a working screen into a gallery of apologies. This is one line, and the
 * caller is responsible for it being true — "nothing needs you here" and "you
 * may not see this" are different sentences and must not share one.
 */
export function PanelNote({
  tone = 'quiet',
  children,
}: {
  tone?: 'quiet' | 'attention'
  children: ReactNode
}) {
  return (
    <p
      // `status`, never `alert`: a panel with nothing in it is not an
      // interruption, and `alert` is reserved for money nobody can account for.
      role={tone === 'attention' ? 'status' : undefined}
      className={cn(
        'rounded-lg px-4 py-3 text-sm',
        tone === 'attention'
          ? 'border border-border-strong bg-accent-soft text-accent-foreground'
          : 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </p>
  )
}
