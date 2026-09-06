/**
 * Tasks, in one import.
 *
 * The unit of operational work — a cleaning, a repair, a guest request, an
 * inspection — and the four things this module lets somebody do to one:
 *
 *   `defineTaskCreation`        open a task, or report a fault
 *   `defineTaskAssignment`      put somebody on it, taking off whoever was
 *   `defineTaskPriorityChange`  say how urgent it is now
 *   `defineTaskCancellation`    stop work that should not happen
 *
 * Every one of them is a `defineOperation`, so none can reach a write without
 * having passed authorization twice, validation, the domain rule and the audit
 * event. Reading the work itself starts in `operations.ts`; the shapes are in
 * `types.ts`.
 *
 * ── Why `repository.ts` is not re-exported here ───────────────────────────
 *
 * It reaches PostgREST, and nothing that only wants a priority label should be
 * handed a database adapter. It is reachable, deliberately, only at
 * `@/lib/tasks/repository`, by a caller that has said out loud it wants one.
 *
 * Being honest about the limit of that: the operations construct the adapter
 * themselves from the request-scoped client, so this barrel still *reaches* it
 * even though it does not name it. What actually keeps a Client Component
 * importing this file from taking every route down with `Can't resolve 'fs'`
 * is that `repository.ts` imports the persistence *leaves* and never the
 * `@/lib/persistence` barrel, which re-exports the `postgres` driver.
 * `scripts/client-bundle.mjs` walks that graph and is the thing that proves
 * it — it records the same failure happening three times in one day.
 */

export {
  defineTaskAssignment,
  defineTaskCancellation,
  defineTaskCreation,
  defineTaskPriorityChange,
  type TaskAssignmentOperation,
  type TaskCancellationOperation,
  type TaskCreationOperation,
  type TaskOperationOptions,
  type TaskPriorityOperation,
} from './operations'

export {
  INITIAL_TASK_STATUSES,
  SETTLED_TASK_STATUSES,
  TASK_PRIORITY_LABELS,
  isSettled,
  type AssignTaskInput,
  type CancelTaskInput,
  type ChangePriorityInput,
  type CreatedTask,
  type CreateTaskInput,
  type PriorityChangeResult,
  type TaskAssignment,
  type TaskAssignmentResult,
  type TaskCancellationResult,
  type TaskRecord,
} from './types'
