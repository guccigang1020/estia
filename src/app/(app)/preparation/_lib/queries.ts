/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the preparation board.
 *
 * Writes go through `createPreparationOperations` and there is no second path.
 * Reads are different in kind — there is no rule to enforce, no version to
 * check and nothing to audit — so they are plain queries here, exactly as
 * `bookings/_lib/queries.ts` argues, and every one of them runs on the
 * request-scoped client under row level security.
 *
 * ── Two things are on this board, and they are not the same thing ─────────
 *
 * **The work plan** is the preparation domain's artefact: a versioned list of
 * sections computed from a frozen `PreparationSnapshot`, which is the entire
 * mechanism that stops a plan built in March from re-costing itself in April.
 * It is read through `SupabasePreparationPorts` — the real adapter — and never
 * re-derived from the live catalogue here.
 *
 * **The task** is the operational job somebody is actually holding: a row in
 * `public.tasks` with a due time, a unit, a status and an assignee. It is what
 * a cleaner opens the product to see.
 *
 * A plan without tasks is a plan nobody has been given; tasks without a plan
 * are what the product looks like today, because `work_plans` is written by
 * `buildPlan` and nothing has called it yet. Both states are ordinary, and the
 * screen says which one it is in rather than rendering the same blank for
 * both.
 *
 * ── The scope narrowing is the same rule `can()` applies, in SQL ──────────
 *
 * Row level security is the floor and this is not a substitute for it. But a
 * query that reads the whole organization and then filters in JavaScript has
 * already read rows it had no business reading, so the membership's scope is
 * pushed into the query — `scopeFor(actor, …, family: 'operations')`, because
 * an external seller's default scope is `own_records` and a task belongs to a
 * team. Every row that comes back is then checked again with `can()`, which is
 * the second floor `properties/_lib/load.ts` sets out: a query built wrong is
 * a bug, and a query built wrong that widens a list is a leak.
 *
 * ── Why the due window is widened and then narrowed ───────────────────────
 *
 * `due_at` is a `timestamptz` and the board is a list of *property-local
 * days*. A UTC-midnight boundary puts a job due at 01:00 in Jerusalem on the
 * previous day, which is wrong every night rather than occasionally. So the
 * query reads a day either side and `localDate` — the same function
 * `persistence/metrics.ts` converts every timestamp with — decides which day
 * each job belongs to. Over-returning costs a few rows; getting the day wrong
 * costs a cleaner turning up on the wrong morning.
 */

import { can, scopeFor, type Actor, type Scope } from '@/lib/authz/can'
import { addDays, localDate } from '@/lib/booking/dates'
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
} from '@/lib/contracts/states'
import type { SupabasePreparationPorts } from '@/lib/persistence'
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
import type { PreparationSnapshot, WorkPlan } from '@/lib/preparation'

import type { Horizon } from './horizon'

/* ------------------------------------------------------ what belongs here -- */

/**
 * The task types that stand between a unit and its next guest.
 *
 * Cleaning, preparation and inspection are the readiness chain itself.
 * `maintenance` is here for a reason worth stating: a broken boiler is the
 * commonest thing that stops a unit being ready, and a preparation board that
 * showed the cleaning and hid the reason the room cannot be let would be
 * showing the half of the day that is going well. That is also where the
 * product's only `blocked` work lives — a job waiting on a supplier's quote is
 * blocked, not merely late, and the two must not look alike.
 *
 * Deliberately excluded: `guest_request`, `inventory`, `delivery`, `finance`,
 * `administrative` and `custom`. A monthly stock count and a bottle of wine
 * for a couple are real work and neither is a unit's readiness, and a board
 * that lists everything is a board nobody scans.
 */
export const READINESS_TASK_TYPES: readonly TaskType[] = [
  'cleaning',
  'preparation',
  'inspection',
  'maintenance',
]

/** The ceiling on one board. Chosen so the query stays honest about paging. */
export const PREPARATION_PAGE_SIZE = 100

/**
 * How many stays the board will look up a work plan for.
 *
 * `PreparationPorts` has no `listPlans` — every read is `loadPlan(bookingId)`,
 * which is the right shape for the write path that builds one plan and the
 * wrong shape for a board. Until the port grows a list method this is an N+1,
 * so it is bounded out loud rather than left to grow with the window.
 */
export const PLAN_LOOKUP_LIMIT = 25

/* ------------------------------------------------------------- the task -- */

export type PreparationTask = {
  id: string
  type: TaskType
  status: TaskStatus
  priority: TaskPriority
  title: string
  description: string | null
  /** The property-local day this job is due. Never a UTC date. */
  dueOn: string
  /** The instant, kept so the board can show a time as well as a day. */
  dueAt: string
  propertyId: string
  /** Null when the job belongs to the building rather than to one unit. */
  unitId: string | null
  bookingId: string | null
  teamId: string | null
  estimatedMinutes: number | null
  requiresPhoto: boolean
  /**
   * Why it is stopped. Present only on `blocked`, and required there by
   * `tasks_blocked_has_reason` — so a blocked job on this board can always say
   * what it is waiting for.
   */
  blockedReason: string | null
  /** Null when the unit row is not readable. The id is not shown in its place. */
  unitName: string | null
  propertyName: string | null
  /** Everybody on the job, from `task_assignments`. Empty is a real answer. */
  assignees: readonly TaskAssignee[]
}

export type TaskAssignee = {
  userId: string
  /** Null when this reader may not read the profile. Never "עובד". */
  fullName: string | null
  /** True once the person has seen the job and taken it. */
  accepted: boolean
}

const TASK_COLUMNS =
  'id, organization_id, property_id, unit_id, booking_id, team_id, ' +
  'task_type, status, priority, title, description, due_at, ' +
  'estimated_minutes, requires_photo, blocked_reason, assigned_to_user_id, ' +
  'created_by'

export type ListPreparationArgs = {
  actor: Actor
  /** A single property from the shell switcher, or null for everything in scope. */
  propertyId: string | null
  horizon: Horizon
  limit?: number
}

/**
 * The readiness work in the window, as this person may see it.
 *
 * Ordered by when it is due, ascending: a board is read from the next thing
 * that has to happen, not from the newest row.
 */
export async function listPreparationTasks(
  db: Db,
  args: ListPreparationArgs,
): Promise<readonly PreparationTask[]> {
  const limit = args.limit ?? PREPARATION_PAGE_SIZE

  const rows = await scopedTaskRows(db, args, limit)
  if (rows.length === 0) return []

  const inWindow = rows
    .map(toTask)
    .filter(
      (task): task is PreparationTask =>
        task !== null &&
        task.dueOn >= args.horizon.from &&
        task.dueOn < args.horizon.to,
    )
    // The second floor. The query above was narrowed by the same scope, so a
    // row surviving that and failing this is a query built wrong — which is
    // exactly the case where a list must come out short rather than wide.
    .filter((task) =>
      can(args.actor, 'task.view', {
        organizationId: args.actor.organizationId,
        propertyId: task.propertyId,
        unitId: task.unitId ?? undefined,
        teamId: task.teamId ?? undefined,
        family: 'operations',
      }),
    )
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
    .slice(0, limit)

  return decorate(db, args.actor, inWindow)
}

/**
 * How many readiness jobs carry no due date at all.
 *
 * A dated board cannot show them, and dropping them silently would leave a
 * business with undated work that never appears anywhere. Asked as a `head`
 * count so it costs no rows, and said out loud on the screen.
 */
export async function countUndatedTasks(
  db: Db,
  args: ListPreparationArgs,
): Promise<number> {
  const counts = await Promise.all(
    taskNarrowings(args.actor).map(async (narrowing) => {
      let query = db
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', args.actor.organizationId)
        .is('deleted_at', null)
        .is('due_at', null)
        .in('task_type', [...READINESS_TASK_TYPES])

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

/* --------------------------------------------------------- the work plan -- */

export type PlannedStay = {
  bookingId: string
  /** Null when no plan has been built for this stay yet. An ordinary state. */
  plan: WorkPlan | null
  /** The frozen ruleset the plan was computed against, when there is one. */
  snapshot: PreparationSnapshot | null
}

/**
 * The work plans behind the jobs on the board.
 *
 * The booking ids come from the tasks this reader already legitimately holds,
 * not from a separate query over `bookings`. That is not a shortcut: a cleaner
 * has `task.view` and not `booking.view`, so a board that reached for the
 * bookings table to find its plans would show nothing at all to the one person
 * the plans are written for.
 *
 * `loadSnapshot` is only asked for where a plan exists, so a product with no
 * plans — which is every deployment today, because `buildPlan` is a write and
 * no screen calls it yet — costs one query per stay and no more.
 */
export async function loadPlansForTasks(
  ports: SupabasePreparationPorts,
  tasks: readonly PreparationTask[],
  limit = PLAN_LOOKUP_LIMIT,
): Promise<readonly PlannedStay[]> {
  const bookingIds = [
    ...new Set(
      tasks
        .map((task) => task.bookingId)
        .filter((id): id is string => id !== null),
    ),
  ].slice(0, limit)

  return Promise.all(
    bookingIds.map(async (bookingId) => {
      const plan = await ports.loadPlan(bookingId)
      return {
        bookingId,
        plan,
        snapshot: plan === null ? null : await ports.loadSnapshot(bookingId),
      }
    }),
  )
}

/* ------------------------------------------------------------- internals -- */

/**
 * One narrowing, as data rather than as a function over a query builder.
 *
 * `bookings/_lib/queries.ts` made this call first and for the same reason:
 * taking a PostgREST builder as a parameter needs a self-referential generic
 * that blows TypeScript's instantiation depth on these types, and an `any` in
 * the function that applies the tenant filter is not a trade worth making. So
 * the *decision* travels and each query applies it inline, where the builder's
 * type is still the one the expression produced.
 */
export type ScopeNarrowing =
  | { kind: 'none' }
  | { kind: 'in'; column: string; values: readonly string[] }
  | { kind: 'eq'; column: string; value: string }

/**
 * The membership's scope, as one or more query narrowings.
 *
 * Almost always one. `own_records` is the exception and is genuinely a
 * disjunction — `scopeReaches` admits a row assigned to this person *or*
 * created by them — and PostgREST expresses that with `.or()`, which the
 * transaction compiler and the demo client both refuse on purpose. So it is
 * two queries whose results are merged, exactly as the guest-name search in
 * `bookings/_lib/queries.ts` unions two matches rather than reaching for `or`.
 *
 * An empty scope array is a membership that reaches nothing, and it produces a
 * narrowing that matches nothing rather than being treated as a wildcard —
 * which is the same rule `resolveMetricScope` enforces for aggregates.
 */
export function scopeNarrowings(
  actor: Actor,
  scope: Scope,
): readonly ScopeNarrowing[] {
  // Platform staff act across an organization once inside it, exactly as
  // `isWithinScope` allows, and every such view is audited by the caller.
  if (actor.isPlatformStaff) return [{ kind: 'none' }]

  switch (scope.kind) {
    case 'all_organization':
      return [{ kind: 'none' }]

    case 'properties':
      return [{ kind: 'in', column: 'property_id', values: scope.propertyIds }]

    case 'units':
      return [{ kind: 'in', column: 'unit_id', values: scope.unitIds }]

    case 'team':
      return [{ kind: 'in', column: 'team_id', values: scope.teamIds }]

    case 'own_records':
      return [
        { kind: 'eq', column: 'assigned_to_user_id', value: actor.userId },
        { kind: 'eq', column: 'created_by', value: actor.userId },
      ]

    default:
      // Deny by default. An unrecognised scope reaches nothing rather than
      // everything, which is the failure mode that matters.
      return [{ kind: 'in', column: 'id', values: [] }]
  }
}

/** The narrowings for the family a task belongs to. */
function taskNarrowings(actor: Actor): readonly ScopeNarrowing[] {
  return scopeNarrowings(
    actor,
    // `family: 'operations'` and not the bare default: an external seller's
    // default scope is `own_records` and a task belongs to a team, so asking
    // without the family would apply the wrong one of their two scopes.
    scopeFor(actor, {
      organizationId: actor.organizationId,
      family: 'operations',
    }),
  )
}

async function scopedTaskRows(
  db: Db,
  args: ListPreparationArgs,
  limit: number,
): Promise<readonly Row[]> {
  // A day either side, because `due_at` is an instant and the window is a run
  // of property-local days. `toTask` decides which day each row belongs to.
  const after = `${addDays(args.horizon.from, -1)}T00:00:00Z`
  const before = `${addDays(args.horizon.to, 1)}T00:00:00Z`

  const results = await Promise.all(
    taskNarrowings(args.actor).map(async (narrowing) => {
      let query = db
        .from('tasks')
        .select(TASK_COLUMNS)
        .eq('organization_id', args.actor.organizationId)
        .is('deleted_at', null)
        .in('task_type', [...READINESS_TASK_TYPES])
        .gte('due_at', after)
        .lt('due_at', before)

      if (args.propertyId !== null) {
        query = query.eq('property_id', args.propertyId)
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

  const merged = new Map<string, Row>()
  for (const row of results.flat()) merged.set(asString(row, 'id'), row)
  return [...merged.values()]
}

/**
 * One row, or `null` when it has no due date.
 *
 * The range filter already excludes those, so this is belt to that brace
 * rather than a second rule: a row with a null `due_at` has no day to be on
 * and must not be silently placed on today's.
 */
function toTask(row: Row): PreparationTask | null {
  const dueAt = asTimestampOrNull(row, 'due_at')
  if (dueAt === null) return null

  return {
    id: asString(row, 'id'),
    type: asEnum(row, 'task_type', TASK_TYPES),
    status: asEnum(row, 'status', TASK_STATUSES),
    priority: asEnum(row, 'priority', TASK_PRIORITIES),
    title: asString(row, 'title'),
    description: asStringOrNull(row, 'description'),
    dueAt,
    dueOn: localDate(new Date(dueAt)),
    propertyId: asString(row, 'property_id'),
    unitId: asStringOrNull(row, 'unit_id'),
    bookingId: asStringOrNull(row, 'booking_id'),
    teamId: asStringOrNull(row, 'team_id'),
    estimatedMinutes: asNumberOrNull(row, 'estimated_minutes'),
    requiresPhoto: row.requires_photo === true,
    blockedReason: asStringOrNull(row, 'blocked_reason'),
    unitName: null,
    propertyName: null,
    assignees: [],
  }
}

/**
 * The names, fetched once for the whole page rather than per row.
 *
 * Four small `in` queries instead of four embeds. The embeds would be the
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
  tasks: readonly PreparationTask[],
): Promise<readonly PreparationTask[]> {
  if (tasks.length === 0) return tasks

  const unitIds = unique(tasks.map((task) => task.unitId))
  const propertyIds = unique(tasks.map((task) => task.propertyId))
  const taskIds = tasks.map((task) => task.id)

  const [unitNames, propertyNames, assignments] = await Promise.all([
    namesFrom(db, 'units', unitIds),
    namesFrom(db, 'properties', propertyIds),
    assignmentsFor(db, actor.organizationId, taskIds),
  ])

  const userIds = unique(
    [...assignments.values()].flat().map((entry) => entry.userId),
  )
  const profiles = await namesFrom(db, 'user_profiles', userIds, 'full_name')

  return tasks.map((task) => ({
    ...task,
    unitName:
      task.unitId === null ? null : (unitNames.get(task.unitId) ?? null),
    propertyName: propertyNames.get(task.propertyId) ?? null,
    assignees: (assignments.get(task.id) ?? []).map((entry) => ({
      ...entry,
      fullName: profiles.get(entry.userId) ?? null,
    })),
  }))
}

function unique(values: readonly (string | null)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => value !== null))]
}

async function namesFrom(
  db: Db,
  table: string,
  ids: readonly string[],
  column = 'name',
): Promise<ReadonlyMap<string, string>> {
  // `in.()` with no values is not a query PostgREST accepts, and asking it
  // would turn an empty page into an error.
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
    const entry = {
      userId: asString(row, 'user_id'),
      accepted: asTimestampOrNull(row, 'accepted_at') !== null,
    }
    byTask.set(taskId, [...(byTask.get(taskId) ?? []), entry])
  }

  return byTask
}
