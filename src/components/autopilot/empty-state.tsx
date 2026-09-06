/**
 * "Nothing needs you" said as a fact about the business, never as a blank.
 *
 * ── The failure this exists to prevent ───────────────────────────────────
 *
 * An operations screen with nothing on it is ambiguous in the worst possible
 * direction. It reads identically whether the business is calm, the detectors
 * have not run, the reader lacks a grant, or the table is empty because
 * Autopilot was switched off last week. Three of those four need somebody to
 * do something, and a blank screen tells them all the same nothing.
 *
 * So this takes a `tone` and the caller must choose one:
 *
 *   `calm`      — the reads succeeded and there is genuinely nothing to do.
 *   `withheld`  — the reader may not see this. Not the same as "none".
 *   `dormant`   — Autopilot is not switched on, so nothing was detected.
 *
 * ── And on a calm day, the screen is not empty ───────────────────────────
 *
 * `children` is where today's completed work goes. "הכול בשליטה ✓" on its own
 * is a claim with nothing behind it; the same words above the list of what was
 * finished, what is arriving and what ESTIA handled is a claim a person can
 * check. That is the entire difference between a calm screen and an absent
 * one, and the caller is expected to fill it.
 *
 * Deliberately not `components/shell-screens/screen.tsx`'s `PanelNote`, which
 * is one line inside a panel. This is the whole-region treatment.
 *
 * No `'use client'`.
 */

import type { ReactNode } from 'react'

import { cn } from '@/components/ui/cn'

export type AutopilotEmptyTone = 'calm' | 'withheld' | 'dormant'

export type AutopilotEmptyStateProps = {
  tone: AutopilotEmptyTone
  title: string
  /** One sentence saying why there is nothing, in the reader's terms. */
  body: string
  /** The one thing to do about it, when there is one. */
  action?: ReactNode
  /** What IS true today. Rendered under the sentence on a calm screen. */
  children?: ReactNode
}

const TONE_CLASS: Record<AutopilotEmptyTone, string> = {
  calm: 'border-border bg-surface',
  withheld: 'border-border bg-muted',
  dormant: 'border-border-strong bg-surface-raised',
}

export function AutopilotEmptyState({
  tone,
  title,
  body,
  action,
  children,
}: AutopilotEmptyStateProps) {
  return (
    <section
      // `status`, never `alert`. A calm morning is not an interruption, and a
      // withheld panel is not an emergency either.
      role="status"
      className={cn(
        'flex w-full flex-col gap-4 rounded-xl border px-5 py-7 shadow-soft sm:px-7',
        TONE_CLASS[tone],
      )}
    >
      <div className="flex flex-col gap-2">
        <h2 className="font-display text-lg font-bold tracking-tight text-foreground">
          {title}
        </h2>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {body}
        </p>
      </div>

      {action}
      {children}
    </section>
  )
}
