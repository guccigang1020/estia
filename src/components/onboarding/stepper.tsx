/**
 * Where in the wizard you are, and what is still ahead.
 *
 * A server component with no state of its own: the current step is derived
 * from the database on every request (`_lib/queries.ts`), so there is nothing
 * here to fall out of sync with it.
 *
 * ACCESSIBILITY. It is an ordered list, and the current step carries
 * `aria-current="step"` — the announcement a screen reader needs and the one a
 * row of coloured circles does not provide. The numbers are decorative and are
 * hidden; the position is stated in the visually-hidden text instead, because
 * "3" alone tells a listener nothing about how many there are.
 *
 * RTL. No `left` or `right` anywhere, and the connector between steps grows
 * with `flex-1` rather than being positioned, so the sequence reads right to
 * left in Hebrew without a mirrored stylesheet.
 */

import { cn } from '@/components/ui/cn'
import type { OnboardingStep } from '@/app/(app)/onboarding/_lib/queries'

const ORDER: readonly OnboardingStep[] = [
  'organization',
  'property',
  'unit',
  'done',
]

const LABEL: Record<OnboardingStep, string> = {
  organization: 'העסק',
  property: 'הנכס',
  unit: 'היחידה הראשונה',
  done: 'סיום',
}

export function Stepper({ current }: { current: OnboardingStep }) {
  const currentIndex = ORDER.indexOf(current)

  return (
    <nav aria-label="שלבי ההצטרפות">
      <ol className="flex items-center gap-2 sm:gap-3">
        {ORDER.map((step, index) => {
          const done = index < currentIndex
          const active = index === currentIndex

          return (
            <li
              key={step}
              aria-current={active ? 'step' : undefined}
              className="flex flex-1 items-center gap-2 last:flex-none"
            >
              <span
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold transition-colors',
                  done && 'border-primary bg-primary text-primary-foreground',
                  active && 'border-primary bg-primary-soft text-primary',
                  !done &&
                    !active &&
                    'border-border-strong bg-surface text-muted-foreground',
                )}
              >
                <span aria-hidden="true">{done ? '✓' : index + 1}</span>
              </span>

              <span
                className={cn(
                  'hidden text-sm sm:inline',
                  active
                    ? 'font-semibold text-foreground'
                    : 'text-muted-foreground',
                )}
              >
                {LABEL[step]}
              </span>

              <span className="sr-only">
                {`שלב ${index + 1} מתוך ${ORDER.length}: ${LABEL[step]}${
                  done ? ' — הושלם' : active ? ' — השלב הנוכחי' : ''
                }`}
              </span>

              {index < ORDER.length - 1 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    'h-px flex-1 rounded-full',
                    done ? 'bg-primary' : 'bg-border',
                  )}
                />
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
