/**
 * Month navigation.
 *
 * Links, not buttons, and therefore no `"use client"`: moving to another month
 * is a different view of the same resource, so it belongs in the URL. A person
 * can bookmark ספטמבר, send it to a colleague, and use the browser's own back
 * button — none of which a client-side month counter would give them.
 *
 * RTL: the arrows point the way the reader moves, so "previous" carries `›`
 * and "next" carries `‹`. Placement is left to the flow, which is right-to-left
 * here; nothing below names a physical side.
 */

import Link from 'next/link'

export type MonthNavProps = {
  /** `ספטמבר 2026`. */
  label: string
  /** `אלול–תשרי תשפ״ז`. The Hebrew months the civil month straddles. */
  hebrewLabel: string
  /**
   * Omitted at the edge of the window the calendar will draw. An arrow that
   * led to a month the route then refused would silently redraw as today,
   * which reads as the link being broken.
   */
  previousHref?: string
  nextHref?: string
  /** Returns to the month containing today. Omitted when already there. */
  todayHref?: string
}

const LINK =
  'inline-flex h-9 items-center gap-1.5 rounded-full border border-border-strong ' +
  'bg-surface px-4 text-sm font-medium text-foreground transition-colors ' +
  'duration-150 hover:bg-muted focus-visible:outline-2 ' +
  'focus-visible:outline-offset-2 focus-visible:outline-ring'

export function MonthNav({
  label,
  hebrewLabel,
  previousHref,
  nextHref,
  todayHref,
}: MonthNavProps) {
  return (
    <nav
      aria-label="ניווט בין חודשים"
      className="flex flex-wrap items-center justify-between gap-3"
    >
      <div className="flex flex-col">
        <h2 className="font-display text-xl font-bold tracking-tight text-foreground">
          {label}
        </h2>
        <p className="text-sm text-muted-foreground">{hebrewLabel}</p>
      </div>

      <div className="flex items-center gap-2">
        {previousHref && (
          <Link href={previousHref} className={LINK} rel="prev">
            <span aria-hidden="true">›</span>
            החודש הקודם
          </Link>
        )}

        {todayHref && (
          <Link href={todayHref} className={LINK}>
            החודש הנוכחי
          </Link>
        )}

        {nextHref && (
          <Link href={nextHref} className={LINK} rel="next">
            החודש הבא
            <span aria-hidden="true">‹</span>
          </Link>
        )}
      </div>
    </nav>
  )
}
