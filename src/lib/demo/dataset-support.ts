/**
 * The machinery the demo dataset is built out of.
 *
 * Two things live here, and both exist because a dataset written by hand gets
 * one of them wrong within a week.
 *
 * ── Identifiers ───────────────────────────────────────────────────────────
 *
 * Every id is a real uuid — version nibble `4`, variant nibble `8` — derived
 * from a table group and an index rather than generated. `gen_random_uuid()`
 * would make the dataset different on every load, and a foreign key written
 * by hand into a random id is a foreign key that is wrong the next time the
 * module is imported. Derived ids also make a broken reference obvious to a
 * human reading the file: `00000009-0003-…` is the fourth booking, always.
 *
 * ── Dates ─────────────────────────────────────────────────────────────────
 *
 * Everything is relative to the day the module loads, in Asia/Jerusalem. A
 * demo whose calendar is empty next month is not a demo of a calendar, and
 * hard-coded dates become exactly that on a schedule nobody is watching.
 *
 * `moment()` renders a wall-clock time in Jerusalem with the offset that
 * genuinely applies on that date — `+03:00` in summer, `+02:00` in winter —
 * because the product stores `timestamptz` and an instant written as if
 * Israel were UTC is an instant three hours from where it happened.
 */

/* --------------------------------------------------------------- ids ----- */

/**
 * One number per table, used as the first uuid segment.
 *
 * The numbers follow the migration that creates each table, so the id of a
 * row says which file defines its shape. They are never rendered to a person
 * and nothing derives meaning from them beyond uniqueness.
 */
export const ID_GROUP = {
  organization: 1,
  userProfile: 2,
  membership: 3,
  role: 4,
  membershipScope: 5,
  plan: 6,
  subscription: 7,
  team: 8,
  property: 9,
  unitGroup: 10,
  unit: 11,
  amenity: 12,
  guest: 13,
  booking: 14,
  statusHistory: 15,
  priceLine: 16,
  hold: 17,
  occupancy: 18,
  payment: 19,
  deposit: 20,
  invoice: 21,
  invoiceLine: 22,
  task: 23,
  taskAssignment: 24,
  taskChecklist: 25,
  inventoryItem: 26,
  inventoryMovement: 27,
  approval: 28,
  commission: 29,
  agency: 30,
  agencyAgreement: 31,
  commissionRule: 32,
  agentSettings: 33,
  expenseRule: 34,
  expenseAllocation: 35,
} as const

/**
 * A uuid-shaped identifier that is the same on every load.
 *
 * `4` and `8` in the version and variant positions are not decoration: a
 * PostgREST client, a Postgres `uuid` column and any validator downstream all
 * accept this string, so a demo row can be copied into a real insert and
 * still be a uuid.
 */
export function demoUuid(group: number, index: number): string {
  const first = group.toString(16).padStart(8, '0')
  const second = index.toString(16).padStart(4, '0')
  const last = (group * 100_000 + index).toString(16).padStart(12, '0')
  return `${first}-${second}-4000-8000-${last}`
}

/** An id factory bound to one table, so call sites read as `unitId(3)`. */
export function idsFor(group: number): (index: number) => string {
  return (index) => demoUuid(group, index)
}

/**
 * The agency's id, stated here rather than in `dataset-agents.ts`.
 *
 * Bookings sold by the external agent carry `agency_id`, and the agent module
 * carries the bookings' commissions — so whichever of the two owned the
 * constant, the other would import it and the graph would have a cycle.
 * Derived ids make that a non-problem: both modules compute the same value.
 */
export const AGENCY_ID = demoUuid(ID_GROUP.agency, 1)

/* -------------------------------------------------------------- dates ---- */

const JERUSALEM = 'Asia/Jerusalem'

const CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: JERUSALEM,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

/** The wall-clock reading in Jerusalem for an instant, as a UTC epoch. */
function wallClock(instant: Date): number {
  const parts = CLOCK.formatToParts(instant)
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)

  return Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    // `en-GB` renders midnight as 24 in some engines; 24 and 0 are the same
    // hour and the difference is a whole day of error.
    read('hour') % 24,
    read('minute'),
    read('second'),
  )
}

/** Minutes Jerusalem is ahead of UTC at a given instant. */
function offsetMinutes(instant: Date): number {
  return Math.round((wallClock(instant) - instant.getTime()) / 60_000)
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  const hours = Math.floor(absolute / 60)
    .toString()
    .padStart(2, '0')
  const rest = (absolute % 60).toString().padStart(2, '0')
  return `${sign}${hours}:${rest}`
}

/**
 * Today in Jerusalem, resolved once when the module loads.
 *
 * Once, deliberately: a dataset whose "today" moved mid-render would produce
 * a booking that straddles a different day than the calendar it is drawn on.
 */
export const TODAY: string = (() => {
  const now = new Date()
  return new Date(wallClock(now)).toISOString().slice(0, 10)
})()

/**
 * A calendar date `offset` days from today, as `YYYY-MM-DD`.
 *
 * Arithmetic in UTC on a date-only value, so a daylight-saving boundary
 * cannot turn "seven days from now" into six days and twenty-three hours.
 */
export function day(offset: number): string {
  const midnight = Date.parse(`${TODAY}T00:00:00Z`)
  return new Date(midnight + offset * 86_400_000).toISOString().slice(0, 10)
}

/** An instant, written as the wall-clock time in Jerusalem on that date. */
export function moment(date: string, time = '12:00'): string {
  const wall = Date.parse(`${date}T${time}:00Z`)
  // Two passes: the offset depends on the instant, and the instant depends on
  // the offset. The second pass settles it everywhere except the one ambiguous
  // hour a clock change creates, which no demo row lands in by design.
  const firstGuess = wall - offsetMinutes(new Date(wall)) * 60_000
  const instant = wall - offsetMinutes(new Date(firstGuess)) * 60_000
  return `${date}T${time}:00${formatOffset(offsetMinutes(new Date(instant)))}`
}

/** An instant `offset` days from today at a given wall-clock time. */
export function momentOn(offset: number, time = '12:00'): string {
  return moment(day(offset), time)
}

/** Nights between two `YYYY-MM-DD` dates, half-open, the way a stay counts. */
export function nights(checkIn: string, checkOut: string): number {
  return Math.round(
    (Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) /
      86_400_000,
  )
}

/** A `daterange` as PostgREST renders it, half-open. */
export function dateRange(from: string, to: string): string {
  return `[${from},${to})`
}

/* ------------------------------------------------------------- rows ------ */

/**
 * The metadata columns the charter puts on every meaningful record.
 *
 * Written once here rather than on four hundred rows, because a dataset that
 * omits `version` on one table in five is a dataset that proves nothing about
 * whether the product's optimistic locking has anything to read.
 */
export function stamped(createdBy: string | null, createdOffset: number) {
  return {
    created_at: momentOn(createdOffset, '09:00'),
    created_by: createdBy,
    updated_at: momentOn(createdOffset, '09:00'),
    updated_by: createdBy,
    version: 1,
    deleted_at: null,
    deleted_by: null,
  }
}

/** The same, for the tables that carry no soft delete. */
export function stampedNoDelete(
  createdBy: string | null,
  createdOffset: number,
) {
  return {
    created_at: momentOn(createdOffset, '09:00'),
    created_by: createdBy,
    updated_at: momentOn(createdOffset, '09:00'),
    updated_by: createdBy,
    version: 1,
  }
}

/** Percentage of an amount in agorot, rounded to the agora. */
export function share(amountAgorot: number, percent: number): number {
  return Math.round((amountAgorot * percent) / 100)
}
