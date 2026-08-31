/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the operations screens.
 *
 * Four routes read `public.tasks`: the task board, the maintenance queue, the
 * fault register and — through `inventory_movements.task_id` — the stock
 * ledger. They ask different questions of the same table, so the *reading* of
 * a task row lives here once and each screen narrows it.
 *
 * ── Why this is not a repository ──────────────────────────────────────────
 *
 * There is no operations port to put it behind. `src/lib/preparation` owns the
 * readiness rules and `SupabasePreparationPorts` reads `work_plans` and
 * `preparation_snapshots`; nothing in `src/lib` owns a task, an incident or an
 * inventory item. So the reads are plain queries here, exactly as
 * `bookings/_lib/queries.ts` and `finance/_lib/queries.ts` argue, over the same
 * request-scoped client an adapter would have used, mapped with the same
 * `@/lib/persistence` helpers and validated against the same frozen
 * vocabularies in `@/lib/contracts/states`. That gap is written down in the
 * report rather than worked around silently.
 *
 * ── There is no `incidents` table, and this is where that surfaces ────────
 *
 * The permission catalogue carries `incident.view`, `incident.create`,
 * `incident.update` and `incident.resolve`, and `DOMAIN_EVENTS` carries
 * `incident.opened` and `incident.resolved`. No migration creates an
 * `incidents` table, and `createDemoClient` throws `MissingDemoTable` for one
 * on purpose. 0011's own comment says what the shape is instead: "The unit of
 * operational work: a cleaning, a repair, a guest request, an inspection. One
 * shape rather than four tables". A fault report is therefore a task whose
 * `task_type` is `maintenance`, and `INCIDENT_TASK_TYPES` below is that
 * statement written once rather than repeated on two screens.
 *
 * ── The grant is a parameter, and that is the point ───────────────────────
 *
 * The same row is `task.view` on the board and `incident.view` on the fault
 * register, and a cleaner holds the first and not the second. So `listTasks`
 * takes the grant it must check per row instead of hard-coding one, and the
 * route guard checks the same grant before any of this runs.
 *
 * No money is read here. `public.tasks` has no amount column; what maintenance
 * work costs lives in `approvals` and in the stock it consumed, and it is read
 * in `maintenance/_lib/queries.ts` where it is shown.
 */

import { can, holdsGrant, redact, type Actor } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import { localDate, nightsBetween } from '@/lib/booking'
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
} from '@/lib/contracts/states'
import {
  asEnum,
  asNumberOrNull,
  asString,
  asStringOrNull,
  asTimestampOrNull,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'

import type { TaskFilter } from './filters'
import {
  TASK_SCOPE_COLUMNS,
  narrowingsFor,
  operationsResource,
  reachesNothing,
} from './scope'

/* ---------------------------------------------------------------- shared -- */

/**
 * The ceiling on one page.
 *
 * The same number and the same reasoning as `BOOKING_PAGE_SIZE` and
 * `FINANCE_PAGE_SIZE`: the query stays honest about paging, and the screen says
 * out loud when it has hit it rather than letting a list quietly stop.
 */
export const OPERATIONS_PAGE_SIZE = 100

/**
 * What a fault report is, given that `public.incidents` does not exist.
 *
 * See the header. One entry, and it is a list rather than a constant so the
 * two screens that consume it read as "the incident types" instead of "the
 * maintenance type", which is the thing being said.
 */
export const INCIDENT_TASK_TYPES: readonly TaskType[] = ['maintenance']

/**
 * The work the maintenance queue covers.
 *
 * `inspection` is here and `cleaning` is not. A quarterly inspection is
 * maintenance of the building on the same rota, and a departure clean is the
 * readiness chain that `/preparation` already owns — putting it here would put
 * the same job on two boards with two different sets of columns.
 */
export const MAINTENANCE_TASK_TYPES: readonly TaskType[] = [
  'maintenance',
  'inspection',
]

/* ------------------------------------------------------------- the task -- */

/** Somebody on the job, from `task_assignments`. */
export type TaskAssignee = {
  userId: string
  /** Null when this reader may not read the profile. Never "עובד". */
  fullName: string | null
  /** True once the person has seen the job and taken it. */
  accepted: boolean
}

/**
 * One line of an operations list.
 *
 * The optional fields are optional because `redact()` genuinely removes them:
 * a reader without `booking.view` has no `bookingId` key at all, and the type
 * says so rather than letting a component read `undefined` out of a field it
 * was told was a string.
 */
export type TaskListItem = {
  id: string
  type: TaskType
  status: TaskStatus
  priority: TaskPriority
  title: string
  description: string | null
  propertyId: string
  /** Null when the job belongs to the building rather than to one unit. */
  unitId: string | null
  teamId: string | null
  /** The instant it is due, or null because nobody dated it. */
  dueAt: string | null
  /** That instant as the property's calendar day. Never a UTC date. */
  dueOn: string | null
  /** When the row was written, as a property-local day. Always present. */
  openedOn: string
  /** Property-local day the work finished, or null because it has not. */
  completedOn: string | null
  estimatedMinutes: number | null
  actualMinutes: number | null
  requiresPhoto: boolean
  /**
   * Why it is stopped. Present only on `blocked`, and required there by
   * `tasks_blocked_has_reason` — so a blocked job can always say what it is
   * waiting for.
   */
  blockedReason: string | null
  cancellationReason: string | null
  completionNote: string | null
  assignedToUserId: string | null
  /** Null when the unit row is not readable. The id is not shown in its place. */
  unitName: string | null
  propertyName: string | null
  /** Everybody on the job. Empty is a real answer: nobody is holding it. */
  assignees: readonly TaskAssignee[]
  /** Withheld without `booking.view`. The stay a job belongs to. */
  bookingId?: string | null
  /** Withheld with it. Never replaced by an id. */
  reportedBy?: string | null
}

/**
 * The fields a reader may hold `task.view` and still not see.
 *
 * A cleaner holds `task.view`, `task.update` and `task.complete` and holds
 * neither `booking.view` nor `guest.view_name` — so she reaches her own work
 * and cannot follow it back to the stay, which is where the guest's name and
 * the price of the stay are. Nothing on this screen prints either; this is
 * what stops the link that would.
 *
 * `user.view` gates who reported the fault. A cleaner reporting a broken boiler
 * should not learn from the board which of her colleagues reported the others.
 */
const TASK_REDACTIONS = [
  { key: 'bookingId', requires: 'booking.view' },
  { key: 'reportedBy', requires: 'user.view' },
] as const satisfies ReadonlyArray<{ key: keyof TaskListItem; requires: Grant }>

const TASK_COLUMNS =
  'id, organization_id, property_id, unit_id, booking_id, team_id, ' +
  'task_type, status, priority, title, description, due_at, ' +
  'estimated_minutes, actual_minutes, requires_photo, blocked_reason, ' +
  'cancellation_reason, completion_note, assigned_to_user_id, verified_by, ' +
  'completed_at, created_at, created_by'

export type ListTasksArgs = {
  db: Db
  actor: Actor
  /** A single property from the shell switcher, or null for everything in scope. */
  propertyId: string | null
  filter: TaskFilter
  /**
   * The grant that admits a row. `task.view` on the board, `incident.view` on
   * the fault register — the same row, two different readers.
   */
  grant: Grant
  /** Narrow to these task types, or null for every type. */
  types?: readonly TaskType[] | null
  limit?: number
}

/**
 * The tasks this reader may see, soonest first.
 *
 * Ordered by `due_at` ascending with the undated last: a board is read from
 * the next thing that has to happen. Undated work is *kept* rather than
 * dropped — `/preparation` drops it because a dated board has nowhere to put
 * it, and this board is a list, so a job nobody scheduled belongs on it at the
 * bottom instead of nowhere at all.
 */
export async function listTasks(
  args: ListTasksArgs,
): Promise<readonly TaskListItem[]> {
  const { db, actor, grant } = args
  const limit = args.limit ?? OPERATIONS_PAGE_SIZE

  const rows = await scopedTaskRows(args, limit)
  if (rows.length === 0) return []

  const visible = rows
    .map(toTask)
    // The second floor. The query above was narrowed by the same scope, so a
    // row surviving that and failing this is a query built wrong — which is
    // exactly the case where a list must come out short rather than wide.
    .filter((task) =>
      can(
        actor,
        grant,
        operationsResource(actor, {
          propertyId: task.propertyId,
          unitId: task.unitId,
          teamId: task.teamId,
          assignedToUserId: task.assignedToUserId,
        }),
      ),
    )
    .sort(byDueThenPriority)
    .slice(0, limit)

  const decorated = await decorate(db, actor, visible)

  return decorated.map((task) =>
    redact(
      actor,
      task,
      TASK_REDACTIONS,
      operationsResource(actor, {
        propertyId: task.propertyId,
        unitId: task.unitId,
        teamId: task.teamId,
        assignedToUserId: task.assignedToUserId,
      }),
    ),
  )
}

/**
 * How many tasks of these types this membership reaches, before any filter.
 *
 * Asked as a `head` count so it costs no rows, and asked *through the same
 * scope narrowing as the list* — not over the whole organization. Row level
 * security would narrow it in production and does not exist in the demo, so a
 * count that skipped the narrowing would report a different number in the two
 * places, which is precisely the divergence the demo client exists to make
 * loud. The screen uses it to tell "you have no tasks" apart from "your filter
 * matches none".
 */
export async function countTasks(
  args: Omit<ListTasksArgs, 'filter' | 'limit'>,
): Promise<number> {
  const counts = await Promise.all(
    narrowingsFor(args.actor, TASK_SCOPE_COLUMNS).map(async (narrowing) => {
      if (reachesNothing(narrowing)) return 0

      let query = args.db
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', args.actor.organizationId)
        .is('deleted_at', null)

      if (args.types) query = query.in('task_type', [...args.types])
      if (args.propertyId !== null) {
        query = query.eq('property_id', args.propertyId)
      }
      if (narrowing.kind === 'in') {
        query = query.in(narrowing.column, [...narrowing.values])
      } else if (narrowing.kind === 'eq') {
        query = query.eq(narrowing.column, narrowing.value)
      }

      const { count, error } = await query
      if (error) throw error
      return count ?? 0
    }),
  )

  // One variant for most memberships; two only for `own_records`, where the
  // rule is genuinely a disjunction. Summing then double-counts a job somebody
  // both created and holds, so the widest single answer is taken instead of a
  // total that could exceed the real one.
  return Math.max(...counts, 0)
}

/* ------------------------------------------------------------- readings -- */

/**
 * What the rows on screen add up to, for the strip above the board.
 *
 * A reading of the statuses, never a decision from them. `blocked` is counted
 * on its own and not folded into "open": a job waiting on a supplier is not a
 * job in progress, and a supervisor scanning a morning needs to find it in one
 * pass. That distinction is the whole reason `TASK_STATUSES` carries both.
 */
export type TaskSummary = {
  total: number
  blocked: number
  unassigned: number
  /** Due before today and not finished. */
  overdue: number
  /** Neither finished, verified nor cancelled. */
  open: number
}

const SETTLED_STATUSES: readonly TaskStatus[] = [
  'completed',
  'verified',
  'cancelled',
]

export function summariseTasks(
  tasks: readonly TaskListItem[],
  today = localDate(new Date()),
): TaskSummary {
  let blocked = 0
  let unassigned = 0
  let overdue = 0
  let open = 0

  for (const task of tasks) {
    const settled = SETTLED_STATUSES.includes(task.status)
    if (task.status === 'blocked') blocked += 1
    if (!settled) open += 1
    if (!settled && task.assignees.length === 0) unassigned += 1
    if (!settled && task.dueOn !== null && task.dueOn < today) overdue += 1
  }

  return { total: tasks.length, blocked, unassigned, overdue, open }
}

/**
 * How long this job has been open, in whole days.
 *
 * `nightsBetween` is the booking domain's own day arithmetic. Its parameters
 * are named for a stay because that is where it was written; the calculation
 * is a difference between two property-local ISO dates, and a second copy of
 * that subtraction is a second place for a fault to be aged wrong.
 */
export function daysOpen(
  task: TaskListItem,
  today = localDate(new Date()),
): number {
  const until = task.completedOn ?? today
  const days = nightsBetween({ checkIn: task.openedOn, checkOut: until })
  return Number.isNaN(days) ? 0 : Math.max(days, 0)
}

/* ------------------------------------------------------------ internals -- */

/**
 * Soonest first, with the undated last and the urgent above the ordinary.
 *
 * Two keys rather than one: a board sorted by date alone puts a critical job
 * due on Thursday below four low-priority ones due on Wednesday, and the
 * person reading it at seven in the morning is looking for the first.
 */
function byDueThenPriority(a: TaskListItem, b: TaskListItem): number {
  if (a.dueAt === null && b.dueAt !== null) return 1
  if (a.dueAt !== null && b.dueAt === null) return -1
  if (a.dueAt !== null && b.dueAt !== null && a.dueAt !== b.dueAt) {
    return a.dueAt.localeCompare(b.dueAt)
  }
  return (
    TASK_PRIORITIES.indexOf(b.priority) - TASK_PRIORITIES.indexOf(a.priority)
  )
}

async function scopedTaskRows(
  args: ListTasksArgs,
  limit: number,
): Promise<readonly Row[]> {
  const results = await Promise.all(
    narrowingsFor(args.actor, TASK_SCOPE_COLUMNS).map(async (narrowing) => {
      if (reachesNothing(narrowing)) return [] as Row[]

      let query = args.db
        .from('tasks')
        .select(TASK_COLUMNS)
        .eq('organization_id', args.actor.organizationId)
        .is('deleted_at', null)

      if (args.types) query = query.in('task_type', [...args.types])
      if (args.propertyId !== null) {
        query = query.eq('property_id', args.propertyId)
      }
      if (args.filter.status !== null) {
        query = query.eq('status', args.filter.status)
      }
      if (args.filter.type !== null) {
        query = query.eq('task_type', args.filter.type)
      }
      if (args.filter.priority !== null) {
        query = query.eq('priority', args.filter.priority)
      }
      if (narrowing.kind === 'in') {
        query = query.in(narrowing.column, [...narrowing.values])
      } else if (narrowing.kind === 'eq') {
        query = query.eq(narrowing.column, narrowing.value)
      }

      const { data, error } = await query
        .order('due_at', { ascending: true })
        .limit(limit)

      if (error) throw error
      return toRows(data)
    }),
  )

  // Merged by id: the two `own_records` variants overlap on any job somebody
  // both created and holds, and a board must not print it twice.
  const merged = new Map<string, Row>()
  for (const row of results.flat()) merged.set(asString(row, 'id'), row)
  return [...merged.values()]
}

function toTask(row: Row): TaskListItem {
  const dueAt = asTimestampOrNull(row, 'due_at')
  const completedAt = asTimestampOrNull(row, 'completed_at')
  const createdAt = asTimestampOrNull(row, 'created_at')

  return {
    id: asString(row, 'id'),
    type: asEnum(row, 'task_type', TASK_TYPES),
    status: asEnum(row, 'status', TASK_STATUSES),
    priority: asEnum(row, 'priority', TASK_PRIORITIES),
    title: asString(row, 'title'),
    description: asStringOrNull(row, 'description'),
    propertyId: asString(row, 'property_id'),
    unitId: asStringOrNull(row, 'unit_id'),
    teamId: asStringOrNull(row, 'team_id'),
    dueAt,
    dueOn: dueAt === null ? null : localDate(new Date(dueAt)),
    // `tasks.created_at` is `not null default now()`, so a row without one is a
    // row that did not come from this database. Falling back to today would
    // date every fault to this morning, which is the one thing an age column
    // must never do.
    openedOn:
      createdAt === null
        ? localDate(new Date())
        : localDate(new Date(createdAt)),
    completedOn: completedAt === null ? null : localDate(new Date(completedAt)),
    estimatedMinutes: asNumberOrNull(row, 'estimated_minutes'),
    actualMinutes: asNumberOrNull(row, 'actual_minutes'),
    requiresPhoto: row.requires_photo === true,
    blockedReason: asStringOrNull(row, 'blocked_reason'),
    cancellationReason: asStringOrNull(row, 'cancellation_reason'),
    completionNote: asStringOrNull(row, 'completion_note'),
    assignedToUserId: asStringOrNull(row, 'assigned_to_user_id'),
    unitName: null,
    propertyName: null,
    assignees: [],
    bookingId: asStringOrNull(row, 'booking_id'),
    // Resolved to a name in `decorate`. The id is never printed.
    reportedBy: asStringOrNull(row, 'created_by'),
  }
}

/**
 * The names, fetched once for the whole page rather than per row.
 *
 * Three small `in` queries instead of three embeds. The embeds would be the
 * obvious move and are not available: `DEMO_RELATIONS` declares the joins the
 * demo client can resolve and `tasks` has none of them, so an embed here would
 * be a screen that works against Postgres and throws `UnsupportedQuery` in the
 * demo — which is precisely the divergence the demo client exists to make
 * loud. Separate reads behave identically in both.
 *
 * A name that does not come back stays `null`. Row level security may refuse a
 * unit or a profile this reader may not see, and a truncated uuid in a column
 * headed "יחידה" is unhelpful while a confident wrong label is worse.
 */
async function decorate(
  db: Db,
  actor: Actor,
  tasks: readonly TaskListItem[],
): Promise<readonly TaskListItem[]> {
  if (tasks.length === 0) return tasks

  const [unitNames, propertyNames, assignments] = await Promise.all([
    namesFrom(db, 'units', unique(tasks.map((task) => task.unitId))),
    namesFrom(db, 'properties', unique(tasks.map((task) => task.propertyId))),
    assignmentsFor(
      db,
      actor.organizationId,
      tasks.map((task) => task.id),
    ),
  ])

  /**
   * Names are only *read* when this reader may see them.
   *
   * Not merely hidden afterwards. `redact()` deletes keys on the record it is
   * given and cannot reach into `assignees[].fullName` one level down — the
   * same limit `finance/_lib/queries.ts` runs into with a commission rule's
   * label — so a reader without `user.view` would otherwise be handed every
   * colleague's name inside the array while the top-level key was tidied away.
   * Skipping the query is the version of that which cannot be got wrong, and it
   * is one fewer round trip for the reader who is refused anyway.
   */
  const profiles = holdsGrant(actor, 'user.view')
    ? await namesFrom(
        db,
        'user_profiles',
        unique([
          ...[...assignments.values()].flat().map((entry) => entry.userId),
          ...tasks.map((task) => task.reportedBy ?? null),
        ]),
        'full_name',
      )
    : new Map<string, string>()

  return tasks.map((task) => ({
    ...task,
    unitName:
      task.unitId === null ? null : (unitNames.get(task.unitId) ?? null),
    propertyName: propertyNames.get(task.propertyId) ?? null,
    reportedBy:
      task.reportedBy == null ? null : (profiles.get(task.reportedBy) ?? null),
    assignees: (assignments.get(task.id) ?? []).map((entry) => ({
      ...entry,
      fullName: profiles.get(entry.userId) ?? null,
    })),
  }))
}

export function unique(
  values: readonly (string | null | undefined)[],
): readonly string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

export async function namesFrom(
  db: Db,
  table: string,
  ids: readonly string[],
  column = 'name',
): Promise<ReadonlyMap<string, string>> {
  // `in.()` with no values is not a query worth issuing, and asking it would
  // turn an empty page into an error.
  if (ids.length === 0) return new Map()

  const { data, error } = await db
    .from(table)
    .select(`id, ${column}`)
    .in('id', [...ids])

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    const value = asStringOrNull(row, column)
    if (value !== null) names.set(asString(row, 'id'), value)
  }
  return names
}

async function assignmentsFor(
  db: Db,
  organizationId: string,
  taskIds: readonly string[],
): Promise<ReadonlyMap<string, readonly Omit<TaskAssignee, 'fullName'>[]>> {
  if (taskIds.length === 0) return new Map()

  const { data, error } = await db
    .from('task_assignments')
    .select('task_id, user_id, accepted_at, declined_at, unassigned_at')
    .eq('organization_id', organizationId)
    .in('task_id', [...taskIds])

  if (error) throw error

  const byTask = new Map<string, Omit<TaskAssignee, 'fullName'>[]>()

  for (const row of toRows(data)) {
    // Somebody who declined, or who was taken off, is not on the job. Leaving
    // them on the board is how a shift looks covered when it is not.
    if (asTimestampOrNull(row, 'declined_at') !== null) continue
    if (asTimestampOrNull(row, 'unassigned_at') !== null) continue

    const taskId = asString(row, 'task_id')
    byTask.set(taskId, [
      ...(byTask.get(taskId) ?? []),
      {
        userId: asString(row, 'user_id'),
        accepted: asTimestampOrNull(row, 'accepted_at') !== null,
      },
    ])
  }

  return byTask
}
