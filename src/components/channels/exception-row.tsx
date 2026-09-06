import { playbookFor } from '@/lib/channels/exceptions'
import type { ChannelException } from '@/lib/channels/types'

import { SeverityBadge } from './sync-badge'

/**
 * One exception, and what to do about it.
 *
 * ── The resolution path is on the row, not behind it ──────────────────────
 *
 * An exception centre where every row has to be opened to learn what it means
 * is an exception centre somebody works once. The steps come from
 * `EXCEPTION_PLAYBOOK`, which is a total record over the exception kinds — so
 * a kind cannot be added without somebody writing down how it is cleared.
 *
 * ── The grant is shown, and that is not clutter ───────────────────────────
 *
 * A receptionist who can see a mapping problem and cannot fix it needs to know
 * *who* to ask, and "you do not have permission" arrives too late to help. The
 * playbook names the grant, and the row says it.
 */
export function ExceptionRow({
  exception,
  now,
}: {
  exception: ChannelException
  /** Passed in so the rendered age is deterministic — see the screens. */
  now: Date
}) {
  const playbook = playbookFor(exception.kind)
  const settled =
    exception.state === 'resolved' || exception.state === 'dismissed'

  return (
    <li className="flex flex-col gap-3 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={exception.severity} />
          <span className="font-semibold text-foreground">
            {exception.title}
          </span>
          {exception.state === 'acknowledged' && (
            <span className="text-xs text-muted-foreground">
              (נצפה, טרם טופל)
            </span>
          )}
        </div>
        <time
          className="text-xs text-muted-foreground"
          dateTime={exception.occurredAt.toISOString()}
        >
          {formatWhen(exception.occurredAt, now)}
        </time>
      </div>

      <p className="text-sm text-foreground">{exception.detail}</p>

      {(exception.externalReservationId || exception.externalListingId) && (
        <p className="text-xs text-muted-foreground">
          {exception.externalReservationId &&
            `הזמנה בערוץ: ${exception.externalReservationId}`}
          {exception.externalReservationId && exception.externalListingId
            ? ' · '
            : ''}
          {exception.externalListingId &&
            `מודעה: ${exception.externalListingId}`}
        </p>
      )}

      {!settled && (
        <div className="rounded-lg bg-muted px-3 py-3">
          <p className="text-xs font-semibold text-foreground">מה עושים</p>
          <ol className="mt-1.5 flex list-inside list-decimal flex-col gap-1 text-xs text-muted-foreground">
            {playbook.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="mt-2 text-xs text-muted-foreground">
            נדרשת ההרשאה <code className="font-mono">{playbook.requires}</code>
            {playbook.retryable
              ? '. אחרי התיקון אפשר להריץ את הקליטה מחדש.'
              : '. הרצה חוזרת לא תפתור את זה — נדרשת החלטה.'}
          </p>
        </div>
      )}

      {settled && exception.resolutionNote && (
        <p className="text-xs text-muted-foreground">
          נסגר: {exception.resolutionNote}
        </p>
      )}
    </li>
  )
}

/**
 * How long this has been waiting.
 *
 * Relative rather than absolute, because the number that matters is the age:
 * an unmapped reservation from Tuesday has had four more days to be sold to
 * somebody else. The absolute time is on the `dateTime` attribute for anyone
 * who needs it.
 */
function formatWhen(at: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000)
  if (minutes < 1) return 'עכשיו'
  if (minutes < 60) return `לפני ${minutes} דקות`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? 'לפני שעה' : `לפני ${hours} שעות`

  const days = Math.floor(hours / 24)
  return days === 1 ? 'אתמול' : `לפני ${days} ימים`
}
