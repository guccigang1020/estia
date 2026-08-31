/**
 * A job's status, named in Hebrew, and the one status that must never be
 * mistaken for progress.
 *
 * ── `blocked` is not a slow `in_progress` ─────────────────────────────────
 *
 * They are opposite situations wearing the same greyish badge in most task
 * boards. `in_progress` means somebody is holding it and it will finish;
 * `blocked` means nobody can finish it until something outside the job
 * changes, and the unit it belongs to will not be ready. A supervisor scanning
 * a morning needs to find the second in one pass.
 *
 * So `blocked` is the only status here that leaves the flat badge entirely: it
 * carries the danger outline, a warning glyph, and — because colour is never
 * the only signal in this product — the reason underneath it in words.
 * `tasks_blocked_has_reason` makes that reason mandatory in the database, so
 * there is always one to show.
 *
 * The labels are a total `Record<TaskStatus, …>` over the frozen vocabulary in
 * `src/lib/contracts/states.ts`, so a status added to the contract fails the
 * build here rather than rendering `awaiting_approval` at a housekeeper.
 * Nothing in this file invents a status name.
 *
 * No `"use client"`: it renders text.
 */

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { cn } from '@/components/ui/cn'
import {
  TASK_PRIORITIES,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
} from '@/lib/contracts/states'

export const TASK_STATUS_LABEL: Readonly<Record<TaskStatus, string>> = {
  new: 'חדשה',
  assigned: 'הוקצתה',
  accepted: 'אושרה על ידי המבצע',
  in_progress: 'בביצוע',
  blocked: 'תקועה',
  awaiting_approval: 'ממתינה לאישור',
  completed: 'הושלמה',
  verified: 'נבדקה ואושרה',
  cancelled: 'בוטלה',
}

export const TASK_TYPE_LABEL: Readonly<Record<TaskType, string>> = {
  cleaning: 'ניקיון',
  preparation: 'הכנה',
  inspection: 'ביקורת',
  maintenance: 'תחזוקה',
  guest_request: 'בקשת אורח',
  delivery: 'משלוח',
  inventory: 'מלאי',
  finance: 'כספים',
  administrative: 'מנהלה',
  custom: 'אחר',
}

export const TASK_PRIORITY_LABEL: Readonly<Record<TaskPriority, string>> = {
  low: 'נמוכה',
  normal: 'רגילה',
  high: 'גבוהה',
  critical: 'קריטית',
}

/**
 * Which statuses mean the work is behind somebody rather than ahead of them.
 *
 * Used to summarise a day, never to decide anything: the status itself is the
 * record, and this is a reading of it.
 */
const SETTLED = new Set<TaskStatus>(['completed', 'verified', 'cancelled'])

export function isSettled(status: TaskStatus): boolean {
  return SETTLED.has(status)
}

export function isBlocked(status: TaskStatus): boolean {
  return status === 'blocked'
}

function toneFor(status: TaskStatus): BadgeTone {
  if (status === 'in_progress' || status === 'accepted') return 'brand'
  if (status === 'verified' || status === 'completed') return 'accent'
  return 'neutral'
}

export function TaskStatusBadge({
  status,
  className,
}: {
  status: TaskStatus
  className?: string
}) {
  if (status === 'blocked') {
    return (
      <Badge
        tone="neutral"
        className={cn(
          'border border-danger bg-surface font-bold text-danger',
          className,
        )}
      >
        <span aria-hidden="true">■</span>
        {TASK_STATUS_LABEL.blocked}
      </Badge>
    )
  }

  return (
    <Badge
      tone={toneFor(status)}
      className={cn(
        status === 'cancelled' && 'line-through opacity-70',
        className,
      )}
    >
      {TASK_STATUS_LABEL[status]}
    </Badge>
  )
}

/**
 * Priority, shown only when it is above the ordinary.
 *
 * A badge on every row is a badge nobody reads, and `normal` is what most work
 * is. `TASK_PRIORITIES` is imported rather than retyped so the ordering below
 * cannot drift from the contract's.
 */
export function TaskPriorityBadge({ priority }: { priority: TaskPriority }) {
  if (TASK_PRIORITIES.indexOf(priority) <= TASK_PRIORITIES.indexOf('normal')) {
    return null
  }

  return (
    <Badge
      tone="neutral"
      className={priority === 'critical' ? 'text-danger' : 'text-warning'}
    >
      עדיפות {TASK_PRIORITY_LABEL[priority]}
    </Badge>
  )
}
