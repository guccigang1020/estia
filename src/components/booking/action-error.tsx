/**
 * A failed Server Action, said to the person who caused it.
 *
 * The whole point is that this component invents nothing. The server already
 * answered the three questions the charter demands — what failed, whether the
 * data was saved, whether retrying is safe — in Hebrew, inside `SafeErrorBody`.
 * `fromSafeError` adopts that wording verbatim; this renders it. A second set
 * of sentences written here would disagree with the server's within a month,
 * and the user would be told two different things about the same failure.
 *
 * A stack trace or a SQL string cannot reach here even by accident:
 * `toSafeResponse` produces only the fields below, and the technical detail is
 * a correlation id that matches a server log entry and discloses nothing.
 */

import type { SafeErrorBody } from '@/lib/errors/safe-response'
import { fromSafeError } from '@/components/states/error-copy'
import { cn } from '@/components/ui/cn'

export function ActionError({
  error,
  className,
}: {
  error: SafeErrorBody
  className?: string
}) {
  const presentation = fromSafeError(error)

  return (
    <div
      // `alert` rather than a polite status: the person pressed a button and
      // is waiting for the answer, and nothing else on screen announces it.
      role="alert"
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-danger bg-surface px-4 py-3 text-sm',
        className,
      )}
    >
      <p className="font-semibold text-danger">{presentation.title}</p>
      <p className="text-foreground">{presentation.description}</p>
      <p className="text-xs text-muted-foreground">
        {presentation.dataOutcomeText}
      </p>
      <p className="text-xs text-muted-foreground">{presentation.retryText}</p>

      {/* Every offending field, not the first: a form that reveals its
          problems one at a time is a form somebody submits five times. */}
      {error.fields && error.fields.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1 text-xs text-danger">
          {error.fields.map((issue) => (
            <li key={`${issue.field}-${issue.code}`}>
              <span className="font-medium">{issue.label ?? issue.field}</span>
              {': '}
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      {presentation.reference && (
        <p className="text-xs text-muted-foreground">
          מזהה לתקלה:{' '}
          <span dir="ltr" className="font-mono">
            {presentation.reference}
          </span>
        </p>
      )}
    </div>
  )
}
