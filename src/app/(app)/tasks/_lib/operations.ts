/**
 * EXECUTION CONTEXT — SERVER ONLY. Opening a task, and opening a fault report.
 *
 * ── Nothing is defined here any more ──────────────────────────────────────
 *
 * This file used to hold the creation operation itself, with a header
 * explaining that it belonged in `src/lib` beside `src/lib/booking` and
 * `src/lib/preparation`, that no such module existed, and that it would move
 * there unchanged when one did. `src/lib/tasks` now exists and it has moved:
 * same schema, same derived status, same audit sentences, same two events, and
 * three more operations beside it — assignment, priority and cancellation —
 * which Autopilot's executor had been recording as `command_not_implemented`.
 *
 * What is left is a re-export, so that `wiring.ts`, `actions.ts` and this
 * directory's tests keep importing the operation from where they always have.
 * A screen may keep asking its own `_lib` for the thing it uses; it must not
 * be the place the thing is defined.
 */

export {
  defineTaskCreation,
  INITIAL_TASK_STATUSES,
  type CreatedTask,
  type CreateTaskInput,
  type TaskCreationOperation,
} from '@/lib/tasks'
