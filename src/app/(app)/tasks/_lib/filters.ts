/**
 * What the operations lists are filtered by, as a pure function of the URL.
 *
 * The same decision `bookings/_lib/filters.ts` and `finance/_lib/filters.ts`
 * made, for the same reason: a filtered list is a thing people send each other
 * — "look at everything that is stuck" — and a filter held in component state
 * produces a link that opens on somebody else's screen showing something else.
 *
 * Three keys rather than one, because a task board is genuinely filtered on
 * three axes and a supervisor's actual question is "which cleaning jobs are
 * blocked". Every value is checked against the frozen tuple in
 * `@/lib/contracts/states` and anything outside it is dropped rather than
 * queried — which is the honest behaviour for a hand-edited URL, and which
 * stops a value the enum does not contain reaching PostgREST as a database
 * error the reader cannot act on.
 */

import { firstParam, type SearchParams } from '@/app/(auth)/_lib/search-params'
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
} from '@/lib/contracts/states'

/** Kept as constants so the form, the parser and the query string agree. */
export const TASK_FILTER_KEYS = {
  status: 'status',
  type: 'type',
  priority: 'priority',
} as const

export type TaskFilter = {
  /** Null means "every status", which is the unfiltered list. */
  status: TaskStatus | null
  type: TaskType | null
  priority: TaskPriority | null
}

/** The unfiltered read, written once so no caller spells it three ways. */
export const NO_TASK_FILTER: TaskFilter = {
  status: null,
  type: null,
  priority: null,
}

function pick<T extends string>(
  params: SearchParams,
  key: string,
  allowed: readonly T[],
): T | null {
  const raw = firstParam(params[key])
  if (raw === null) return null
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : null
}

export function parseTaskFilter(params: SearchParams): TaskFilter {
  return {
    status: pick(params, TASK_FILTER_KEYS.status, TASK_STATUSES),
    type: pick(params, TASK_FILTER_KEYS.type, TASK_TYPES),
    priority: pick(params, TASK_FILTER_KEYS.priority, TASK_PRIORITIES),
  }
}

/**
 * Is anything hiding rows?
 *
 * `propertyId` is included because narrowing to one property is a filter the
 * reader did not set on this screen — it is the shell's property switcher —
 * and it is the one they are most likely to have forgotten about. Getting this
 * wrong tells a business with forty open jobs that it has never had one.
 */
export function hasActiveTaskFilter(
  filter: TaskFilter,
  propertyId: string | null,
): boolean {
  return (
    filter.status !== null ||
    filter.type !== null ||
    filter.priority !== null ||
    propertyId !== null
  )
}

/**
 * The filter, said back to the person whose data it is hiding.
 *
 * Shown inside the "no results" empty state, so the reader can see what is in
 * the way rather than concluding the module is broken.
 */
export function describeTaskFilter(
  filter: TaskFilter,
  labels: {
    status: Record<TaskStatus, string>
    type: Record<TaskType, string>
    priority: Record<TaskPriority, string>
  },
  propertyName?: string | null,
): string {
  const parts: string[] = []
  if (propertyName) parts.push(propertyName)
  if (filter.type !== null) parts.push(labels.type[filter.type])
  if (filter.status !== null) parts.push(labels.status[filter.status])
  if (filter.priority !== null) {
    parts.push(`עדיפות ${labels.priority[filter.priority]}`)
  }
  return parts.join(' · ')
}
