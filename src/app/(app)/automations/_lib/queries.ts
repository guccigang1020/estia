/**
 * EXECUTION CONTEXT — SERVER ONLY. The rows the dry run runs over.
 *
 * `dry-run.ts` says where this belongs — "PURE. Rows in, candidates out. The
 * reads live in `queries.ts`" — and this is that file. It reads nothing of its
 * own.
 *
 * ── Three reads, and all three are somebody else's ────────────────────────
 *
 * The bookings, the tasks and the payments the simulation needs are the same
 * three lists `/bookings`, `/tasks` and `/finance/payments` already render, and
 * they are fetched by calling those screens' own queries rather than by writing
 * a fourth `db.from('bookings')` here. That is not tidiness. Each of those
 * functions carries authorization the simulation must not be allowed to skip:
 * `listTasks` applies the operations scope narrowing to the query and then
 * `can()` per row and `redact()` per field, and `listPayments` narrows per row
 * and withholds the payer's name and every amount from a reader who may not see
 * them. A private copy of those queries here would be a private copy of those
 * rules, and the first thing a copy does is fall behind.
 *
 * The one exception is bookings: `bookings/_lib/queries.ts` deliberately leaves
 * the row check to row level security and the screen, so the `can()` floor for
 * booking rows is applied here — see `visibleBookings`.
 *
 * ── A missing grant is an empty list, not a smaller one ───────────────────
 *
 * A reader without `payment.view` contributes no payments to the simulation, so
 * the payment rules report zero and the screen says why. That is the honest
 * answer and it is deliberately not hidden: a housekeeper looking at this page
 * should see that the money rules are outside what she can preview, rather than
 * see a confident "0 תשלומים נכשלו" that means "you cannot look".
 *
 * ── What the simulation therefore is, and is not ──────────────────────────
 *
 * It is what these automations would have done to the rows *this reader can
 * see*, on the newest page of each list. It is not an organization-wide audit,
 * and the ceiling is stated on screen rather than left for somebody to discover
 * that the number stopped growing at a hundred.
 */

import { can, holdsGrant, type Actor, type Resource } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import { asString, asStringOrNull, toRows, type Db } from '@/lib/persistence'
import type { FinanceRepository } from '@/lib/finance/repository'

import { EMPTY_BOOKING_FILTERS } from '../../bookings/_lib/filters'
import { listBookings } from '../../bookings/_lib/queries'
import { NO_TASK_FILTER } from '../../tasks/_lib/filters'
import { listTasks } from '../../tasks/_lib/queries'
import { listPayments } from '../../finance/_lib/queries'

import type { BookingFact, DryRunRows, PaymentFact, TaskFact } from './dry-run'

/**
 * The newest page of each list.
 *
 * Deliberately smaller than the 100 the three screens use. A dry run is read in
 * one glance and its job is to be believed, not to be exhaustive: three hundred
 * rows would take three round trips of a hundred each and would move no
 * decision that sixty rows does not already move. The screen states the number.
 */
export const DRY_RUN_SAMPLE = 60

export interface DryRunSource {
  db: Db
  repo: FinanceRepository
  actor: Actor
  /** A single property from the shell switcher, or null for everything in scope. */
  propertyId: string | null
}

/**
 * Why a table was not read.
 *
 * Three states and not a boolean, for the reason the whole section exists:
 * `holdsGrant` returns false for two opposite situations, and a screen that
 * collapsed them would tell an owner on Basic that they lack permission to see
 * their own tasks. They do not — `task.view` is mapped to the `operations`
 * entitlement, their role carries the grant, and their package does not carry
 * the feature. That is a sentence about billing wearing the costume of a
 * sentence about permissions, which is precisely the confusion this product
 * refuses to ship.
 *
 * Asked in the same order `actionReadiness` asks it: the role first, so nobody
 * whose role genuinely lacks the right is told to go and buy something that
 * would not help them.
 */
export type ReadAccess = 'readable' | 'missing_permission' | 'missing_feature'

export interface TableRead {
  access: ReadAccess
  /** Rows actually read. Zero whenever `access` is not `readable`. */
  count: number
}

/** What the preview actually read, so the screen can say so. */
export interface DryRunInputs {
  rows: DryRunRows
  bookings: TableRead
  tasks: TableRead
  payments: TableRead
}

function accessTo(actor: Actor, grant: Grant): ReadAccess {
  if (!actor.grants.has(grant)) return 'missing_permission'
  if (!holdsGrant(actor, grant)) return 'missing_feature'
  return 'readable'
}

export async function loadDryRunInputs(
  source: DryRunSource,
): Promise<DryRunInputs> {
  const { actor } = source

  const bookingAccess = accessTo(actor, 'booking.view')
  const taskAccess = accessTo(actor, 'task.view')
  const paymentAccess = accessTo(actor, 'payment.view')

  const [bookings, tasks, payments] = await Promise.all([
    bookingAccess === 'readable' ? loadBookings(source) : [],
    taskAccess === 'readable' ? loadTasks(source) : [],
    paymentAccess === 'readable' ? loadPayments(source) : [],
  ])

  return {
    rows: { bookings, tasks, payments },
    bookings: { access: bookingAccess, count: bookings.length },
    tasks: { access: taskAccess, count: tasks.length },
    payments: { access: paymentAccess, count: payments.length },
  }
}

/* ------------------------------------------------------------ bookings --- */

/** The resource a booking authorization question is asked about. */
function bookingResource(
  organizationId: string,
  propertyId: string | null,
): Resource {
  const resource: Resource = { organizationId }
  if (propertyId !== null) resource.propertyId = propertyId
  return resource
}

/**
 * The bookings this reader may see, as facts.
 *
 * `listBookings` applies the tenant and property filters and leaves the row
 * decision to row level security, exactly as the bookings screen does. The
 * demo client has no policy engine — `createDemoClient` says so — so a
 * property-scoped membership would otherwise preview the whole organization's
 * stays here, and this is the floor that stops it. In production it is the
 * second of the two, which is where it belongs anyway.
 */
async function loadBookings(
  source: DryRunSource,
): Promise<readonly BookingFact[]> {
  const rows = await listBookings(source.db, {
    organizationId: source.actor.organizationId,
    propertyId: source.propertyId,
    filters: EMPTY_BOOKING_FILTERS,
    limit: DRY_RUN_SAMPLE,
  })

  const visible = rows.filter((row) =>
    can(
      source.actor,
      'booking.view',
      bookingResource(source.actor.organizationId, row.propertyId),
    ),
  )

  const sources = await bookingSources(
    source,
    visible.map((row) => row.id),
  )

  return visible.map((row) => ({
    id: row.id,
    reference: row.reference,
    status: row.status,
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    propertyId: row.propertyId,
    source: sources.get(row.id) ?? null,
  }))
}

/**
 * Where each booking came from, for the readers entitled to know.
 *
 * A second read rather than a wider `LIST_COLUMNS`, because `bookings.source`
 * is gated by its own grant: `booking.view_source` separates a manager who may
 * see that a stay arrived through an agent from a receptionist who may not, and
 * widening the shared list query would hand the column to every screen that
 * calls it. Skipped entirely for a reader without the grant, so no value is
 * fetched that would then have to be thrown away — and the fact is then absent
 * from the candidate rather than blank, which is what makes a rule comparing it
 * report "the fact was missing" instead of quietly never matching.
 *
 * No template in the shipped library compares `source` today. It is read anyway
 * because the alternative — a placeholder — is the exact failure this product
 * spends a whole engine avoiding, and because a customer's first custom rule is
 * very often "when a booking arrives from Airbnb".
 */
async function bookingSources(
  source: DryRunSource,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (ids.length === 0) return new Map()
  if (!holdsGrant(source.actor, 'booking.view_source')) return new Map()

  const { data, error } = await source.db
    .from('bookings')
    .select('id, source')
    .eq('organization_id', source.actor.organizationId)
    .in('id', [...ids])

  if (error) throw error

  const found = new Map<string, string>()
  for (const row of toRows(data)) {
    const value = asStringOrNull(row, 'source')
    if (value !== null) found.set(asString(row, 'id'), value)
  }
  return found
}

/* --------------------------------------------------------------- tasks --- */

async function loadTasks(source: DryRunSource): Promise<readonly TaskFact[]> {
  const rows = await listTasks({
    db: source.db,
    actor: source.actor,
    propertyId: source.propertyId,
    filter: NO_TASK_FILTER,
    grant: 'task.view',
    limit: DRY_RUN_SAMPLE,
  })

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    dueAt: row.dueAt,
    propertyId: row.propertyId,
  }))
}

/* ------------------------------------------------------------ payments --- */

async function loadPayments(
  source: DryRunSource,
): Promise<readonly PaymentFact[]> {
  const rows = await listPayments({
    repo: source.repo,
    actor: source.actor,
    organizationId: source.actor.organizationId,
    propertyId: source.propertyId,
    filter: { status: null },
    limit: DRY_RUN_SAMPLE,
  })

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    // `requiresAttention` is a `PaymentAttention` or null on the row, and the
    // fact is a boolean. The reduction is deliberate: the dry run asks "does a
    // person have to look at this", and every reason to look is the same
    // answer to that question.
    requiresAttention: row.requiresAttention !== null,
    // Null for a reader without `booking.view` — `listPayments` does not fetch
    // the references at all for them — so the label falls back to "תשלום"
    // rather than printing an id.
    reference: row.bookingReference,
    propertyId: row.propertyId,
  }))
}
