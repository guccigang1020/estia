/**
 * EXECUTION CONTEXT — SERVER ONLY. The import's only way to write.
 *
 * ── Nothing here writes to a table ────────────────────────────────────────
 *
 * Every record goes through the domain command that already exists for its
 * entity: a guest through `guest.create`, a booking through `booking.create`, a
 * property through `property.create`. Not "as well as" the ordinary path — the
 * *same* path, so an imported booking passes the same authorization, the same
 * validation, the same optimistic locking, the same audit event and the same
 * occupancy exclusion constraint as one typed at the desk.
 *
 * The alternative is what makes migrations poisonous. A bulk loader that
 * inserts straight into `bookings` produces rows that no rule ever saw: stays
 * that overlap, guests with no audit trail, prices that never passed the
 * pricing engine, and a `version` column that is right by luck. Those rows sit
 * quietly until the day somebody amends one and the whole invariant set is
 * discovered to have been optional all along.
 *
 * ── The events guarantee, enforced by this file's parameter type ──────────
 *
 * `defineImportCommands` takes `Omit<OperationServices, 'events' |
 * 'onEventError'>`. There is no `events` field on the argument, so a caller
 * *cannot* hand these commands a live bus — it is a type error at the call
 * site, not a mistake found later in a customer's message log. The bus is
 * constructed here, is an `EventQuarantine`, has no `subscribe` method, and
 * every event it receives is kept for the report and delivered to nobody.
 *
 * Read `quarantine.ts` before changing any of this. The failure it prevents is
 * eighteen hundred confirmation messages about stays from 2023, sent from the
 * operator's own business, on the first day they trusted us with their history.
 *
 * ── History may be written over the calendar; the future may not ──────────
 *
 * A 2023 stay overlaps nothing that matters and its availability was settled
 * three years ago, so it is created with `overrideAvailability` and a stated
 * reason — which requires the actor to hold `booking.override_availability`,
 * and is recorded in the audit sentence as an override. A stay that is current
 * or still to come is checked against live availability like any other, so an
 * import can never quietly double-book a unit that is about to be occupied.
 *
 * That asymmetry is the whole policy and it is one line to check.
 */

import type { AuditActor } from '../audit/events'
import type { Actor } from '../authz/can'
import { defineBookingOperations } from '../booking/operations'
import type { BookingRepository } from '../booking/repository'
import { defineGuestOperations } from '../guests/operations'
import type { Db } from '../persistence'
import { definePropertyOperations } from '../properties/operations'
import type { OperationServices } from '../service'
import { operationIdempotencyKey } from './idempotency'
import { EventQuarantine } from './quarantine'
import type { ImportRecord } from './types'

/* ------------------------------------------------------------- the port -- */

export type CommandContext = {
  actor: Actor
  auditActor: AuditActor
  correlationId: string
  now: Date
  /** True when the stay ended before today. Decides the availability policy. */
  historic: boolean
}

/** The ESTIA unit a booking row resolved to, settled before the write. */
export type ResolvedUnit = {
  id: string
  propertyId: string | null
}

export type WriteOutcome = {
  id: string
  /** True when the service pipeline replayed a key rather than writing. */
  replayed: boolean
}

/**
 * What `apply.ts` is allowed to do.
 *
 * Deliberately narrow: three creates, and two updates that do not exist yet.
 * `apply.ts` cannot reach a table, a client or an arbitrary operation through
 * this port, so "every write goes through a domain command" is a property of
 * the port's shape rather than a convention in the apply loop.
 */
export type ImportCommands = {
  createProperty(
    record: ImportRecord,
    context: CommandContext,
  ): Promise<WriteOutcome>
  createGuest(
    record: ImportRecord,
    context: CommandContext,
  ): Promise<WriteOutcome>
  /**
   * `unit` is a required argument and not something looked up in here.
   *
   * A booking file names a unit in words; ESTIA needs an id. Resolving that in
   * the write path would mean the dry run and the apply matching names by two
   * different rules, and the failure would be a year of stays attached to the
   * wrong villa. So the resolution happens once, in `conflicts.ts`, is shown to
   * a person on the review screen, and arrives here settled.
   */
  createBooking(
    record: ImportRecord,
    context: CommandContext,
    unit: ResolvedUnit,
  ): Promise<WriteOutcome>
  /**
   * The update path for a record the source has since corrected.
   *
   * Optional because the domain commands do not exist: there is no
   * `guest.update` and no general `booking.update` operation in this build,
   * only `booking.amend_dates` and `booking.change_status`, neither of which
   * covers a re-exported row. Writing the corrections directly would break the
   * one rule this file exists to keep, so `apply.ts` reports such rows as
   * needing a person instead — see `RECORD_OUTCOMES`.
   *
   * When the operations land, wire them here and the apply loop starts using
   * them with no other change.
   */
  updateGuest?: (
    record: ImportRecord,
    estiaId: string,
    context: CommandContext,
  ) => Promise<WriteOutcome>
  updateBooking?: (
    record: ImportRecord,
    estiaId: string,
    context: CommandContext,
  ) => Promise<WriteOutcome>
}

/** The evidence of what was withheld. Handed to the completion report. */
export type ImportCommandBundle = {
  commands: ImportCommands
  quarantine: EventQuarantine
}

/* ------------------------------------------------------------- failures -- */

export class UnsupportedImportEntityError extends Error {
  constructor(entity: string) {
    super(`No domain command exists for import entity '${entity}'`)
    this.name = 'UnsupportedImportEntityError'
  }
}

/* ------------------------------------------------------------- the build -- */

/**
 * Bind the import to the real operations.
 *
 * Note what is *not* in the options: `events`. See the file header — that
 * omission is the guarantee, and widening this type is the one change in this
 * module that would silently reintroduce the failure the whole feature is
 * judged on.
 */
export function defineImportCommands(options: {
  db: Db
  bookings: BookingRepository
  services: Omit<OperationServices, 'events' | 'onEventError'>
}): ImportCommandBundle {
  const quarantine = new EventQuarantine()

  // The one place the pipeline's services are assembled for an import. The
  // spread is deliberately *before* `events`, so an object that somehow carried
  // one could not override the quarantine.
  const services: OperationServices = {
    ...options.services,
    events: quarantine,
    onEventError: () => {
      /* unreachable: the quarantine never throws and never delivers */
    },
  }

  const guests = defineGuestOperations({ db: options.db })
  const properties = definePropertyOperations({ db: options.db })
  const bookings = defineBookingOperations(options.bookings)

  const commands: ImportCommands = {
    async createProperty(record, context) {
      if (record.values.entity !== 'properties') {
        throw new UnsupportedImportEntityError(record.entity)
      }
      const property = record.values.property

      const outcome = await properties.createProperty.run({
        request: {
          input: {
            name: property.name,
            slug: property.slug,
            propertyType: property.propertyType,
            city: property.city,
            description: property.description,
            defaultCheckInTime: property.checkInTime,
            defaultCheckOutTime: property.checkOutTime,
            minNights: property.minNights,
            // The domain stores VAT in basis points and never in whole
            // percent, so 17 becomes 1700 here. Getting this backwards would
            // import every property at 0.17% tax and nobody would notice until
            // an invoice.
            taxRateBps: Math.round(property.taxRatePercent * 100),
          },
          idempotencyKey: operationIdempotencyKey(
            record,
            context.actor.organizationId,
          ),
        },
        context: contextFor(context),
        services,
      })

      return { id: outcome.data.id, replayed: outcome.replayed }
    },

    async createGuest(record, context) {
      if (record.values.entity !== 'guests') {
        throw new UnsupportedImportEntityError(record.entity)
      }
      const guest = record.values.guest

      const outcome = await guests.createGuest.run({
        request: {
          input: {
            fullName: guest.fullName,
            phone: guest.phone,
            email: guest.email,
            language: guest.language,
            nationality: guest.nationality,
            city: guest.city,
            tags: guest.tags,
            notes: guest.notes,
            marketingConsent: guest.marketingConsent,
          },
          idempotencyKey: operationIdempotencyKey(
            record,
            context.actor.organizationId,
          ),
        },
        context: contextFor(context),
        services,
      })

      return { id: outcome.data.id, replayed: outcome.replayed }
    },

    async createBooking(record, context, unit) {
      if (record.values.entity !== 'bookings') {
        throw new UnsupportedImportEntityError(record.entity)
      }
      const booking = record.values.booking

      const outcome = await bookings.createBooking.run({
        request: {
          input: {
            unitId: unit.id,
            unitLabel: booking.unitName,
            propertyId: unit.propertyId ?? undefined,
            guestName: booking.guestName,
            guestCount: booking.guestCount,
            checkIn: booking.checkIn,
            checkOut: booking.checkOut,
            // `other_channel` and not `direct_manual`: these stays were sold
            // somewhere else, and attributing three years of another product's
            // bookings to the ESTIA desk would make every source report wrong
            // from the first day.
            source: 'other_channel',
            sourceChannel: 'ייבוא ממערכת קודמת',
            // Already sold. The booking operation admits `confirmed` as an
            // initial status for exactly this reason — refusing it would mean
            // inventing a payment history for a stay that happened.
            status: 'confirmed',
            pricing: {
              baseNightlyAgorot: nightlyFrom(booking),
            },
            // History only. See the file header: a stay that is current or
            // still to come is checked against live availability like any
            // other, so an import can never quietly double-book a live unit.
            overrideAvailability: context.historic ? true : undefined,
          },
          idempotencyKey: operationIdempotencyKey(
            record,
            context.actor.organizationId,
          ),
        },
        context: {
          ...contextFor(context),
          reason: context.historic
            ? 'ייבוא היסטוריית שהויות ממערכת קודמת'
            : null,
        },
        services,
      })

      return { id: outcome.data.booking.id, replayed: outcome.replayed }
    },
  }

  return { commands, quarantine }
}

function contextFor(context: CommandContext) {
  return {
    actor: context.actor,
    auditActor: context.auditActor,
    correlationId: context.correlationId,
    now: context.now,
  }
}

/**
 * The nightly rate this stay was sold at.
 *
 * Derived from the total rather than taken from a rate card, because a rate
 * card describes today and this stay was sold in 2023. Where the source gave no
 * total the rate is zero, which is honest — a booking with no money on it — and
 * is visible on the report as such rather than being invented from the unit's
 * current price.
 */
function nightlyFrom(booking: {
  checkIn: string
  checkOut: string
  totalAgorot: number | null
}): number {
  if (booking.totalAgorot === null) return 0
  const nights =
    (Date.parse(`${booking.checkOut}T00:00:00Z`) -
      Date.parse(`${booking.checkIn}T00:00:00Z`)) /
    86_400_000
  if (!Number.isFinite(nights) || nights <= 0) return booking.totalAgorot
  return Math.round(booking.totalAgorot / nights)
}
