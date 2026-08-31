/**
 * The dry run, stated before anything else on the screen.
 *
 * ── Why this is the top of the page and not a tab ─────────────────────────
 *
 * Every automation product that people trust earns it in the same place:
 * Zapier's test step, Stripe's test webhooks, Make's run history. Nobody
 * switches on software that will act on their business until they have watched
 * it not act. So the first thing on `/automations` is not a list of rules — it
 * is what those rules would have done to rows that are really in this database,
 * counted by the real engine, with the matched rows named underneath.
 *
 * ── What the four numbers mean, and why `refused` is one of them ──────────
 *
 * `wouldRun` and `refused` are never added together. On a package without the
 * automation module every trigger that fires is refused, and that number is the
 * entire upgrade argument measured on the customer's own data rather than
 * asserted at them. Folding it into a total would delete the only honest
 * version of that sentence; hiding it would leave the plan lock as a brochure.
 *
 * ── What it read, said out loud ───────────────────────────────────────────
 *
 * The counts below the figures are the rows the simulation actually saw. A
 * reader without `payment.view` sees "לא נקראו" rather than a confident zero,
 * because "your business has no failed payments" and "you may not look at
 * payments" are opposite facts that would otherwise render identically.
 *
 * No `"use client"`: values in, markup out.
 */

import {
  DRY_RUN_SAMPLE,
  type DryRunInputs,
  type TableRead,
} from '../_lib/queries'
import type { DryRunHeadline } from '../_lib/rules'

export type DryRunPanelProps = {
  headline: DryRunHeadline
  inputs: DryRunInputs
  /** True when the package does not include the module. Changes the wording only. */
  locked: boolean
}

export function DryRunPanel({ headline, inputs, locked }: DryRunPanelProps) {
  return (
    <section
      aria-labelledby="dry-run-title"
      className="flex flex-col gap-5 rounded-xl border border-border-strong bg-surface p-5 shadow-soft sm:p-6"
    >
      <header className="flex flex-col gap-2">
        <h2
          id="dry-run-title"
          className="font-display text-xl font-bold tracking-tight text-foreground"
        >
          הרצה יבשה על הנתונים שלך
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          המנוע האמיתי רץ עכשיו על הזמנות, משימות ותשלומים שקיימים במסד הנתונים
          הזה, עם אותה בדיקת תנאים, אותה בדיקת הרשאות ואותו מנגנון מניעת כפילות
          שהיו רצים באמת. שום פעולה לא בוצעה — ההודעות לא נשלחו, המשימות לא
          נפתחו והחשבוניות לא הופקו.
        </p>
      </header>

      <dl className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-muted p-4 sm:grid-cols-4">
        <Figure label="אירועים שזוהו" value={headline.candidates} />
        <Figure
          label={locked ? 'היו מתבצעות בחבילה מתאימה' : 'פעולות שהיו מתבצעות'}
          value={locked ? headline.refused : headline.wouldRun}
        />
        <Figure
          label="כללים שנגעו בנתונים"
          value={locked ? headline.refusingRules : headline.actingRules}
        />
        <Figure label="סוננו בתנאי" value={headline.filtered} />
      </dl>

      {locked && headline.refused > 0 && (
        <p
          role="status"
          className="rounded-lg border border-accent-strong/40 bg-accent-soft px-4 py-3 text-sm text-foreground"
        >
          <span className="font-semibold">
            {headline.refused === 1
              ? 'פעולה אחת הייתה מתבצעת'
              : `${headline.refused} פעולות היו מתבצעות`}
          </span>{' '}
          על הנתונים שלמעלה, והחבילה הנוכחית עצרה את כולן. המספר הזה נמדד על
          הנתונים של העסק הזה ולא על דוגמה.
        </p>
      )}

      <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
        <p>
          נקראו: {sourceLine('הזמנות', inputs.bookings)} ·{' '}
          {sourceLine('משימות', inputs.tasks)} ·{' '}
          {sourceLine('תשלומים', inputs.payments)}.
        </p>
        <p>
          ההדמיה קוראת עד {DRY_RUN_SAMPLE} שורות מכל רשימה, מהחדשות ביותר, ורק
          שורות שמותר לך לראות. היא אינה מבדק על כל היסטוריית העסק.
        </p>
      </div>
    </section>
  )
}

/**
 * What was read, or the honest reason it was not.
 *
 * Three sentences, because `ReadAccess` has three states and two of them are
 * opposite conversations. An owner on Basic holds `task.view` and their package
 * does not include operations: writing "you have no permission" there sends the
 * person who *owns the business* to ask themselves for a right they already
 * hold, and reads as a refusal where an upgrade belongs.
 */
function sourceLine(noun: string, source: TableRead): string {
  switch (source.access) {
    case 'readable':
      return `${source.count} ${noun}`
    case 'missing_permission':
      return `${noun} — לא נקראו, התפקיד שלך אינו כולל צפייה בהן`
    case 'missing_feature':
      return `${noun} — לא נקראו, החבילה הנוכחית אינה כוללת אותן`
  }
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-display text-2xl font-bold tabular-nums text-foreground">
        {value}
      </dd>
    </div>
  )
}
