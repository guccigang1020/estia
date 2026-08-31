'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. Everything the bookings screens change.
 *
 * ── The rule this file exists to keep ─────────────────────────────────────
 *
 * Not one of these functions writes a row. Each resolves who is asking, checks
 * that they may, and then hands the request to an operation from
 * `defineBookingOperations`, which is the only path to a booking row that has
 * authorization, validation, optimistic locking, the domain rule, the
 * transaction, the audit event and idempotency wired into it in that order. A
 * `db.from('bookings').update(...)` here would look identical on screen and
 * would skip all seven.
 *
 * ── Why `assertCan` is called here as well ────────────────────────────────
 *
 * The pipeline checks the same permission. This check is not redundant, it is
 * the independent one: the screen hides controls the actor cannot use, and
 * hiding a control is not authorization. An action reached by a crafted POST —
 * which is all a Server Action is — must refuse on its own terms, before it
 * has read anything, and it must do so even if the operation it wraps is one
 * day rewired. Deny by default, twice, on purpose.
 *
 * ── What a caller gets back ───────────────────────────────────────────────
 *
 * Never a thrown error. A throw inside a Server Action reaches the browser as
 * a digest and an empty screen, and the user learns nothing. Every failure is
 * turned into the `SafeErrorBody` that `src/lib/errors` already produced —
 * Hebrew sentence, whether the data was saved, whether retrying is safe, and a
 * correlation id that matches the server log. `fromSafeError` in
 * `states/error-copy.ts` renders it verbatim; no second wording is invented on
 * the client.
 */

import { revalidatePath } from 'next/cache'

import { assertCan, can, type Resource } from '@/lib/authz/can'
import {
  BOOKING_STATUSES,
  checkAvailability,
  totalGuests,
  type AvailabilityBlocker,
  type BookingSource,
  type BookingStatus,
} from '@/lib/booking'
import {
  BusinessRuleError,
  NotFoundError,
  toSafeResponse,
  type SafeErrorBody,
} from '@/lib/errors'
import { asAgorot, asNumber, toRow } from '@/lib/persistence'
import type { EventType } from '@/lib/preparation/types'

import { shellContext } from '../../_lib/context'
import { auditActorFor, bookingWiring } from './wiring'

/* --------------------------------------------------------------- shape -- */

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

/**
 * The context every action needs, or the refusal that replaces it.
 *
 * A signed-out or workspace-less caller is refused here rather than allowed to
 * reach an operation with a fabricated actor. `shellContext()` is the same
 * resolution the shell rendered with — React `cache` shares it — so an action
 * cannot disagree with the screen about which organization it is in.
 */
async function requireReady() {
  const context = await shellContext()

  if (!context) {
    return {
      ok: false as const,
      error: {
        code: 'unauthenticated',
        message: 'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
        dataMessage: 'הנתונים לא נשמרו. שום דבר במערכת לא השתנה.',
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
        message: 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לבצע פעולות על הזמנות.',
        dataMessage: 'הנתונים לא נשמרו. שום דבר במערכת לא השתנה.',
        retryMessage: 'ניסיון חוזר לא יעזור עד שהחברות בארגון תופעל.',
        dataOutcome: 'not_saved' as const,
        retryable: false,
        correlationId: crypto.randomUUID(),
      },
    }
  }

  return { ok: true as const, context }
}

/** One place that turns a thrown failure into the three sentences a user is owed. */
function failure(
  cause: unknown,
  correlationId: string,
): {
  ok: false
  error: SafeErrorBody
} {
  const safe = toSafeResponse(cause, correlationId)
  return { ok: false, error: safe.error }
}

/* ---------------------------------------------------------- create --- */

export type CreateBookingInput = {
  unitId: string
  unitLabel: string
  propertyId: string | null
  guestName: string
  /**
   * The party, split the way `public.bookings` has stored it since 0009.
   *
   * There is no `guestCount` here any more. The total is `adults + children +
   * infants` and it is derived below rather than sent, so a browser cannot
   * offer a total that disagrees with its own breakdown — the operation refuses
   * that pair, and a field that can only ever be wrong is a field worth not
   * having.
   */
  adults: number
  children: number
  infants: number
  /** Pairs sharing a bed. Decides double beds against separate ones. */
  couples: number
  extraBedsRequested: number
  cotsRequested: number
  eventType: EventType
  specialRequests: string | null
  checkIn: string
  checkOut: string
  status: BookingStatus
  source: BookingSource
  /**
   * The price the seller agreed for this booking, per night, or null to use the
   * unit's stored rate.
   *
   * Non-null is refused for an actor without `booking.override_price` — twice,
   * here and inside the operation. See the block in `createBookingAction`.
   */
  agreedNightlyAgorot: number | null
  /**
   * Generated once per form instance in the browser. A second submission of
   * the same form replays the first answer instead of creating a second
   * booking — the server half of duplicate-submit protection, and the half a
   * disabled button cannot provide.
   */
  idempotencyKey: string
}

export type CreatedBooking = {
  id: string
  reference: string
  totalAgorot: number
  nights: number
}

const INITIAL_STATUSES: readonly BookingStatus[] = [
  'inquiry',
  'quote',
  'option',
  'awaiting_payment',
  'confirmed',
]

export async function createBookingAction(
  input: CreateBookingInput,
): Promise<ActionResult<CreatedBooking>> {
  const gate = await requireReady()
  if (!gate.ok) return gate

  const { context } = gate
  const correlationId = crypto.randomUUID()

  try {
    const resource: Resource = {
      organizationId: context.actor.organizationId,
      unitId: input.unitId,
      ...(input.propertyId !== null ? { propertyId: input.propertyId } : {}),
    }

    // The independent refusal. Before anything is read, and regardless of what
    // the screen chose to render.
    assertCan(context.actor, 'booking.create', resource)

    if (!INITIAL_STATUSES.includes(input.status)) {
      // Refused here rather than left to the schema, because the message the
      // schema would produce names a field the person never saw.
      throw new Error(`Unsupported initial status: ${input.status}`)
    }

    // ── The agreed price, authorized rather than merely accepted ───────────
    //
    // A villa owner sells at the price they agreed with the guest, and two
    // identical stays going for different amounts is the normal case here
    // rather than an exception. So a price may come from the browser — but
    // only from somebody entitled to set one. This is the independent refusal;
    // `booking.create` asserts the same grant again inside the operation,
    // before it prices anything. An actor without the grant that posts a price
    // anyway is refused here and never reaches the second check.
    //
    // Nothing below treats a low price as suspicious. The unit's stored rate is
    // a default and a suggestion, never a floor.
    if (input.agreedNightlyAgorot !== null) {
      assertCan(context.actor, 'booking.override_price', resource)
    }

    const { operations, services, db } = await bookingWiring()

    // The unit's own price list and its capacity, read from the unit. The rate
    // is the *default*: it is what a booking is priced at unless somebody
    // holding `booking.override_price` names another number, and it is never
    // taken from the browser on its own.
    const unit = await unitTermsFor(
      db,
      context.actor.organizationId,
      input.unitId,
    )

    // Capacity, checked on the server. The form checks the same thing, and a
    // form check is not enforcement — a Server Action is a POST, and a crafted
    // one could otherwise put fifty people into a four-person cabin.
    const guestCount = totalGuests({
      adults: input.adults,
      children: input.children,
      infants: input.infants,
    })
    if (guestCount > unit.maxGuests) {
      throw new BusinessRuleError({
        code: 'booking.over_capacity',
        message: `Party of ${guestCount} exceeds unit capacity ${unit.maxGuests}`,
        userMessage:
          `היחידה מכילה עד ${unit.maxGuests} אורחים, וההזמנה מונה ` +
          `${guestCount}. בחר יחידה גדולה יותר או עדכן את מספר האורחים.`,
      })
    }

    // Assembled key by key rather than spread. `s.object` refuses a field it
    // does not name — `allowUnknown` is off by design — so passing the form's
    // own `idempotencyKey` through as input would fail validation with a
    // message about a field the person never filled in.
    const operationInput = {
      unitId: input.unitId,
      unitLabel: input.unitLabel,
      guestName: input.guestName,
      guestCount,
      adults: input.adults,
      children: input.children,
      infants: input.infants,
      couples: input.couples,
      extraBedsRequested: input.extraBedsRequested,
      cotsRequested: input.cotsRequested,
      eventType: input.eventType,
      specialRequests: input.specialRequests,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      source: input.source,
      status: input.status,
      pricing: unit.pricing,
      ...(input.agreedNightlyAgorot !== null
        ? { agreedNightlyAgorot: input.agreedNightlyAgorot }
        : {}),
      ...(input.propertyId !== null ? { propertyId: input.propertyId } : {}),
    }

    const outcome = await operations.createBooking.run({
      request: { input: operationInput, idempotencyKey: input.idempotencyKey },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services,
    })

    revalidatePath('/bookings')

    return {
      ok: true,
      data: {
        id: outcome.data.booking.id,
        reference: outcome.data.booking.reference,
        totalAgorot: outcome.data.booking.totalAgorot,
        nights: outcome.data.quote.nights,
      },
    }
  } catch (cause) {
    return failure(cause, correlationId)
  }
}

/**
 * The unit's price list and its capacity, as stored.
 *
 * `checkAvailability` and `priceStay` both refuse to invent a number, and so
 * does this: a unit whose row cannot be read produces a failure the caller
 * sees, not a zero that quietly prices a stay at nothing.
 *
 * The rate read here is the *default*. Where a business wants a fixed price,
 * this is that fixed price and nothing further is needed; where a business
 * quotes deal by deal, it is the number the field starts on. Neither shape is
 * forced, and a unit priced at zero is a unit nobody has configured rather than
 * a free stay — which is why the read fails loudly instead of defaulting.
 */
async function unitTermsFor(
  db: Awaited<ReturnType<typeof bookingWiring>>['db'],
  organizationId: string,
  unitId: string,
) {
  const { data, error } = await db
    .from('units')
    .select(
      'base_price_agorot, extra_guest_price_agorot, cleaning_fee_agorot, ' +
        'deposit_agorot, standard_guests, max_guests',
    )
    .eq('organization_id', organizationId)
    .eq('id', unitId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw error
  if (!data) {
    throw new NotFoundError('unit', unitId, {
      userMessage:
        'היחידה שנבחרה לא נמצאה או שאינה בטווח שלך. רענן את הדף ובחר יחידה שוב.',
    })
  }

  // The same mapping helpers every adapter uses. A `numeric` column arrives as
  // a string and a price that has become a float is money that will be wrong a
  // few thousand rows later, so the read is checked rather than cast.
  const row = toRow(data)

  return {
    maxGuests: asNumber(row, 'max_guests'),
    pricing: {
      baseNightlyAgorot: asAgorot(row, 'base_price_agorot'),
      extraGuestNightlyAgorot: asAgorot(row, 'extra_guest_price_agorot'),
      cleaningFeeAgorot: asAgorot(row, 'cleaning_fee_agorot'),
      depositAgorot: asAgorot(row, 'deposit_agorot'),
      includedGuests: asNumber(row, 'standard_guests'),
    },
  }
}

/* ------------------------------------------------------- change status -- */

export type ChangeStatusInput = {
  bookingId: string
  to: BookingStatus
  /** What the screen believes it is editing. Optimistic locking depends on it. */
  version: number
  reason?: string
}

export async function changeBookingStatusAction(
  input: ChangeStatusInput,
): Promise<ActionResult<{ status: BookingStatus; version: number }>> {
  const gate = await requireReady()
  if (!gate.ok) return gate

  const { context } = gate
  const correlationId = crypto.randomUUID()

  try {
    if (!BOOKING_STATUSES.includes(input.to)) {
      throw new Error(`Unknown status: ${input.to}`)
    }

    // The generic gate. The state machine holds the *specific* permission for
    // this particular move — `deposit.release` is not `booking.change_status`
    // — and refuses again inside the operation.
    assertCan(context.actor, 'booking.change_status', {
      organizationId: context.actor.organizationId,
    })

    const { operations, services } = await bookingWiring()

    const outcome = await operations.changeBookingStatus.run({
      request: {
        input: { to: input.to },
        resourceId: input.bookingId,
        expectedVersion: input.version,
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
        reason: input.reason ?? null,
      },
      services,
    })

    revalidatePath('/bookings')
    revalidatePath(`/bookings/${input.bookingId}`)

    return {
      ok: true,
      data: {
        status: outcome.data.booking.status,
        version: outcome.data.booking.version,
      },
    }
  } catch (cause) {
    return failure(cause, correlationId)
  }
}

/* -------------------------------------------------------------- cancel -- */

export type CancelBookingInput = {
  bookingId: string
  version: number
  /** Mandatory. `booking.cancel` declares `requiresReason` and refuses without it. */
  reason: string
}

export async function cancelBookingAction(
  input: CancelBookingInput,
): Promise<ActionResult<{ status: BookingStatus }>> {
  const gate = await requireReady()
  if (!gate.ok) return gate

  const { context } = gate
  const correlationId = crypto.randomUUID()

  try {
    assertCan(context.actor, 'booking.cancel', {
      organizationId: context.actor.organizationId,
    })

    const { operations, services } = await bookingWiring()

    const outcome = await operations.cancelBooking.run({
      request: {
        input: {},
        resourceId: input.bookingId,
        expectedVersion: input.version,
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
        reason: input.reason,
      },
      services,
    })

    revalidatePath('/bookings')
    revalidatePath(`/bookings/${input.bookingId}`)

    return { ok: true, data: { status: outcome.data.booking.status } }
  } catch (cause) {
    return failure(cause, correlationId)
  }
}

/* -------------------------------------------------------- availability -- */

export type AvailabilityAnswer = {
  available: boolean
  nights: number
  blockers: readonly AvailabilityBlocker[]
}

/**
 * The pre-submit check.
 *
 * It is a courtesy and explicitly not a guarantee — the dates can be taken in
 * the second between this answer and the submit, which is why
 * `booking.create` runs the identical check inside the same transaction that
 * writes the row and turns a lost race into a `ConflictError`. Offering this
 * without that would be a form that promises what the database has not agreed
 * to.
 *
 * Gated on `availability.view` rather than `booking.view`: an external seller
 * is entitled to know a date is taken and is not entitled to know by whom. The
 * answer carries only free/busy and the domain's own blocker messages — never
 * the booking that is in the way, its guest, or its price.
 *
 * `booking.create` is accepted in its place because it already implies this
 * answer: whoever may write a booking for these dates will be told by the
 * create call itself whether they were taken. Refusing the courtesy check to
 * somebody the authoritative check will answer anyway would produce an error
 * banner on a button that is about to work.
 */
export async function checkAvailabilityAction(input: {
  unitId: string
  checkIn: string
  checkOut: string
}): Promise<ActionResult<AvailabilityAnswer>> {
  const gate = await requireReady()
  if (!gate.ok) return gate

  const { context } = gate
  const correlationId = crypto.randomUUID()

  try {
    const resource: Resource = {
      organizationId: context.actor.organizationId,
      unitId: input.unitId,
    }

    // `assertCan` on the narrower grant when the wider one is absent, so the
    // refusal names the permission a role actually needs rather than the one
    // that happened to be checked second.
    if (!can(context.actor, 'booking.create', resource)) {
      assertCan(context.actor, 'availability.view', resource)
    }

    const { repository } = await bookingWiring()

    const result = await checkAvailability(
      repository,
      {
        organizationId: context.actor.organizationId,
        unitId: input.unitId,
        range: { checkIn: input.checkIn, checkOut: input.checkOut },
      },
      { now: new Date() },
    )

    return {
      ok: true,
      data: {
        available: result.available,
        nights: result.nights,
        blockers: result.blockers,
      },
    }
  } catch (cause) {
    return failure(cause, correlationId)
  }
}
