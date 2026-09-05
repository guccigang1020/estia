'use client'

/**
 * The in-app channel, on screen.
 *
 * This is the one channel with no credential behind it and therefore the one
 * this product delivers end to end: the row was written by the routing engine,
 * this is where a signed-in person reads it, and the three controls below are
 * what turn reading into a state the rest of the module acts on.
 *
 * ── Why there are three controls and not one ──────────────────────────────
 *
 *   · **נקרא** is "I have seen this". It clears the count and nothing else.
 *   · **טופל** is "I have DONE the thing", and it is the one with weight:
 *     `escalation.ts` reads `actedAt` and stops the ladder. Merging it into
 *     "read" would mean somebody glancing at their bell at two in the morning
 *     silences the escalation that was about to wake the manager — which is
 *     precisely the failure escalation exists to prevent.
 *   · **הסתר** removes it from the list without claiming either.
 *
 * The labels say which is which, because a person choosing between them has to
 * understand that one of them stops somebody else being called.
 *
 * ── Imports are leaf modules, never the barrel ────────────────────────────
 *
 * `@/lib/notifications` re-exports `SupabaseNotificationRepository`, which
 * pulls in `src/lib/persistence` and through it the Node-only `postgres`
 * driver. Tracing that into a client bundle is a hard build failure — the
 * payments settings screen returned 500 for exactly this reason. A client
 * component takes the vocabulary and the types, and nothing that talks to a
 * database.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useAsyncAction } from '@/components/ui/async-action'
import { PanelNote } from '@/components/shell-screens/screen'
import { markNotificationAction } from '@/app/(app)/settings/notifications/_lib/actions'
import { CATEGORY_LABEL, SEVERITY_LABEL } from '@/lib/notifications/labels'
import type {
  NotificationCategory,
  NotificationSeverity,
} from '@/lib/notifications/types'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

/**
 * What one row needs, and nothing more.
 *
 * Dates arrive already formatted. A Server Component may not hand a `Date`
 * across the boundary without it being serialised, and formatting on the
 * server means one Hebrew rendering rather than one per browser locale.
 */
export type NotificationRow = {
  id: string
  title: string
  body: string
  actionHref: string | null
  category: NotificationCategory
  severity: NotificationSeverity
  occurredAtLabel: string
  isRead: boolean
  isActed: boolean
  escalationLevel: number
}

export function NotificationList({
  rows,
}: {
  rows: readonly NotificationRow[]
}) {
  if (rows.length === 0) {
    return (
      <PanelNote>
        אין התראות פתוחות. כשיהיה תשלום שנכשל, משימה שאיחרה או בקשה שממתינה
        להחלטה שלך — היא תופיע כאן.
      </PanelNote>
    )
  }

  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <NotificationItem key={row.id} row={row} />
      ))}
    </ul>
  )
}

const SEVERITY_TONE: Record<
  NotificationSeverity,
  'neutral' | 'brand' | 'accent'
> = {
  info: 'neutral',
  attention: 'brand',
  urgent: 'accent',
  critical: 'accent',
}

function NotificationItem({ row }: { row: NotificationRow }) {
  const router = useRouter()
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const mark = useAsyncAction<void>()

  const apply = (state: 'read' | 'dismissed' | 'acted') => {
    setFailure(null)
    if (mark.pending) return

    void mark.run(async () => {
      const result = await markNotificationAction({
        notificationId: row.id,
        state,
      })
      if (!result.ok) {
        setFailure(result.error)
        return
      }
      router.refresh()
    })
  }

  return (
    <li
      className={
        'flex flex-col gap-3 rounded-xl border p-4 ' +
        (row.isRead
          ? 'border-border bg-surface'
          : // Unread is a weight, not a colour: an accent border would compete
            // with the severity badge beside it and neither would be readable.
            'border-border-strong bg-surface shadow-soft')
      }
    >
      {failure && <ActionError error={failure} />}

      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
        <h3 className="text-sm font-semibold text-foreground">{row.title}</h3>
        <div className="flex flex-wrap items-center gap-2">
          {row.escalationLevel > 0 && (
            <Badge tone="accent">{`הוסלם · רמה ${row.escalationLevel}`}</Badge>
          )}
          <Badge tone={SEVERITY_TONE[row.severity]}>
            {SEVERITY_LABEL[row.severity]}
          </Badge>
          <Badge tone="neutral">{CATEGORY_LABEL[row.category]}</Badge>
        </div>
      </div>

      {/* `whitespace-pre-line`: the raising module's own detail is a second
          line beneath the catalogue's sentence, and collapsing them would run
          "חדר 4, משפחת לוי" onto the end of a paragraph. */}
      <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
        {row.body}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {row.occurredAtLabel}
        </span>

        <div className="flex flex-wrap items-center gap-2">
          {row.actionHref && (
            <Button href={row.actionHref} variant="secondary" size="sm">
              לטיפול
            </Button>
          )}

          {!row.isActed && (
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={mark.pending}
              onClick={() => apply('acted')}
            >
              טופל
            </Button>
          )}

          {!row.isRead && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={mark.pending}
              onClick={() => apply('read')}
            >
              נקרא
            </Button>
          )}

          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={mark.pending}
            onClick={() => apply('dismissed')}
          >
            הסתר
          </Button>
        </div>
      </div>

      {!row.isActed && (
        <p className="text-xs text-muted-foreground">
          &quot;טופל&quot; עוצר את ההסלמה. &quot;נקרא&quot; רק מוריד את הסימון.
        </p>
      )}
    </li>
  )
}
