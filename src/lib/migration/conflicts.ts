/**
 * Collisions, and the person who has to settle them.
 *
 * ── Nothing is ever discarded here ────────────────────────────────────────
 *
 * That is the rule this file exists to keep, and it is worth saying why it is a
 * rule rather than a preference. Three years of a real guesthouse's bookings
 * contain genuine double-entries, stays cancelled in the old system and
 * re-entered under a new number, an owner's own week recorded as a booking, and
 * one Friday in 2023 when the villa really was sold twice and somebody sorted
 * it out on the telephone. Every one of those is a *fact about the operator's
 * business*, and only they know which reading is right.
 *
 * An import that dropped the second row of each pair would produce a cleaner
 * report and a wrong migration — wrong in the worst available way, because the
 * missing stays are invisible. So a collision becomes a `Conflict`: both sides
 * described well enough to choose between them without leaving the screen, and
 * a decision that starts as `undecided` and stays there until a person moves
 * it.
 *
 * ── Overlap is half-open, and the same half-open everywhere ───────────────
 *
 * `rangesOverlap` from `src/lib/booking/types.ts` is imported rather than
 * rewritten. A guest leaving on the 5th and one arriving on the 5th do not
 * collide — that is a same-day turnaround and it is the normal case. A second
 * overlap test here that got that wrong would report a conflict on every
 * changeover in the file, which is the fastest possible way to make an operator
 * abandon a migration: eight hundred conflicts, none of them real.
 *
 * ── Four kinds, because they are four different questions ─────────────────
 *
 * A booking against an existing booking asks "which of these is the real one".
 * A booking against another row of the same file asks "did your old system hold
 * this stay twice". A booking against an owner's stay asks "was this let, or
 * was this the family". A booking against a maintenance block asks "did you
 * sell it anyway". Collapsing them into one "overlap" would put one question in
 * front of a person four times and get four answers to the wrong one.
 */

import {
  OCCUPYING_STATUSES,
  rangesOverlap,
  type BookingStatus,
  type DateRange,
} from '../booking/types'
import type {
  BookingValues,
  Conflict,
  ConflictKind,
  ImportRecord,
} from './types'

/* --------------------------------------------------------- what exists -- */

/** A booking already in ESTIA, as this module needs to see one. */
export type ExistingBooking = {
  id: string
  reference: string
  unitId: string
  unitName: string
  guestName: string
  status: BookingStatus
  checkIn: string
  checkOut: string
}

/** A unit already in ESTIA. Matched by name, because a file has no ids. */
export type ExistingUnit = {
  id: string
  name: string
  propertyId: string | null
  propertyName: string | null
}

/** Dates already off sale: an owner's own week, or a plumber. */
export type ExistingBlock = {
  id: string
  unitId: string
  unitName: string
  /** `owner_stay` and `maintenance` ask different questions of a person. */
  kind: 'owner_stay' | 'maintenance'
  label: string
  checkIn: string
  checkOut: string
}

export type ExistingCalendar = {
  units: readonly ExistingUnit[]
  bookings: readonly ExistingBooking[]
  blocks: readonly ExistingBlock[]
}

/* ------------------------------------------------------------- matching -- */

/**
 * A unit name, reduced to the thing worth comparing.
 *
 * Case, surrounding whitespace and the various quote marks only. Nothing
 * cleverer: `וילה 1` and `וילה 2` differ by one character and a fuzzy match
 * that treated them as one would attach a year of bookings to the wrong villa,
 * which is the same class of damage as merging two guests.
 */
export function normalizeUnitName(name: string): string {
  return name
    .replace(/["'׳״]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** The unit this row names, or `null` when ESTIA has no unit by that name. */
export function findUnit(
  units: readonly ExistingUnit[],
  unitName: string,
  propertyName: string | null,
): ExistingUnit | null {
  const wanted = normalizeUnitName(unitName)
  const matches = units.filter(
    (unit) => normalizeUnitName(unit.name) === wanted,
  )

  if (matches.length === 0) return null
  if (matches.length === 1) return matches[0] ?? null

  // Two units share a name across two properties, which is ordinary — every
  // operator has a "יחידה 1" in each villa. The property column is what
  // separates them, and without it the answer is honestly unknown rather than
  // the first one found.
  if (propertyName === null) return null

  const wantedProperty = normalizeUnitName(propertyName)
  return (
    matches.find(
      (unit) =>
        unit.propertyName !== null &&
        normalizeUnitName(unit.propertyName) === wantedProperty,
    ) ?? null
  )
}

/* ------------------------------------------------------------ detection -- */

const OCCUPYING = new Set<BookingStatus>(OCCUPYING_STATUSES)

function rangeOf(booking: BookingValues): DateRange {
  return { checkIn: booking.checkIn, checkOut: booking.checkOut }
}

function formatRange(range: DateRange): string {
  return `${range.checkIn} עד ${range.checkOut}`
}

/**
 * Every decision this file's bookings owe a person.
 *
 * Pure and synchronous over data that is already loaded. It is part of the dry
 * run, and the dry run does not perform I/O — see `dryrun.ts`.
 */
export function detectConflicts(
  records: readonly ImportRecord[],
  calendar: ExistingCalendar,
  options: { skippedRows?: readonly number[] } = {},
): readonly Conflict[] {
  const skipped = new Set(options.skippedRows ?? [])
  const conflicts: Conflict[] = []

  // Rows already accepted for a unit, so the file can be checked against
  // itself. Keyed by the ESTIA unit id where the unit is known and by the
  // normalised name where it is not — an unknown unit's rows still collide
  // with each other, and dropping that check would hide a duplicate export.
  const placed = new Map<string, { row: number; booking: BookingValues }[]>()

  for (const record of records) {
    if (record.values.entity !== 'bookings') continue
    if (skipped.has(record.rowNumber)) continue

    const booking = record.values.booking
    const range = rangeOf(booking)
    const unit = findUnit(
      calendar.units,
      booking.unitName,
      booking.propertyName,
    )

    if (unit === null) {
      conflicts.push({
        id: `unit:${record.rowNumber}`,
        kind: 'unit_mismatch',
        rowNumber: record.rowNumber,
        entity: 'bookings',
        left: {
          origin: 'import',
          reference: String(record.rowNumber),
          label: booking.unitName,
          detail:
            `${booking.guestName}, ${formatRange(range)}` +
            (booking.propertyName === null
              ? ''
              : ` · נכס: ${booking.propertyName}`),
        },
        right: {
          origin: 'estia',
          reference: '—',
          label: 'אין יחידה בשם הזה',
          detail:
            calendar.units.length === 0
              ? 'לא הוגדרה עדיין אף יחידה בארגון.'
              : `יחידות קיימות: ${calendar.units
                  .slice(0, 6)
                  .map((candidate) => candidate.name)
                  .join(', ')}`,
        },
        question:
          `שורה ${record.rowNumber} מפנה ליחידה ״${booking.unitName}״ ` +
          'שאינה קיימת ב-ESTIA. צור אותה, מפה אותה ליחידה קיימת, או דלג ' +
          'על השורה.',
        decision: 'undecided',
      })
      // Still recorded against its name, so two rows for the same unknown unit
      // still collide with each other rather than both passing silently.
    }

    const key = unit?.id ?? `name:${normalizeUnitName(booking.unitName)}`

    // ── Against the file itself ──────────────────────────────────────────
    for (const earlier of placed.get(key) ?? []) {
      if (!rangesOverlap(range, rangeOf(earlier.booking))) continue

      conflicts.push({
        id: `file:${earlier.row}:${record.rowNumber}`,
        kind: 'booking_overlaps_import',
        rowNumber: record.rowNumber,
        entity: 'bookings',
        left: {
          origin: 'import',
          reference: String(earlier.row),
          label: earlier.booking.guestName,
          detail: `${formatRange(rangeOf(earlier.booking))} · ${
            earlier.booking.unitName
          }`,
        },
        right: {
          origin: 'import',
          reference: String(record.rowNumber),
          label: booking.guestName,
          detail: `${formatRange(range)} · ${booking.unitName}`,
        },
        question:
          `שתי שורות בקובץ תופסות את אותם תאריכים באותה יחידה. ` +
          'האם זו אותה שהות שנרשמה פעמיים, או שתי שהויות שונות?',
        decision: 'undecided',
      })
    }

    // ── Against what ESTIA already holds ─────────────────────────────────
    if (unit !== null) {
      for (const existing of calendar.bookings) {
        if (existing.unitId !== unit.id) continue
        // A cancelled or no-show booking does not hold the calendar and must
        // not produce a decision. `OCCUPYING_STATUSES` is the domain's own
        // answer to "does this booking take the dates", imported rather than
        // restated so the two cannot drift.
        if (!OCCUPYING.has(existing.status)) continue
        if (!rangesOverlap(range, existing)) continue

        conflicts.push(
          overlapConflict(
            'booking_overlaps_booking',
            record.rowNumber,
            booking,
            {
              origin: 'estia',
              reference: existing.id,
              label: `${existing.guestName} · ${existing.reference}`,
              detail: `${formatRange(existing)} · ${existing.unitName}`,
            },
            'התאריכים תפוסים בהזמנה שכבר קיימת ב-ESTIA. איזו מהשתיים נכונה?',
          ),
        )
      }

      for (const block of calendar.blocks) {
        if (block.unitId !== unit.id) continue
        if (!rangesOverlap(range, block)) continue

        const kind: ConflictKind =
          block.kind === 'owner_stay'
            ? 'booking_overlaps_owner_stay'
            : 'booking_overlaps_maintenance'

        conflicts.push(
          overlapConflict(
            kind,
            record.rowNumber,
            booking,
            {
              origin: 'estia',
              reference: block.id,
              label: block.label,
              detail: `${formatRange(block)} · ${block.unitName}`,
            },
            block.kind === 'owner_stay'
              ? 'התאריכים שמורים לשהות בעלים. האם השהות הזו הושכרה בכל זאת?'
              : 'התאריכים חסומים לתחזוקה. האם היחידה הושכרה למרות החסימה?',
          ),
        )
      }
    }

    const bucket = placed.get(key)
    if (bucket) bucket.push({ row: record.rowNumber, booking })
    else placed.set(key, [{ row: record.rowNumber, booking }])
  }

  return conflicts
}

function overlapConflict(
  kind: ConflictKind,
  rowNumber: number,
  booking: BookingValues,
  right: Conflict['right'],
  question: string,
): Conflict {
  return {
    id: `${kind}:${rowNumber}:${right.reference}`,
    kind,
    rowNumber,
    entity: 'bookings',
    left: {
      origin: 'import',
      reference: String(rowNumber),
      label: booking.guestName,
      detail: `${formatRange(rangeOf(booking))} · ${booking.unitName}`,
    },
    right,
    question,
    decision: 'undecided',
  }
}

/* ------------------------------------------------------------- decisions -- */

/**
 * The rows a person has decided not to import.
 *
 * `undecided` is deliberately **not** in this set. An unsettled conflict blocks
 * its row from being written at all — see `applicableRows` — rather than
 * defaulting to either answer. A default here would be the silent discard this
 * whole file exists to prevent, or its mirror image: a double booking written
 * because nobody said no.
 */
export function skippedRows(
  conflicts: readonly Conflict[],
): ReadonlySet<number> {
  const rows = new Set<number>()
  for (const conflict of conflicts) {
    if (conflict.decision === 'skip_record') rows.add(conflict.rowNumber)
    if (conflict.decision === 'keep_existing') rows.add(conflict.rowNumber)
  }
  return rows
}

/** Rows still waiting on a person. Blocked from the apply, and counted on it. */
export function undecidedRows(
  conflicts: readonly Conflict[],
): ReadonlySet<number> {
  const rows = new Set<number>()
  for (const conflict of conflicts) {
    if (conflict.decision === 'undecided') rows.add(conflict.rowNumber)
  }
  return rows
}

/**
 * Which rows the apply may write.
 *
 * Three states and only one of them writes: settled in favour of importing,
 * settled against, and not settled. Anything not conflicted at all is
 * writable, which is the overwhelming majority of a real file.
 */
export function applicableRows(
  records: readonly ImportRecord[],
  conflicts: readonly Conflict[],
): readonly ImportRecord[] {
  const blocked = new Set([
    ...skippedRows(conflicts),
    ...undecidedRows(conflicts),
  ])
  return records.filter((record) => !blocked.has(record.rowNumber))
}

/** Replace one decision, returning a new list. Nothing here mutates. */
export function decide(
  conflicts: readonly Conflict[],
  id: string,
  decision: Conflict['decision'],
): readonly Conflict[] {
  return conflicts.map((conflict) =>
    conflict.id === id ? { ...conflict, decision } : conflict,
  )
}
