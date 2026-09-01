/**
 * The readiness board: what has to be ready, in which unit, by when.
 *
 * Grouped by the day the job is due rather than listed flat, because that is
 * the question somebody opens this screen holding — "what is happening today,
 * and is anything from yesterday still open". The day comes from `dueOn`,
 * which the query already converted to the property's own calendar date; this
 * component never parses a timestamp.
 *
 * ── What is deliberately not on it ────────────────────────────────────────
 *
 * No guest name, no booking value, no rate, no payment status. Not because
 * this component hides them — because the query never asked for them. A
 * cleaner reaching this screen holds `task.view` and nothing else, and the
 * cheapest way to keep a price off a cleaner's phone is not to fetch one. The
 * booking behind a job is present only as the fact that there is one, and only
 * as a link for a reader who may open it.
 *
 * `blocked` is the one thing this board is designed to make findable — see
 * `task-status.tsx`.
 *
 * No `"use client"`: rows in, markup out.
 */

import Link from 'next/link'

import { cn } from '@/components/ui/cn'
import type { PreparationTask } from '@/app/(app)/preparation/_lib/queries'
import { PROPERTY_TIME_ZONE } from '@/lib/booking/dates'

import {
  TASK_TYPE_LABEL,
  TaskPriorityBadge,
  TaskStatusBadge,
  isBlocked,
  isSettled,
} from './task-status'

const WITHHELD = 'לא זמין לצפייה'

export type TaskBoardProps = {
  tasks: readonly PreparationTask[]
  /** The property-local date of today, so "היום" is the property's today. */
  today: string
  /** True when this reader may open the stay behind a job. */
  mayOpenBooking: boolean
}

export function TaskBoard({ tasks, today, mayOpenBooking }: TaskBoardProps) {
  const days = groupByDay(tasks)

  return (
    <div className="flex flex-col gap-6">
      {days.map(({ day, entries }) => (
        <section key={day} className="flex flex-col gap-3">
          <h3 className="flex flex-wrap items-baseline gap-2 font-display text-lg font-bold text-foreground">
            {dayHeading(day, today)}
            <span className="text-sm font-normal text-muted-foreground">
              {entries.length === 1 ? 'משימה אחת' : `${entries.length} משימות`}
              {countOpen(entries) > 0 && ` · ${countOpen(entries)} פתוחות`}
              {countBlocked(entries) > 0 && (
                <span className="font-semibold text-danger">
                  {' '}
                  · {countBlocked(entries)} תקועות
                </span>
              )}
            </span>
          </h3>

          <ul className="flex flex-col gap-3">
            {entries.map((task) => (
              <li key={task.id}>
                <TaskRow task={task} mayOpenBooking={mayOpenBooking} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function TaskRow({
  task,
  mayOpenBooking,
}: {
  task: PreparationTask
  mayOpenBooking: boolean
}) {
  return (
    <article
      className={cn(
        'flex flex-col gap-3 rounded-xl border bg-surface p-4 shadow-soft',
        // The blocked row is the one a supervisor has to find in one pass, so
        // it is outlined rather than merely badged. The badge and the reason
        // carry the same information for a reader who sees no colour.
        isBlocked(task.status) ? 'border-danger' : 'border-border',
        isSettled(task.status) && 'opacity-70',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="font-display text-base font-bold text-foreground">
          {task.title}
        </h4>
        <div className="flex flex-wrap items-center gap-2">
          <TaskPriorityBadge priority={task.priority} />
          <TaskStatusBadge status={task.status} />
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <Cell label="סוג">{TASK_TYPE_LABEL[task.type]}</Cell>
        <Cell label="יחידה">
          {task.unitId === null ? 'הנכס כולו' : (task.unitName ?? WITHHELD)}
        </Cell>
        <Cell label="נכס">{task.propertyName ?? WITHHELD}</Cell>
        <Cell label="עד השעה">
          <time dateTime={task.dueAt} dir="ltr" className="tabular-nums">
            {timeOf(task.dueAt)}
          </time>
          {task.estimatedMinutes !== null && (
            <span className="block text-xs text-muted-foreground">
              משך מוערך {task.estimatedMinutes} דקות
            </span>
          )}
        </Cell>
      </dl>

      {/* Mandatory in the database on a blocked row, so there is always one to
          show. A blocked job with no stated reason is the state this product
          does not permit. */}
      {isBlocked(task.status) && (
        <p className="rounded-lg border border-danger bg-surface px-3 py-2 text-sm text-danger">
          <span className="font-semibold">תקוע: </span>
          {task.blockedReason ?? 'לא נרשמה סיבה.'}
        </p>
      )}

      {task.description !== null && (
        <p className="text-sm text-muted-foreground">{task.description}</p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <Assignees task={task} />

        {task.requiresPhoto && <span>דרוש תיעוד בתמונה</span>}

        {/* Offered only to a reader who may open it. A cleaner sees that the
            job belongs to a stay and is given no way into it, which is the
            privacy rule rather than a missing feature. */}
        {task.bookingId !== null && mayOpenBooking && (
          <Link
            href={`/bookings/${task.bookingId}`}
            className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            השהייה שאליה המשימה שייכת
          </Link>
        )}

        {/* The plan is a different link from the stay, offered on different
            terms. `/bookings/…` is the guest, the dates and the money and
            needs `booking.view`; the preparation plan is the work, needs only
            `task.view`, and carries neither a name nor a price. So the person
            holding this job is given the plan and not the stay — the privacy
            rule stated as two links rather than as one withheld. */}
        {task.bookingId !== null && (
          <Link
            href={`/preparation/${task.bookingId}`}
            className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            תוכנית ההכנה לשהייה
          </Link>
        )}
      </div>
    </article>
  )
}

/**
 * Who is on the job.
 *
 * "Assigned" and "accepted" are different facts and are shown as different
 * facts: a board that cannot tell them apart has no idea whether the day is
 * covered, which is the reason `task_assignments.accepted_at` exists at all.
 * Nobody assigned is stated rather than left blank — an unassigned departure
 * clean is a room nobody is cleaning.
 */
function Assignees({ task }: { task: PreparationTask }) {
  if (task.assignees.length === 0) {
    return <span className="font-semibold text-warning">טרם הוקצתה לאיש</span>
  }

  return (
    <span>
      {task.assignees
        .map(
          (assignee) =>
            `${assignee.fullName ?? WITHHELD}${assignee.accepted ? '' : ' (טרם אישר)'}`,
        )
        .join(' · ')}
    </span>
  )
}

/* ------------------------------------------------------------ fragments -- */

function Cell({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  )
}

function groupByDay(
  tasks: readonly PreparationTask[],
): readonly { day: string; entries: readonly PreparationTask[] }[] {
  const days = new Map<string, PreparationTask[]>()
  for (const task of tasks) {
    days.set(task.dueOn, [...(days.get(task.dueOn) ?? []), task])
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, entries]) => ({ day, entries }))
}

function countOpen(tasks: readonly PreparationTask[]): number {
  return tasks.filter((task) => !isSettled(task.status)).length
}

function countBlocked(tasks: readonly PreparationTask[]): number {
  return tasks.filter((task) => isBlocked(task.status)).length
}

/**
 * The heading for one day.
 *
 * "היום" and "מחר" are relative to the *property's* date, which is passed in
 * rather than computed here — a component that called `new Date()` would put
 * the server's midnight on the heading and be wrong for three hours every
 * night.
 */
function dayHeading(day: string, today: string): string {
  const named = new Intl.DateTimeFormat('he-IL', {
    weekday: 'long',
    day: 'numeric',
    month: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`))

  if (day === today) return `היום · ${named}`
  if (day < today) return `${named} · עבר`
  return named
}

/** The wall-clock time of an instant, at the property's timezone. */
function timeOf(instant: string): string {
  return new Intl.DateTimeFormat('he-IL', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: PROPERTY_TIME_ZONE,
  }).format(new Date(instant))
}
