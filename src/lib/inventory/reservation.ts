/**
 * Promising stock to a booking, and the reason two people cannot promise the
 * same towels.
 *
 * ══ The concurrency answer, in full ═══════════════════════════════════════
 *
 * Two receptionists confirm two bookings half a second apart. Both need
 * twenty-five of the fifty towels; the second one needs thirty. Whatever
 * happens, `quantity_reserved` must not end up above `quantity`.
 *
 * The naive shape — read the item, subtract in TypeScript, write the new total
 * back — loses that race every time, because both readers see the same
 * starting number and the second write overwrites rather than adds. It is
 * also, unavoidably, what PostgREST offers: there is no way to express
 * `set quantity_reserved = quantity_reserved + 25` through it.
 *
 * So reservation is **not** a table write from this application. It is
 * `public.reserve_inventory`, a SECURITY DEFINER function added by
 * `0030_inventory_forecast.sql`, and it stacks three defences:
 *
 *   1. `select … for update` on the item row. The second caller waits.
 *   2. `set quantity_reserved = quantity_reserved + n` — *relative*. Under
 *      READ COMMITTED the second transaction re-reads the committed value and
 *      adds to it, so nothing is lost even if the lock were released early.
 *   3. `inventory_items_reserved_within_quantity`, the CHECK constraint 0011
 *      already carries: `quantity_reserved <= quantity`. This is the actual
 *      guarantee. It binds `service_role` and the table owner, neither of
 *      which RLS constrains, and it refuses an oversell as a constraint
 *      violation rather than as a branch somebody could forget to write —
 *      exactly as `unit_occupancy_no_overlap` refuses a double booking.
 *
 * `planReservation` below is the fourth layer and the least important one: it
 * produces the sentence a person reads. Delete it and the product is still
 * correct; it simply fails with SQLSTATE 23514 and a constraint name instead
 * of "there are eighteen free and you asked for twenty-five".
 *
 * `reservation.test.ts` proves both halves: that the pure guard refuses the
 * over-large request, and — the one that matters — that the adapter calls the
 * function rather than reading and writing the column, because a passing unit
 * test over a read-modify-write would be a passing test over a race.
 */

import { BusinessRuleError, ValidationError } from '../errors'
import type { InventoryCapabilities, Reservation } from './types'

export interface ReservationRequest {
  itemId: string
  quantity: number
  /** Inclusive ISO dates the stock is spoken for. */
  neededFrom: string
  neededTo: string
  bookingId?: string | null
  note?: string | null
}

/** The item, as the guard needs to see it. */
export interface ReservableItem {
  itemId: string
  label: string
  quantity: number
  quantityReserved: number
  /** An existing live reservation for the same booking and item, if any. */
  existingQuantity?: number
}

export interface ReservationPlan {
  itemId: string
  quantity: number
  /** What is free before this reservation is applied. */
  freeBefore: number
  /** What will be free after. Never negative — the guard refuses first. */
  freeAfter: number
  /** True when this replaces a live reservation rather than adding one. */
  replaces: boolean
}

/**
 * Can this reservation be made, and what does it leave behind?
 *
 * `existingQuantity` is added back before the check because re-reserving the
 * same booking's towels is a *change*, not a second promise: a booking that
 * already holds twenty-five and is being raised to thirty needs five more, not
 * thirty more. Without this, editing a party size upward on a nearly-full
 * cupboard would fail with "not enough" while the stock is sitting in that
 * very booking's own reservation.
 */
export function planReservation(
  item: ReservableItem,
  request: ReservationRequest,
): ReservationPlan {
  assertRequest(request)

  const existing = item.existingQuantity ?? 0
  const freeBefore = item.quantity - item.quantityReserved + existing

  if (request.quantity > freeBefore) {
    throw new BusinessRuleError({
      code: 'inventory_insufficient',
      message:
        `Cannot reserve ${request.quantity} of ${item.itemId}: ` +
        `${freeBefore} free.`,
      userMessage:
        `לא ניתן לשריין ${request.quantity} מתוך ״${item.label}״ — זמינים ` +
        `${freeBefore} בלבד. השאר כבר משוריין להזמנות אחרות.`,
      publicDetails: {
        itemId: item.itemId,
        requested: request.quantity,
        free: freeBefore,
      },
    })
  }

  return {
    itemId: item.itemId,
    quantity: request.quantity,
    freeBefore,
    freeAfter: freeBefore - request.quantity,
    replaces: existing > 0,
  }
}

/**
 * Refuse before the database is touched, with the field named.
 *
 * A quantity of zero is not a reservation and a reversed window is a typo, and
 * both would otherwise reach the function and come back as a SQLSTATE.
 */
function assertRequest(request: ReservationRequest): void {
  const issues = []

  if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
    issues.push({
      field: 'quantity',
      code: 'invalid',
      message: 'הכמות לשריון חייבת להיות מספר שלם גדול מאפס.',
    })
  }

  if (request.neededTo < request.neededFrom) {
    issues.push({
      field: 'neededTo',
      code: 'invalid',
      message: 'תאריך הסיום קודם לתאריך ההתחלה.',
    })
  }

  if (issues.length > 0) {
    throw new ValidationError(issues, {
      userMessage: 'בקשת השריון אינה תקינה.',
    })
  }
}

/**
 * Reservations are refused outright when the capability is off.
 *
 * Separate from `planReservation` because it is a different refusal: "this
 * business does not reserve stock" is a configuration answer, and reporting it
 * as "not enough towels" would send somebody to count a cupboard that is full.
 */
export function assertReservationsEnabled(
  capabilities: InventoryCapabilities,
): void {
  if (capabilities.reservations) return

  throw new BusinessRuleError({
    code: 'inventory_reservations_disabled',
    message: 'Reservations are not enabled for this organization.',
    userMessage:
      'שריון מלאי אינו פעיל בארגון הזה. אפשר להפעיל אותו בהגדרות המלאי — ' +
      'ההזמנה עצמה נשמרת גם בלעדיו.',
  })
}

/**
 * The reservations that fall on a given day.
 *
 * A reservation covers a window: linen promised from Friday to Sunday is
 * unavailable on all three days, not only on the first. The forecast turns
 * these into demand lines and this is where "which days" is answered.
 */
export function coversDate(reservation: Reservation, date: string): boolean {
  if (reservation.status !== 'reserved') return false
  return date >= reservation.neededFrom && date <= reservation.neededTo
}

/**
 * The one day a reservation claims stock, for the forecast's demand lines.
 *
 * Deliberately `neededFrom` alone and not every day of the window. Linen is
 * taken out of the cupboard once, at the start of the stay, and stays out —
 * counting it again on each night of a five-night booking would report five
 * times the requirement and produce a wall of shortages that do not exist.
 * The window is what `coversDate` is for; the claim is a single day.
 */
export function claimDateOf(reservation: Reservation): string {
  return reservation.neededFrom
}
