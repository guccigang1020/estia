import { cn } from '@/components/ui/cn'

/**
 * The six steps of connecting a channel, and where this business has got to.
 *
 * ── Why the order is load-bearing ─────────────────────────────────────────
 *
 * Connect → discover → match → validate → preview → activate. The last three
 * are the ones that are usually collapsed into a save button, and collapsing
 * them is how a guesthouse ends up with Booking.com selling the wrong cabin:
 * validation catches a unit that is not for sale, preview shows what will
 * actually be pushed, and activation is a decision somebody takes on purpose.
 * A mapping is written as `draft` and stays there until the last step — see
 * `resolveListing`, which will not route a reservation through anything else.
 *
 * The list is rendered as an ordered list rather than as a row of chevrons, so
 * a screen reader reads it as the sequence it is.
 */
export const SETUP_STEPS = [
  {
    key: 'connect',
    title: 'חיבור',
    body: 'התחברות לחשבון שלך בערוץ.',
  },
  {
    key: 'discover',
    title: 'איתור מודעות',
    body: 'משיכת רשימת המודעות שהערוץ מוכר בשמך.',
  },
  {
    key: 'match',
    title: 'התאמה',
    body: 'קישור כל מודעה ליחידה אצלך. מודעה ללא יחידה תיצור חריגה, לא ניחוש.',
  },
  {
    key: 'validate',
    title: 'בדיקה',
    body: 'האם היחידה קיימת, שייכת לנכס הנכון, ומוגדרת למכירה.',
  },
  {
    key: 'preview',
    title: 'תצוגה מקדימה',
    body: 'מה בדיוק ייצא לערוץ ומה ייכנס ממנו, לפני שמשהו זז.',
  },
  {
    key: 'activate',
    title: 'הפעלה',
    body: 'רק מכאן הזמנות מהערוץ הופכות להזמנות אצלך.',
  },
] as const

export type SetupStepKey = (typeof SETUP_STEPS)[number]['key']

export function SetupSteps({ current }: { current: SetupStepKey }) {
  const currentIndex = SETUP_STEPS.findIndex((step) => step.key === current)

  return (
    <ol className="flex flex-col gap-3">
      {SETUP_STEPS.map((step, index) => {
        const done = index < currentIndex
        const active = index === currentIndex

        return (
          <li
            key={step.key}
            aria-current={active ? 'step' : undefined}
            className={cn(
              'flex gap-3 rounded-lg border px-3 py-3',
              active
                ? 'border-primary bg-primary-soft'
                : 'border-border bg-surface',
            )}
          >
            <span
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                done
                  ? 'bg-success/10 text-success'
                  : active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground',
              )}
              aria-hidden="true"
            >
              {index + 1}
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-semibold text-foreground">
                {step.title}
                {/* Stated in text, not only in colour. */}
                {done && (
                  <span className="text-muted-foreground"> — הושלם</span>
                )}
              </span>
              <span className="text-xs text-muted-foreground">{step.body}</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}
