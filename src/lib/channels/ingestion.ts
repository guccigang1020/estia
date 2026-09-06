/**
 * A reservation arrives from a channel. What happens to it.
 *
 * ══ IDEMPOTENCY IS THE POINT OF THIS FILE ═══════════════════════════════════
 *
 * OTAs redeliver. A webhook that gets a slow response is sent again; a nightly
 * poll overlaps the webhook that already delivered the same stay; a retry
 * after a deploy replays an hour of events. **The same OTA reservation
 * delivered twice must produce exactly one booking**, and the guarantee cannot
 * be "the handler remembers to look first" — that is the argument
 * `0006_idempotency.sql` makes at length and it is the same argument here.
 *
 * The key is the channel's own reservation id plus the channel code, and
 * nothing else. Not the payload, not the delivery id, not a timestamp: those
 * differ between two deliveries of one reservation, which is precisely the
 * case that must collapse. The database enforces it with a unique index on
 * `(organization_id, ledger_key)`; this file computes the key and decides what
 * a second sighting *means*.
 *
 * ── This file does not write a booking ────────────────────────────────────
 *
 * It produces a `BookingIntent` — the input to the existing `booking.create`
 * operation, with its idempotency key already filled in. The write goes
 * through `defineOperation`, which is where authorization, validation,
 * optimistic locking, the audit sentence and the domain event live. A channel
 * that wrote to `bookings` directly would have skipped all five, and which one
 * it skipped would not be obvious until it mattered.
 *
 * Two idempotency layers, therefore, and they are not redundant: the ledger
 * stops the same reservation being *considered* twice, and the operation's own
 * key stops it being *written* twice even if the ledger read raced.
 *
 * ── Availability is not consulted here, and that is deliberate ────────────
 *
 * A reservation from an OTA is already sold. The guest has a confirmation. If
 * the nights are not free in ESTIA the correct outcome is not "refuse the
 * booking" — the booking exists in the world whatever this system thinks — it
 * is a conflict a person must resolve, which the exclusion constraint on
 * `bookings` will produce at the write and which the operation reports as a
 * conflict. Asking `checkAvailability` here would add a second opinion in
 * front of the one guarantee that actually holds.
 */

import { isIsoDate } from '../booking/dates'
import {
  nightsBetween,
  type Agorot,
  type BookingSource,
} from '../booking/types'
import { fingerprint } from '../service/idempotency'

import {
  BOOKING_SOURCE_FOR_CHANNEL,
  CHANNEL_LABEL,
  type ChannelCode,
  type ChannelReservation,
  type ChannelReservationRecord,
  type ChannelReservationStatus,
} from './types'
import { draftException, type ChannelExceptionDraft } from './exceptions'
import {
  ambiguousMappingException,
  inactiveMappingException,
  listingKey,
  resolveListing,
  unmappedListingException,
  type ListingRef,
  type UnitFact,
} from './mapping'
import type { ListingMapping } from './types'

/* ------------------------------------------------------------------ keys -- */

/**
 * The idempotency key for one OTA reservation.
 *
 * Channel code and reservation id, nothing else. Two channels are perfectly
 * entitled to issue the same reservation number and must not collide; the
 * organization is not in the key because both the ledger's unique index and
 * the operation's idempotency scope already carry it, and putting it here as
 * well would make the key unusable as a stable public reference.
 */
export function reservationLedgerKey(
  channelCode: ChannelCode,
  externalReservationId: string,
): string {
  return `channel:${channelCode}:${externalReservationId}`
}

/**
 * A hash of everything about the stay that ESTIA would act on.
 *
 * The fallback for channels that do not number their revisions. Deliberately
 * *not* a hash of the whole payload: an OTA that stamps a `deliveredAt` or a
 * marketing consent flag into every redelivery would produce a new hash each
 * time, and every redelivery would look like a modification. What is hashed is
 * what a change to would require doing something about.
 */
export function contentFingerprint(reservation: ChannelReservation): string {
  return fingerprint({
    listing: reservation.externalListingId,
    variant: reservation.externalVariantId,
    checkIn: reservation.stay.checkIn,
    checkOut: reservation.stay.checkOut,
    guestName: reservation.guestName,
    guestCount: reservation.guestCount,
    adults: reservation.adults,
    children: reservation.children,
    infants: reservation.infants,
    gross: reservation.grossAgorot,
    currency: reservation.currency,
    status: reservation.status,
  })
}

/* --------------------------------------------------------------- outcomes -- */

/**
 * What `booking.create` is to be called with.
 *
 * Shaped as the operation's own input rather than as a domain booking, so this
 * module never constructs a `BookingDraft` and never has an opinion about
 * `version`, `id` or the price lines the pricing engine produces. It fills the
 * form; the operation is still the thing that submits it.
 */
export interface BookingIntent {
  operation: 'booking.create'
  /** Handed to `OperationRequest.idempotencyKey`. The second layer. */
  idempotencyKey: string
  input: {
    unitId: string
    unitLabel: string
    propertyId: string
    guestName: string
    guestCount: number
    adults?: number
    children?: number
    infants?: number
    checkIn: string
    checkOut: string
    /** From `BOOKING_SOURCE_FOR_CHANNEL`. The frozen enum, never a new value. */
    source: BookingSource
    sourceChannel: string
    status: 'confirmed'
    pricing: { baseNightlyAgorot: Agorot }
    /** The channel's number, per night. Needs `booking.override_price`. */
    agreedNightlyAgorot: Agorot
    specialRequests: string | null
  }
  /** The channel's gross, kept whole for the revenue reconciliation. */
  channelGrossAgorot: Agorot
  channelNetAgorot: Agorot | null
  /**
   * `gross - nightly * nights`, in agorot.
   *
   * Non-zero when the channel's total does not divide evenly across the
   * nights, which is common — a 1,000₪ three-night stay is 333.33₪ a night and
   * one agora has to live somewhere. It is reported rather than absorbed:
   * an owner comparing the ESTIA total to the Booking.com statement should be
   * told about the difference by this system, not discover it themselves.
   */
  roundingAgorot: number
}

/** What the ledger row becomes after this delivery. */
export interface LedgerUpsert {
  organizationId: string
  connectorId: string
  channelCode: ChannelCode
  externalReservationId: string
  ledgerKey: string
  revision: number | null
  contentFingerprint: string
  lastStatus: ChannelReservationStatus
  seenAt: Date
}

export type DuplicateReason =
  /** The channel's revision counter has not moved. */
  | 'same_revision'
  /** No revision counter, and nothing we act on has changed. */
  | 'same_content'

export type IngestionOutcome =
  /** Never seen. Create the booking through the operation. */
  | { kind: 'booking_intent'; intent: BookingIntent; ledger: LedgerUpsert }
  /**
   * Seen, and nothing has changed. The redelivery case. No booking, no
   * exception, no noise — the ledger's `lastSeenAt` moves and that is all.
   */
  | {
      kind: 'duplicate'
      ledgerKey: string
      reason: DuplicateReason
      existing: ChannelReservationRecord
      ledger: LedgerUpsert
    }
  /** Seen, and something changed. Hand to `modification.ts`. */
  | {
      kind: 'modification'
      ledgerKey: string
      existing: ChannelReservationRecord
      reservation: ChannelReservation
      ledger: LedgerUpsert
    }
  /** Seen, and the channel has cancelled it. Hand to `cancellation.ts`. */
  | {
      kind: 'cancellation'
      ledgerKey: string
      existing: ChannelReservationRecord
      reservation: ChannelReservation
      ledger: LedgerUpsert
    }
  /**
   * A person has to look at it. `ledger` is present when the delivery should
   * still be remembered — an unmapped listing that redelivers every four
   * minutes must raise one exception, not four hundred.
   */
  | {
      kind: 'exception'
      exception: ChannelExceptionDraft
      ledger: LedgerUpsert | null
    }

/* ------------------------------------------------------------------ input -- */

/**
 * A booking ESTIA already holds for the same unit and dates.
 *
 * Supplied by the caller so this stays a pure function. Used for one thing:
 * spotting the same stay arriving under a second reservation id, which is what
 * happens when a guest books, the channel times out, and they book again.
 */
export interface ExistingStay {
  bookingId: string
  unitId: string
  checkIn: string
  checkOut: string
  /** The channel reservation it came from, when it came from one. */
  externalReservationId: string | null
  channelCode: ChannelCode | null
}

export interface IngestionInput {
  organizationId: string
  connectorId: string
  reservation: ChannelReservation
  /** Every mapping for this connector. Resolution happens here, not in SQL. */
  mappings: readonly ListingMapping[]
  /** The units this organization can sell. Supplies the label and the check. */
  units: readonly UnitFact[]
  /** The ledger row for this reservation id, or `null` on a first sighting. */
  existing: ChannelReservationRecord | null
  /** Bookings already held for these dates. May be empty; never guessed. */
  sameStay?: readonly ExistingStay[]
  /** The currency this organization trades in. A mismatch is refused. */
  organizationCurrency: string
  now: Date
}

/* ----------------------------------------------------------------- engine -- */

export function ingestReservation(input: IngestionInput): IngestionOutcome {
  const { reservation, organizationId, connectorId, now } = input

  const ledgerKey = reservationLedgerKey(
    reservation.channelCode,
    reservation.externalReservationId,
  )
  const content = contentFingerprint(reservation)

  const ledger: LedgerUpsert = {
    organizationId,
    connectorId,
    channelCode: reservation.channelCode,
    externalReservationId: reservation.externalReservationId,
    ledgerKey,
    revision: reservation.revision,
    contentFingerprint: content,
    lastStatus: reservation.status,
    seenAt: now,
  }

  // 1 ── Redelivery, before anything else.
  //
  //      First because it is the cheapest answer and the most common one, and
  //      because every check below it — mapping, validity, duplicate stay —
  //      would otherwise re-raise the same exception on every redelivery of a
  //      reservation that already failed once.
  if (input.existing) {
    const verdict = compareWithLedger(reservation, content, input.existing)

    if (verdict === 'duplicate') {
      return {
        kind: 'duplicate',
        ledgerKey,
        reason:
          reservation.revision !== null ? 'same_revision' : 'same_content',
        existing: input.existing,
        ledger,
      }
    }

    if (verdict === 'stale') {
      return {
        kind: 'exception',
        ledger: null, // The ledger already holds a newer truth. Do not move it back.
        exception: draftException('stale_webhook', {
          organizationId,
          connectorId,
          channelCode: reservation.channelCode,
          occurredAt: now,
          subject: ledgerKey,
          externalReservationId: reservation.externalReservationId,
          externalListingId: reservation.externalListingId,
          bookingId: input.existing.bookingId,
          detail:
            `הגיע עדכון להזמנה ${reservation.externalReservationId} עם גרסה ` +
            `${reservation.revision} בזמן שכבר קיימת אצלך גרסה ` +
            `${input.existing.revision}. העדכון הישן לא הוחל.`,
        }),
      }
    }

    if (reservation.status === 'cancelled') {
      return {
        kind: 'cancellation',
        ledgerKey,
        existing: input.existing,
        reservation,
        ledger,
      }
    }

    return {
      kind: 'modification',
      ledgerKey,
      existing: input.existing,
      reservation,
      ledger,
    }
  }

  // 2 ── Is it a reservation at all?
  const invalid = validationProblem(reservation, input.organizationCurrency)
  if (invalid) {
    return {
      kind: 'exception',
      ledger,
      exception: draftException('invalid_reservation', {
        organizationId,
        connectorId,
        channelCode: reservation.channelCode,
        occurredAt: now,
        subject: ledgerKey,
        externalReservationId: reservation.externalReservationId,
        externalListingId: reservation.externalListingId,
        detail: invalid,
      }),
    }
  }

  // 3 ── Which unit is this?
  const ref: ListingRef = {
    channelCode: reservation.channelCode,
    externalListingId: reservation.externalListingId,
    externalVariantId: reservation.externalVariantId,
  }
  const resolution = resolveListing(input.mappings, ref)
  const exceptionContext = {
    organizationId,
    connectorId,
    occurredAt: now,
    externalReservationId: reservation.externalReservationId,
  }

  if (resolution.kind === 'unmapped') {
    return {
      kind: 'exception',
      ledger,
      exception: unmappedListingException(ref, exceptionContext),
    }
  }
  if (resolution.kind === 'ambiguous') {
    return {
      kind: 'exception',
      ledger,
      exception: ambiguousMappingException(
        ref,
        resolution.mappings,
        exceptionContext,
      ),
    }
  }
  if (resolution.kind === 'inactive') {
    return {
      kind: 'exception',
      ledger,
      exception: inactiveMappingException(resolution.mapping, exceptionContext),
    }
  }

  const mapping = resolution.mapping
  const unit = input.units.find(
    (candidate) => candidate.unitId === mapping.unitId,
  )

  if (!unit) {
    // The mapping points at a unit this organization no longer has. Refused
    // rather than resolved to the property, because "somewhere in that
    // guesthouse" is not a bed.
    return {
      kind: 'exception',
      ledger,
      exception: draftException('mapping_missing', {
        organizationId,
        connectorId,
        channelCode: reservation.channelCode,
        occurredAt: now,
        subject: listingKey(ref),
        externalReservationId: reservation.externalReservationId,
        externalListingId: reservation.externalListingId,
        propertyId: mapping.propertyId,
        detail:
          'ההתאמה מצביעה על יחידה שכבר אינה קיימת במערכת. ההזמנה לא נוצרה. ' +
          'מפה מחדש את המודעה ליחידה קיימת והרץ שוב.',
      }),
    }
  }

  // 4 ── The same stay, under a second reservation number.
  const twin = (input.sameStay ?? []).find(
    (stay) =>
      stay.unitId === mapping.unitId &&
      stay.checkIn === reservation.stay.checkIn &&
      stay.checkOut === reservation.stay.checkOut &&
      stay.externalReservationId !== reservation.externalReservationId,
  )

  if (twin) {
    return {
      kind: 'exception',
      ledger,
      exception: draftException('duplicate_booking', {
        organizationId,
        connectorId,
        channelCode: reservation.channelCode,
        occurredAt: now,
        subject: `${mapping.unitId}:${reservation.stay.checkIn}:${reservation.stay.checkOut}`,
        externalReservationId: reservation.externalReservationId,
        externalListingId: reservation.externalListingId,
        bookingId: twin.bookingId,
        unitId: mapping.unitId,
        propertyId: mapping.propertyId,
        detail:
          `הזמנה ${reservation.externalReservationId} מ-` +
          `${CHANNEL_LABEL[reservation.channelCode]} מתארת את אותה יחידה ` +
          'ואותם תאריכים של הזמנה שכבר קיימת אצלך. לא נוצרה הזמנה שנייה.',
      }),
    }
  }

  // 5 ── An intent. The write goes through `booking.create`.
  return {
    kind: 'booking_intent',
    ledger,
    intent: buildIntent(reservation, mapping, unit, ledgerKey),
  }
}

/* ------------------------------------------------------------- internals -- */

type LedgerVerdict = 'duplicate' | 'stale' | 'changed'

/**
 * Has anything moved since we last saw this reservation?
 *
 * The revision counter wins where a channel has one, because it is the
 * channel's own statement of ordering and is the only thing that can identify
 * an *out-of-order* delivery — a webhook overtaken by a poll is a real event
 * and applying it would move the booking backwards.
 *
 * Content is the fallback and answers a weaker question: it can say "nothing
 * changed" but never "this is older". A channel with no revision counter
 * therefore gets no `stale` verdict, which is correct — there is no evidence
 * for one.
 */
function compareWithLedger(
  reservation: ChannelReservation,
  content: string,
  existing: ChannelReservationRecord,
): LedgerVerdict {
  if (reservation.revision !== null && existing.revision !== null) {
    if (reservation.revision < existing.revision) return 'stale'
    if (reservation.revision === existing.revision) return 'duplicate'
    return 'changed'
  }

  return content === existing.contentFingerprint ? 'duplicate' : 'changed'
}

/** `null` when the reservation is usable. Hebrew, and specific, when not. */
function validationProblem(
  reservation: ChannelReservation,
  organizationCurrency: string,
): string | null {
  const { checkIn, checkOut } = reservation.stay

  if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) {
    return `הערוץ שלח תאריכים שאינם תקינים (${checkIn} עד ${checkOut}).`
  }
  if (checkOut <= checkIn) {
    return (
      `תאריך העזיבה (${checkOut}) אינו מאוחר מתאריך ההגעה (${checkIn}), ` +
      'ולכן אין כאן לילות למכור.'
    )
  }
  if (!Number.isInteger(reservation.guestCount) || reservation.guestCount < 1) {
    return 'ההזמנה הגיעה ללא מספר אורחים תקין.'
  }
  if (
    !Number.isInteger(reservation.grossAgorot) ||
    reservation.grossAgorot < 0
  ) {
    return 'סכום ההזמנה שהגיע מהערוץ אינו סכום תקין באגורות.'
  }
  if (reservation.currency !== organizationCurrency) {
    // Never converted. A rate this module invented would become the number on
    // an owner's statement, and nothing here is entitled to decide it.
    return (
      `ההזמנה נקובה ב-${reservation.currency} והעסק עובד ב-` +
      `${organizationCurrency}. המערכת אינה ממירה מטבע מיוזמתה.`
    )
  }

  return null
}

function buildIntent(
  reservation: ChannelReservation,
  mapping: ListingMapping,
  unit: UnitFact,
  ledgerKey: string,
): BookingIntent {
  const nights = nightsBetween(reservation.stay)
  const nightly = Math.round(reservation.grossAgorot / nights)
  const rounding = reservation.grossAgorot - nightly * nights

  return {
    operation: 'booking.create',
    idempotencyKey: ledgerKey,
    input: {
      unitId: mapping.unitId,
      unitLabel: unit.name,
      propertyId: mapping.propertyId,
      guestName: reservation.guestName,
      guestCount: reservation.guestCount,
      ...(reservation.adults === null ? {} : { adults: reservation.adults }),
      ...(reservation.children === null
        ? {}
        : { children: reservation.children }),
      ...(reservation.infants === null ? {} : { infants: reservation.infants }),
      checkIn: reservation.stay.checkIn,
      checkOut: reservation.stay.checkOut,
      source: BOOKING_SOURCE_FOR_CHANNEL[reservation.channelCode],
      // The specific channel, always — `other_channel` is where Expedia lands
      // in the frozen booking enum, and this string is the only place the
      // actual name survives.
      sourceChannel: CHANNEL_LABEL[reservation.channelCode],
      // Channel imports arrive already sold. `INITIAL_STATUSES` in
      // `booking/operations.ts` admits `confirmed` for exactly this reason.
      status: 'confirmed',
      pricing: { baseNightlyAgorot: nightly },
      agreedNightlyAgorot: nightly,
      specialRequests: reservation.note,
    },
    channelGrossAgorot: reservation.grossAgorot,
    channelNetAgorot: reservation.netAgorot,
    roundingAgorot: rounding,
  }
}
