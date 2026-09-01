/**
 * The arithmetic behind a number, shown wherever the number is.
 *
 * The charter's rule is that a projected figure shows its arithmetic and there
 * is no black-box quantity. The practical reason is an argument that happens
 * in every guest house: a manager is told the order says 30 linen sets when 25
 * guests are arriving, and "the system calculated it" loses that argument
 * every time. "25 לפי כללי ההכנה, 28 אחרי מרווח ההכנה, 30 אחרי מרווח הכביסה"
 * wins it, and it wins because it is checkable.
 *
 * Rendered as a chain rather than a single sentence because the steps are the
 * argument. A manager who disagrees usually disagrees with ONE of them — the
 * laundry buffer is too generous, or the bundle size is out of date — and a
 * single collapsed sentence gives them nothing to point at.
 *
 * No `"use client"`: values in, markup out.
 */

import type { ExplanationStep } from '@/lib/laundry'

const KIND_LABEL: Readonly<Record<ExplanationStep['kind'], string>> = {
  preparation: 'כללי ההכנה',
  preparation_buffer: 'מרווח ההכנה',
  laundry_buffer: 'מרווח הכביסה',
  bundle: 'עיגול לחבילות',
  adjustment: 'התאמה ידנית',
  aggregate: 'איחוד',
}

export type ExplanationProps = {
  steps: readonly ExplanationStep[]
  /** The figure the chain should end at. Checked, not assumed. */
  expected?: number
}

export function Explanation({ steps, expected }: ExplanationProps) {
  if (steps.length === 0) {
    // An empty chain is not a tidy absence: it means a number arrived without
    // its derivation, and saying so is better than rendering nothing under a
    // figure the reader was promised an explanation for.
    return (
      <p className="text-xs text-muted-foreground">
        לא נשמר הסבר לחישוב הזה. הכמות נכונה, אך אי אפשר להראות כאן איך היא
        התקבלה.
      </p>
    )
  }

  const last = steps.at(-1)
  const disagrees = expected !== undefined && last?.value !== expected

  return (
    <div className="flex flex-col gap-1.5">
      <ol className="flex flex-col gap-1">
        {steps.map((step, index) => (
          <li
            key={`${step.kind}-${index}`}
            className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"
          >
            <span
              aria-hidden="true"
              className="mt-1.5 size-1 shrink-0 rounded-full bg-border-strong"
            />
            <span>
              <span className="font-semibold text-foreground">
                {KIND_LABEL[step.kind]}
              </span>
              {': '}
              {step.text}
            </span>
          </li>
        ))}
      </ol>

      {/* The chain and the figure beside it must agree. A chain whose end
          disagrees with the number it explains is worse than no chain, so it
          is reported rather than quietly rendered. */}
      {disagrees && (
        <p role="status" className="text-xs font-semibold text-danger">
          שים לב: שרשרת החישוב מסתיימת ב-{last?.value} והכמות המוצגת היא{' '}
          {expected}. יש לבדוק את השורה הזאת.
        </p>
      )}
    </div>
  )
}
