/**
 * "This part of the product does not exist yet", said precisely.
 *
 * ── Why this is not an empty state ────────────────────────────────────────
 *
 * `ModuleEmptyState` has a `messages` preset — "אין שיחות פתוחות … כל פנייה
 * מהאתר, מהוואטסאפ או מהמייל מגיעה לחוט אחד לכל אורח" — and rendering it on
 * `/inbox` would be a lie of a specific and expensive kind. It asserts that the
 * mailbox works and that this business has had no conversations. Neither is
 * true: there is no `messages` table, no `threads` table and no `conversations`
 * table in any migration from 0001 to 0026, so nothing could arrive in it. A
 * buyer who reads "no open conversations", asks a question in WhatsApp and
 * watches nothing appear has been told the product is broken; a buyer who reads
 * "the messaging tables are not built, and here are the grants that are already
 * waiting for them" has been told the truth and can price it.
 *
 * `empty-presets.ts` exists to stop "you have no bookings" being shown to
 * somebody whose filter matched nothing. This is the same distinction one level
 * further out: a module with no rows and a module with no *table* look identical
 * on screen and are, again, opposite situations.
 *
 * ── What it renders ───────────────────────────────────────────────────────
 *
 * The names, not a paraphrase. Which storage is missing, and which parts of the
 * product already exist and are waiting for it — the permission strings, the
 * menu item, the empty-state copy. Those are the facts an engineer needs to
 * close the gap and the facts a buyer needs to judge how far from done it is,
 * and both are cheaper to read as a list than as a paragraph.
 *
 * No `"use client"`: it renders text.
 */

import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'

export type DomainGapProps = {
  /** What is missing, as a heading: "מודול ההודעות עדיין לא קיים". */
  title: string
  /** Two or three sentences. What is absent, and what the screen shows instead. */
  body: ReactNode
  /**
   * The tables the product would need, named exactly as a migration would
   * create them. Rendered LTR because they are identifiers.
   */
  missingTables: readonly string[]
  /**
   * What already exists and is waiting — permission strings, a menu entry,
   * copy. Each is a short Hebrew phrase; the identifier inside it, if any, is
   * the caller's to wrap.
   */
  alreadyBuilt: readonly ReactNode[]
}

export function DomainGap({
  title,
  body,
  missingTables,
  alreadyBuilt,
}: DomainGapProps) {
  return (
    <div
      // `status` and not `alert`: this is a true statement about the product's
      // shape, not a failure that just happened to the person reading it.
      role="status"
      className="flex flex-col gap-4 rounded-xl border border-border-strong bg-accent-soft p-6 text-accent-foreground sm:p-7"
    >
      <div className="flex flex-col gap-2">
        <h2 className="font-display text-lg font-bold tracking-tight">
          {title}
        </h2>
        <div className="max-w-prose text-sm leading-relaxed">{body}</div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide opacity-80">
            טבלאות שחסרות במסד
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {missingTables.map((table) => (
              <li key={table}>
                <Badge tone="neutral" className="font-mono" dir="ltr">
                  {table}
                </Badge>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide opacity-80">
            מה כבר קיים ומחכה להן
          </h3>
          <ul className="flex flex-col gap-1 text-sm">
            {alreadyBuilt.map((entry, index) => (
              <li key={index} className="flex gap-2">
                <span aria-hidden="true">·</span>
                <span>{entry}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

/** A permission string, rendered as one: LTR, monospaced, never translated. */
export function GrantCode({ children }: { children: string }) {
  return (
    <span dir="ltr" className="font-mono text-xs">
      {children}
    </span>
  )
}
