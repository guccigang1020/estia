/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What the guest asked for, and where it
 * got to.
 *
 * ── Three words, and never a fourth ───────────────────────────────────────
 *
 * התקבלה · בטיפול · הושלמה. `public.task_status` has nine members and the
 * trigger in §11 of migration 0034 collapses them onto four before the row is
 * ever read here — so this component could not show a staff name, an assignee,
 * a blocked reason or a completion note even if somebody added a field for it.
 * `guest_requests` does not carry them.
 *
 * `blocked` deliberately arrives as בטיפול. That the linen has not come back
 * from the laundry is a fact about the business's day; a guest told their
 * towels are BLOCKED learns something alarming they cannot act on.
 */

import { Badge, type BadgeTone } from '@/components/ui/badge'
import {
  GUEST_REQUEST_CATEGORY_LABEL,
  GUEST_REQUEST_STATE_LABEL,
  type GuestRequest,
  type GuestRequestState,
} from '@/lib/guest-journey/types'

const TONE: Record<GuestRequestState, BadgeTone> = {
  received: 'neutral',
  in_progress: 'brand',
  completed: 'accent',
  cancelled: 'neutral',
}

function when(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('he-IL', {
    day: 'numeric',
    month: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jerusalem',
  }).format(date)
}

export function RequestList({
  requests,
}: {
  requests: readonly GuestRequest[]
}) {
  if (requests.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        עוד לא שלחת בקשות.
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-2">
      {requests.map((request) => (
        <li
          key={request.id}
          className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-foreground">
              {GUEST_REQUEST_CATEGORY_LABEL[request.category]}
            </span>
            <Badge tone={TONE[request.state]}>
              {GUEST_REQUEST_STATE_LABEL[request.state]}
            </Badge>
          </div>

          {request.body && (
            <p className="whitespace-pre-line text-sm text-muted-foreground">
              {request.body}
            </p>
          )}

          <p className="text-xs text-muted-foreground">
            נשלחה {when(request.createdAt)}
            {request.completedAt && ` · הושלמה ${when(request.completedAt)}`}
          </p>
        </li>
      ))}
    </ul>
  )
}
