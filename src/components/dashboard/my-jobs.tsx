/**
 * The rooms one person is holding a mop for.
 *
 * ── Why a list and not a count ────────────────────────────────────────────
 *
 * Every other band of the home screen is a number, because every other band
 * answers "how much is waiting". This one answers "which room next", and a
 * count cannot answer that. A cleaner who opens the product and reads "4"
 * still has to open a second screen to learn anything, and the second screen
 * is the one she is standing in a corridor trying not to need.
 *
 * ── What is on a row, and what is structurally absent ─────────────────────
 *
 * Unit, what the job is, when it is due, whether it is stopped and why. There
 * is no guest name, no rate, no booking total and no payment state — not
 * because they are filtered out here, but because `PreparationTask` does not
 * carry them. The privacy rule is enforced by the shape of the record the
 * board reads, which is a much harder thing to get wrong than a redaction
 * somebody has to remember to write.
 *
 * No `"use client"`: rows in, markup out.
 */

import {
  TASK_TYPE_LABEL,
  TaskPriorityBadge,
  TaskStatusBadge,
} from '@/components/preparation/task-status'
import { Button } from '@/components/ui/button'
import type { PreparationTask } from '@/app/(app)/preparation/_lib/queries'

export type MyJobsPanelProps = {
  jobs: readonly PreparationTask[]
  /** The board this list is a glance at, when the reader may open it. */
  href: string | null
  /** True when there are more jobs today than the panel is showing. */
  atCeiling: boolean
}

export function MyJobsPanel({ jobs, href, atCeiling }: MyJobsPanelProps) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-soft sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-lg font-bold tracking-tight text-foreground sm:text-xl">
            יחידות להכנה היום
          </h2>
          <p className="text-sm text-muted-foreground">
            העבודה שבטווח שלך, לפי שעת היעד. מה שנתקע מופיע עם הסיבה.
          </p>
        </div>
        {href !== null && (
          <Button href={href} variant="secondary" size="sm">
            ללוח ההכנה
          </Button>
        )}
      </div>

      {jobs.length === 0 ? (
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          אין יחידה להכין היום בטווח שלך. זו תשובה אמיתית — לא סינון שהסתיר
          משהו.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {jobs.map((job) => (
            <li
              key={job.id}
              className="flex min-h-16 flex-col gap-2 rounded-lg border border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-semibold text-foreground">
                    {job.unitName ?? 'עבודה בשטח הנכס'}
                  </span>
                  <TaskStatusBadge status={job.status} />
                  <TaskPriorityBadge priority={job.priority} />
                </div>
                <p className="text-sm text-muted-foreground">
                  {TASK_TYPE_LABEL[job.type]} · {job.title}
                </p>
                {job.blockedReason && (
                  <p className="text-sm text-danger">
                    תקועה כי: {job.blockedReason}
                  </p>
                )}
              </div>

              <span className="shrink-0 text-sm text-muted-foreground">
                {job.requiresPhoto ? 'נדרש תיעוד בתמונה' : 'ללא תיעוד בתמונה'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {atCeiling && (
        <p
          role="status"
          className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
        >
          מוצגות היחידות הראשונות של היום. יש עוד — לוח ההכנה מציג את כולן.
        </p>
      )}
    </div>
  )
}
