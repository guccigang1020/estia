/**
 * The booking lifecycle writes the register. Pure functions, no I/O.
 *
 * Four moments, and each one is a different sentence:
 *
 *   1. **confirmed** — the stay is committed, so an entry exists. It is
 *      `expected` and it is usually incomplete: the guest's address is not
 *      known at the moment somebody confirms dates over the telephone.
 *   2. **guest details** — a name, an address, a corrected head count arrive
 *      and fill the entry in. This can happen many times, and it is the reason
 *      `applyBookingFacts` is an update rather than a create.
 *   3. **arrival** — the guest is here. The arrival *time* is recorded now,
 *      because until now nobody knew it: the stated arrival hour on a booking
 *      is an intention, and a register that wrote it down as an arrival would
 *      record a time the guest never turned up at.
 *   4. **departure** — the stay is over and the entry is closed.
 *
 * ── Why these are pure ────────────────────────────────────────────────────
 *
 * Every function here takes facts and returns an outcome. Nothing reads a
 * clock, nothing generates an id, nothing writes. That is what makes the four
 * moments testable as four moments rather than as four database states, and it
 * is what lets the same functions run from an operation, from a backfill, and
 * from the preview on the settings screen without any of the three producing a
 * different entry.
 *
 * ── An incomplete entry is written, not withheld ──────────────────────────
 *
 * `missingFields` is reported *on the entry*, never used to refuse writing it.
 * A register that dropped every stay whose guest had not yet given an address
 * would be a register with holes in it, and the holes would be invisible. A
 * register that holds the stay and says which fields are outstanding is one
 * somebody can actually work through.
 */

import {
  isGuestBookEnabledFor,
  requiresField,
  type GuestBookConfig,
} from './config'
import {
  GUEST_BOOK_FIELDS,
  type GuestAddress,
  type GuestBookEntry,
  type GuestBookEntryStatus,
  type GuestBookField,
} from './types'

// ── What the booking knows ────────────────────────────────────────────────

/**
 * The booking facts the register is written from.
 *
 * A projection rather than the booking record itself, and deliberately so:
 * this module must not depend on the shape of the bookings table, and a
 * function that took a whole `Booking` would be untestable without building
 * one. Every field here is something a register entry needs; nothing else is
 * asked for.
 */
export interface BookingFacts {
  bookingId: string
  organizationId: string
  propertyId: string
  reference: string
  /** `cancelled` here is what makes the entry `cancelled`. */
  lifecycle: BookingLifecycle
  guestName: string | null
  guestAddress: GuestAddress | null
  /** `YYYY-MM-DD`, property-local. */
  checkIn: string
  checkOut: string | null
  /** `HH:MM`, recorded when the guest actually arrived. Not the stated hour. */
  arrivedAt: string | null
  departedAt: string | null
  guestCount: number
  financialDocumentRef: string | null
  financialDocumentId: string | null
  notes: string | null
}

/**
 * Where the booking is, reduced to the four things the register cares about.
 *
 * Not `BookingStatus`. The booking state machine has fifteen members and the
 * register distinguishes four; mapping is the caller's job, at the edge, where
 * the booking vocabulary is already in scope. Restating fifteen members here
 * would make this module a second reader of a vocabulary it does not own.
 */
export const BOOKING_LIFECYCLES = [
  'unconfirmed',
  'confirmed',
  'in_house',
  'departed',
  'cancelled',
] as const

export type BookingLifecycle = (typeof BOOKING_LIFECYCLES)[number]

const STATUS_FOR: Record<BookingLifecycle, GuestBookEntryStatus | null> = {
  // No entry at all: nothing is committed, so nobody stayed anywhere.
  unconfirmed: null,
  confirmed: 'expected',
  in_house: 'arrived',
  departed: 'departed',
  cancelled: 'cancelled',
}

// ── The outcome ───────────────────────────────────────────────────────────

/**
 * What the lifecycle event did to the register.
 *
 * `skipped` carries a Hebrew reason because it is shown: an operator asking
 * "why is this stay not in my register" deserves the actual answer — the
 * capability is off, this property is excluded, the booking was never
 * confirmed — rather than an absence.
 */
export type GuestBookOutcome =
  | { outcome: 'skipped'; reason: string }
  | {
      outcome: 'created' | 'updated' | 'unchanged'
      entry: GuestBookEntry
      /** Required fields the entry still has no value for. Reported, never fatal. */
      missingFields: readonly GuestBookField[]
    }

/** The fields that changed between two entries, for the audit summary. */
export function changedFields(
  before: GuestBookEntry,
  after: GuestBookEntry,
): readonly string[] {
  const keys = Object.keys(after) as (keyof GuestBookEntry)[]
  return keys
    .filter((key) => key !== 'updatedAt' && key !== 'version')
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => String(key))
}

// ── Completeness ──────────────────────────────────────────────────────────

/**
 * Which required fields this entry has no value for.
 *
 * `guest_count` counts as missing at zero rather than only at null: a register
 * entry recording that nobody stayed is not a lenient entry either.
 */
export function missingRequiredFields(
  entry: GuestBookEntry,
  config: GuestBookConfig,
): readonly GuestBookField[] {
  return GUEST_BOOK_FIELDS.filter((field) => {
    if (!requiresField(config, field)) return false
    return !hasValue(entry, field)
  })
}

function hasValue(entry: GuestBookEntry, field: GuestBookField): boolean {
  switch (field) {
    case 'booking_reference':
      return entry.bookingReference.trim().length > 0
    case 'property':
      return entry.propertyId.trim().length > 0
    case 'primary_guest_name':
      return (entry.primaryGuestName ?? '').trim().length > 0
    case 'guest_address':
      return (
        entry.guestAddress !== null &&
        entry.guestAddress.line.trim().length > 0 &&
        entry.guestAddress.city.trim().length > 0
      )
    case 'arrival':
      return entry.arrivalDate.trim().length > 0
    case 'departure':
      return (entry.departureDate ?? '').trim().length > 0
    case 'guest_count':
      return entry.guestCount > 0
    case 'financial_document':
      return (entry.financialDocumentRef ?? '').trim().length > 0
    case 'notes':
      return (entry.notes ?? '').trim().length > 0
  }
}

// ── Projection ────────────────────────────────────────────────────────────

/**
 * The entry those booking facts describe, given an existing one or none.
 *
 * Written as a projection rather than a set of mutations, so replaying the
 * whole lifecycle in any order produces the same entry. The one thing it does
 * *not* overwrite is a value the booking no longer carries: a name that was
 * recorded and has since been cleared off the booking stays in the register,
 * because the register records what was true at the stay and a booking edited
 * afterwards does not change who was in the building.
 */
function project(
  facts: BookingFacts,
  existing: GuestBookEntry | null,
  status: GuestBookEntryStatus,
  now: Date,
): GuestBookEntry {
  const base: GuestBookEntry = existing ?? {
    // The id is the caller's: a pure function must not invent one, and a
    // repository that upserts by `booking_id` never needs it to.
    id: '',
    organizationId: facts.organizationId,
    propertyId: facts.propertyId,
    bookingId: facts.bookingId,
    bookingReference: facts.reference,
    primaryGuestName: null,
    guestAddress: null,
    arrivalDate: facts.checkIn,
    arrivalTime: null,
    departureDate: null,
    departureTime: null,
    guestCount: 0,
    financialDocumentRef: null,
    financialDocumentId: null,
    notes: null,
    status,
    createdAt: now,
    updatedAt: now,
    version: 0,
  }

  return {
    ...base,
    bookingReference: facts.reference,
    propertyId: facts.propertyId,
    primaryGuestName: keep(facts.guestName, base.primaryGuestName),
    guestAddress: facts.guestAddress ?? base.guestAddress,
    arrivalDate: facts.checkIn,
    // Only a real arrival writes a time. See the header.
    arrivalTime: facts.arrivedAt ?? base.arrivalTime,
    departureDate: facts.checkOut ?? base.departureDate,
    departureTime: facts.departedAt ?? base.departureTime,
    guestCount: facts.guestCount > 0 ? facts.guestCount : base.guestCount,
    financialDocumentRef: keep(
      facts.financialDocumentRef,
      base.financialDocumentRef,
    ),
    financialDocumentId: facts.financialDocumentId ?? base.financialDocumentId,
    notes: keep(facts.notes, base.notes),
    status,
    updatedAt: now,
  }
}

/** A supplied non-empty value wins; otherwise what was already recorded stays. */
function keep(incoming: string | null, existing: string | null): string | null {
  if (incoming === null) return existing
  const trimmed = incoming.trim()
  return trimmed.length > 0 ? trimmed : existing
}

// ── The one entry point ───────────────────────────────────────────────────

/**
 * Apply booking facts to the register.
 *
 * The capability check comes first and is not optional: `isGuestBookEnabledFor`
 * answers both halves — the organization switch and the property list — and
 * this is the only place a caller has to remember to ask. An entry created for
 * a property the operator excluded is indistinguishable from a legitimate one
 * once it is written.
 */
export function applyBookingFacts(args: {
  facts: BookingFacts
  config: GuestBookConfig
  existing: GuestBookEntry | null
  now: Date
}): GuestBookOutcome {
  const { facts, config, existing, now } = args

  if (!config.enabled) {
    return {
      outcome: 'skipped',
      reason: 'ניהול ספר אורחים אינו פעיל בחשבון הזה.',
    }
  }

  if (!isGuestBookEnabledFor(config, facts.propertyId)) {
    return {
      outcome: 'skipped',
      reason: 'ניהול ספר אורחים אינו פעיל בנכס הזה.',
    }
  }

  const status = STATUS_FOR[facts.lifecycle]
  if (status === null) {
    return {
      outcome: 'skipped',
      reason: 'ההזמנה טרם אושרה, ולכן אין לה רישום בספר האורחים.',
    }
  }

  const entry = project(facts, existing, status, now)
  const missingFields = missingRequiredFields(entry, config)

  if (existing === null) {
    return { outcome: 'created', entry, missingFields }
  }

  const changed = changedFields(existing, entry)
  if (changed.length === 0) {
    return { outcome: 'unchanged', entry: existing, missingFields }
  }

  return {
    outcome: 'updated',
    entry: { ...entry, version: existing.version + 1 },
    missingFields,
  }
}
