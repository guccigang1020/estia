'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. Making a quote.
 *
 * ── Two things, and they are deliberately separable ───────────────────────
 *
 * Quoting a stay and holding it are different rights and different acts:
 *
 *   · **pricing** needs `quote.create` and writes nothing. It is `priceStay`
 *     over the unit's stored rates, which is where every number a customer is
 *     told comes from;
 *   · **holding** needs `hold.create` and writes a row that takes the dates off
 *     the market.
 *
 * An agent at the `availability_price` rung may do the first and not the second
 * — that is the whole point of the rung existing between `availability` and
 * `availability_hold` — so this action performs the second only when the caller
 * genuinely holds the right, and reports which of the two happened. Refusing the
 * quote to somebody who cannot hold, or holding silently for somebody who only
 * asked for a price, would each collapse a distinction the ladder was built to
 * make.
 *
 * ── The price is the unit's, never the browser's ──────────────────────────
 *
 * `pricingForUnit`-style reads: the nightly rate, the extra-guest rate, the
 * cleaning fee and the deposit all come off the `units` row inside this
 * function. A rate arriving from a form is a number a customer can change with
 * the developer tools, and the quote it produces is one the business is then
 * asked to honour.
 *
 * ── The hold goes through the operation, never through an insert ──────────
 *
 * `operations.placeHold` is the only path to a `holds` row that carries
 * authorization, the availability check *inside the same transaction that
 * writes*, the agent's concurrency cap, the audit event and idempotency. A
 * `db.from('holds').insert(...)` here would look identical on screen and would
 * skip all five — including the one that stops two sellers holding the same
 * night.
 *
 * The availability answer this returns is therefore a courtesy and not a
 * guarantee, exactly as `checkAvailabilityAction` says of itself: the dates can
 * be taken in the second between the price and the hold, and the hold operation
 * is what turns that into a `ConflictError` rather than a double booking.
 */

import { revalidatePath } from 'next/cache'

import { assertCan, can } from '@/lib/authz/can'
import { inventoryResource } from '@/lib/agents'
import { checkAvailability, type AvailabilityBlocker } from '@/lib/booking'
import type { PriceLine } from '@/lib/booking/types'
import { NotFoundError, toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import {
  asAgorot,
  asBoolean,
  asNumber,
  asString,
  asStringOrNull,
  toRow,
} from '@/lib/persistence'

import { bookingWiring, auditActorFor } from '../../bookings/_lib/wiring'
import { shellContext } from '../../_lib/context'
import { quoteFor } from '../../calendar/_lib/quote'

/* --------------------------------------------------------------- shape -- */

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

export type QuoteRequest = {
  unitId: string
  checkIn: string
  checkOut: string
  guests: number
  /** Take the dates off the market. Ignored without `hold.create`. */
  hold: boolean
  /** Minutes the hold should last. The domain clamps it to the agent's limits. */
  holdMinutes?: number
  /**
   * Generated once per form instance in the browser. A second submission
   * replays the first answer instead of placing a second hold on the same
   * nights — the server half of duplicate-submit protection, and the half a
   * disabled button cannot provide.
   */
  idempotencyKey: string
}

export type QuoteAnswer = {
  unitLabel: string
  nights: number
  lines: readonly PriceLine[]
  totalAgorot: number
  stayTotalAgorot: number
  depositAgorot: number
  taxAgorot: number
  /** VAT already inside the total, or `null` when it is its own line. */
  taxIncludedAgorot: number | null
  /** Free/busy as of a moment ago. Not a promise; see the header. */
  available: boolean
  blockers: readonly AvailabilityBlocker[]
  /** Whether the party physically fits, which availability does not answer. */
  fits: boolean
  /** The hold that was placed, or `null` because none was asked for or allowed. */
  holdId: string | null
  holdExpiresAt: string | null
  /** True when a hold was wanted and this caller may not place one. */
  holdRefused: boolean
}

/* ---------------------------------------------------------------- gate -- */

async function requireReady() {
  const context = await shellContext()

  if (!context) {
    return {
      ok: false as const,
      error: {
        code: 'unauthenticated',
        message: 'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
        dataMessage: 'שום דבר לא נשמר.',
        retryMessage: 'ניסיון חוזר לא יעזור עד שתתחבר מחדש.',
        dataOutcome: 'not_saved' as const,
        retryable: false,
        correlationId: crypto.randomUUID(),
      },
    }
  }

  if (context.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: 'membership_not_active',
        message: 'אין לך מרחב עבודה פעיל, ולכן לא ניתן להוציא הצעת מחיר.',
        dataMessage: 'שום דבר לא נשמר.',
        retryMessage: 'ניסיון חוזר לא יעזור עד שהחברות בארגון תופעל.',
        dataOutcome: 'not_saved' as const,
        retryable: false,
        correlationId: crypto.randomUUID(),
      },
    }
  }

  return { ok: true as const, context }
}

/* -------------------------------------------------------------- create -- */

export async function createQuoteAction(
  input: QuoteRequest,
): Promise<ActionResult<QuoteAnswer>> {
  const gate = await requireReady()
  if (!gate.ok) return gate

  const { context } = gate
  const { actor } = context
  const correlationId = crypto.randomUUID()

  try {
    const { db, repository, operations, services } = await bookingWiring()

    // The unit, read before any authorization question that needs its property.
    // `units_select` narrows by `unit_in_scope()` on its own terms, so a unit
    // outside this person's reach comes back as no row at all.
    const unit = await loadUnit(db, actor.organizationId, input.unitId)

    // The independent refusal, against the *inventory* family — an external
    // seller's default scope is `own_records` and a unit belongs to nobody in
    // particular, so asking without the family would refuse every agent.
    // `inventoryResource` is the product's one builder for this; a second one
    // here would be a second chance to forget the family.
    assertCan(
      actor,
      'quote.create',
      inventoryResource({
        organizationId: actor.organizationId,
        propertyId: unit.propertyId,
        unitId: unit.id,
      }),
    )

    const range = { checkIn: input.checkIn, checkOut: input.checkOut }

    const quote = quoteFor(
      {
        id: unit.id,
        code: unit.code,
        name: unit.name,
        status: unit.status,
        propertyId: unit.propertyId,
        propertyName: '',
        maxGuests: unit.maxGuests,
        standardGuests: unit.standardGuests,
        minNights: unit.minNights,
        basePriceAgorot: unit.basePriceAgorot,
        extraGuestPriceAgorot: unit.extraGuestPriceAgorot,
        cleaningFeeAgorot: unit.cleaningFeeAgorot,
        depositAgorot: unit.depositAgorot,
        taxRateBps: unit.taxRateBps,
        taxIncludedInPrice: unit.taxIncludedInPrice,
        detailed: false,
      },
      range,
      input.guests,
    )

    if (quote === null) {
      // `base_price_agorot = 0` is the column default and means the unit has
      // never been priced. Rendering ₪0 would look like a free stay, so the
      // domain refuses and so does this.
      throw new NotFoundError('unit_price', unit.id, {
        userMessage:
          'ליחידה הזו עוד לא הוגדר מחיר, ולכן אי אפשר להוציא עליה הצעה. הגדר תעריף ליחידה ונסה שוב.',
      })
    }

    const availability = await checkAvailability(
      repository,
      {
        organizationId: actor.organizationId,
        unitId: unit.id,
        range,
      },
      { now: new Date() },
    )

    // The hold, and only when the right is genuinely held. `can()` rather than
    // `assertCan()`: wanting a hold and not being allowed one is not a failed
    // quote, it is a quote without a hold, and the answer says which.
    const mayHold = can(
      actor,
      'hold.create',
      inventoryResource({
        organizationId: actor.organizationId,
        propertyId: unit.propertyId,
        unitId: unit.id,
      }),
    )

    let holdId: string | null = null
    let holdExpiresAt: string | null = null

    if (input.hold && mayHold && availability.available) {
      const outcome = await operations.placeHold.run({
        request: {
          input: {
            unitId: unit.id,
            unitLabel: `${unit.code} · ${unit.name}`,
            propertyId: unit.propertyId,
            checkIn: input.checkIn,
            checkOut: input.checkOut,
            // The reason the enum already has for exactly this. A quote's hold
            // is not a staff block and not a guest checkout, and calling it one
            // would make every report about agent activity wrong.
            reason: 'agent_quote',
            ...(input.holdMinutes ? { minutes: input.holdMinutes } : {}),
          },
          idempotencyKey: input.idempotencyKey,
        },
        context: {
          actor,
          auditActor: auditActorFor(context.user),
          correlationId,
        },
        services,
      })

      holdId = outcome.data.hold.id
      holdExpiresAt = outcome.data.hold.expiresAt
      revalidatePath('/quotes')
    }

    return {
      ok: true,
      data: {
        unitLabel: `${unit.code} · ${unit.name}`,
        nights: quote.nights,
        lines: quote.lines,
        totalAgorot: quote.totalAgorot,
        stayTotalAgorot: quote.stayTotalAgorot,
        depositAgorot: quote.depositAgorot,
        taxAgorot: quote.taxAgorot,
        taxIncludedAgorot: quote.taxIncludedAgorot,
        available: availability.available,
        blockers: availability.blockers,
        fits: input.guests <= unit.maxGuests,
        holdId,
        holdExpiresAt,
        holdRefused: input.hold && !mayHold,
      },
    }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* --------------------------------------------------------------- pieces -- */

type QuotableUnit = {
  id: string
  code: string
  name: string
  status: string
  propertyId: string
  maxGuests: number
  standardGuests: number
  minNights: number
  basePriceAgorot: number
  extraGuestPriceAgorot: number
  cleaningFeeAgorot: number
  depositAgorot: number
  taxRateBps: number
  taxIncludedInPrice: boolean
}

/**
 * The unit and its property's tax settings.
 *
 * `properties!inner` because a unit whose property is unreadable is a unit this
 * person has no business quoting: the property carries `tax_rate_bps` and
 * `tax_included_in_price`, and guessing either produces a price that is wrong by
 * the VAT — which is the number a customer is told.
 */
async function loadUnit(
  db: Awaited<ReturnType<typeof bookingWiring>>['db'],
  organizationId: string,
  unitId: string,
): Promise<QuotableUnit> {
  const { data, error } = await db
    .from('units')
    .select(
      'id, code, name, status, property_id, max_guests, standard_guests, ' +
        'min_nights, base_price_agorot, extra_guest_price_agorot, ' +
        'cleaning_fee_agorot, deposit_agorot, ' +
        'properties!inner(id, name, tax_rate_bps, tax_included_in_price)',
    )
    .eq('organization_id', organizationId)
    .eq('id', unitId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw error
  if (!data) {
    // The same wording `createBookingAction` uses. To somebody outside the
    // reach, the unit does not exist — saying "you are not allowed to see it"
    // would confirm that it is on this business's books.
    throw new NotFoundError('unit', unitId, {
      userMessage:
        'היחידה שנבחרה לא נמצאה או שאינה בטווח שלך. רענן את הדף ובחר יחידה שוב.',
    })
  }

  const row = toRow(data)
  const embedded = row.properties
  const property = toRow(Array.isArray(embedded) ? embedded[0] : embedded)

  return {
    id: asString(row, 'id'),
    code: asString(row, 'code'),
    name: asStringOrNull(row, 'name') ?? asString(row, 'code'),
    status: asString(row, 'status'),
    propertyId: asString(row, 'property_id'),
    maxGuests: asNumber(row, 'max_guests'),
    standardGuests: asNumber(row, 'standard_guests'),
    minNights: asNumber(row, 'min_nights'),
    basePriceAgorot: asAgorot(row, 'base_price_agorot'),
    extraGuestPriceAgorot: asAgorot(row, 'extra_guest_price_agorot'),
    cleaningFeeAgorot: asAgorot(row, 'cleaning_fee_agorot'),
    depositAgorot: asAgorot(row, 'deposit_agorot'),
    taxRateBps: asNumber(property, 'tax_rate_bps'),
    taxIncludedInPrice: asBoolean(property, 'tax_included_in_price'),
  }
}
