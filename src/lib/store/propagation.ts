/**
 * What happens to the things a guest bought when the stay itself changes.
 *
 * ── The three rules, and the mistake each one prevents ────────────────────
 *
 *   **Booking cancelled.** Examine each order against its OWN cancellation
 *   policy. Never blanket-cancel and never blanket-refund. A ₪1,500 שולחן שוק
 *   ordered from a supplier three weeks ago and a bottle of wine that has not
 *   been opened are not the same decision, and a product that made them the
 *   same would either rob the guest or bill the business.
 *
 *   **Dates moved.** Re-verify each purchased service on the NEW date, and
 *   raise an exception where it cannot hold. Silently carrying a Friday DJ to
 *   a Tuesday is how nobody turns up.
 *
 *   **Guest count changed.** Recalculate per-guest pricing according to the
 *   policy, and generate an AMENDMENT requiring consent — never a silent
 *   charge. A family that adds a child and finds ₪240 more on their bill with
 *   no conversation is a complaint the business cannot win.
 *
 * ── Why this module decides nothing on its own ────────────────────────────
 *
 * Every function here returns a PLAN: a list of consequences with reasons.
 * Nothing is written, nothing is cancelled and no money moves. `operations.ts`
 * takes the plan through the service pipeline, where each consequence gets its
 * authorization check, its audit event and its idempotency key.
 *
 * That separation is also what makes the propagation testable at all: "a
 * booking cancelled eight hours before arrival refunds the wine and not the
 * table" is a pure assertion over a plan, and it is in `propagation.test.ts`.
 *
 * ── The policy is the SNAPSHOT ────────────────────────────────────────────
 *
 * Every decision below reads `cancellationPolicySnapshot` from the order line,
 * which is what the guest was sold under. The catalogue's current policy is
 * not consulted, is not imported and would be wrong: a business tightening its
 * terms in March must not retroactively tighten February's sales.
 */

import { applyPercent } from '../finance/money'
import type { Agorot } from '../booking/types'
import { isTerminal } from './orders'
import { quantityFor } from './pricing'
import type {
  BookingFacts,
  OrderLineSnapshot,
  StoreCancellationPolicy,
  StoreOrder,
} from './types'
import { partySize } from './types'

const HOUR_MS = 3_600_000

/* ------------------------------------------------------- cancelled stay --- */

export type CancellationOutcome =
  /** Nothing was charged, so nothing is owed. Cancel and move on. */
  | 'cancel_no_refund_due'
  /** Inside the free window: cancel and give the money back in full. */
  | 'cancel_refund_full'
  /** Partly refundable, by the policy's own percentage. */
  | 'cancel_refund_partial'
  /** The policy says the money is kept. Cancelled, not refunded. */
  | 'cancel_no_refund'
  /**
   * A person has to decide. The policy did not say, or the service has already
   * been performed, and guessing either way is somebody's money.
   */
  | 'needs_decision'

export type OrderCancellationPlan = {
  orderId: string
  reference: string
  outcome: CancellationOutcome
  /** How much to give back. Always 0 for the outcomes that refund nothing. */
  refundAgorot: Agorot
  /** Hebrew, for the owner's screen. Says which policy produced this. */
  explanation: string
  /** True where a person must confirm before anything happens. */
  requiresHuman: boolean
}

/**
 * What each order on a cancelled booking should have happen to it.
 *
 * One entry per order, and every entry states its reasoning. An owner looking
 * at this list is about to make five decisions at once, and a list that does
 * not say why cannot be checked.
 */
export function planForCancelledBooking(input: {
  orders: readonly StoreOrder[]
  /** When the stay would have started. The policy's clock runs to this. */
  arrivalAt: Date
  /** How much has actually been taken, per order. Absent means nothing. */
  paidAgorotByOrder?: Readonly<Record<string, Agorot>>
  now: Date
}): readonly OrderCancellationPlan[] {
  const paid = input.paidAgorotByOrder ?? {}

  return input.orders
    .filter((order) => !isTerminal(order.status))
    .map((order) => {
      const taken = paid[order.id] ?? 0

      // One policy per order, and an order whose lines disagree is decided by
      // a person. Mixing a non-refundable table with a refundable bottle into
      // one automatic answer is exactly the blanket decision this forbids.
      const policies = order.lines.map(
        (line) => line.cancellationPolicySnapshot,
      )
      const shared = singlePolicy(policies)

      if (shared === null) {
        return {
          orderId: order.id,
          reference: order.reference,
          outcome: 'needs_decision' as const,
          refundAgorot: 0,
          explanation:
            'בהזמנה הזו יש פריטים עם מדיניות ביטול שונה, ולכן צריך להחליט עליהם בנפרד.',
          requiresHuman: true,
        }
      }

      // Already performed. The money question is not the policy's any more.
      if (order.status === 'fulfilled' || order.status === 'completed') {
        return {
          orderId: order.id,
          reference: order.reference,
          outcome: 'needs_decision' as const,
          refundAgorot: 0,
          explanation:
            'השירות כבר בוצע. ההחלטה על החזר אינה נגזרת ממדיניות הביטול ודורשת אדם.',
          requiresHuman: true,
        }
      }

      if (taken === 0) {
        return {
          orderId: order.id,
          reference: order.reference,
          outcome: 'cancel_no_refund_due' as const,
          refundAgorot: 0,
          explanation: 'לא נגבה תשלום על ההזמנה הזו, ולכן אין מה להחזיר.',
          requiresHuman: false,
        }
      }

      return refundByPolicy({
        order,
        policy: shared,
        takenAgorot: taken,
        arrivalAt: input.arrivalAt,
        now: input.now,
      })
    })
}

function refundByPolicy(input: {
  order: StoreOrder
  policy: StoreCancellationPolicy
  takenAgorot: Agorot
  arrivalAt: Date
  now: Date
}): OrderCancellationPlan {
  const { order, policy, takenAgorot } = input
  const hoursBefore =
    (input.arrivalAt.getTime() - input.now.getTime()) / HOUR_MS

  const base = {
    orderId: order.id,
    reference: order.reference,
    requiresHuman: false,
  }

  switch (policy.kind) {
    case 'non_refundable':
      return {
        ...base,
        outcome: 'cancel_no_refund',
        refundAgorot: 0,
        explanation:
          'המוצר נמכר ללא אפשרות החזר, ולכן ההזמנה מבוטלת והתשלום נשמר.',
      }

    case 'free_until_hours': {
      const window = policy.hoursBefore ?? 0
      if (hoursBefore >= window) {
        return {
          ...base,
          outcome: 'cancel_refund_full',
          refundAgorot: takenAgorot,
          explanation: `הביטול נעשה יותר מ־${window} שעות לפני ההגעה, ולכן מגיע החזר מלא.`,
        }
      }
      return {
        ...base,
        outcome: 'cancel_no_refund',
        refundAgorot: 0,
        explanation: `הביטול נעשה פחות מ־${window} שעות לפני ההגעה, ולכן לפי המדיניות אין החזר.`,
      }
    }

    case 'percentage': {
      const percent = policy.refundPercent ?? 0
      const refund = applyPercent(takenAgorot, percent)
      return {
        ...base,
        outcome:
          refund >= takenAgorot
            ? 'cancel_refund_full'
            : 'cancel_refund_partial',
        refundAgorot: refund,
        explanation: `לפי מדיניות הביטול של הפריט מוחזרים ${percent}% מהסכום ששולם.`,
      }
    }

    case 'unspecified':
      return {
        ...base,
        outcome: 'needs_decision',
        refundAgorot: 0,
        requiresHuman: true,
        explanation:
          'לא נקבעה מדיניות ביטול למוצר הזה, ולכן ההחלטה על החזר היא שלך.',
      }
  }
}

/** One policy, or `null` where the lines disagree. */
function singlePolicy(
  policies: readonly StoreCancellationPolicy[],
): StoreCancellationPolicy | null {
  if (policies.length === 0) {
    return { kind: 'unspecified' }
  }

  const first = policies[0]
  const same = policies.every(
    (policy) =>
      policy.kind === first.kind &&
      policy.hoursBefore === first.hoursBefore &&
      policy.refundPercent === first.refundPercent,
  )

  return same ? first : null
}

/* ------------------------------------------------------------ moved dates -- */

export type DateChangeExceptionReason =
  | 'outside_availability'
  | 'lead_time_not_met'
  | 'provider_must_reconfirm'
  | 'service_date_in_past'

export type DateChangeException = {
  orderId: string
  reference: string
  lineId: string
  serviceName: string
  reason: DateChangeExceptionReason
  /** Hebrew, for the owner. Says what has to happen next. */
  message: string
}

export type DateChangePlan = {
  /** Orders whose service moves cleanly with the stay. */
  movedOrderIds: readonly string[]
  /** Orders that cannot simply move. Each needs a person. */
  exceptions: readonly DateChangeException[]
}

/**
 * Re-verify every purchased service against the new dates.
 *
 * `stillAvailable` is a callback rather than a table read, so this stays a
 * pure function: the caller resolves availability through
 * `evaluateEligibility` with the new date and hands the answer in. That also
 * means the propagation logic and the eligibility logic cannot drift, because
 * there is only one of the latter.
 */
export function planForMovedDates(input: {
  orders: readonly StoreOrder[]
  /** The new stay. */
  booking: BookingFacts
  /** The new service date for an order, derived from the new arrival. */
  newServiceDateFor: (order: StoreOrder) => string
  /** Can this line still be had on that date? Resolved by the caller. */
  stillAvailable: (
    order: StoreOrder,
    line: OrderLineSnapshot,
    date: string,
  ) => boolean
  now: Date
}): DateChangePlan {
  const moved: string[] = []
  const exceptions: DateChangeException[] = []

  for (const order of input.orders) {
    if (isTerminal(order.status)) continue

    const date = input.newServiceDateFor(order)
    let clean = true

    for (const line of order.lines) {
      const serviceAt = Date.parse(`${date}T12:00:00Z`)

      if (!Number.isNaN(serviceAt) && serviceAt < input.now.getTime()) {
        clean = false
        exceptions.push({
          orderId: order.id,
          reference: order.reference,
          lineId: line.id,
          serviceName: line.itemNameSnapshot,
          reason: 'service_date_in_past',
          message:
            'התאריך החדש כבר עבר, ולכן אי אפשר להעביר את השירות אליו. בטל או קבע מועד אחר.',
        })
        continue
      }

      if (!input.stillAvailable(order, line, date)) {
        clean = false
        exceptions.push({
          orderId: order.id,
          reference: order.reference,
          lineId: line.id,
          serviceName: line.itemNameSnapshot,
          reason: 'outside_availability',
          message:
            'השירות אינו זמין בתאריך החדש. צריך להציע לאורח מועד אחר או לבטל את השורה.',
        })
        continue
      }

      // The lead time PROMISED, not the catalogue's current one.
      const noticeHours =
        (Date.parse(`${date}T12:00:00Z`) - input.now.getTime()) / HOUR_MS
      if (
        Number.isFinite(noticeHours) &&
        noticeHours < line.leadTimeHoursSnapshot
      ) {
        clean = false
        exceptions.push({
          orderId: order.id,
          reference: order.reference,
          lineId: line.id,
          serviceName: line.itemNameSnapshot,
          reason: 'lead_time_not_met',
          message: `השירות דורש ${line.leadTimeHoursSnapshot} שעות התראה, והתאריך החדש קרוב מדי. צריך לוודא מול הספק.`,
        })
        continue
      }

      // A service somebody else performs never moves silently. The DJ agreed
      // to a Friday and has not agreed to anything else.
      if (line.fulfilmentKindSnapshot === 'external_provider') {
        clean = false
        exceptions.push({
          orderId: order.id,
          reference: order.reference,
          lineId: line.id,
          serviceName: line.itemNameSnapshot,
          reason: 'provider_must_reconfirm',
          message:
            'השירות מבוצע על ידי ספק חיצוני. צריך לשלוח בקשה חדשה ולקבל אישור למועד החדש.',
        })
      }
    }

    if (clean) moved.push(order.id)
  }

  return { movedOrderIds: moved, exceptions }
}

/* ---------------------------------------------------- guest count changed -- */

export type GuestCountAmendment = {
  orderId: string
  reference: string
  lineId: string
  serviceName: string
  previousQuantity: number
  newQuantity: number
  previousLineTotalAgorot: Agorot
  newLineTotalAgorot: Agorot
  /** Signed. Positive means the guest owes more, and needs consent. */
  deltaAgorot: Agorot
  /** Always true where the delta is positive. Restated for the caller. */
  requiresConsent: boolean
  explanation: string
}

/**
 * What a change in the party does to per-guest pricing.
 *
 * Only the models whose multiplier IS the party are touched — `per_guest` and
 * `per_child`. A fixed price does not move because two more people arrived,
 * and a per-night price is the dates' business rather than the party's.
 *
 * The UNIT PRICE IS THE SNAPSHOT. What changes is the quantity, which is what
 * "per guest" means. Re-reading the catalogue's price here would let a stay
 * that grew by one child be re-priced at this month's rate for all of it,
 * which is the exact failure the whole snapshot discipline exists to stop.
 */
export function planForGuestCountChange(input: {
  orders: readonly StoreOrder[]
  /** The booking as it now is. */
  booking: BookingFacts
}): readonly GuestCountAmendment[] {
  const amendments: GuestCountAmendment[] = []

  for (const order of input.orders) {
    if (isTerminal(order.status)) continue

    for (const line of order.lines) {
      const model = line.pricingModelSnapshot
      if (model !== 'per_guest' && model !== 'per_child') continue

      const newQuantity = quantityFor(
        {
          pricingModel: model,
          // The snapshot line does not carry the item's bounds, and re-reading
          // them from the catalogue would be reading a live figure. One is the
          // honest floor: a stay always has at least one person in it.
          minQuantity: 1,
          maxQuantity: null,
        },
        input.booking,
      )

      if (newQuantity === line.quantity) continue

      const unit = line.unitPriceAgorot + line.optionsAgorot + line.addonsAgorot
      const newTotal = unit * newQuantity - line.lineDiscountAgorot
      const delta = newTotal - line.lineTotalAgorot

      amendments.push({
        orderId: order.id,
        reference: order.reference,
        lineId: line.id,
        serviceName: line.itemNameSnapshot,
        previousQuantity: line.quantity,
        newQuantity,
        previousLineTotalAgorot: line.lineTotalAgorot,
        newLineTotalAgorot: newTotal,
        deltaAgorot: delta,
        // NEVER A SILENT CHARGE. A positive delta is a proposal the guest has
        // to agree to, and `proposeAmendment` derives the same flag from the
        // same sign so the two cannot disagree.
        requiresConsent: delta > 0,
        explanation:
          delta > 0
            ? `מספר האורחים עלה ל־${partySize(input.booking)}, ולכן ${line.itemNameSnapshot} מתומחר מחדש לפי ${newQuantity} במקום ${line.quantity}. השינוי דורש את אישור האורח.`
            : `מספר האורחים ירד, ולכן ${line.itemNameSnapshot} מתומחר מחדש לפי ${newQuantity} במקום ${line.quantity}.`,
      })
    }
  }

  return amendments
}
