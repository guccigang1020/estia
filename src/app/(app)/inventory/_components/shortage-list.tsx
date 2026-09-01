/**
 * A shortage, with its arithmetic and the things that can be done about it.
 *
 * ── The arithmetic is on the card, not behind it ──────────────────────────
 *
 * `נדרשים 30, צפויים נקיים 24, חסרים 6`. Three numbers, one line, and the
 * shortage is visibly the difference of the other two. A card that showed
 * only the six would be a number a person either believes or ignores — and
 * once one of them is wrong, they ignore all of them.
 *
 * ── Two severities, and they mean different things ────────────────────────
 *
 * `critical` is "there will not be enough". `warning` is "there will be
 * enough, and the remainder drops under the floor you keep for the booking you
 * have not taken yet". Eating into the buffer is a decision a manager is
 * entitled to make; not being told is not. So the second is present and quiet.
 *
 * ── Only actions this organization can take ───────────────────────────────
 *
 * The engine already filtered them by capability. This renders what it was
 * given and invents nothing — a button here that the action then refuses is
 * the failure the capability model exists to prevent.
 *
 * No `"use client"`: text, numbers and links.
 */

import { formatDayMonth } from '@/lib/booking'
import { SHORTAGE_ACTION_LABEL, type ShortageAlert } from '@/lib/inventory'

import { Button } from '@/components/ui/button'

export function ShortageList({ alerts }: { alerts: readonly ShortageAlert[] }) {
  return (
    <ul className="flex flex-col gap-4">
      {alerts.map((alert) => (
        <ShortageCard key={alert.id} alert={alert} />
      ))}
    </ul>
  )
}

export function ShortageCard({ alert }: { alert: ShortageAlert }) {
  const critical = alert.severity === 'critical'

  return (
    <li
      className={
        'flex flex-col gap-3 rounded-xl border bg-surface p-4 shadow-soft ' +
        (critical ? 'border-danger' : 'border-warning')
      }
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-base font-bold text-foreground">
          {/* Colour is never the only signal. */}
          <span aria-hidden="true">{critical ? '■ ' : '▲ '}</span>
          {alert.label}
          {alert.propertyName !== null && (
            <span className="font-normal text-muted-foreground">
              {' '}
              · {alert.propertyName}
            </span>
          )}
        </h3>
        <p className="text-sm text-muted-foreground">
          {formatDayMonth(alert.date)}
          {alert.daysAhead > 0 ? ` · בעוד ${alert.daysAhead} ימים` : ' · היום'}
        </p>
      </div>

      {/* The arithmetic. Never a black-box number. */}
      <p
        className={
          'text-sm ' + (critical ? 'font-semibold text-danger' : 'text-warning')
        }
      >
        {alert.message}
      </p>

      <dl className="grid grid-cols-3 gap-3 rounded-lg bg-muted px-3 py-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">נדרש</dt>
          <dd className="tabular-nums text-foreground">{alert.required}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">צפוי נקי</dt>
          <dd className="tabular-nums text-foreground">
            {alert.expectedClean}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">חסר</dt>
          <dd className="tabular-nums text-foreground">{alert.shortage}</dd>
        </div>
      </dl>

      {alert.bookingIds.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {alert.bookingIds.length === 1
            ? 'הזמנה אחת תובעת את המלאי הזה באותו יום.'
            : `${alert.bookingIds.length} הזמנות תובעות את המלאי הזה באותו יום.`}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold text-muted-foreground">
          מה אפשר לעשות
        </p>
        <ul className="flex flex-col gap-2">
          {alert.actions.map((action) => (
            <li
              key={action.kind}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm"
            >
              {action.href === null ? (
                <span className="font-semibold text-foreground">
                  {action.label}
                </span>
              ) : (
                <Button href={action.href} variant="ghost" size="sm">
                  {action.label}
                </Button>
              )}
              <span className="text-xs text-muted-foreground">
                {action.detail}
              </span>
              {alert.suggestedAction === action.kind && (
                <span className="rounded bg-brand/10 px-2 py-0.5 text-xs font-semibold text-brand">
                  מומלץ
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </li>
  )
}

/** The label map, re-exported so a screen that lists kinds has one source. */
export { SHORTAGE_ACTION_LABEL }
