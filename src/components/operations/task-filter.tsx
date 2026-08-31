'use client'

/**
 * The three-axis filter the operations lists share.
 *
 * `"use client"` because it navigates. The filter is pushed into the URL and
 * the server component re-queries, so a filtered list is a link somebody can
 * send and the back button undoes a filter the way a person expects — the same
 * decision `StatusFilterBar` and `BookingFiltersBar` made, for the same reason.
 *
 * It is a real `<form method="get">` with real named controls and a real submit
 * button, so it works before hydration and with JavaScript disabled: the
 * browser's own GET submission produces the same query string this handler
 * builds. The handler exists to make it a client-side navigation, not to make
 * it work at all.
 *
 * The statuses, types and priorities are props and are always the frozen tuples
 * from `@/lib/contracts/states` with the Hebrew names
 * `components/preparation/task-status.tsx` already owns. A list retyped here
 * would drift from the enum the moment one was added, and the filter would
 * quietly stop being able to find those rows — which on this board means being
 * unable to select `blocked`, the one status somebody is actually hunting for.
 *
 * `axes` exists because the fault register has no type axis to offer: every row
 * on it is one type by definition, and a select with one option is a control
 * that pretends to do something.
 */

import { useRouter, useSearchParams } from 'next/navigation'
import { useTransition, type FormEvent } from 'react'

import { TASK_FILTER_KEYS } from '@/app/(app)/tasks/_lib/filters'
import {
  TASK_PRIORITY_LABEL,
  TASK_STATUS_LABEL,
  TASK_TYPE_LABEL,
} from '@/components/preparation/task-status'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/input'
import type { TaskPriority, TaskStatus, TaskType } from '@/lib/contracts/states'

export type TaskFilterAxis = 'status' | 'type' | 'priority'

export function TaskFilterBar({
  path,
  legend,
  axes,
  statuses,
  types,
  priorities,
  selected,
}: {
  /** Where the form submits. The screen's own route, e.g. `/tasks`. */
  path: string
  /** Names the form for a screen reader: "סינון משימות". */
  legend: string
  /** Which axes this screen genuinely filters on. */
  axes: readonly TaskFilterAxis[]
  statuses: readonly TaskStatus[]
  types: readonly TaskType[]
  priorities: readonly TaskPriority[]
  selected: {
    status: TaskStatus | null
    type: TaskType | null
    priority: TaskPriority | null
  }
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const form = new FormData(event.currentTarget)
    const next = new URLSearchParams()

    for (const key of Object.values(TASK_FILTER_KEYS)) {
      const value = form.get(key)
      // An empty value is dropped rather than written as `?status=`, so a
      // cleared filter produces a clean URL and "is anything filtered" stays
      // readable from the address bar.
      if (typeof value === 'string' && value.trim().length > 0) {
        next.set(key, value.trim())
      }
    }

    const query = next.toString()
    startTransition(() => {
      router.push(query.length > 0 ? `${path}?${query}` : path)
    })
  }

  const isFiltered = Object.values(TASK_FILTER_KEYS).some(
    (key) => searchParams.get(key) !== null,
  )

  return (
    <form
      method="get"
      action={path}
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5"
      aria-label={legend}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {axes.includes('status') && (
          <Field label="סטטוס">
            <Select
              name={TASK_FILTER_KEYS.status}
              defaultValue={selected.status ?? ''}
            >
              <option value="">כל הסטטוסים</option>
              {statuses.map((status) => (
                <option key={status} value={status}>
                  {TASK_STATUS_LABEL[status]}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {axes.includes('type') && (
          <Field label="סוג">
            <Select
              name={TASK_FILTER_KEYS.type}
              defaultValue={selected.type ?? ''}
            >
              <option value="">כל הסוגים</option>
              {types.map((type) => (
                <option key={type} value={type}>
                  {TASK_TYPE_LABEL[type]}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {axes.includes('priority') && (
          <Field label="עדיפות">
            <Select
              name={TASK_FILTER_KEYS.priority}
              defaultValue={selected.priority ?? ''}
            >
              <option value="">כל העדיפויות</option>
              {priorities.map((priority) => (
                <option key={priority} value={priority}>
                  {TASK_PRIORITY_LABEL[priority]}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'מסנן…' : 'סנן'}
        </Button>

        {/* A link, not a reset button: clearing the filter is a navigation to
            the unfiltered list, which is exactly what the URL says. */}
        {isFiltered && (
          <Button href={path} variant="ghost" size="sm">
            נקה סינון
          </Button>
        )}

        <span aria-live="polite" className="sr-only">
          {pending ? 'מסנן את הרשימה' : ''}
        </span>
      </div>
    </form>
  )
}
