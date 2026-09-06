/**
 * The heading every step of the migration wears.
 *
 * One component rather than eight copies of the same markup, because the thing
 * that has to be identical across the eight routes is the sentence position: an
 * operator reads the lead once per screen and stops reading it if it moves.
 *
 * No `'use client'`. It takes the step it is on as a prop and renders text.
 */

import {
  MIGRATION_STEPS,
  STEP_LEAD,
  STEP_TITLE,
  stepIndex,
  type MigrationStep,
} from '@/app/(app)/migration/_lib/steps'

export function StepHeader({
  step,
  children,
}: {
  step: MigrationStep
  /** A status line the step itself owns — the file name, a count, a warning. */
  children?: React.ReactNode
}) {
  const position = stepIndex(step) + 1

  return (
    <header className="flex flex-col gap-2">
      <p className="text-xs font-semibold text-muted-foreground">
        שלב {position} מתוך {MIGRATION_STEPS.length}
      </p>
      <h2 className="font-display text-xl font-bold tracking-tight text-foreground sm:text-2xl">
        {STEP_TITLE[step]}
      </h2>
      <p className="max-w-prose text-sm text-muted-foreground">
        {STEP_LEAD[step]}
      </p>
      {children}
    </header>
  )
}

/**
 * The sentence a step shows instead of itself when it cannot be opened.
 *
 * Named rather than blank. A person who deep-links to the dry run from a
 * colleague's message, or reloads the tab and loses the file, must be told
 * which of eight things is missing — a blank panel is indistinguishable from a
 * broken product.
 */
export function StepBlocked({
  step,
  reason,
  action,
}: {
  step: MigrationStep
  reason: string
  action?: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <StepHeader step={step} />
      <div
        role="status"
        className="flex flex-col items-start gap-3 rounded-xl border border-border-strong bg-accent-soft px-4 py-4 text-sm text-accent-foreground"
      >
        <p className="font-display text-base font-bold">
          השלב הזה עדיין לא פתוח
        </p>
        <p>{reason}</p>
        <p>
          הקובץ נקרא בדפדפן הזה ולא נשלח לשום מקום, ולכן רענון של הדף או פתיחת
          הקישור במחשב אחר מתחילים מחדש. זו לא תקלה — זו הסיבה שרשימת הלקוחות
          שלך לא יושבת אצלנו בזמן שאתם מחליטים.
        </p>
        {action}
      </div>
    </section>
  )
}
