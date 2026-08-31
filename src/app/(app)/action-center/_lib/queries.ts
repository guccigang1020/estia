/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the action centre.
 *
 * ── What this screen is, and what it refuses to be ────────────────────────
 *
 * Five questions about today, each answered from a table and none of them a
 * statistic: who arrives, who leaves, which of those stays still owes money,
 * which work is stuck, and which decision is waiting for a person. Every row
 * that comes out of this file is a record somebody can open and act on. There
 * is no occupancy percentage here and no revenue tile, and that is not an
 * omission — `dashboard/page.tsx` argues at length that a fabricated "72%
 * תפוסה" is a number somebody eventually repeats to their accountant, and a
 * KPI wall bolted onto the one screen a manager opens at 8am would be the same
 * mistake with a different heading.
 *
 * ── Today is a property-local day, never a UTC one ────────────────────────
 *
 * `check_in` and `check_out` are `date` columns and compare cleanly. Everything
 * with a `timestamptz` — a payment's `created_at`, a task's `due_at` — is
 * converted with `localDate` against `PROPERTY_TIME_ZONE`, which is the same
 * conversion `persistence/metrics.ts` and `finance/_lib/queries.ts` use. An
 * ISO slice would file a payment taken at 00:30 in Israel under yesterday, on
 * the screen whose entire subject is what happens today.
 *
 * ── Three floors, and the menu is none of them ────────────────────────────
 *
 *   1. `requireActionCenterAccess` refuses the route without any of four
 *      grants, and each panel below additionally asks `holdsGrant` for its own
 *      before it issues a query — so a receptionist gets no approvals panel
 *      rather than an empty one.
 *   2. The membership's scope is pushed into the query as a narrowing, and
 *      every row that survives it is checked again with `can()` against the
 *      property it names. A query built wrong then returns short rather than
 *      wide, which is the failure direction that matters.
 *   3. Row level security refuses regardless of both. `bookings_select`,
 *      `tasks_select`, `payments_select` and `approvals_select` each carry
 *      their own `has_permission(...)` plus `property_in_scope`.
 *
 * `redact()` is the fourth thing and is not a floor of the same kind: it
 * removes fields from rows this reader is entitled to. The guest's name is
 * gated on `guest.view_name` and the money on `booking.view_price`, and the
 * name is not even *asked for* without the grant — see `stayGuestNames`.
 *
 * ── Money ─────────────────────────────────────────────────────────────────
 *
 * Integer agorot throughout, read through `asAgorot`, which refuses a float at
 * the border. Nothing here divides by 100. `sumAgorot` is the domain's own
 * addition and the only way a set of amounts becomes one amount.
 *
 * The outstanding figure reproduces `outstandingAgorot` from
 * `src/lib/finance/operations.ts` rather than calling it, and that is a gap
 * worth naming: that function takes `readonly Payment[]`, and a `Payment` is a
 * domain record with `appliedEventIds` — a second query per row against
 * `payment_attempts`, which the demo does not carry and which this screen shows
 * none of. Building sixteen fabricated `Payment` records to reach a subtraction
 * would be worse than performing the subtraction with the domain's own sum. The
 * finance port needs a list method; until it has one, this is written down
 * rather than worked around silently.
 */

import { scopeNarrowings } from '@/app/(app)/preparation/_lib/queries'
import {
  can,
  holdsGrant,
  redact,
  scopeFor,
  type Actor,
  type Resource,
} from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import { BOOKING_STATUSES, type BookingStatus } from '@/lib/booking/types'
import { addDays, localDate } from '@/lib/booking/dates'
import {
  APPROVAL_STATUSES,
  APPROVAL_TYPES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  type ApprovalStatus,
  type ApprovalType,
  type PaymentMethod,
  type PaymentStatus,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
} from '@/lib/contracts/states'
import {
  PAYMENT_ATTENTIONS,
  sumAgorot,
  type PaymentAttention,
} from '@/lib/finance'
import {
  asAgorot,
  asEnum,
  asEnumOrNull,
  asIsoDate,
  asNumber,
  asNumberOrNull,
  asString,
  asStringOrNull,
  asTimestamp,
  asTimestampOrNull,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'

/* ---------------------------------------------------------------- shared -- */

/**
 * The ceiling on any one panel.
 *
 * Lower than `BOOKING_PAGE_SIZE` on purpose. This is a list of things a person
 * is going to do today; a panel that needs a hundred rows is a panel nobody
 * reads, and the screens the rows link to are where a long list belongs. Each
 * panel says out loud when it hits the ceiling.
 */
export const ACTION_PANEL_SIZE = 25

/**
 * Any one of these opens the screen.
 *
 * Ordered least-privileged first, so the grant reported on a refusal is the
 * smallest one that would have admitted this person — which is the one an
 * administrator would actually have to give them.
 *
 * It lives here rather than beside `requireActionCenterAccess` for a mundane
 * reason with a real consequence: `access.ts` imports the route guard, which
 * imports the Supabase server client, which reads `@/lib/env` at module load —
 * so a test importing the tuple from there needs a Supabase project to exist.
 * This file has no such dependency, `access.ts` imports the tuple from here,
 * and the door and the panels therefore cannot disagree about which grants are
 * in play.
 *
 * `message.view` and `incident.view` are deliberately absent even though the
 * menu entry lists them: there is no `messages` table and no `incidents` table
 * in any migration from 0001 to 0026, so admitting somebody on either would
 * open a screen with nothing on it for them. See `/inbox`.
 */
export const ACTION_CENTER_GRANTS: readonly [Grant, ...Grant[]] = [
  'task.view',
  'booking.view',
  'payment.view',
  'approval.decide',
]

export type ActionCenterArgs = {
  db: Db
  actor: Actor
  organizationId: string
  /** A single property, or null for every property in scope. */
  propertyId: string | null
  /** The property-local day, as `YYYY-MM-DD`. Passed in so it is testable. */
  today: string
  limit?: number
}

/** Today at the property, which is the only "today" this screen knows. */
export function propertyToday(now: Date = new Date()): string {
  return localDate(now)
}

function resourceFor(
  organizationId: string,
  propertyId: string | null,
  family: Resource['family'],
): Resource {
  const resource: Resource = { organizationId, family }
  if (propertyId !== null) resource.propertyId = propertyId
  return resource
}

/**
 * The membership's scope, as query narrowings, for one family.
 *
 * Imported from the preparation board rather than restated. It is a pure
 * function over `Scope`, it is tested there, and a second copy is a second
 * place for `own_records` — the one case that is genuinely a disjunction and
 * therefore two queries — to be got wrong.
 */
function narrowingsFor(
  actor: Actor,
  family: NonNullable<Resource['family']>,
): ReturnType<typeof scopeNarrowings> {
  return scopeNarrowings(
    actor,
    scopeFor(actor, { organizationId: actor.organizationId, family }),
  )
}

/* ---------------------------------------------------------------- stays -- */

/**
 * Why a stay is on today's list.
 *
 * Three roles rather than one list of "today's bookings", because they are
 * three different jobs. An arrival needs a key and a clean room; a departure
 * needs an inspection and a deposit decision; a guest already in the building
 * needs neither and is on screen so that nobody is surprised by them.
 */
export type StayRole = 'arriving' | 'departing' | 'in_house'

export type DayStay = {
  id: string
  reference: string
  role: StayRole
  status: BookingStatus
  propertyId: string
  unitId: string
  /** Null when the unit row is not readable. The id is not shown in its place. */
  unitName: string | null
  checkIn: string
  checkOut: string
  /** The hour the guest said they would arrive, when they said one. */
  arrivalTime: string | null
  guestCount: number
  /** What the guest asked for, written on the booking. Often null. */
  guestNotes: string | null
  /** Withheld without `guest.view_name`. Never replaced by "אורח". */
  guestName?: string | null
  /** Withheld without `booking.view_price`. */
  totalAgorot?: number
}

const STAY_REDACTIONS = [
  { key: 'guestName', requires: 'guest.view_name' },
  { key: 'totalAgorot', requires: 'booking.view_price' },
] as const satisfies ReadonlyArray<{ key: keyof DayStay; requires: Grant }>

/**
 * `units(name)` and not `guests(full_name)`.
 *
 * The bookings list embeds both and leans on `guests_select` to withhold the
 * name from a reader without `guest.view`. That is correct against Postgres and
 * it is *only* correct against Postgres: `createDemoClient` says in its own
 * header that there is no policy engine behind its arrays, so the same embed
 * hands the demo's cleaner a guest's name. The name is therefore asked for in a
 * separate query that is not issued at all without the grant — see
 * `stayGuestNames` — and the field is redacted afterwards as well. Two
 * mechanisms, because the cheap one is the one that runs in the browser a buyer
 * is looking at.
 */
const STAY_COLUMNS =
  'id, reference, status, check_in, check_out, arrival_time, adults, ' +
  'children, infants, property_id, unit_id, guest_id, guest_notes, ' +
  'total_agorot, units(name)'

/**
 * The statuses a stay on today's board can legitimately be in.
 *
 * `cancelled` and `no_show` are excluded because nobody is arriving: the room
 * is free and putting the row on an arrivals board is how a receptionist ends
 * up holding a key for somebody who is not coming. They are not hidden — the
 * bookings list shows them — they are simply not today's work.
 */
const LIVE_STATUSES: readonly BookingStatus[] = BOOKING_STATUSES.filter(
  (status) => status !== 'cancelled' && status !== 'no_show',
)

/**
 * Everything happening at the property today, in one query per scope narrowing.
 *
 * One read rather than three: arrivals, departures and in-house stays are
 * `check_in = today`, `check_out = today` and `check_in < today < check_out`,
 * which is a single window over the stay. Three queries would be three round
 * trips for rows that overlap anyway — a same-day-turnaround unit appears
 * twice, once as a departure and once as an arrival, and that is two different
 * bookings rather than one row counted twice.
 *
 * ── The window is `check_out >= today`, and that is not the occupancy test ──
 *
 * `stay` is half-open `[check_in, check_out)` because check-out day is not an
 * occupied night — that is what makes a same-day turnaround possible without
 * losing a night, and `rangesOverlap` is written that way throughout the
 * product. Applied here it produces a board with no departures on it: a guest
 * leaving this morning stops overlapping today at midnight.
 *
 * They are still in the building. The room still has to be inspected, the
 * deposit still has to be decided, and the clean before this afternoon's
 * arrival cannot start until they are gone. So the boundary is deliberately
 * *not* the occupancy boundary, and the difference is stated here rather than
 * left as a suspicious `>=`: availability asks which nights are sold, and this
 * screen asks who is in the building today.
 */
export async function listStaysToday(
  args: ActionCenterArgs,
): Promise<readonly DayStay[]> {
  const { db, actor, organizationId, propertyId, today } = args
  const limit = args.limit ?? ACTION_PANEL_SIZE

  if (!holdsGrant(actor, 'booking.view')) return []

  const tomorrow = addDays(today, 1)

  const results = await Promise.all(
    narrowingsFor(actor, 'booking').map(async (narrowing) => {
      let query = db
        .from('bookings')
        .select(STAY_COLUMNS)
        .eq('organization_id', organizationId)
        .is('deleted_at', null)
        .in('status', [...LIVE_STATUSES])
        // Starts before tomorrow and has not already ended. A
        // `check_in = today` filter would drop every guest already in the
        // building; a `check_out > today` filter would drop every departure.
        .lt('check_in', tomorrow)
        .gte('check_out', today)

      if (propertyId !== null) query = query.eq('property_id', propertyId)
      if (narrowing.kind === 'in') {
        query = query.in(narrowing.column, [...narrowing.values])
      } else if (narrowing.kind === 'eq') {
        query = query.eq(narrowing.column, narrowing.value)
      }

      const { data, error } = await query
        .order('check_in', { ascending: true })
        .limit(limit)

      if (error) throw error
      return toRows(data)
    }),
  )

  const merged = new Map<string, Row>()
  for (const row of results.flat()) merged.set(asString(row, 'id'), row)

  const rows = [...merged.values()].filter((row) =>
    can(
      actor,
      'booking.view',
      resourceFor(organizationId, asString(row, 'property_id'), 'booking'),
    ),
  )

  const names = await stayGuestNames(db, actor, organizationId, rows)

  return rows
    .map((row) => {
      const propertyOfRow = asString(row, 'property_id')
      const checkIn = asIsoDate(row, 'check_in')
      const checkOut = asIsoDate(row, 'check_out')

      const stay: DayStay = {
        id: asString(row, 'id'),
        reference: asString(row, 'reference'),
        role: roleOf(checkIn, checkOut, today),
        status: asEnum(row, 'status', BOOKING_STATUSES),
        propertyId: propertyOfRow,
        unitId: asString(row, 'unit_id'),
        unitName: embeddedField(row.units, 'name'),
        checkIn,
        checkOut,
        arrivalTime: asStringOrNull(row, 'arrival_time'),
        guestCount:
          asNumber(row, 'adults') +
          asNumber(row, 'children') +
          asNumber(row, 'infants'),
        guestNotes: asStringOrNull(row, 'guest_notes'),
        guestName: names.get(asString(row, 'guest_id')) ?? null,
        totalAgorot: asAgorot(row, 'total_agorot'),
      }

      return redact(
        actor,
        stay,
        STAY_REDACTIONS,
        resourceFor(organizationId, propertyOfRow, 'booking'),
      )
    })
    .sort(byUrgency)
    .slice(0, limit)
}

/**
 * A departure is more urgent than an arrival, and an arrival than a guest who
 * is already settled.
 *
 * A checkout happens in the morning and blocks the clean that has to happen
 * before the afternoon arrival, so it is the thing that goes wrong first. The
 * tie-break is the stated arrival hour where there is one, then the reference,
 * so the order is stable across renders rather than dependent on row order.
 */
const ROLE_ORDER: Record<StayRole, number> = {
  departing: 0,
  arriving: 1,
  in_house: 2,
}

function byUrgency(a: DayStay, b: DayStay): number {
  const role = ROLE_ORDER[a.role] - ROLE_ORDER[b.role]
  if (role !== 0) return role
  const time = (a.arrivalTime ?? '').localeCompare(b.arrivalTime ?? '')
  if (time !== 0) return time
  return a.reference.localeCompare(b.reference)
}

function roleOf(checkIn: string, checkOut: string, today: string): StayRole {
  if (checkOut === today) return 'departing'
  if (checkIn === today) return 'arriving'
  return 'in_house'
}

/**
 * Guest names for the stays on screen, or an empty map.
 *
 * Not issued at all without `guest.view_name`. `guests_select` would refuse it
 * in production anyway, but a query that cannot succeed is a round trip nobody
 * should pay for — and, as `STAY_COLUMNS` explains, the demo has no policy
 * engine to do the refusing. A name that does not come back stays null and the
 * screen renders the booking reference, which is a real identifier.
 */
async function stayGuestNames(
  db: Db,
  actor: Actor,
  organizationId: string,
  rows: readonly Row[],
): Promise<ReadonlyMap<string, string>> {
  if (!holdsGrant(actor, 'guest.view_name')) return new Map()

  const ids = [...new Set(rows.map((row) => asString(row, 'guest_id')))]
  if (ids.length === 0) return new Map()

  const { data, error } = await db
    .from('guests')
    .select('id, full_name')
    .eq('organization_id', organizationId)
    .in('id', ids)

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    const name = asStringOrNull(row, 'full_name')
    if (name !== null) names.set(asString(row, 'id'), name)
  }
  return names
}

/** An embed comes back as an object or, for some shapes, a one-element array. */
function embeddedField(value: unknown, field: string): string | null {
  const record = Array.isArray(value) ? value[0] : value
  if (typeof record !== 'object' || record === null) return null
  const raw = (record as Record<string, unknown>)[field]
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/* ------------------------------------------------------------- balances -- */

/**
 * A stay on today's board that has not been paid for in full.
 *
 * `billedAgorot` is `bookings.total_agorot`, which the database owns and
 * recomputes from the price lines on every write — so it is the figure the
 * guest was quoted rather than one this file added up. `settledAgorot` is
 * captured less refunded across the booking's payments, by `sumAgorot`.
 */
export type OpenBalance = {
  bookingId: string
  reference: string
  propertyId: string
  role: StayRole
  guestName: string | null
  billedAgorot: number
  settledAgorot: number
  /** Billed less settled. Positive; a fully paid stay is not on this list. */
  outstandingAgorot: number
  /**
   * Money the provider never resolved, counted as neither paid nor owed.
   *
   * `bookingBalance` in the finance domain reports it separately for a reason
   * worth repeating on screen: folding it into "outstanding" invites a second
   * charge, and folding it into "paid" invites a check-in on money that never
   * arrived. A row carrying this is a row somebody has to look at before they
   * ask the guest for anything.
   */
  unknownAgorot: number
}

/**
 * What today's stays still owe.
 *
 * Needs both grants and says so by returning `null` rather than an empty array
 * when either is missing: "every guest has paid" and "you may not see what
 * anybody owes" are different sentences, and the screen prints them
 * differently. `paymentTotals` in the finance module makes the same
 * distinction for the same reason.
 */
export async function listOpenBalances(
  args: ActionCenterArgs,
  stays: readonly DayStay[],
): Promise<readonly OpenBalance[] | null> {
  const { db, actor, organizationId } = args

  if (!holdsGrant(actor, 'payment.view')) return null
  if (!holdsGrant(actor, 'booking.view_price')) return null
  if (stays.length === 0) return []

  const bookingIds = stays.map((stay) => stay.id)

  const { data, error } = await db
    .from('payments')
    .select(
      'booking_id, property_id, status, captured_agorot, ' +
        'amount_refunded_agorot, amount_agorot',
    )
    .eq('organization_id', organizationId)
    .in('booking_id', bookingIds)

  if (error) throw error

  const captured = new Map<string, number[]>()
  const refunded = new Map<string, number[]>()
  const unknown = new Map<string, number[]>()

  for (const row of toRows(data)) {
    // The payment carries its own property, and a reader scoped to one
    // property must not have another property's money folded into a total they
    // are shown. The booking above already passed the same check; this is the
    // row-level floor for the payment itself.
    if (
      !can(
        actor,
        'payment.view',
        resourceFor(organizationId, asString(row, 'property_id'), 'finance'),
      )
    ) {
      continue
    }

    const bookingId = asString(row, 'booking_id')
    push(captured, bookingId, asAgorot(row, 'captured_agorot'))
    push(refunded, bookingId, asAgorot(row, 'amount_refunded_agorot'))
    if (asEnum(row, 'status', PAYMENT_STATUSES) === 'unknown') {
      push(unknown, bookingId, asAgorot(row, 'amount_agorot'))
    }
  }

  const balances: OpenBalance[] = []

  for (const stay of stays) {
    // `redact` removed the field, so there is no billed figure to compare
    // against. Skipping is right: an outstanding amount computed from a total
    // this reader may not see would disclose the total by subtraction.
    if (stay.totalAgorot === undefined) continue

    const settled = sumAgorot([
      ...(captured.get(stay.id) ?? []),
      ...(refunded.get(stay.id) ?? []).map((value) => -value),
    ])
    const outstanding = sumAgorot([stay.totalAgorot, -settled])
    const inFlight = sumAgorot(unknown.get(stay.id) ?? [])

    // A settled stay is not an action. A stay that overpaid is — but that is
    // `requires_attention: 'overpaid'` on the payment, which the payments
    // panel below already surfaces, and duplicating it here would put the same
    // job on the screen twice under two different headings.
    if (outstanding <= 0 && inFlight === 0) continue

    balances.push({
      bookingId: stay.id,
      reference: stay.reference,
      propertyId: stay.propertyId,
      role: stay.role,
      guestName: stay.guestName ?? null,
      billedAgorot: stay.totalAgorot,
      settledAgorot: settled,
      outstandingAgorot: outstanding,
      unknownAgorot: inFlight,
    })
  }

  return balances.sort((a, b) => b.outstandingAgorot - a.outstandingAgorot)
}

function push(map: Map<string, number[]>, key: string, value: number): void {
  const existing = map.get(key)
  if (existing) existing.push(value)
  else map.set(key, [value])
}

/** What today's board owes in all, by the domain's own sum. */
export function outstandingTotalAgorot(
  balances: readonly OpenBalance[],
): number {
  return sumAgorot(balances.map((balance) => balance.outstandingAgorot))
}

/* ---------------------------------------------------------------- tasks -- */

export type StuckTask = {
  id: string
  title: string
  type: TaskType
  status: TaskStatus
  priority: TaskPriority
  propertyId: string
  unitId: string | null
  teamId: string | null
  /** Required by `tasks_blocked_has_reason`, so a blocked job always has one. */
  blockedReason: string | null
  /** The property-local day it was due, or null when it carries no date. */
  dueOn: string | null
  /** True when the due day is behind us. Stated, never colour alone. */
  overdue: boolean
}

const STUCK_TASK_COLUMNS =
  'id, title, task_type, status, priority, property_id, unit_id, team_id, ' +
  'blocked_reason, due_at, assigned_to_user_id, created_by, deleted_at'

/**
 * The work that will not finish on its own.
 *
 * Two things, and they are deliberately one list. A `blocked` job is stopped by
 * something outside it — `task-status.tsx` argues that at length — and an
 * overdue job is stopped by nobody having done it. Both need the same response
 * from the same person this morning, and splitting them into two panels means
 * scanning twice.
 *
 * Everything else is excluded: `completed`, `verified` and `cancelled` are
 * settled, and a job due tomorrow is tomorrow's.
 */
export async function listStuckTasks(
  args: ActionCenterArgs,
): Promise<readonly StuckTask[] | null> {
  const { db, actor, organizationId, propertyId, today } = args
  const limit = args.limit ?? ACTION_PANEL_SIZE

  if (!holdsGrant(actor, 'task.view')) return null

  // A day either side of the boundary, because `due_at` is an instant and the
  // cut is a property-local midnight. `localDate` decides which day each row
  // is on; over-reading costs a few rows, getting the day wrong tells somebody
  // a job is late when it is due this evening.
  const before = `${addDays(today, 1)}T00:00:00Z`

  const results = await Promise.all(
    narrowingsFor(actor, 'operations').map(async (narrowing) => {
      let query = db
        .from('tasks')
        .select(STUCK_TASK_COLUMNS)
        .eq('organization_id', organizationId)
        .is('deleted_at', null)
        .in('status', [...UNSETTLED_TASK_STATUSES])
        .lt('due_at', before)

      if (propertyId !== null) query = query.eq('property_id', propertyId)
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

  return (
    [...merged.values()]
      .map((row): StuckTask => {
        const dueAt = asTimestampOrNull(row, 'due_at')
        const dueOn = dueAt === null ? null : localDate(new Date(dueAt))
        const status = asEnum(row, 'status', TASK_STATUSES)
        return {
          id: asString(row, 'id'),
          title: asString(row, 'title'),
          type: asEnum(row, 'task_type', TASK_TYPES),
          status,
          priority: asEnum(row, 'priority', TASK_PRIORITIES),
          propertyId: asString(row, 'property_id'),
          unitId: asStringOrNull(row, 'unit_id'),
          teamId: asStringOrNull(row, 'team_id'),
          blockedReason: asStringOrNull(row, 'blocked_reason'),
          dueOn,
          overdue: dueOn !== null && dueOn < today,
        }
      })
      // Blocked at any date, or unfinished and past its day. A job due later
      // today is neither, and belongs on the preparation board rather than here.
      .filter((task) => task.status === 'blocked' || task.overdue)
      .filter((task) =>
        can(actor, 'task.view', {
          organizationId,
          propertyId: task.propertyId,
          unitId: task.unitId ?? undefined,
          teamId: task.teamId ?? undefined,
          family: 'operations',
        }),
      )
      .sort((a, b) => {
        // Blocked first: it is the one nobody can fix by working harder.
        if ((a.status === 'blocked') !== (b.status === 'blocked')) {
          return a.status === 'blocked' ? -1 : 1
        }
        return (a.dueOn ?? '').localeCompare(b.dueOn ?? '')
      })
      .slice(0, limit)
  )
}

const UNSETTLED_TASK_STATUSES: readonly TaskStatus[] = TASK_STATUSES.filter(
  (status) =>
    status !== 'completed' && status !== 'verified' && status !== 'cancelled',
)

/* ------------------------------------------------------------- payments -- */

export type PaymentNeedingAttention = {
  id: string
  bookingId: string
  propertyId: string
  status: PaymentStatus
  method: PaymentMethod
  /** Set when a person must intervene. Never cleared by automation. */
  requiresAttention: PaymentAttention | null
  /** When the provider stopped answering, as a property-local date. */
  unknownSince: string | null
  recordedOn: string
  /** Withheld without `booking.view_price`. */
  amountAgorot?: number
}

const PAYMENT_REDACTIONS = [
  { key: 'amountAgorot', requires: 'booking.view_price' },
] as const satisfies ReadonlyArray<{
  key: keyof PaymentNeedingAttention
  requires: Grant
}>

/**
 * Money the automation has stopped working on.
 *
 * Two queries and not one `.or()`. The condition is genuinely a disjunction —
 * `status = 'unknown'` **or** `requires_attention is not null` — and both the
 * transaction compiler and the demo client refuse `.or()` on purpose, because
 * an `.or()` quietly ignored is a list of rows the caller never asked for. The
 * results are merged by id, so a payment that satisfies both appears once.
 *
 * The second half is written as `.in('requires_attention', PAYMENT_ATTENTIONS)`
 * rather than `.not(…, 'is', null)`. `payments_requires_attention` constrains
 * the column to exactly those three values or null, so the two are the same
 * set — and `.not()` is not in the operator list either the transaction
 * compiler or the demo client implements, so writing it would produce a screen
 * that works against Postgres and throws `UnsupportedQuery` in the demo. The
 * tuple is the contract's own, so a fourth attention added there is filtered
 * for here on the same commit.
 *
 * `unknown` is not `failed`, and this is the reason the panel exists. A
 * processor that timed out has left the business unable to say whether the card
 * was charged; folding it into "failed" tells a bookkeeper it definitely was
 * not, which is the one thing nobody knows.
 */
export async function listPaymentsNeedingAttention(
  args: ActionCenterArgs,
): Promise<readonly PaymentNeedingAttention[] | null> {
  const { db, actor, organizationId, propertyId } = args
  const limit = args.limit ?? ACTION_PANEL_SIZE

  if (!holdsGrant(actor, 'payment.view')) return null

  const columns =
    'id, booking_id, property_id, status, method, amount_agorot, ' +
    'requires_attention, unknown_since, created_at'

  const base = () => {
    let query = db
      .from('payments')
      .select(columns)
      .eq('organization_id', organizationId)
    if (propertyId !== null) query = query.eq('property_id', propertyId)
    return query
  }

  const [unresolved, flagged] = await Promise.all([
    base()
      .eq('status', 'unknown')
      .order('created_at', { ascending: false })
      .limit(limit),
    base()
      .in('requires_attention', [...PAYMENT_ATTENTIONS])
      .order('created_at', { ascending: false })
      .limit(limit),
  ])

  if (unresolved.error) throw unresolved.error
  if (flagged.error) throw flagged.error

  const merged = new Map<string, Row>()
  for (const row of [...toRows(unresolved.data), ...toRows(flagged.data)]) {
    merged.set(asString(row, 'id'), row)
  }

  return [...merged.values()]
    .filter((row) =>
      can(
        actor,
        'payment.view',
        resourceFor(organizationId, asString(row, 'property_id'), 'finance'),
      ),
    )
    .map((row) => {
      const propertyOfRow = asString(row, 'property_id')
      const item: PaymentNeedingAttention = {
        id: asString(row, 'id'),
        bookingId: asString(row, 'booking_id'),
        propertyId: propertyOfRow,
        status: asEnum(row, 'status', PAYMENT_STATUSES),
        method: asEnum(row, 'method', PAYMENT_METHODS),
        requiresAttention: asEnumOrNull(
          row,
          'requires_attention',
          PAYMENT_ATTENTIONS,
        ),
        unknownSince: propertyDate(row, 'unknown_since'),
        recordedOn: localDate(new Date(asTimestamp(row, 'created_at'))),
        amountAgorot: asAgorot(row, 'amount_agorot'),
      }
      return redact(
        actor,
        item,
        PAYMENT_REDACTIONS,
        resourceFor(organizationId, propertyOfRow, 'finance'),
      )
    })
    .sort((a, b) => b.recordedOn.localeCompare(a.recordedOn))
    .slice(0, limit)
}

function propertyDate(row: Row, column: string): string | null {
  const value = asTimestampOrNull(row, column)
  return value === null ? null : localDate(new Date(value))
}

/* ------------------------------------------------------------ approvals -- */

export type WaitingApproval = {
  id: string
  type: ApprovalType
  status: ApprovalStatus
  propertyId: string | null
  bookingId: string | null
  taskId: string | null
  /** Required by the schema: a request nobody can evaluate gets approved. */
  reason: string
  requestedByUserId: string
  /** Null when the profile is not readable. Never a uuid in its place. */
  requestedByName: string | null
  requestedOn: string
  /** The property-local day it lapses, or null when nothing expires it. */
  expiresOn: string | null
  /** True once that day is behind us. An expired request holds nothing open. */
  lapsed: boolean
  /**
   * The ask and the ceiling it exceeds, in basis points or agorot.
   *
   * Both are withheld without `booking.view_price`: a discount request spells
   * out a percentage of a stay's price, and an expense request is a shekel
   * figure. Whether an exception is *waiting* is not money; how big it is, is.
   */
  requestedValueBps?: number | null
  limitValueBps?: number | null
  requestedAgorot?: number | null
  limitAgorot?: number | null
}

const APPROVAL_REDACTIONS = [
  { key: 'requestedValueBps', requires: 'booking.view_price' },
  { key: 'limitValueBps', requires: 'booking.view_price' },
  { key: 'requestedAgorot', requires: 'booking.view_price' },
  { key: 'limitAgorot', requires: 'booking.view_price' },
] as const satisfies ReadonlyArray<{
  key: keyof WaitingApproval
  requires: Grant
}>

/**
 * Decisions nobody has made.
 *
 * `null` without `approval.decide`, because the panel is a queue of things to
 * decide and a reader who cannot decide any of them is being shown somebody
 * else's inbox. Whoever raised the request sees its state on the record it
 * belongs to; a request list is not the same screen as a decision list.
 *
 * ── `null` has two causes and the screen must not merge them ──────────────
 *
 * `holdsGrant` consults the plan as well as the role, and `approval.decide` is
 * gated on the `approvals` entitlement — which only `management` carries.
 * Every package the demo offers is therefore refused here, *including the
 * owner's*, and the reason is "your package does not include approvals" rather
 * than "you may not decide". The page asks `authorize()` for the reason and
 * prints whichever it is; collapsing the two would tell an owner they lack a
 * permission they hold.
 *
 * That is also a finding about the dataset rather than about this file:
 * `DEMO_DATASET` seeds three `approvals` rows and `DEMO_PLANS` offers no
 * package that can read one, so the demo carries data no persona on any plan
 * can reach. Reported rather than papered over by widening the gate.
 *
 * `approvals` carries a nullable `property_id` — a request can be about the
 * organization rather than about a building — so the resource declares one only
 * where the row has one, and a null lands on the membership's default scope.
 */
export async function listWaitingApprovals(
  args: ActionCenterArgs,
): Promise<readonly WaitingApproval[] | null> {
  const { db, actor, organizationId, propertyId, today } = args
  const limit = args.limit ?? ACTION_PANEL_SIZE

  if (!holdsGrant(actor, 'approval.decide')) return null

  let query = db
    .from('approvals')
    .select(
      'id, approval_type, status, property_id, booking_id, task_id, reason, ' +
        'requested_by, requested_at, expires_at, requested_value_bps, ' +
        'limit_value_bps, requested_agorot, limit_agorot',
    )
    .eq('organization_id', organizationId)
    .eq('status', 'requested')

  if (propertyId !== null) query = query.eq('property_id', propertyId)

  const { data, error } = await query
    .order('requested_at', { ascending: true })
    .limit(limit)

  if (error) throw error

  const rows = toRows(data).filter((row) => {
    const property = asStringOrNull(row, 'property_id')
    const resource: Resource = { organizationId }
    if (property !== null) resource.propertyId = property
    return can(actor, 'approval.decide', resource)
  })

  const names = await profileNames(
    db,
    holdsGrant(actor, 'user.view')
      ? [...new Set(rows.map((row) => asString(row, 'requested_by')))]
      : [],
  )

  return rows.map((row) => {
    const property = asStringOrNull(row, 'property_id')
    const expiresAt = asTimestampOrNull(row, 'expires_at')
    const expiresOn = expiresAt === null ? null : localDate(new Date(expiresAt))
    const requestedBy = asString(row, 'requested_by')

    const item: WaitingApproval = {
      id: asString(row, 'id'),
      type: asEnum(row, 'approval_type', APPROVAL_TYPES),
      status: asEnum(row, 'status', APPROVAL_STATUSES),
      propertyId: property,
      bookingId: asStringOrNull(row, 'booking_id'),
      taskId: asStringOrNull(row, 'task_id'),
      reason: asString(row, 'reason'),
      requestedByUserId: requestedBy,
      requestedByName: names.get(requestedBy) ?? null,
      requestedOn: localDate(new Date(asTimestamp(row, 'requested_at'))),
      expiresOn,
      lapsed: expiresOn !== null && expiresOn < today,
      requestedValueBps: asNumberOrNull(row, 'requested_value_bps'),
      limitValueBps: asNumberOrNull(row, 'limit_value_bps'),
      requestedAgorot: asNumberOrNull(row, 'requested_agorot'),
      limitAgorot: asNumberOrNull(row, 'limit_agorot'),
    }

    const resource: Resource = { organizationId }
    if (property !== null) resource.propertyId = property
    return redact(actor, item, APPROVAL_REDACTIONS, resource)
  })
}

/**
 * Display names for the people who raised the requests.
 *
 * `user_profiles_select` admits anybody who shares an organization with the
 * subject, and the ids only ever come from rows this reader was already
 * admitted to. A missing name stays null rather than being filled with a uuid,
 * and the request is then labelled by what it asks for — which is the part a
 * decider actually needs.
 */
async function profileNames(
  db: Db,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (userIds.length === 0) return new Map()

  const { data, error } = await db
    .from('user_profiles')
    .select('id, full_name')
    .in('id', [...userIds])

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    const name = asStringOrNull(row, 'full_name')
    if (name !== null) names.set(asString(row, 'id'), name)
  }
  return names
}
