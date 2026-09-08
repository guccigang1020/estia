import Link from 'next/link'

import type { Triage } from '@/app/(app)/action-center/_lib/triage'
import { calmLine } from '@/app/(app)/action-center/_lib/triage'

/**
 * The one line above the eight panels, and the one button under it.
 *
 * ══ WHAT THIS IS FOR ════════════════════════════════════════════════════════
 *
 * Spec 6.0 §2 and §6. Eight panels answer "what needs my attention now?"
 * completely and answer it badly: the row that matters is in the sixth, and
 * the person reading at eight in the morning stops at the first. This is the
 * top the screen did not have.
 *
 * ══ THE DESIGN DECISIONS, AND WHY EACH ONE ══════════════════════════════════
 *
 * **The number is the largest thing on the screen.** It is the answer to the
 * only question the screen asks, and everything below it is the working. A
 * strip whose heading outweighed its figure would be a label with a number
 * attached rather than an answer.
 *
 * **One button, and it is the only one here.** §6: every exception gets one
 * preferred action. Three buttons on a triage strip would be the ten-button
 * problem it exists to prevent, moved one level up.
 *
 * **Calm is a design state, not an empty div.** A morning with nothing wrong is
 * the most common morning and the strip says so in a sentence — and says it
 * differently when a panel could not be read, because "your morning is clear"
 * and "clear as far as I could see" are different promises.
 *
 * **Colour is never the message.** The tone shifts with severity and every
 * state also carries its own words: a person reading this in monochrome, or
 * hearing it, gets the same answer. That is the rule `state-meta.ts` sets for
 * the calendar and it does not stop being true here.
 *
 * No `"use client"`: values in, markup out.
 */
export function TriageStrip({ result }: { result: Triage }) {
  const calm = result.total === 0
  const partial = result.unreadable > 0

  return (
    <section
      aria-labelledby="triage-heading"
      className={[
        'relative overflow-hidden rounded-2xl border p-6 shadow-lift sm:p-7',
        calm
          ? 'border-border bg-surface'
          : 'border-border-strong bg-surface-raised',
      ].join(' ')}
    >
      {/*
        A single wash of colour behind the figure, not a filled card. A solid
        alert-coloured block on the screen somebody opens every morning stops
        being read within a week; a ground that shifts is noticed and does not
        shout.
      */}
      <div
        aria-hidden
        className={[
          'pointer-events-none absolute inset-y-0 start-0 w-1.5',
          calm ? 'bg-border' : 'estia-grad-primary',
        ].join(' ')}
      />

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h2
            id="triage-heading"
            className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground"
          >
            מה דורש אותך עכשיו
          </h2>

          {calm ? (
            <p className="max-w-prose text-base leading-relaxed text-foreground">
              {calmLine(result)}
            </p>
          ) : (
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="estia-figures font-display text-5xl font-bold leading-none tracking-tight text-foreground">
                {result.total}
              </span>
              <span className="text-lg leading-snug text-foreground">
                {result.total === 1 ? 'דבר אחד דורש אותך' : 'דברים דורשים אותך'}
              </span>
            </div>
          )}
        </div>

        {result.first !== null && (
          <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm leading-relaxed text-foreground">
              <span className="text-muted-foreground">קודם כול: </span>
              {result.first.headline}
            </p>

            {/*
              A plain link rather than the Button component, because this is
              navigation and the primary control on the screen. Sized for a
              thumb — §103 asks for mobile-friendly actions and this is the one
              control a manager taps while walking.
            */}
            <Link
              href={result.first.href}
              className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-soft transition-colors hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {result.first.cta}
            </Link>
          </div>
        )}

        {/*
          Counted separately and said out loud. A panel this reader may not see
          is not a problem; a panel that failed to load is, and folding either
          into the headline figure would make the number a guess.
        */}
        {(partial || result.withheld > 0) && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {partial &&
              `${result.unreadable} לוחות לא נקראו והם מסומנים בשגיאה למטה. המספר למעלה אינו כולל אותם. `}
            {result.withheld > 0 &&
              `${result.withheld} לוחות סגורים בהרשאות שלך — זו אינה קביעה שאין בהם דבר.`}
          </p>
        )}
      </div>
    </section>
  )
}
