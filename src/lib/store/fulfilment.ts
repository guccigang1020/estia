/**
 * What buying something creates for somebody to do.
 *
 * ── The recipe is a promise, and it is frozen ─────────────────────────────
 *
 * A product carries a `fulfilmentRecipe`; the moment it is bought, that recipe
 * is copied onto the order line as `fulfilmentRecipeSnapshot`. This module
 * reads the SNAPSHOT and never the catalogue, for the same reason nothing here
 * reads a catalogue price: the tasks that were promised are the tasks that are
 * owed, and editing the recipe next week changes the next sale rather than
 * this one.
 *
 * ── Why this returns drafts instead of writing tasks ──────────────────────
 *
 * `tasks` belongs to the operations module and to another owner. Writing into
 * it from here would put two modules in charge of one table's invariants, so
 * this produces `TaskDraft` values — a shape the operations module can insert
 * — and `operations.ts` hands them to the task writer inside the same
 * transaction as the order.
 *
 * That is also what makes the whole thing testable without a database: the
 * assertion "buying pool heating creates one task, due four hours before the
 * guest wants to swim, with a three-item checklist" is a pure function call.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────
 *
 * Every draft carries a `dedupeKey` derived from the order line. A retried
 * confirmation, a double-tapped approve, a replayed webhook: all of them
 * produce the same key, and the operations module's own uniqueness on that key
 * is what makes "two tasks for one purchase" impossible rather than unlikely.
 */

import type { TaskPriority, TaskType } from '../contracts/states'
import type { OrderLineSnapshot, StoreOrder } from './types'

/**
 * A task, as the operations module would insert it.
 *
 * Deliberately a plain shape rather than an import from `src/lib/persistence`:
 * the two modules agree on these fields and nothing more, which is a smaller
 * surface than sharing a type.
 */
export type TaskDraft = {
  organizationId: string
  propertyId: string
  bookingId: string | null
  taskType: TaskType
  priority: TaskPriority
  title: string
  description: string | null
  /** ISO instant. When the work must be finished. */
  dueAt: string
  checklist: readonly string[]
  teamId: string | null
  /** Stable across retries. See the header. */
  dedupeKey: string
  /** What caused it, so the task screen can link back. */
  sourceOrderId: string
  sourceOrderLineId: string
}

const HOUR_MS = 3_600_000

/** The task types a recipe may name. Anything else falls back to a safe one. */
const KNOWN_TASK_TYPES: readonly TaskType[] = [
  'cleaning',
  'preparation',
  'inspection',
  'maintenance',
  'guest_request',
  'delivery',
  'inventory',
  'finance',
  'administrative',
  'custom',
]

function taskTypeFor(candidate: string | undefined): TaskType {
  return candidate &&
    (KNOWN_TASK_TYPES as readonly string[]).includes(candidate)
    ? (candidate as TaskType)
    : // A purchase somebody has to act on is a guest request, which is the
      // honest default and puts it on the right board.
      'guest_request'
}

/**
 * When the work has to be done by.
 *
 * `dueOffsetHours` is relative to the service moment and is normally negative:
 * the pool is heated four hours before the guest wants to swim in it. A recipe
 * with no offset is due at the service moment itself, which is the right
 * reading for handing over a bottle of wine.
 */
function dueAtFor(serviceAt: Date, offsetHours: number | undefined): string {
  const offset = Number.isFinite(offsetHours) ? (offsetHours as number) : 0
  return new Date(serviceAt.getTime() + offset * HOUR_MS).toISOString()
}

/**
 * The tasks one order line creates. Zero, or one.
 *
 * Zero for `none`, for `external_provider` — where the work is somebody else's
 * and the artefact is a provider request rather than a task — and for
 * `inventory`, where the stock module is the actor and this module deliberately
 * does not reach into it.
 */
export function tasksForLine(input: {
  order: Pick<
    StoreOrder,
    'id' | 'organizationId' | 'propertyId' | 'bookingId' | 'reference'
  >
  line: Pick<
    OrderLineSnapshot,
    | 'id'
    | 'itemNameSnapshot'
    | 'fulfilmentKindSnapshot'
    | 'fulfilmentRecipeSnapshot'
    | 'quantity'
    | 'notes'
    | 'customizationAnswers'
  >
  serviceAt: Date
}): readonly TaskDraft[] {
  const { order, line, serviceAt } = input

  if (
    line.fulfilmentKindSnapshot !== 'staff_task' &&
    line.fulfilmentKindSnapshot !== 'custom'
  ) {
    return []
  }

  const recipe = line.fulfilmentRecipeSnapshot

  const title =
    recipe.title && recipe.title.trim().length > 0
      ? recipe.title
      : `${line.itemNameSnapshot} · הזמנה ${order.reference}`

  // The guest's answers belong in the description, because that is what the
  // person doing the work needs — "which flavour", "how many candles". They
  // are the guest's own words about the service, not their personal details.
  const answers = Object.entries(line.customizationAnswers)
    .map(([key, value]) => `${key}: ${value}`)
    .join(' · ')

  const description = [recipe.description, line.notes, answers]
    .filter((part): part is string => Boolean(part && part.trim().length > 0))
    .join('\n')

  return [
    {
      organizationId: order.organizationId,
      propertyId: order.propertyId,
      bookingId: order.bookingId,
      taskType: taskTypeFor(recipe.taskType),
      // Normal, not high. A bought extra is ordinary work, and a board where
      // everything is urgent is a board where nothing is.
      priority: 'normal',
      title,
      description: description.length > 0 ? description : null,
      dueAt: dueAtFor(serviceAt, recipe.dueOffsetHours),
      checklist: recipe.checklist ?? [],
      teamId: recipe.teamId ?? null,
      // One task per line, forever. A retry produces this same string.
      dedupeKey: `store.line:${line.id}`,
      sourceOrderId: order.id,
      sourceOrderLineId: line.id,
    },
  ]
}

/** Every task an order creates, across its lines. */
export function tasksForOrder(input: {
  order: Pick<
    StoreOrder,
    'id' | 'organizationId' | 'propertyId' | 'bookingId' | 'reference' | 'lines'
  >
  serviceAt: Date
}): readonly TaskDraft[] {
  return input.order.lines.flatMap((line) =>
    tasksForLine({ order: input.order, line, serviceAt: input.serviceAt }),
  )
}

/** Which lines need an outside company rather than a member of staff. */
export function linesNeedingProvider(
  lines: readonly OrderLineSnapshot[],
): readonly OrderLineSnapshot[] {
  return lines.filter(
    (line) =>
      line.fulfilmentKindSnapshot === 'external_provider' &&
      line.providerId !== null,
  )
}
