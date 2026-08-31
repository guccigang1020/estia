/**
 * The fault register: what was reported, where, by whom, and whether anybody
 * has picked it up.
 *
 * ── Why this is not the maintenance table with a column removed ───────────
 *
 * They read the same rows and ask different questions. The maintenance queue is
 * a manager's: what is it costing and who owns it. The register is a reporter's
 * and a supervisor's: was this seen, and has anybody taken it? So the columns
 * that matter here are *when it was reported*, *by whom*, and whether it is
 * still unassigned — and there is no money on this screen at all, because
 * `incident.view` and `expense.view` are different grants held by different
 * people and a register that leaked a repair bill would be a register a cleaner
 * could not be shown.
 *
 * `reportedBy` is an absent key for a reader without `user.view`, and then
 * nothing is printed rather than a placeholder name.
 *
 * No `"use client"`: rows in, markup out.
 */

import { daysOpen, type TaskListItem } from '@/app/(app)/tasks/_lib/queries'
import {
  TaskPriorityBadge,
  TaskStatusBadge,
} from '@/components/preparation/task-status'
import { cn } from '@/components/ui/cn'
import { formatDayMonthYear } from '@/lib/booking'

import { Absent, Cell, Td, Th } from './table-parts'

export function IncidentTable({
  incidents,
  caption,
}: {
  incidents: readonly TaskListItem[]
  caption: string
}) {
  return (
    <>
      {/* -------------------------------------------------------- phone -- */}
      <ul className="flex flex-col gap-3 sm:hidden">
        {incidents.map((incident) => (
          <li
            key={incident.id}
            className={cn(
              'flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft',
              incident.status === 'blocked' && 'border-s-4 border-s-danger',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <span className="font-display text-base font-bold text-foreground">
                {incident.title}
              </span>
              <TaskStatusBadge status={incident.status} />
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Cell label="יחידה">
                <Where incident={incident} />
              </Cell>
              <Cell label="דווח">
                <Reported incident={incident} />
              </Cell>
              <Cell label="טופל על ידי">
                <Handler incident={incident} />
              </Cell>
              <Cell label="פתוח">
                <Age incident={incident} />
              </Cell>
            </dl>

            <TaskPriorityBadge priority={incident.priority} />
            <Stuck incident={incident} />
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
                <Th>התקלה</Th>
                <Th>יחידה</Th>
                <Th>דווח</Th>
                <Th>טופל על ידי</Th>
                <Th>פתוח</Th>
                <Th>סטטוס</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {incidents.map((incident) => (
                <tr
                  key={incident.id}
                  className={cn(
                    'transition-colors hover:bg-muted',
                    incident.status === 'blocked' &&
                      'border-s-4 border-s-danger bg-danger/5',
                  )}
                >
                  <Td>
                    <span className="font-medium text-foreground">
                      {incident.title}
                    </span>
                    {incident.description !== null && (
                      <span className="mt-0.5 block max-w-prose text-xs text-muted-foreground">
                        {incident.description}
                      </span>
                    )}
                    <span className="mt-1 block">
                      <TaskPriorityBadge priority={incident.priority} />
                    </span>
                  </Td>
                  <Td>
                    <Where incident={incident} />
                  </Td>
                  <Td>
                    <Reported incident={incident} />
                  </Td>
                  <Td>
                    <Handler incident={incident} />
                  </Td>
                  <Td>
                    <Age incident={incident} />
                  </Td>
                  <Td>
                    <TaskStatusBadge status={incident.status} />
                    <Stuck incident={incident} />
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

function Where({ incident }: { incident: TaskListItem }) {
  if (incident.unitName !== null) {
    return (
      <span className="flex flex-col">
        <span>{incident.unitName}</span>
        {incident.propertyName !== null && (
          <span className="text-xs text-muted-foreground">
            {incident.propertyName}
          </span>
        )}
      </span>
    )
  }
  if (incident.propertyName !== null) {
    return (
      <span className="flex flex-col">
        <span>{incident.propertyName}</span>
        <span className="text-xs text-muted-foreground">שטח משותף</span>
      </span>
    )
  }
  return <Absent />
}

/**
 * When it was reported, and by whom where that may be shown.
 *
 * The date is `tasks.created_at`, which is the moment the report was written
 * down. The name is absent — not blank, absent — for a reader without
 * `user.view`, so nothing is printed rather than a placeholder that would make
 * two reporters indistinguishable.
 */
function Reported({ incident }: { incident: TaskListItem }) {
  return (
    <span className="flex flex-col">
      <span>{formatDayMonthYear(incident.openedOn)}</span>
      {'reportedBy' in incident && incident.reportedBy && (
        <span className="text-xs text-muted-foreground">
          {incident.reportedBy}
        </span>
      )}
    </span>
  )
}

/**
 * Who took it.
 *
 * "לא נלקח" is the state this register exists to expose: a fault nobody has
 * picked up is a fault that will be found again by the next guest.
 */
function Handler({ incident }: { incident: TaskListItem }) {
  if (incident.assignees.length === 0) {
    return <span className="text-warning">לא נלקח</span>
  }

  return (
    <span className="flex flex-col gap-0.5">
      {incident.assignees.map((assignee) => (
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

function Age({ incident }: { incident: TaskListItem }) {
  const days = daysOpen(incident)
  const settled = incident.completedOn !== null

  if (settled) {
    return (
      <span className="text-muted-foreground">
        נסגר {formatDayMonthYear(incident.completedOn as string)}
      </span>
    )
  }

  return (
    <span className={days >= 7 ? 'font-medium text-warning' : undefined}>
      {days === 0 ? 'היום' : `${days} ימים`}
    </span>
  )
}

function Stuck({ incident }: { incident: TaskListItem }) {
  if (incident.status !== 'blocked' || incident.blockedReason === null) {
    return null
  }
  return (
    <span className="mt-1 block max-w-prose text-xs font-medium text-danger">
      ממתין ל: {incident.blockedReason}
    </span>
  )
}
