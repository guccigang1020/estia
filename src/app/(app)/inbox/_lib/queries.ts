/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the inbox.
 *
 * ══ THERE IS NO MESSAGING DOMAIN, AND THIS FILE WILL NOT INVENT ONE ══════
 *
 * `message.view`, `message.send`, `message.assign` and `template.manage` are in
 * the permission catalogue. `src/components/states/empty-presets.ts` carries a
 * finished `messages` preset — "אין שיחות פתוחות … כל פנייה מהאתר, מהוואטסאפ או
 * מהמייל מגיעה לחוט אחד לכל אורח" — and an illustration to go with it. The menu
 * has an item. And there is no `messages` table, no `threads` table, no
 * `conversations` table and no `message_participants` table in any migration
 * from 0001 to 0026, so `DEMO_DATASET` has no key for one and nothing could
 * ever arrive in it.
 *
 * That preset is therefore the one thing this screen must not render. It
 * asserts two facts — the mailbox works, and this business has had no
 * conversations — and both are false. A buyer who reads "no open
 * conversations", sends a message and watches nothing appear has been shown a
 * broken product. A buyer who is told the tables are not built has been shown
 * an honest one and can price the gap. `empty-presets.ts` exists to stop "you
 * have never made a booking" being shown to somebody whose filter matched
 * nothing; this is the same distinction one level further out.
 *
 * ── What is genuinely here, and what each thing actually is ───────────────
 *
 * Three lists, each labelled as what it is rather than dressed as a thread:
 *
 *   1. **A guest's own words on their booking.** `bookings.guest_notes` is
 *      what the guest asked for, typed in when the stay was taken. It is
 *      inbound, it is unactioned until somebody does something about it, and it
 *      is the closest thing the schema has to an unread message. It is not a
 *      conversation: there is no reply, no timestamp of its own and no author
 *      beyond the booking.
 *   2. **A guest request that became work.** `tasks` with
 *      `task_type = 'guest_request'` is an inbound ask that somebody turned
 *      into a job, and it is the only part of this screen that is genuinely
 *      *assignable* — through `task_assignments` and `task.assign`, which
 *      exist. `message.assign` has nothing to write to.
 *   3. **A team note on a booking.** `bookings.internal_notes`, gated on
 *      `booking.note.internal`, which is its own grant precisely because an
 *      internal note is not for the guest.
 *
 * ── Gating ────────────────────────────────────────────────────────────────
 *
 * `requireGrant('message.view')` refuses the route, which is the honest gate
 * even though no row below comes from a messages table: it is the right a
 * business would give somebody to read guest correspondence, and the screen
 * would be built out of it once the tables exist.
 *
 * Each list then asks for its own. A guest's words are guest data and need
 * `guest.view_name`, not merely `booking.view` — the note routinely contains
 * the guest's plans and sometimes their telephone number, and it happens to
 * live on the booking row rather than the guest row. An internal note needs
 * `booking.note.internal`. Work needs `task.view`.
 */

import { scopeNarrowings } from '@/app/(app)/preparation/_lib/queries'
import {
  can,
  holdsGrant,
  scopeFor,
  type Actor,
  type Resource,
} from '@/lib/authz/can'
import { BOOKING_STATUSES, type BookingStatus } from '@/lib/booking/types'
import { localDate } from '@/lib/booking/dates'
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskPriority,
  type TaskStatus,
} from '@/lib/contracts/states'
import {
  asEnum,
  asIsoDate,
  asString,
  asStringOrNull,
  asTimestamp,
  asTimestampOrNull,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'

/* ---------------------------------------------------------------- shared -- */

/** The ceiling on one list. The screen says out loud when it hits it. */
export const INBOX_PAGE_SIZE = 50

/**
 * What is STILL absent, after 0063.
 *
 * This list used to name four tables and it was accurate when written. Then
 * `conversations`, `conversation_messages` and `conversation_reads` were
 * built — the thread, both directions of message, and per-person read state
 * — under those names rather than the ones guessed here.
 *
 * The list is shortened rather than deleted, because the point of it stands:
 * a screen that prints what it lacks is worth more than one that implies it
 * lacks nothing. What it must never do is keep naming something that now
 * exists, which would tell a business its database is missing tables it has.
 *
 * Templates are genuinely still absent. `template.manage` is in the
 * catalogue and has nothing to point at, which is exactly the state
 * `message.assign` was in until 0063 gave it
 * `conversations.assigned_to_user_id`.
 */
export const MISSING_MESSAGING_TABLES: readonly string[] = ['message_templates']

export type InboxArgs = {
  db: Db
  actor: Actor
  organizationId: string
  /** A single property, or null for every property in scope. */
  propertyId: string | null
  limit?: number
}

function bookingResource(organizationId: string, propertyId: string): Resource {
  return { organizationId, propertyId, family: 'booking' }
}

/* ------------------------------------------------------- guest requests -- */

/**
 * A guest's own words, attached to their stay.
 *
 * `writtenOn` is the booking's `created_at`, and it is labelled on screen as
 * "when the booking was taken" rather than "when the guest wrote this" —
 * because the column carries no timestamp of its own and the two are only the
 * same when the note was typed at the same moment. Calling it a message
 * timestamp would be inventing a fact.
 */
export type GuestNote = {
  bookingId: string
  reference: string
  propertyId: string
  status: BookingStatus
  checkIn: string
  checkOut: string
  /** Null when this reader may not read guest records. Never "אורח". */
  guestName: string | null
  /** The guest's words. The reason this row exists. */
  text: string
  /** The booking's own `created_at`, not a message timestamp. */
  writtenOn: string
  /** True when the stay has not ended: an old note about a past stay is not work. */
  live: boolean
}

const NOTE_COLUMNS =
  'id, reference, status, check_in, check_out, property_id, guest_id, ' +
  'guest_notes, internal_notes, created_at'

/**
 * Guest requests recorded on live bookings, newest booking first.
 *
 * `null` without `guest.view_name` — the note is the guest's own words and is
 * guest data wherever the column happens to sit. A reader with `booking.view`
 * and no guest grant is told that rather than shown an empty inbox.
 */
export async function listGuestNotes(
  args: InboxArgs,
  today: string,
): Promise<readonly GuestNote[] | null> {
  if (!holdsGrant(args.actor, 'booking.view')) return null
  if (!holdsGrant(args.actor, 'guest.view_name')) return null

  const rows = await bookingRows(args)
  const names = await guestNames(args, rows)

  return rows
    .map((row): GuestNote | null => {
      const text = asStringOrNull(row, 'guest_notes')
      if (text === null || text.trim().length === 0) return null

      return {
        bookingId: asString(row, 'id'),
        reference: asString(row, 'reference'),
        propertyId: asString(row, 'property_id'),
        status: asEnum(row, 'status', BOOKING_STATUSES),
        checkIn: asIsoDate(row, 'check_in'),
        checkOut: asIsoDate(row, 'check_out'),
        guestName: names.get(asString(row, 'guest_id')) ?? null,
        text,
        writtenOn: localDate(new Date(asTimestamp(row, 'created_at'))),
        live: asIsoDate(row, 'check_out') >= today,
      }
    })
    .filter((note): note is GuestNote => note !== null)
    .sort((a, b) => b.writtenOn.localeCompare(a.writtenOn))
}

/* ---------------------------------------------------------- team notes -- */

export type InternalNote = {
  bookingId: string
  reference: string
  propertyId: string
  status: BookingStatus
  checkIn: string
  checkOut: string
  text: string
  writtenOn: string
  live: boolean
}

/**
 * Notes the team left for itself on a booking.
 *
 * `null` without `booking.note.internal`. That grant exists as its own entry in
 * the catalogue for exactly this reason — an internal note is written in the
 * knowledge that the guest will not read it, and a role that can see the
 * booking is not thereby a role that may read what the team said about it.
 */
export async function listInternalNotes(
  args: InboxArgs,
  today: string,
): Promise<readonly InternalNote[] | null> {
  if (!holdsGrant(args.actor, 'booking.view')) return null
  if (!holdsGrant(args.actor, 'booking.note.internal')) return null

  const rows = await bookingRows(args)

  return rows
    .map((row): InternalNote | null => {
      const text = asStringOrNull(row, 'internal_notes')
      if (text === null || text.trim().length === 0) return null

      return {
        bookingId: asString(row, 'id'),
        reference: asString(row, 'reference'),
        propertyId: asString(row, 'property_id'),
        status: asEnum(row, 'status', BOOKING_STATUSES),
        checkIn: asIsoDate(row, 'check_in'),
        checkOut: asIsoDate(row, 'check_out'),
        text,
        writtenOn: localDate(new Date(asTimestamp(row, 'created_at'))),
        live: asIsoDate(row, 'check_out') >= today,
      }
    })
    .filter((note): note is InternalNote => note !== null)
    .sort((a, b) => b.writtenOn.localeCompare(a.writtenOn))
}

/* -------------------------------------------------- requests become work -- */

/**
 * A guest request somebody turned into a job.
 *
 * This is the only assignable thing on the screen, and the assignment is real:
 * `task_assignments` carries the people on it, `task.assign` is the grant, and
 * `tasks.assigned_to_user_id` is what an `own_records` scope narrows on.
 * `message.assign` has nothing equivalent, which is the gap this list makes
 * visible rather than papers over.
 */
export type RequestTask = {
  id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  propertyId: string
  unitId: string | null
  teamId: string | null
  bookingId: string | null
  /** The property-local day it is due, or null when it carries no date. */
  dueOn: string | null
  /** The person answerable for it. Null when nobody has taken it. */
  assignedToUserId: string | null
  assignedToName: string | null
  /** Why it was cancelled, required by `tasks_cancelled_has_reason`. */
  cancellationReason: string | null
}

/**
 * Guest requests as work, every status.
 *
 * Cancelled ones are kept deliberately. An inbox that hides "the guests said
 * never mind" is an inbox that makes somebody chase a request that was
 * withdrawn, and `tasks_cancelled_has_reason` guarantees there is a reason to
 * print beside it.
 *
 * `null` without `task.view`.
 */
export async function listRequestTasks(
  args: InboxArgs,
): Promise<readonly RequestTask[] | null> {
  const { db, actor, organizationId, propertyId } = args
  const limit = args.limit ?? INBOX_PAGE_SIZE

  if (!holdsGrant(actor, 'task.view')) return null

  const narrowings = scopeNarrowings(
    actor,
    scopeFor(actor, { organizationId, family: 'operations' }),
  )

  const results = await Promise.all(
    narrowings.map(async (narrowing) => {
      let query = db
        .from('tasks')
        .select(
          'id, title, description, status, priority, property_id, unit_id, ' +
            'team_id, booking_id, due_at, assigned_to_user_id, created_by, ' +
            'cancellation_reason',
        )
        .eq('organization_id', organizationId)
        .is('deleted_at', null)
        .eq('task_type', 'guest_request')

      if (propertyId !== null) query = query.eq('property_id', propertyId)
      if (narrowing.kind === 'in') {
        query = query.in(narrowing.column, [...narrowing.values])
      } else if (narrowing.kind === 'eq') {
        query = query.eq(narrowing.column, narrowing.value)
      }

      const { data, error } = await query
        .order('due_at', { ascending: false })
        .limit(limit)

      if (error) throw error
      return toRows(data)
    }),
  )

  const merged = new Map<string, Row>()
  for (const row of results.flat()) merged.set(asString(row, 'id'), row)

  const rows = [...merged.values()].filter((row) =>
    can(actor, 'task.view', {
      organizationId,
      propertyId: asString(row, 'property_id'),
      unitId: asStringOrNull(row, 'unit_id') ?? undefined,
      teamId: asStringOrNull(row, 'team_id') ?? undefined,
      family: 'operations',
    }),
  )

  const names = await profileNames(
    db,
    holdsGrant(actor, 'user.view')
      ? rows
          .map((row) => asStringOrNull(row, 'assigned_to_user_id'))
          .filter((id): id is string => id !== null)
      : [],
  )

  return rows.map((row): RequestTask => {
    const dueAt = asTimestampOrNull(row, 'due_at')
    const assignee = asStringOrNull(row, 'assigned_to_user_id')

    return {
      id: asString(row, 'id'),
      title: asString(row, 'title'),
      description: asStringOrNull(row, 'description'),
      status: asEnum(row, 'status', TASK_STATUSES),
      priority: asEnum(row, 'priority', TASK_PRIORITIES),
      propertyId: asString(row, 'property_id'),
      unitId: asStringOrNull(row, 'unit_id'),
      teamId: asStringOrNull(row, 'team_id'),
      bookingId: asStringOrNull(row, 'booking_id'),
      dueOn: dueAt === null ? null : localDate(new Date(dueAt)),
      assignedToUserId: assignee,
      assignedToName: assignee === null ? null : (names.get(assignee) ?? null),
      cancellationReason: asStringOrNull(row, 'cancellation_reason'),
    }
  })
}

/* ------------------------------------------------------------ internals -- */

/**
 * The bookings both note lists read from, fetched once.
 *
 * Two lists over one query rather than two queries over one table: the notes
 * are two columns on the same row, and asking twice would double the cost of a
 * screen that is already reading more than it would like to. The scope
 * narrowing and the `can()` check are applied here, so neither caller can
 * forget them.
 */
async function bookingRows(args: InboxArgs): Promise<readonly Row[]> {
  const { db, actor, organizationId, propertyId } = args
  const limit = args.limit ?? INBOX_PAGE_SIZE

  const narrowings = scopeNarrowings(
    actor,
    scopeFor(actor, { organizationId, family: 'booking' }),
  )

  const results = await Promise.all(
    narrowings.map(async (narrowing) => {
      let query = db
        .from('bookings')
        .select(NOTE_COLUMNS)
        .eq('organization_id', organizationId)
        .is('deleted_at', null)

      if (propertyId !== null) query = query.eq('property_id', propertyId)
      if (narrowing.kind === 'in') {
        query = query.in(narrowing.column, [...narrowing.values])
      } else if (narrowing.kind === 'eq') {
        query = query.eq(narrowing.column, narrowing.value)
      }

      const { data, error } = await query
        .order('created_at', { ascending: false })
        .limit(limit)

      if (error) throw error
      return toRows(data)
    }),
  )

  const merged = new Map<string, Row>()
  for (const row of results.flat()) merged.set(asString(row, 'id'), row)

  return [...merged.values()].filter((row) =>
    can(
      actor,
      'booking.view',
      bookingResource(organizationId, asString(row, 'property_id')),
    ),
  )
}

async function guestNames(
  args: InboxArgs,
  rows: readonly Row[],
): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(rows.map((row) => asString(row, 'guest_id')))]
  if (ids.length === 0) return new Map()

  const { data, error } = await args.db
    .from('guests')
    .select('id, full_name')
    .eq('organization_id', args.organizationId)
    .in('id', ids)

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    const name = asStringOrNull(row, 'full_name')
    if (name !== null) names.set(asString(row, 'id'), name)
  }
  return names
}

async function profileNames(
  db: Db,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return new Map()

  const { data, error } = await db
    .from('user_profiles')
    .select('id, full_name')
    .in('id', unique)

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    const name = asStringOrNull(row, 'full_name')
    if (name !== null) names.set(asString(row, 'id'), name)
  }
  return names
}
