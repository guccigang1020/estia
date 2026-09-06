/**
 * An OTA changed something about a stay ESTIA already holds.
 *
 * ── Two things this file must do, and one it must never do ────────────────
 *
 *   · **Name the delta.** Not "the reservation was updated" — which field,
 *     from what, to what.
 *   · **Name what else moves.** A date change is not a date change. It is a
 *     preparation window, a cleaning task, a laundry order, an amenity draw, a
 *     door code with a validity window, and a revenue figure — seven systems,
 *     and the one nobody thinks of is laundry, which is why a bed is stripped
 *     on the wrong Friday. `DOWNSTREAM_SYSTEMS` is closed and each change kind
 *     names its own, so a new field cannot be added without somebody deciding
 *     what it touches.
 *   · **Never silently overwrite a local change.** This is the refusal the
 *     file is built around, and it is not squeamishness. A manager who moved a
 *     booking to a different date after speaking to the guest, and a
 *     Booking.com webhook that arrives four minutes later carrying the old
 *     dates, are two people who both believe they know when the guest is
 *     coming. Applying the webhook silently deletes a decision and a phone
 *     call, and nobody finds out until the guest arrives to a room that is not
 *     ready.
 *
 * ── Conflict is decided per field, refused as a whole ─────────────────────
 *
 * Detection is per field: a channel changing the price while a person changed
 * the guest count is not a conflict, and calling it one would make the queue
 * useless. But once *any* field conflicts the entire modification is held —
 * applying the non-conflicting half produces a booking that matches neither
 * the channel's version nor the manager's, which is the one state worse than
 * either.
 *
 * ── This file applies nothing ─────────────────────────────────────────────
 *
 * It produces a plan. The changes are made by the booking domain's own
 * operations, under `defineOperation`, with their own authorization, locking
 * and audit sentence. Two of the commands this plan can name do not exist as
 * operations yet — see `ModificationCommand.available`, which says so rather
 * than pretending.
 */

import { nightsBetween, type Agorot, type DateRange } from '../booking/types'
import type { BookingStatus } from '../booking/types'
import type { Grant } from '../authz/permissions'

import {
  CHANNEL_LABEL,
  DOWNSTREAM_LABEL,
  DOWNSTREAM_SYSTEMS,
  type ChannelReservation,
  type DownstreamSystem,
} from './types'
import { draftException, type ChannelExceptionDraft } from './exceptions'

/* ----------------------------------------------------------------- fields -- */

export const MODIFICATION_FIELDS = [
  'dates',
  'guest_count',
  'guest_name',
  'price',
] as const

export type ModificationField = (typeof MODIFICATION_FIELDS)[number]

export const MODIFICATION_FIELD_LABEL: Readonly<
  Record<ModificationField, string>
> = {
  dates: 'תאריכים',
  guest_count: 'מספר אורחים',
  guest_name: 'שם האורח',
  price: 'מחיר',
}

/**
 * What each change reaches, and why.
 *
 * A total `Record`, so a field added above without a downstream list fails the
 * typecheck. The lists are deliberately generous: the cost of naming a system
 * that turns out not to care is a line on a screen, and the cost of omitting
 * one is unwashed linen.
 */
export const DOWNSTREAM_FOR_FIELD: Readonly<
  Record<ModificationField, readonly DownstreamSystem[]>
> = {
  // Everything. The stay moved.
  dates: [
    'availability',
    'preparation',
    'tasks',
    'laundry',
    'inventory',
    'access',
    'revenue',
  ],
  // Not availability — the unit is blocked either way — and not access, which
  // is per stay rather than per head. Everything else scales with people.
  guest_count: ['preparation', 'tasks', 'laundry', 'inventory', 'revenue'],
  // The name on the arrival instructions and on whatever greets them.
  guest_name: ['access'],
  price: ['revenue'],
}

/** The grant a person would need to make each change by hand. */
export const GRANT_FOR_FIELD: Readonly<Record<ModificationField, Grant>> = {
  dates: 'booking.amend_dates',
  guest_count: 'booking.amend_guest_count',
  guest_name: 'booking.update',
  price: 'booking.amend_price',
}

/* ------------------------------------------------------------ local state -- */

/**
 * One edit a person made here, from the audit trail.
 *
 * Per field and timestamped, because "the booking was touched since the last
 * sync" is too coarse to be useful — it makes every channel update conflict
 * with every unrelated note somebody added.
 */
export interface LocalEdit {
  field: ModificationField
  at: Date
  byUserId: string | null
}

export interface LocalBookingState {
  bookingId: string
  organizationId: string
  propertyId: string
  unitId: string
  status: BookingStatus
  stay: DateRange
  guestCount: number
  guestName: string
  totalAgorot: Agorot
  /** The optimistic-locking version. Carried into the amend command. */
  version: number
  /** When a channel update was last applied. `null` before the first one. */
  lastChannelSyncAt: Date | null
  /** Edits made here. Only those after `lastChannelSyncAt` can conflict. */
  localEdits: readonly LocalEdit[]
}

/* ------------------------------------------------------------------ delta -- */

export type FieldValue = string | number

export interface FieldChange {
  field: ModificationField
  before: FieldValue
  after: FieldValue
  /** Hebrew, for the screen and the audit sentence. */
  description: string
  downstream: readonly DownstreamSystem[]
}

export interface FieldConflict {
  field: ModificationField
  /** What ESTIA holds now, after the local edit. */
  local: FieldValue
  /** What the channel is asking for. */
  incoming: FieldValue
  editedAt: Date
  editedByUserId: string | null
}

/**
 * One command the caller runs to apply one change.
 *
 * `available: false` is not a placeholder. `booking.amend_dates` exists as an
 * operation; `booking.amend_guest_count` and `booking.amend_price` are
 * permissions in the catalogue with no operation behind them yet. A plan that
 * silently omitted the unbuildable half would report success over a price that
 * never moved, so the command is named, marked unavailable, and surfaced — the
 * same argument the channels report already makes about the absent integration.
 */
export interface ModificationCommand {
  operation: string
  requires: Grant
  fields: readonly ModificationField[]
  /** Passed as `OperationRequest.expectedVersion`. Refuses a stale plan. */
  expectedVersion: number
  /** False when no such operation exists in the booking domain today. */
  available: boolean
}

export type ModificationPlan =
  /** The channel sent an update that changes nothing ESTIA acts on. */
  | { kind: 'no_change' }
  | {
      kind: 'apply'
      changes: readonly FieldChange[]
      downstream: readonly DownstreamSystem[]
      commands: readonly ModificationCommand[]
    }
  /** Held. Nothing applied, on any field. */
  | {
      kind: 'conflict'
      changes: readonly FieldChange[]
      conflicts: readonly FieldConflict[]
      exception: ChannelExceptionDraft
    }

/* ----------------------------------------------------------------- engine -- */

export interface ModificationInput {
  current: LocalBookingState
  incoming: ChannelReservation
  connectorId: string
  now: Date
}

export function planModification(input: ModificationInput): ModificationPlan {
  const { current, incoming } = input

  const changes = deltaOf(current, incoming)
  if (changes.length === 0) return { kind: 'no_change' }

  const conflicts = conflictsAmong(changes, current)

  if (conflicts.length > 0) {
    return {
      kind: 'conflict',
      changes,
      conflicts,
      exception: conflictException(input, changes, conflicts),
    }
  }

  return {
    kind: 'apply',
    changes,
    downstream: downstreamOf(changes),
    commands: commandsFor(changes, current.version),
  }
}

/** Every system any of these changes reaches, in the catalogue's own order. */
export function downstreamOf(
  changes: readonly FieldChange[],
): readonly DownstreamSystem[] {
  const touched = new Set<DownstreamSystem>()
  for (const change of changes) {
    for (const system of change.downstream) touched.add(system)
  }
  // Ordered by the frozen vocabulary rather than by insertion, so two plans
  // with the same effect render identically.
  return DOWNSTREAM_SYSTEMS.filter((system) => touched.has(system))
}

/* -------------------------------------------------------------- internals -- */

function change(
  field: ModificationField,
  before: FieldValue,
  after: FieldValue,
  description: string,
): FieldChange {
  return {
    field,
    before,
    after,
    description,
    downstream: DOWNSTREAM_FOR_FIELD[field],
  }
}

function deltaOf(
  current: LocalBookingState,
  incoming: ChannelReservation,
): readonly FieldChange[] {
  const changes: FieldChange[] = []

  const movedIn = current.stay.checkIn !== incoming.stay.checkIn
  const movedOut = current.stay.checkOut !== incoming.stay.checkOut

  if (movedIn || movedOut) {
    changes.push(
      change(
        'dates',
        `${current.stay.checkIn} → ${current.stay.checkOut}`,
        `${incoming.stay.checkIn} → ${incoming.stay.checkOut}`,
        `השהות זזה מ-${current.stay.checkIn}–${current.stay.checkOut} ` +
          `ל-${incoming.stay.checkIn}–${incoming.stay.checkOut} ` +
          `(${nightsBetween(current.stay)} לילות → ` +
          `${nightsBetween(incoming.stay)}).`,
      ),
    )
  }

  if (current.guestCount !== incoming.guestCount) {
    changes.push(
      change(
        'guest_count',
        current.guestCount,
        incoming.guestCount,
        `מספר האורחים השתנה מ-${current.guestCount} ל-${incoming.guestCount}.`,
      ),
    )
  }

  if (current.guestName.trim() !== incoming.guestName.trim()) {
    changes.push(
      change(
        'guest_name',
        current.guestName,
        incoming.guestName,
        `שם האורח השתנה מ-״${current.guestName}״ ל-״${incoming.guestName}״.`,
      ),
    )
  }

  if (current.totalAgorot !== incoming.grossAgorot) {
    changes.push(
      change(
        'price',
        current.totalAgorot,
        incoming.grossAgorot,
        'סכום ההזמנה בערוץ שונה מהסכום הרשום אצלך.',
      ),
    )
  }

  return changes
}

/**
 * Which of these changes lands on something a person already changed here?
 *
 * Only edits *after* the last channel sync count. An edit older than the last
 * applied update has already been reconciled once — treating it as a
 * standing conflict would make every subsequent channel update conflict
 * forever, which is a queue that grows and is never worked.
 *
 * A booking that has never been synced (`lastChannelSyncAt === null`) treats
 * every local edit as recent, which is the safe direction: the alternative is
 * a first sync that silently overwrites months of manual corrections.
 */
function conflictsAmong(
  changes: readonly FieldChange[],
  current: LocalBookingState,
): readonly FieldConflict[] {
  const since = current.lastChannelSyncAt

  return changes.flatMap((entry) => {
    const edit = current.localEdits
      .filter(
        (candidate) =>
          candidate.field === entry.field &&
          (since === null || candidate.at.getTime() > since.getTime()),
      )
      // The most recent local edit is the one the person remembers making.
      .sort((a, b) => b.at.getTime() - a.at.getTime())[0]

    if (!edit) return []

    return [
      {
        field: entry.field,
        local: entry.before,
        incoming: entry.after,
        editedAt: edit.at,
        editedByUserId: edit.byUserId,
      },
    ]
  })
}

function commandsFor(
  changes: readonly FieldChange[],
  expectedVersion: number,
): readonly ModificationCommand[] {
  const fields = new Set(changes.map((entry) => entry.field))
  const commands: ModificationCommand[] = []

  if (fields.has('dates')) {
    commands.push({
      operation: 'booking.amend_dates',
      requires: GRANT_FOR_FIELD.dates,
      fields: ['dates'],
      expectedVersion,
      available: true,
    })
  }

  if (fields.has('guest_count')) {
    commands.push({
      operation: 'booking.amend_guest_count',
      requires: GRANT_FOR_FIELD.guest_count,
      fields: ['guest_count'],
      expectedVersion,
      // The permission exists; the operation does not. Named, not hidden.
      available: false,
    })
  }

  if (fields.has('price')) {
    commands.push({
      operation: 'booking.amend_price',
      requires: GRANT_FOR_FIELD.price,
      fields: ['price'],
      expectedVersion,
      available: false,
    })
  }

  if (fields.has('guest_name')) {
    commands.push({
      operation: 'booking.update',
      requires: GRANT_FOR_FIELD.guest_name,
      fields: ['guest_name'],
      expectedVersion,
      available: false,
    })
  }

  return commands
}

function conflictException(
  input: ModificationInput,
  changes: readonly FieldChange[],
  conflicts: readonly FieldConflict[],
): ChannelExceptionDraft {
  const { current, incoming, connectorId, now } = input

  const lines = conflicts.map(
    (conflict) =>
      `${MODIFICATION_FIELD_LABEL[conflict.field]}: אצלך ${conflict.local}, ` +
      `בערוץ ${conflict.incoming}`,
  )

  return draftException('modification_conflict', {
    organizationId: current.organizationId,
    connectorId,
    channelCode: incoming.channelCode,
    occurredAt: now,
    subject: `${current.bookingId}:${incoming.externalReservationId}`,
    externalReservationId: incoming.externalReservationId,
    externalListingId: incoming.externalListingId,
    bookingId: current.bookingId,
    unitId: current.unitId,
    propertyId: current.propertyId,
    detail:
      `${CHANNEL_LABEL[incoming.channelCode]} שלח שינוי על שדות ששונו כאן ` +
      `מאז הסנכרון האחרון. שום שינוי לא הוחל — לא זה של הערוץ ולא ביטול ` +
      `של מה שנעשה כאן. ${lines.join(' · ')}. ` +
      `מערכות שיושפעו כשתחליט: ` +
      `${downstreamOf(changes)
        .map((system) => DOWNSTREAM_LABEL[system])
        .join(', ')}.`,
  })
}
