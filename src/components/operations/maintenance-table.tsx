/**
 * The maintenance queue: what is broken, where, since when, who owns it and
 * what it is costing.
 *
 * Five questions, five columns, and each one is a column on a row or a sum over
 * one. Two renderings — table on a desk, cards on a phone — for the same reason
 * every other list in this product has two: a handyman reads this standing in a
 * plant room, and a horizontally scrolling table is unusable there.
 *
 * ── "Since when" is the column this screen exists for ─────────────────────
 *
 * A maintenance list sorted by due date tells you what is next. It does not
 * tell you that the solar boiler has been waiting eleven days for a second
 * quote, which is the sentence that gets it fixed. So the age is computed from
 * `tasks.created_at` — the day it was written down — and shown beside the
 * status rather than buried in a detail view.
 *
 * ── Money is withheld, never zeroed ───────────────────────────────────────
 *
 * `redact()` deletes the cost keys for a reader without `expense.view`, and
 * `Money` renders the absence in words. An empty cell in a money column reads
 * as ₪0, which is a number and a wrong one — a repair nobody has priced and a
 * repair that cost nothing are different facts.
 *
 * No `"use client"`: rows in, markup out.
 */

import type { MaintenanceItem } from '@/app/(app)/maintenance/_lib/queries'
import { daysOpen } from '@/app/(app)/tasks/_lib/queries'
import { Money } from '@/components/finance/money'
import {
  TASK_TYPE_LABEL,
  TaskPriorityBadge,
  TaskStatusBadge,
} from '@/components/preparation/task-status'
import { cn } from '@/components/ui/cn'
import { formatDayMonthYear } from '@/lib/booking'

import { Absent, Cell, Td, Th } from './table-parts'

export function MaintenanceTable({
  items,
  caption,
}: {
  items: readonly MaintenanceItem[]
  caption: string
}) {
  return (
    <>
      {/* -------------------------------------------------------- phone -- */}
      <ul className="flex flex-col gap-3 sm:hidden">
        {items.map((item) => (
          <li
            key={item.id}
            className={cn(
              'flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft',
              item.status === 'blocked' && 'border-s-4 border-s-danger',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <span className="font-display text-base font-bold text-foreground">
                {item.title}
              </span>
              <TaskStatusBadge status={item.status} />
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Cell label="יחידה">
                <Where item={item} />
              </Cell>
              <Cell label="פתוח מאז">
                <OpenSince item={item} />
              </Cell>
              <Cell label="אחראי">
                <Owner item={item} />
              </Cell>
              <Cell label="עלות מאושרת">
                <Money agorot={item.cost.committedAgorot} emphasis />
              </Cell>
            </dl>

            <div className="flex flex-wrap items-center gap-2">
              <TaskPriorityBadge priority={item.priority} />
            </div>

            <Waiting item={item} />
          </li>
        ))}
      </ul>

      {/* -------------------------------------------------------- desk --- */}
      <div className="hidden overflow-hidden rounded-xl border border-border bg-surface shadow-soft sm:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-200 border-collapse text-start text-sm">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="border-b border-border bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <Th>מה תקול</Th>
                <Th>יחידה</Th>
                <Th>פתוח מאז</Th>
                <Th>אחראי</Th>
                <Th>סטטוס</Th>
                <Th align="end">עלות</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((item) => (
                <tr
                  key={item.id}
                  className={cn(
                    'transition-colors hover:bg-muted',
                    item.status === 'blocked' &&
                      'border-s-4 border-s-danger bg-danger/5',
                  )}
                >
                  <Td>
                    <span className="font-medium text-foreground">
                      {item.title}
                    </span>
                    {item.description !== null && (
                      <span className="mt-0.5 block max-w-prose text-xs text-muted-foreground">
                        {item.description}
                      </span>
                    )}
                    <span className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {TASK_TYPE_LABEL[item.type]}
                      </span>
                      <TaskPriorityBadge priority={item.priority} />
                    </span>
                  </Td>
                  <Td>
                    <Where item={item} />
                  </Td>
                  <Td>
                    <OpenSince item={item} />
                  </Td>
                  <Td>
                    <Owner item={item} />
                  </Td>
                  <Td>
                    <TaskStatusBadge status={item.status} />
                    <Waiting item={item} />
                  </Td>
                  <Td align="end">
                    <Money agorot={item.cost.committedAgorot} emphasis />
                    {/* Shown only when there is one. A "ממתין לאישור: ₪0" on
                        every row is noise that hides the rows where it is
                        not — and a quote nobody has agreed to is not a cost. */}
                    {item.cost.pendingAgorot !== undefined &&
                      item.cost.pendingAgorot > 0 && (
                        <span className="block text-xs text-warning">
                          ממתין לאישור{' '}
                          <Money agorot={item.cost.pendingAgorot} />
                        </span>
                      )}
                    {item.cost.partsAgorot !== undefined &&
                      item.cost.partsAgorot > 0 && (
                        <span className="block text-xs text-muted-foreground">
                          מתוכו חלקים <Money agorot={item.cost.partsAgorot} />
                        </span>
                      )}
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

function Where({ item }: { item: MaintenanceItem }) {
  if (item.unitName !== null) {
    return (
      <span className="flex flex-col">
        <span>{item.unitName}</span>
        {item.propertyName !== null && (
          <span className="text-xs text-muted-foreground">
            {item.propertyName}
          </span>
        )}
      </span>
    )
  }

  if (item.propertyName !== null) {
    return (
      <span className="flex flex-col">
        <span>{item.propertyName}</span>
        {/* Plant, grounds and shared systems are the commonest maintenance
            work and belong to no room. `unit_id` is nullable for that. */}
        <span className="text-xs text-muted-foreground">שטח משותף</span>
      </span>
    )
  }

  return <Absent />
}

/**
 * How long this has been broken.
 *
 * The day it was written down, and the number of days since. Both, because "9
 * ביוני" answers a different question from "לפני 11 ימים" and a queue is read
 * for the second.
 */
function OpenSince({ item }: { item: MaintenanceItem }) {
  const days = daysOpen(item)
  const settled = item.completedOn !== null

  return (
    <span className="flex flex-col">
      <span>{formatDayMonthYear(item.openedOn)}</span>
      <span
        className={
          !settled && days >= 7
            ? 'text-xs font-medium text-warning'
            : 'text-xs text-muted-foreground'
        }
      >
        {settled
          ? days === 0
            ? 'נסגר באותו יום'
            : `היה פתוח ${days} ימים`
          : days === 0
            ? 'נפתח היום'
            : `${days} ימים`}
      </span>
    </span>
  )
}

function Owner({ item }: { item: MaintenanceItem }) {
  if (item.assignees.length === 0) {
    return <span className="text-warning">אין אחראי</span>
  }

  return (
    <span className="flex flex-col gap-0.5">
      {item.assignees.map((assignee) => (
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

/**
 * What the job is waiting for, in words.
 *
 * Two different waits, and they are answered by two different people. A blocked
 * job is waiting on something outside itself and `tasks_blocked_has_reason`
 * guarantees it says what. An undecided approval is waiting on a person who has
 * the authority to spend, and that is a sentence a manager can act on today.
 */
function Waiting({ item }: { item: MaintenanceItem }) {
  return (
    <>
      {item.status === 'blocked' && item.blockedReason !== null && (
        <span className="mt-1 block max-w-prose text-xs font-medium text-danger">
          ממתין ל: {item.blockedReason}
        </span>
      )}
      {item.cost.awaitingDecision && (
        <span className="mt-1 block text-xs text-warning">
          יש בקשת אישור פתוחה
        </span>
      )}
    </>
  )
}
