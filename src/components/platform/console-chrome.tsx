import type { ReactNode } from 'react'

import Link from 'next/link'

import { cn } from '@/components/ui/cn'

/**
 * The console's own frame.
 *
 * ══ IT MUST NOT LOOK LIKE THE CUSTOMER'S APPLICATION ══════════════════════
 *
 * Nothing here is imported from `src/components/nav`. There is no sidebar of
 * business modules, no organization switcher, no property selector and no
 * quick-create — not because they were left out for later, but because every
 * one of them is a control for acting inside one tenant, and a person who is
 * standing in this console is not inside any tenant at all.
 *
 * The visual difference is deliberate too. A support console that renders like
 * the product is a console somebody takes a screenshot of and sends to a
 * customer, and it is a console whose operator forgets, at half past six, that
 * the account on screen is not their own. So it carries a dark bar, its own
 * wordmark, and a standing line saying whose data is on the screen.
 */

/* ------------------------------------------------------------- the frame -- */

export interface ConsoleNavItem {
  href: string
  label: string
  /** Rendered dimmed and unclickable when the viewer lacks the grant. */
  available: boolean
}

export function ConsoleShell({
  staffName,
  roleName,
  nav,
  children,
}: {
  staffName: string
  roleName: string
  nav: readonly ConsoleNavItem[]
  children: ReactNode
}) {
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="border-b border-border-strong bg-foreground text-background">
        <div className="mx-auto flex w-full max-w-shell flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex items-baseline gap-3">
            <span
              dir="ltr"
              className="font-display text-lg font-bold tracking-[0.22em]"
            >
              ESTIA
            </span>
            <span className="text-sm font-semibold opacity-90">
              קונסולת פלטפורמה
            </span>
          </div>

          <div className="flex items-center gap-3 text-xs">
            <span className="opacity-90">
              {staffName} · {roleName}
            </span>
            {/*
              The way out. A link and not a redirect, because the operator
              chooses when to leave — and because a console that silently
              bounces you into the customer application is the console that
              blurs the two.
            */}
            <Link
              href="/dashboard"
              className="rounded-full border border-background/40 px-3 py-1 font-medium underline-offset-4 hover:bg-background/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-background"
            >
              יציאה לאפליקציה
            </Link>
          </div>
        </div>

        <nav
          aria-label="ניווט קונסולה"
          className="mx-auto flex w-full max-w-shell flex-wrap gap-1 px-4 pb-2 sm:px-6 lg:px-8"
        >
          {nav.map((item) =>
            item.available ? (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-full px-3 py-1.5 text-sm font-medium opacity-90 hover:bg-background/10 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-background"
              >
                {item.label}
              </Link>
            ) : (
              /*
                Shown and disabled rather than hidden. A support-role colleague
                who cannot open the plans screen should learn that the screen
                exists and that their role does not reach it — a menu that
                silently omits it teaches them the product does not have it.
                The route refuses independently either way.
              */
              <span
                key={item.href}
                aria-disabled="true"
                title="התפקיד שלך אינו כולל את המסך הזה"
                className="cursor-not-allowed rounded-full px-3 py-1.5 text-sm font-medium opacity-40"
              >
                {item.label}
              </span>
            ),
          )}
        </nav>
      </header>

      <main id="main" className="flex-1">
        {children}
      </main>

      <footer className="border-t border-border bg-surface">
        <div className="mx-auto w-full max-w-shell px-4 py-4 text-xs text-muted-foreground sm:px-6 lg:px-8">
          כל פעולה שמבוצעת כאן נרשמת ביומן הביקורת של הלקוח עצמו, חתומה{' '}
          <code dir="ltr">platform_staff</code> ועם הנימוק שנמסר — הלקוח רואה
          אותה במסך הביקורת שלו. התחזות מלאה אינה קיימת במוצר; מה שיש כאן הוא
          צפייה בקריאה בלבד, תחומה בזמן ומתועדת.
        </div>
      </footer>
    </div>
  )
}

/* ------------------------------------------------------------- fragments -- */

export function ConsolePage({
  title,
  lede,
  actions,
  children,
}: {
  title: string
  lede?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex max-w-2xl flex-col gap-2">
          <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            {title}
          </h1>
          {lede && <p className="text-sm text-muted-foreground">{lede}</p>}
        </div>
        {actions}
      </div>
      {children}
    </div>
  )
}

export type NoticeTone = 'neutral' | 'strong' | 'warning'

const NOTICE_TONE: Record<NoticeTone, string> = {
  neutral: 'border-border bg-surface text-foreground',
  strong: 'border-primary bg-primary-soft text-primary',
  warning: 'border-danger bg-surface text-foreground',
}

export function ConsoleNotice({
  title,
  tone = 'neutral',
  children,
}: {
  title?: string
  tone?: NoticeTone
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-xl border px-4 py-3 text-sm leading-relaxed',
        NOTICE_TONE[tone],
      )}
    >
      {title && <p className="mb-1 font-semibold">{title}</p>}
      <div>{children}</div>
    </div>
  )
}

/** A definition list, for the facts about one record. */
export function ConsoleFacts({
  items,
}: {
  items: readonly { label: string; value: ReactNode }[]
}) {
  return (
    <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium text-muted-foreground">
            {item.label}
          </dt>
          <dd className="text-sm text-foreground">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * A table that scrolls itself.
 *
 * `overflow-x-auto` on the wrapper rather than on the page, so a wide console
 * table never stretches the shell.
 */
export function ConsoleTable({
  caption,
  head,
  children,
}: {
  caption: string
  head: readonly string[]
  children: ReactNode
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-soft">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border bg-muted">
            {head.map((column) => (
              <th
                key={column}
                scope="col"
                className="whitespace-nowrap px-4 py-3 text-start font-semibold"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  )
}
