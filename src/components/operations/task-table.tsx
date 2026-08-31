/**
 * The task board, as a table on a desk and as cards on a phone.
 *
 * Two renderings of the same rows rather than one table that scrolls sideways,
 * exactly as `BookingTable` and `PaymentTable` do and for the same reason: this
 * is the screen a cleaner opens one-handed on a landing, and a horizontally
 * scrolling table is unusable there. Both are in the DOM once each and the
 * heading order is the same in both.
 *
 * ── `blocked` does not look like `in_progress`, anywhere on this screen ───
 *
 * `TaskStatusBadge` already gives `blocked` the danger outline and a glyph —
 * that component was written for exactly this distinction and is reused rather
 * than re-decided here. This table adds the second half of it: the row itself
 * carries an inline-start danger rule, and the reason is printed underneath in
 * words. `tasks_blocked_has_reason` makes that reason mandatory in the
 * database, so there is always one to print.
 *
 * The reason it matters: `in_progress` means somebody is holding the job and it
 * will finish. `blocked` means nobody can finish it until something outside the
 * job changes, and the unit it belongs to will not be ready. A supervisor
 * scanning a morning has to find the second in one pass, and colour alone is
 * never the signal.
 *
 * ── What an absence means here ────────────────────────────────────────────
 *
 * A missing key is a withheld field: `bookingId` is gone for a reader without
 * `booking.view`, so the link to the stay is not offered and not hinted at. A
 * null is a real absence: a job nobody has dated has no `dueOn`, and "לא נקבע
 * מועד" is the answer rather than a gap.
 *
 * No `"use client"`: rows in, markup out.
 */

import Link from 'next/link'

import type { TaskListItem } from '@/app/(app)/tasks/_lib/queries'
import {
  TASK_TYPE_LABEL,
  TaskPriorityBadge,
  TaskStatusBadge,
} from '@/components/preparation/task-status'
import { cn } from '@/components/ui/cn'
import { formatDayMonthYear } from '@/lib/booking'

import { Absent, Cell, Td, Th } from './table-parts'

export type TaskTableProps = {
  tasks: readonly TaskListItem[]
  /**
   * False when the reader lacks `booking.view`. The stay is then not offered as
   * a link, because the route behind it would refuse them — an offered link
   * that redirects is worse than no link.
   */
  linkBookings: boolean
  /** Sentence under the table for a screen reader, e.g. "רשימת המשימות". */
  caption: string
}

export function TaskTable({ tasks, linkBookings, caption }: TaskTableProps) {
  return (
    <>
      {/* -------------------------------------------------------- phone -- */}
      <ul className="flex flex-col gap-3 sm:hidden">
        {tasks.map((task) => (
          <li
            key={task.id}
            className={cn(
              'flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft',
              task.status === 'blocked' && 'border-s-4 border-s-danger',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <span className="font-display text-base font-bold text-foreground">
                {task.title}
              </span>
              <TaskStatusBadge status={task.status} />
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Cell label="סוג">{TASK_TYPE_LABEL[task.type]}</Cell>
              <Cell label="יחידה">
                <Where task={task} />
              </Cell>
              <Cell label="אחראי">
                <Assignees task={task} />
              </Cell>
              <Cell label="מועד">
                <Due task={task} />
              </Cell>
            </dl>

            <div className="flex flex-wrap items-center gap-2">
              <TaskPriorityBadge priority={task.priority} />
              <BookingLink task={task} linked={linkBookings} />
            </div>

            <BlockedReason task={task} />
          </li>
        ))}
      </ul>

      {/* -------------------------------------------------------- desk --- */}
      <div className="hidden overflow-hidden rounded-xl border border-border bg-surface shadow-soft sm:block">
        {/* Its own scroller, so a wide table never widens the shell. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-200 border-collapse text-start text-sm">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="border-b border-border bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <Th>משימה</Th>
                <Th>סוג</Th>
                <Th>יחידה</Th>
                <Th>אחראי</Th>
                <Th>מועד</Th>
                <Th>סטטוס</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {tasks.map((task) => (
                <tr
                  key={task.id}
                  className={cn(
                    'transition-colors hover:bg-muted',
                    // The row-level half of the blocked distinction. Paired
                    // with the badge and the printed reason, never alone.
                    task.status === 'blocked' &&
                      'border-s-4 border-s-danger bg-danger/5',
                  )}
                >
                  <Td>
                    <span className="font-medium text-foreground">
                      {task.title}
                    </span>
                    {task.description !== null && (
                      <span className="mt-0.5 block max-w-prose text-xs text-muted-foreground">
                        {task.description}
                      </span>
                    )}
                    <span className="mt-1 flex flex-wrap items-center gap-2">
                      <TaskPriorityBadge priority={task.priority} />
                      <BookingLink task={task} linked={linkBookings} />
                    </span>
                  </Td>
                  <Td>{TASK_TYPE_LABEL[task.type]}</Td>
                  <Td>
                    <Where task={task} />
                  </Td>
                  <Td>
                    <Assignees task={task} />
                  </Td>
                  <Td>
                    <Due task={task} />
                  </Td>
                  <Td>
                    <TaskStatusBadge status={task.status} />
                    <BlockedReason task={task} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------ fragments -- */

/**
 * Where the work is.
 *
 * A job with no unit is not missing one: pool plant, a delivery, a stock count
 * — plenty of work belongs to the property rather than to a room, and 0011
 * makes `unit_id` nullable for exactly that. So the property name is the answer
 * there, and "כל הנכס" says which of the two this is.
 */
function Where({ task }: { task: TaskListItem }) {
  if (task.unitName !== null) {
    return (
      <span className="flex flex-col">
        <span>{task.unitName}</span>
        {task.propertyName !== null && (
          <span className="text-xs text-muted-foreground">
            {task.propertyName}
          </span>
        )}
      </span>
    )
  }

  if (task.propertyName !== null) {
    return (
      <span className="flex flex-col">
        <span>{task.propertyName}</span>
        <span className="text-xs text-muted-foreground">כל הנכס</span>
      </span>
    )
  }

  return <Absent />
}

/**
 * Who is holding it.
 *
 * Three states, and they are not the same sentence. Nobody assigned is a
 * problem somebody has to solve. Assigned and accepted means the person has
 * seen it. Assigned and not accepted means they have not, which on a morning
 * rota is the difference between a covered shift and an assumed one.
 *
 * A null `fullName` is not a hole to be filled with "עובד": the reader either
 * may not see names (`user.view`) or the profile row was refused, and a made-up
 * label would make two different people indistinguishable on a rota.
 */
function Assignees({ task }: { task: TaskListItem }) {
  if (task.assignees.length === 0) {
    return <span className="text-warning">לא מוקצה</span>
  }

  return (
    <span className="flex flex-col gap-0.5">
      {task.assignees.map((assignee) => (
        <span key={assignee.userId}>
          {assignee.fullName ?? 'מוקצה — השם אינו זמין לך'}
          {!assignee.accepted && (
            <span className="block text-xs text-warning">טרם אישר קבלה</span>
          )}
        </span>
      ))}
    </span>
  )
}

function Due({ task }: { task: TaskListItem }) {
  if (task.dueOn === null) {
    return <span className="text-muted-foreground">לא נקבע מועד</span>
  }

  return (
    <span className="flex flex-col">
      <span>{formatDayMonthYear(task.dueOn)}</span>
      {task.completedOn !== null && (
        <span className="text-xs text-muted-foreground">
          הסתיימה {formatDayMonthYear(task.completedOn)}
        </span>
      )}
    </span>
  )
}

/**
 * The reason, in words, under the badge.
 *
 * Colour is never the only signal in this product, and a blocked job is the row
 * where that rule earns its keep: "תקועה" tells a supervisor to stop, and only
 * the reason tells them whom to telephone.
 */
function BlockedReason({ task }: { task: TaskListItem }) {
  if (task.status === 'blocked' && task.blockedReason !== null) {
    return (
      <span className="mt-1 block max-w-prose text-xs font-medium text-danger">
        ממתין ל: {task.blockedReason}
      </span>
    )
  }

  if (task.status === 'cancelled' && task.cancellationReason !== null) {
    return (
      <span className="mt-1 block max-w-prose text-xs text-muted-foreground">
        {task.cancellationReason}
      </span>
    )
  }

  return null
}

/**
 * The stay this job belongs to.
 *
 * The key is absent for a reader without `booking.view` — a cleaner — and then
 * nothing is rendered at all. Not a disabled link and not "לא זמין לצפייה":
 * whether this job happens to be attached to a stay is itself information she
 * has no need for, and the row is complete without it.
 */
function BookingLink({
  task,
  linked,
}: {
  task: TaskListItem
  linked: boolean
}) {
  if (!('bookingId' in task) || !task.bookingId) return null
  if (!linked) return null

  return (
    <Link
      href={`/bookings/${task.bookingId}`}
      className="text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      ההזמנה הקשורה
    </Link>
  )
}
