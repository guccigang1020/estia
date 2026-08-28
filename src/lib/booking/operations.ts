/**
 * The booking operations.
 *
 * Six things a person can actually do — create a booking, move it through the
 * workflow, change its dates, cancel it, hold dates, give them back — each
 * declared with `defineOperation` so that none of them can reach a write
 * without having passed authorization, validation, the version check, the
 * domain rule and the audit trail. There is no second path to a booking row.
 *
 * Three habits are worth naming, because they are easy to get wrong here:
 *
 * **Nothing is stashed between steps.** The definition object is shared by
 * every concurrent run of the operation, so a value computed in `rule` and read
 * in `execute` would be one request's answer used for another's. Pure things —
 * the transition, the quote — are recomputed where they are needed instead. The
 * cost is a few microseconds; the alternative is a booking priced for whoever
 * happened to be a millisecond ahead.
 *
 * **Scope is asserted by hand where there is nothing to load.** The pipeline
 * checks tenant and scope against the *loaded* resource, which a create
 * operation does not have. So `booking.create` and `hold.create` call
 * `assertCan` again with the resource described by their own input, before they
 * read anything. Without it, a manager scoped to one property could write a
 * booking against another.
 *
 * **A lost race is a conflict, a bad request is a rule.** Dates taken by a
 * booking or a live hold produce a `ConflictError` — someone else got there
 * first, and the answer may be different in a second. A stay under the minimum
 * or on a blocked date produces a `BusinessRuleError` — the request itself is
 * wrong and retrying it unchanged will fail identically. The interface needs
 * that distinction to know whether to offer "try again" or "choose other
 * dates".
 */

import { assertCan, type Actor, type Resource } from '../authz/can'
import { BusinessRuleError, ConflictError, ValidationError } from '../errors'
import { formatAgorot } from '../plans/plan'
import { defineOperation, s } from '../service'
import {
  checkAvailability,
  isOccupying,
  type AvailabilityResult,
} from './availability'
import { describeDateChange, formatRange, isIsoDate } from './dates'
import {
  HOLD_REASON_LABEL,
  assertHoldCovers,
  assertHoldIsLive,
  convertHold,
  countLiveHoldsBy,
  holdPolicyFor,
  planHold,
  releaseHold,
} from './holds'
import { priceStay, type StayPricingRequest } from './pricing'
import type { BookingRepository } from './repository'
import {
  BOOKING_STATUS_LABEL,
  assertTransition,
  bookingResource,
  type BookingSnapshot,
} from './state-machine'
import {
  BOOKING_SOURCES,
  BOOKING_STATUSES,
  HOLD_REASONS,
  type BookingAttribution,
  type BookingStatus,
  type DateRange,
  type Hold,
} from './types'

// ── Shared input pieces ───────────────────────────────────────────────────

/**
 * A calendar date, refused unless it is one.
 *
 * The pattern catches the shape and the refinement catches `2026-02-30`, which
 * matches the pattern perfectly and is not a day.
 */
function isoDate(label: string) {
  return s.refine(
    s.string({
      label,
      pattern: /^\d{4}-\d{2}-\d{2}$/,
      patternMessage: 'תאריך חייב להיות בפורמט YYYY-MM-DD.',
    }),
    isIsoDate,
    { code: 'invalid_date', message: 'התאריך אינו קיים בלוח השנה.' },
  )
}

const pricingInput = s.object({
  baseNightlyAgorot: s.agorot({ label: 'מחיר ללילה' }),
  cleaningFeeAgorot: s.optional(s.agorot({ label: 'דמי ניקיון' })),
  includedGuests: s.optional(
    s.number({ integer: true, min: 1, label: 'אורחים כלולים במחיר' }),
  ),
  extraGuestNightlyAgorot: s.optional(
    s.agorot({ label: 'תוספת לאורח נוסף ללילה' }),
  ),
  taxRatePercent: s.optional(s.number({ min: 0, max: 100, label: 'מע״מ' })),
  depositAgorot: s.optional(s.agorot({ label: 'פיקדון ביטחון' })),
  discountPercent: s.optional(
    s.number({ min: 0, max: 100, label: 'הנחה באחוזים' }),
  ),
  discountLabel: s.optional(s.string({ max: 80, label: 'תיאור ההנחה' })),
  addons: s.optional(
    s.arrayOf(
      s.object({
        code: s.string({ max: 40 }),
        label: s.string({ max: 80 }),
        unitPriceAgorot: s.agorot(),
        quantity: s.number({ integer: true, min: 1, max: 99 }),
      }),
      { max: 20, label: 'תוספות' },
    ),
  ),
})

/** What the operations accept as a price. Mirrors `pricingInput`. */
export interface PricingInput {
  baseNightlyAgorot: number
  cleaningFeeAgorot?: number
  includedGuests?: number
  extraGuestNightlyAgorot?: number
  taxRatePercent?: number
  depositAgorot?: number
  discountPercent?: number
  discountLabel?: string
  addons?: readonly {
    code: string
    label: string
    unitPriceAgorot: number
    quantity: number
  }[]
}

/**
 * Turn the request's price fields into a pricing request.
 *
 * The manual discount arrives as its own field rather than inside `discounts`
 * because it is the one a permission guards. Keeping it separate means the
 * check cannot be defeated by hiding an override among ordinary promotions.
 */
function toPricingRequest(
  range: DateRange,
  guests: number,
  input: PricingInput,
  manualDiscountAgorot?: number,
): StayPricingRequest {
  const discounts: NonNullable<StayPricingRequest['discounts']>[number][] = []

  if (input.discountPercent !== undefined && input.discountPercent > 0) {
    discounts.push({
      label: input.discountLabel ?? `הנחה ${input.discountPercent}%`,
      kind: 'percent',
      value: input.discountPercent,
      lineKind: 'promotion',
    })
  }
  if (manualDiscountAgorot !== undefined && manualDiscountAgorot > 0) {
    discounts.push({
      label: 'הנחה שאושרה ידנית',
      kind: 'fixed',
      value: manualDiscountAgorot,
    })
  }

  return {
    range,
    guests,
    baseNightlyAgorot: input.baseNightlyAgorot,
    includedGuests: input.includedGuests,
    extraGuestNightlyAgorot: input.extraGuestNightlyAgorot,
    cleaningFeeAgorot: input.cleaningFeeAgorot,
    addons: input.addons,
    discounts,
    taxRatePercent: input.taxRatePercent,
    depositAgorot: input.depositAgorot,
  }
}

/** The statuses a booking may be born in. Everything else is a transition. */
const INITIAL_STATUSES = [
  'inquiry',
  'quote',
  'option',
  'awaiting_payment',
  // Channel imports arrive already sold. Refusing them would mean inventing a
  // fake payment history for a booking Airbnb has already confirmed.
  'confirmed',
] as const

// ── Shared guards ─────────────────────────────────────────────────────────

/**
 * Turn an unavailable answer into the right kind of failure.
 *
 * `ConflictError` is what the domain asks for when dates collide, and it is the
 * right class — someone else took them — even though its stable code reads
 * `version_conflict`, which is the taxonomy's name for optimistic locking. The
 * Hebrew `userMessage` is what a person sees, and it says what actually
 * happened. Worth a `resource_conflict` code in `errors/` if a third caller
 * ever wants this distinction machine-readable.
 */
function assertAvailable(
  result: AvailabilityResult,
  range: DateRange,
  resourceType: string,
): void {
  if (result.available) return

  const explanation = result.blockers
    .map((blocker) => blocker.message)
    .join(' ')
  const lostARace = result.blockers.some(
    (blocker) => blocker.kind === 'booking' || blocker.kind === 'hold',
  )

  if (lostARace) {
    throw new ConflictError({
      resourceType,
      userMessage: `התאריכים ${formatRange(range)} אינם פנויים. ${explanation}`,
    })
  }

  throw new BusinessRuleError({
    code: 'booking.dates_unavailable',
    message: `Dates unavailable: ${result.blockers
      .map((blocker) => blocker.kind)
      .join(', ')}`,
    userMessage: explanation,
    publicDetails: { blockers: result.blockers.map((blocker) => blocker.kind) },
  })
}

function requireReason(
  reason: string | null | undefined,
  message: string,
): void {
  if (reason !== null && reason !== undefined && reason.trim().length > 0) {
    return
  }
  throw new ValidationError([
    { field: 'reason', code: 'required', message, label: 'סיבה' },
  ])
}

function targetResource(
  actor: Actor,
  unitId: string,
  propertyId?: string,
): Resource {
  const resource: Resource = { organizationId: actor.organizationId, unitId }
  if (propertyId !== undefined) resource.propertyId = propertyId
  return resource
}

function attributionFrom(input: {
  source: BookingAttribution['source']
  sourceChannel?: string | null
  agentUserId?: string | null
  agencyId?: string | null
  campaignId?: string | null
  referralId?: string | null
}): BookingAttribution {
  return {
    source: input.source,
    sourceChannel: input.sourceChannel ?? null,
    agentUserId: input.agentUserId ?? null,
    agencyId: input.agencyId ?? null,
    campaignId: input.campaignId ?? null,
    referralId: input.referralId ?? null,
  }
}

function rangeOf(booking: BookingSnapshot): DateRange {
  return { checkIn: booking.checkIn, checkOut: booking.checkOut }
}

// ── The factory ───────────────────────────────────────────────────────────

/**
 * Build the operations against a repository.
 *
 * A factory rather than six module-level constants, because the repository is
 * the thing that varies: Supabase in the application, an in-memory double in
 * the tests, and one day a read replica for a channel importer. The operations
 * themselves are identical in all three.
 */
export function defineBookingOperations(repo: BookingRepository) {
  /**
   * How many holds this person is holding *right now*.
   *
   * Counted in the domain over everything the store returns, rather than in
   * SQL: a `WHERE expires_at > now()` in the query and `isHoldLive` here would
   * be two definitions of the same word, and the day they disagree an agent is
   * locked out by holds that expired last week.
   */
  async function liveHoldCount(actor: Actor, now: Date): Promise<number> {
    const holds = await repo.loadHoldsByUser(actor.organizationId, actor.userId)
    return countLiveHoldsBy(holds, actor.userId, now)
  }

  // ── booking.create ──────────────────────────────────────────────────────

  const createBooking = defineOperation({
    name: 'booking.create',
    permission: 'booking.create',
    resourceType: 'booking',
    input: s.object({
      unitId: s.string({ label: 'יחידה' }),
      unitLabel: s.string({ max: 120, label: 'שם היחידה' }),
      propertyId: s.optional(s.string()),
      guestName: s.string({ min: 2, max: 120, label: 'שם האורח' }),
      guestCount: s.number({
        integer: true,
        min: 1,
        max: 50,
        label: 'מספר אורחים',
      }),
      checkIn: isoDate('תאריך הגעה'),
      checkOut: isoDate('תאריך עזיבה'),
      source: s.enumOf(BOOKING_SOURCES, { label: 'מקור ההזמנה' }),
      sourceChannel: s.optional(s.nullable(s.string({ max: 80 }))),
      agentUserId: s.optional(s.nullable(s.string())),
      agencyId: s.optional(s.nullable(s.string())),
      campaignId: s.optional(s.nullable(s.string())),
      referralId: s.optional(s.nullable(s.string())),
      status: s.optional(s.enumOf(INITIAL_STATUSES, { label: 'סטטוס' })),
      pricing: pricingInput,
      manualDiscountAgorot: s.optional(s.agorot({ label: 'הנחה ידנית' })),
      overrideAvailability: s.optional(s.boolean({ label: 'עקיפת זמינות' })),
      fromHoldId: s.optional(s.string()),
    }),

    async rule({ input, context, now }) {
      const { actor } = context
      const target = targetResource(actor, input.unitId, input.propertyId)

      // The pipeline could not check scope — there was no resource to load.
      // This is that check, before a single row is read.
      assertCan(actor, 'booking.create', target)

      if (
        input.manualDiscountAgorot !== undefined &&
        input.manualDiscountAgorot > 0
      ) {
        assertCan(actor, 'booking.override_price', target)
        requireReason(
          context.reason,
          'הנחה ידנית דורשת נימוק. הסבר בקצרה מדוע היא ניתנת.',
        )
      }

      const range: DateRange = {
        checkIn: input.checkIn,
        checkOut: input.checkOut,
      }
      const status: BookingStatus = input.status ?? 'inquiry'

      // An enquiry does not occupy the calendar, so it is legitimate for dates
      // that are already sold — that is precisely when a business wants to
      // record the lead and offer something else.
      if (!isOccupying(status)) return

      const hold =
        input.fromHoldId === undefined
          ? null
          : await loadHoldForConversion(repo, actor, input.fromHoldId, {
              unitId: input.unitId,
              range,
              now,
            })

      if (input.overrideAvailability === true) {
        assertCan(actor, 'booking.override_availability', target)
        requireReason(
          context.reason,
          'עקיפת זמינות דורשת נימוק. הסבר בקצרה מדוע ההזמנה נרשמת בכל זאת.',
        )
        return
      }

      const availability = await checkAvailability(
        repo,
        { organizationId: actor.organizationId, unitId: input.unitId, range },
        { now, ignoreHoldId: hold?.id ?? null },
      )
      assertAvailable(availability, range, 'booking')
    },

    async execute({ input, context, now, tx }) {
      const { actor } = context
      const range: DateRange = {
        checkIn: input.checkIn,
        checkOut: input.checkOut,
      }
      const quote = priceStay(
        toPricingRequest(
          range,
          input.guestCount,
          input.pricing,
          input.manualDiscountAgorot,
        ),
      )

      const booking = await repo.insertBooking(
        {
          organizationId: actor.organizationId,
          propertyId: input.propertyId ?? null,
          unitId: input.unitId,
          guestName: input.guestName,
          guestCount: input.guestCount,
          checkIn: range.checkIn,
          checkOut: range.checkOut,
          status: input.status ?? 'inquiry',
          attribution: attributionFrom(input),
          lines: quote.lines,
          totalAgorot: quote.totalAgorot,
          depositRequiredAgorot: quote.depositAgorot,
          createdByUserId: actor.userId,
        },
        tx,
      )

      // The hold stops blocking here, inside the same transaction as the
      // booking it produced. A hold left live would overlap its own booking
      // and the database would reject the very thing it was protecting.
      let hold: Hold | null = null
      if (input.fromHoldId !== undefined) {
        const existing = await repo.loadHold(
          actor.organizationId,
          input.fromHoldId,
        )
        if (existing) {
          hold = await repo.saveHold(convertHold(existing, booking.id, now), tx)
        }
      }

      return { booking, quote, hold }
    },

    audit({ input, result, context }) {
      const range: DateRange = {
        checkIn: input.checkIn,
        checkOut: input.checkOut,
      }
      const override =
        input.overrideAvailability === true ? ' (בעקיפת זמינות)' : ''

      return {
        resourceId: result.booking.id,
        propertyId: result.booking.propertyId,
        after: {
          status: result.booking.status,
          checkIn: result.booking.checkIn,
          checkOut: result.booking.checkOut,
          guestName: result.booking.guestName,
          totalAgorot: result.booking.totalAgorot,
          source: input.source,
        },
        summary:
          `${context.auditActor.label} יצרה את הזמנה ${result.booking.reference} ` +
          `עבור ${input.guestName} ביחידה ${input.unitLabel} ` +
          `לתאריכים ${formatRange(range)} (${result.quote.nights} לילות) ` +
          `בסך ${formatAgorot(result.quote.totalAgorot)}${override}`,
      }
    },

    events({ result }) {
      return [
        {
          name: 'booking.created',
          propertyId: result.booking.propertyId,
          payload: {
            bookingId: result.booking.id,
            unitId: result.booking.unitId,
            status: result.booking.status,
            checkIn: result.booking.checkIn,
            checkOut: result.booking.checkOut,
            totalAgorot: result.booking.totalAgorot,
            convertedHoldId: result.hold === null ? null : result.hold.id,
          },
        },
      ]
    },
  })

  // ── booking.change_status ───────────────────────────────────────────────

  const changeBookingStatus = defineOperation({
    name: 'booking.change_status',
    permission: 'booking.change_status',
    resourceType: 'booking',
    requiresVersion: true,
    input: s.object({ to: s.enumOf(BOOKING_STATUSES, { label: 'סטטוס' }) }),

    async loadResource({ request, context }) {
      const booking = await repo.loadBooking(
        context.actor.organizationId,
        request.resourceId ?? '',
      )
      if (!booking) return null
      return {
        resource: bookingResource(booking),
        entity: booking,
        version: booking.version,
      }
    },

    async rule({ entity, input, context, now }) {
      // Cancellation is refused here on purpose. It has its own operation
      // because it demands a stated reason, and letting it through the generic
      // door would be a way to cancel a stay without ever saying why.
      if (input.to === 'cancelled') {
        throw new BusinessRuleError({
          code: 'booking.use_cancel_operation',
          message: 'Cancellation must go through booking.cancel',
          userMessage: 'ביטול הזמנה מתבצע בפעולת הביטול, שדורשת ציון סיבה.',
        })
      }

      // The state machine holds the law, including the permission this
      // particular move needs — `deposit.release` is not `booking.change_status`
      // and holding the second must not grant the first.
      const transition = assertTransition(context.actor, input.to, {
        booking: entity,
        now,
      })

      if (transition.requiresReason) {
        requireReason(
          context.reason,
          `המעבר למצב "${BOOKING_STATUS_LABEL[input.to]}" דורש נימוק.`,
        )
      }
    },

    async execute({ entity, input, context, now, tx }) {
      // Recomputed rather than carried from `rule` — see the file header.
      const transition = assertTransition(context.actor, input.to, {
        booking: entity,
        now,
      })

      const booking = await repo.updateBooking({
        bookingId: entity.id,
        patch: { status: input.to },
        expectedVersion: entity.version,
        tx,
      })

      return { booking, transition }
    },

    audit({ entity, result, context }) {
      return {
        resourceId: result.booking.id,
        propertyId: result.booking.propertyId,
        action: result.transition.auditAction,
        before: { status: entity.status },
        after: { status: result.booking.status },
        summary:
          `${context.auditActor.label} שינתה את סטטוס הזמנה ${entity.reference} ` +
          `מ"${BOOKING_STATUS_LABEL[entity.status]}" ` +
          `ל"${BOOKING_STATUS_LABEL[result.booking.status]}"`,
      }
    },

    events({ entity, result }) {
      return [
        {
          name: result.transition.event,
          propertyId: result.booking.propertyId,
          payload: {
            bookingId: result.booking.id,
            from: entity.status,
            to: result.booking.status,
            // Carried on the event so a subscriber does not have to re-derive
            // what this transition was supposed to set in motion.
            sideEffects: result.transition.sideEffects,
          },
        },
      ]
    },
  })

  // ── booking.amend_dates ─────────────────────────────────────────────────

  const amendBookingDates = defineOperation({
    name: 'booking.amend_dates',
    permission: 'booking.update',
    resourceType: 'booking',
    requiresVersion: true,
    input: s.object({
      checkIn: isoDate('תאריך הגעה'),
      checkOut: isoDate('תאריך עזיבה'),
      pricing: s.optional(pricingInput),
      overrideAvailability: s.optional(s.boolean({ label: 'עקיפת זמינות' })),
    }),

    async loadResource({ request, context }) {
      const booking = await repo.loadBooking(
        context.actor.organizationId,
        request.resourceId ?? '',
      )
      if (!booking) return null
      return {
        resource: bookingResource(booking),
        entity: booking,
        version: booking.version,
      }
    },

    async rule({ entity, input, context, now }) {
      const range: DateRange = {
        checkIn: input.checkIn,
        checkOut: input.checkOut,
      }

      if (range.checkOut <= range.checkIn) {
        throw new ValidationError([
          {
            field: 'checkOut',
            code: 'invalid_range',
            message: 'תאריך העזיבה חייב להיות מאוחר מתאריך ההגעה.',
            label: 'תאריך עזיבה',
          },
        ])
      }

      assertDatesMayMove(entity, range)

      if (input.pricing !== undefined) {
        assertCan(
          context.actor,
          'booking.override_price',
          bookingResource(entity),
        )
      }

      if (input.overrideAvailability === true) {
        assertCan(
          context.actor,
          'booking.override_availability',
          bookingResource(entity),
        )
        requireReason(
          context.reason,
          'עקיפת זמינות דורשת נימוק. הסבר בקצרה מדוע התאריכים משתנים בכל זאת.',
        )
        return
      }

      // Only an occupying booking competes for the calendar. An enquiry may be
      // moved onto sold dates for the same reason it may be created on them.
      if (!isOccupying(entity.status)) return

      const availability = await checkAvailability(
        repo,
        {
          organizationId: entity.organizationId,
          unitId: entity.unitId,
          range,
        },
        // Ignoring itself. Without this every amendment collides with the
        // booking being amended, and nothing could ever be moved by a day.
        { now, ignoreBookingId: entity.id },
      )
      assertAvailable(availability, range, 'booking')
    },

    async execute({ entity, input, tx }) {
      const range: DateRange = {
        checkIn: input.checkIn,
        checkOut: input.checkOut,
      }
      const quote =
        input.pricing === undefined
          ? null
          : priceStay(toPricingRequest(range, entity.guestCount, input.pricing))

      const booking = await repo.updateBooking({
        bookingId: entity.id,
        patch: {
          checkIn: range.checkIn,
          checkOut: range.checkOut,
          ...(quote === null
            ? {}
            : {
                lines: quote.lines,
                totalAgorot: quote.totalAgorot,
                depositRequiredAgorot: quote.depositAgorot,
              }),
        },
        expectedVersion: entity.version,
        tx,
      })

      return { booking, before: rangeOf(entity), quote }
    },

    audit({ entity, result, context }) {
      // The price is deliberately left alone unless the caller supplied new
      // pricing, and the sentence says which happened — a manager reading this
      // in three months must not have to guess whether the total still matches
      // the nights.
      const money =
        result.quote === null
          ? ' (המחיר לא חושב מחדש)'
          : ` והמחיר חושב מחדש ל-${formatAgorot(result.quote.totalAgorot)}`

      return {
        resourceId: result.booking.id,
        propertyId: result.booking.propertyId,
        before: {
          checkIn: entity.checkIn,
          checkOut: entity.checkOut,
          totalAgorot: entity.totalAgorot,
        },
        after: {
          checkIn: result.booking.checkIn,
          checkOut: result.booking.checkOut,
          totalAgorot: result.booking.totalAgorot,
        },
        summary:
          `${context.auditActor.label} שינתה את תאריכי הזמנה ${entity.reference} ` +
          `${describeDateChange(result.before, rangeOf(result.booking))}${money}`,
      }
    },

    events({ entity, result }) {
      return [
        {
          name: 'booking.dates_changed',
          propertyId: result.booking.propertyId,
          payload: {
            bookingId: result.booking.id,
            from: rangeOf(entity),
            to: rangeOf(result.booking),
          },
        },
      ]
    },
  })

  // ── booking.cancel ──────────────────────────────────────────────────────

  const cancelBooking = defineOperation({
    name: 'booking.cancel',
    permission: 'booking.cancel',
    resourceType: 'booking',
    requiresVersion: true,
    // Not in SENSITIVE_ACTIONS, and demanded anyway: a cancellation with no
    // recorded reason is an argument nobody can settle six months later.
    requiresReason: true,
    input: s.object({
      waiveCancellationFee: s.optional(
        s.boolean({ label: 'ויתור על דמי ביטול' }),
      ),
    }),

    async loadResource({ request, context }) {
      const booking = await repo.loadBooking(
        context.actor.organizationId,
        request.resourceId ?? '',
      )
      if (!booking) return null
      return {
        resource: bookingResource(booking),
        entity: booking,
        version: booking.version,
      }
    },

    async rule({ entity, input, context, now }) {
      assertTransition(context.actor, 'cancelled', { booking: entity, now })

      // Waiving the fee is giving money away, so it is gated by the permission
      // that governs changing a price rather than by the one that cancels.
      if (input.waiveCancellationFee === true) {
        assertCan(
          context.actor,
          'booking.override_price',
          bookingResource(entity),
        )
      }
    },

    async execute({ entity, tx }) {
      const booking = await repo.updateBooking({
        bookingId: entity.id,
        patch: { status: 'cancelled' },
        expectedVersion: entity.version,
        tx,
      })
      return { booking }
    },

    audit({ entity, result, context }) {
      return {
        resourceId: result.booking.id,
        propertyId: result.booking.propertyId,
        action: 'booking.cancelled',
        before: { status: entity.status },
        after: { status: result.booking.status },
        summary:
          `${context.auditActor.label} ביטלה את הזמנה ${entity.reference} ` +
          `של ${entity.guestName} לתאריכים ${formatRange(rangeOf(entity))}`,
      }
    },

    events({ entity, input, result }) {
      return [
        {
          name: 'booking.cancelled',
          propertyId: result.booking.propertyId,
          payload: {
            bookingId: result.booking.id,
            previousStatus: entity.status,
            checkIn: entity.checkIn,
            checkOut: entity.checkOut,
            feeWaived: input.waiveCancellationFee === true,
          },
        },
      ]
    },
  })

  // ── hold.create ─────────────────────────────────────────────────────────

  const placeHold = defineOperation({
    name: 'hold.create',
    permission: 'hold.create',
    resourceType: 'hold',
    input: s.object({
      unitId: s.string({ label: 'יחידה' }),
      unitLabel: s.string({ max: 120, label: 'שם היחידה' }),
      propertyId: s.optional(s.string()),
      checkIn: isoDate('תאריך הגעה'),
      checkOut: isoDate('תאריך עזיבה'),
      reason: s.enumOf(HOLD_REASONS, { label: 'סיבת ההחזקה' }),
      minutes: s.optional(
        s.number({ integer: true, min: 1, max: 43_200, label: 'משך בדקות' }),
      ),
    }),

    async rule({ input, context, now }) {
      const { actor } = context
      assertCan(
        actor,
        'hold.create',
        targetResource(actor, input.unitId, input.propertyId),
      )

      const range: DateRange = {
        checkIn: input.checkIn,
        checkOut: input.checkOut,
      }

      const availability = await checkAvailability(
        repo,
        { organizationId: actor.organizationId, unitId: input.unitId, range },
        {
          now,
          // A maintenance block is the business removing its own inventory. A
          // minimum-stay rule protects revenue from short bookings and has
          // nothing to say about a plumber.
          ignoreMinimumNights: input.reason === 'maintenance_block',
        },
      )
      assertAvailable(availability, range, 'hold')

      // Throws on the concurrency cap and on an over-long duration, before
      // anything is written.
      planHold({
        organizationId: actor.organizationId,
        unitId: input.unitId,
        range,
        reason: input.reason,
        heldByUserId: actor.userId,
        now,
        minutes: input.minutes,
        liveHoldCount: await liveHoldCount(actor, now),
      })
    },

    async execute({ input, context, now, tx }) {
      const { actor } = context
      const draft = planHold({
        organizationId: actor.organizationId,
        unitId: input.unitId,
        range: { checkIn: input.checkIn, checkOut: input.checkOut },
        reason: input.reason,
        heldByUserId: actor.userId,
        now,
        minutes: input.minutes,
        liveHoldCount: await liveHoldCount(actor, now),
      })
      const hold = await repo.insertHold(draft, tx)
      return { hold }
    },

    audit({ input, result, context }) {
      const minutes =
        input.minutes ?? holdPolicyFor(input.reason).defaultMinutes
      const range: DateRange = {
        checkIn: input.checkIn,
        checkOut: input.checkOut,
      }

      return {
        resourceId: result.hold.id,
        propertyId: input.propertyId ?? null,
        after: {
          unitId: input.unitId,
          checkIn: input.checkIn,
          checkOut: input.checkOut,
          reason: input.reason,
          expiresAt: result.hold.expiresAt,
        },
        summary:
          `${context.auditActor.label} תפסה את היחידה ${input.unitLabel} ` +
          `לתאריכים ${formatRange(range)} למשך ${minutes} דקות ` +
          `(${HOLD_REASON_LABEL[input.reason]})`,
      }
    },

    events({ result }) {
      return [
        {
          name: 'hold.created',
          payload: {
            holdId: result.hold.id,
            unitId: result.hold.unitId,
            checkIn: result.hold.checkIn,
            checkOut: result.hold.checkOut,
            expiresAt: result.hold.expiresAt,
          },
        },
      ]
    },
  })

  // ── hold.release ────────────────────────────────────────────────────────

  const releaseHoldOperation = defineOperation({
    name: 'hold.release',
    permission: 'hold.release',
    resourceType: 'hold',
    input: s.nothing,

    async loadResource({ request, context }) {
      const hold = await repo.loadHold(
        context.actor.organizationId,
        request.resourceId ?? '',
      )
      if (!hold) return null
      return {
        resource: { organizationId: hold.organizationId, unitId: hold.unitId },
        entity: hold,
      }
    },

    rule({ entity, now }) {
      // Pure: builds the released hold and throws if it cannot. The result is
      // discarded here and rebuilt in `execute`, so the two steps cannot get
      // out of step with one another.
      releaseHold(entity, now)
    },

    async execute({ entity, now, tx }) {
      const hold = await repo.saveHold(releaseHold(entity, now), tx)
      return { hold }
    },

    audit({ entity, result, context }) {
      return {
        resourceId: result.hold.id,
        before: { releasedAt: null, expiresAt: entity.expiresAt },
        after: { releasedAt: result.hold.releasedAt },
        summary:
          `${context.auditActor.label} שחררה את ההחזקה על יחידה ${entity.unitId} ` +
          `לתאריכים ${formatRange(entity)} (${HOLD_REASON_LABEL[entity.reason]})`,
      }
    },

    events({ result }) {
      return [
        {
          name: 'hold.released',
          payload: {
            holdId: result.hold.id,
            unitId: result.hold.unitId,
            checkIn: result.hold.checkIn,
            checkOut: result.hold.checkOut,
          },
        },
      ]
    },
  })

  return {
    createBooking,
    changeBookingStatus,
    amendBookingDates,
    cancelBooking,
    placeHold,
    releaseHold: releaseHoldOperation,
  }
}

export type BookingOperations = ReturnType<typeof defineBookingOperations>

// ── Helpers used by the operations ────────────────────────────────────────

/**
 * The hold this booking is being made from.
 *
 * Checked three ways, because each one is a different way to take inventory
 * that was never claimed: it must belong to this organization, it must be on
 * this unit, and it must actually cover the dates being booked.
 */
async function loadHoldForConversion(
  repo: BookingRepository,
  actor: Actor,
  holdId: string,
  target: { unitId: string; range: DateRange; now: Date },
): Promise<Hold> {
  const hold = await repo.loadHold(actor.organizationId, holdId)

  if (!hold || hold.organizationId !== actor.organizationId) {
    throw new BusinessRuleError({
      code: 'hold.not_found',
      message: `Hold ${holdId} not found in organization ${actor.organizationId}`,
      userMessage: 'ההחזקה לא נמצאה. בדוק את הזמינות ובצע החזקה חדשה.',
    })
  }

  if (hold.unitId !== target.unitId) {
    throw new BusinessRuleError({
      code: 'hold.wrong_unit',
      message: `Hold ${holdId} is on unit ${hold.unitId}, not ${target.unitId}`,
      userMessage: 'ההחזקה שייכת ליחידה אחרת.',
    })
  }

  assertHoldIsLive(hold, target.now)
  assertHoldCovers(hold, target.range)

  return hold
}

/**
 * May these dates move at all?
 *
 * Three answers, and the middle one is the interesting one. Before arrival,
 * both ends are free to move. While the guest is in the unit, the arrival date
 * is a fact that already happened and only the departure may move, later —
 * which is an extension, the thing guests actually ask for. After check-out the
 * stay is history, and rewriting history is what a credit note is for.
 */
function assertDatesMayMove(booking: BookingSnapshot, range: DateRange): void {
  const inStay: readonly BookingStatus[] = [
    'checked_in',
    'in_house',
    'checkout_pending',
  ]
  const locked: readonly BookingStatus[] = [
    'checked_out',
    'inspection',
    'deposit_release',
    'review_requested',
    'completed',
    'cancelled',
    'no_show',
  ]

  if (locked.includes(booking.status)) {
    throw new BusinessRuleError({
      code: 'booking.dates_locked',
      message: `Dates are not amendable in status ${booking.status}`,
      userMessage:
        'לא ניתן לשנות תאריכים בהזמנה במצב ' +
        `"${BOOKING_STATUS_LABEL[booking.status]}".`,
    })
  }

  if (!inStay.includes(booking.status)) return

  if (range.checkIn !== booking.checkIn) {
    throw new BusinessRuleError({
      code: 'booking.arrival_locked',
      message: 'Arrival date cannot change once the guest has checked in',
      userMessage:
        'האורח כבר ביצע צ׳ק-אין, ולכן לא ניתן לשנות את תאריך ההגעה. אפשר להאריך את השהות.',
    })
  }

  if (range.checkOut <= booking.checkOut) {
    throw new BusinessRuleError({
      code: 'booking.shortening_in_stay',
      message: 'An in-stay booking may only be extended',
      userMessage:
        'בזמן שהות ניתן רק להאריך את התאריכים. לקיצור השהות בצע צ׳ק-אאוט מוקדם.',
    })
  }
}
