/**
 * How a store order gets paid, and the reason this file is small.
 *
 * ══ LIVE PAYMENT MUST NEVER BE REQUIRED ═════════════════════════════════════
 *
 * Seven modes, and `pay_now` is one of them. The default is `with_booking`:
 * the purchase joins the booking's remaining balance, which is how an Israeli
 * guesthouse actually handles pool heating added by telephone. A business that
 * has never heard of a payment provider must be able to run this module end to
 * end, and `mode.ts` plus `store_settings_no_live_payment_in_simple` are what
 * make that structural rather than aspirational.
 *
 * ── The port, and why there is one ────────────────────────────────────────
 *
 * A second worker is building the payment-collection policy in
 * `src/lib/payments/**` right now, and that module DOES NOT EXIST YET.
 * Importing it would be a resolution error that breaks every page of the
 * application, so this module declares what it needs — `PaymentPort` — and
 * ships `manualPaymentPort` as the implementation.
 *
 * `manualPaymentPort` is not a stub that throws. It is the honest, complete
 * implementation of the majority case: it records that money moved, outside
 * the product, and returns the instruction a guest should be given. When
 * `src/lib/payments` lands, a live implementation satisfies the same interface
 * and this file does not change.
 *
 * ── The one thing this module refuses to do ───────────────────────────────
 *
 * It never touches a card, a token or a provider credential. A manual payment
 * is a person writing down that a bank transfer landed; the reference it
 * stores is a transfer number or a cheque number, never a payment instrument.
 */

import { BusinessRuleError } from '../errors'
import type { Agorot } from '../booking/types'
import type {
  PaymentMethod,
  StorePaymentMode,
  StorePaymentStatus,
} from '../contracts/states'

/* ------------------------------------------------------------------ port -- */

/**
 * What the store asks of whatever is collecting money.
 *
 * `prepare` answers "what does this order need from the guest, if anything?"
 * and is called at checkout. `record` answers "money moved — write it down"
 * and is called when a person confirms a transfer, or when a live provider
 * reports a success.
 *
 * THE SHAPE ANOTHER WORKER MUST SATISFY, stated in full so it can be
 * implemented without reading this file:
 *
 *     interface PaymentPort {
 *       prepare(request: PaymentPreparation): Promise<PaymentInstruction>
 *       record(request: PaymentRecord): Promise<RecordedPayment>
 *     }
 *
 * Everything in `PaymentPreparation` is already known to the store; nothing in
 * it is a provider concept. A live implementation adds provider concepts on
 * its own side of the interface and the store never learns them.
 */
export interface PaymentPort {
  prepare(request: PaymentPreparation): Promise<PaymentInstruction>
  record(request: PaymentRecord): Promise<RecordedPayment>
}

export type PaymentPreparation = {
  organizationId: string
  orderId: string
  bookingId: string | null
  mode: StorePaymentMode
  amountAgorot: Agorot
  currency: string
}

/**
 * What the guest is told to do, and what the button says.
 *
 * `callToAction` is the single call to action at checkout, and it is whatever
 * the configured mode actually requires — "שלח בקשה", "שלם עכשיו", "אשר
 * והוסף לחשבון". A checkout that always says "שלם" for a business that never
 * takes payment online is the product lying about itself.
 */
export type PaymentInstruction = {
  mode: StorePaymentMode
  /** Does anything have to happen before the order can be confirmed? */
  requiresGuestAction: boolean
  /** Does money have to move through a provider? Always false for manual. */
  requiresLiveProvider: boolean
  /** The one button. Hebrew. */
  callToAction: string
  /** What the guest reads under it. Hebrew, and never a threat. */
  explanation: string
  /** Where the amount ends up when nobody pays now. */
  settlement: 'booking_balance' | 'on_arrival' | 'separate' | 'none'
  /** The status the order's payment should be set to on creation. */
  initialPaymentStatus: StorePaymentStatus
}

export type PaymentRecord = {
  organizationId: string
  orderId: string
  mode: StorePaymentMode
  method: PaymentMethod
  /** Signed. A refund is negative — see `store_order_payments`. */
  amountAgorot: Agorot
  /** A transfer number, a cheque number, the last four digits. Never a token. */
  reference: string | null
  notes: string | null
  recordedAt: Date
}

export type RecordedPayment = PaymentRecord & {
  status: StorePaymentStatus
}

/* ------------------------------------------------- the null implementation -- */

/**
 * What each mode asks of the guest.
 *
 * Data rather than a switch, so that adding a mode is one entry and cannot
 * be half-added: TypeScript refuses a `Record<StorePaymentMode, …>` that is
 * missing a member, which is precisely the check a switch statement with a
 * default clause silently loses.
 */
const INSTRUCTIONS: Readonly<
  Record<StorePaymentMode, Omit<PaymentInstruction, 'mode'>>
> = {
  with_booking: {
    requiresGuestAction: false,
    requiresLiveProvider: false,
    callToAction: 'אשר והוסף לחשבון השהות',
    explanation:
      'הסכום יתווסף ליתרה של ההזמנה שלך ותשלמו אותו יחד עם שאר השהות.',
    settlement: 'booking_balance',
    initialPaymentStatus: 'unpaid',
  },
  pay_now: {
    requiresGuestAction: true,
    requiresLiveProvider: true,
    callToAction: 'שלם עכשיו',
    explanation: 'התשלום מתבצע כעת, וההזמנה תאושר מיד לאחריו.',
    settlement: 'separate',
    initialPaymentStatus: 'unpaid',
  },
  manual: {
    requiresGuestAction: true,
    requiresLiveProvider: false,
    callToAction: 'שלח הזמנה',
    explanation:
      'נשלח לך את פרטי התשלום — העברה בנקאית, ביט או פייבוקס — וההזמנה תאושר כשנראה שהתשלום הגיע.',
    settlement: 'separate',
    initialPaymentStatus: 'unpaid',
  },
  on_arrival: {
    requiresGuestAction: false,
    requiresLiveProvider: false,
    callToAction: 'אשר הזמנה',
    explanation: 'התשלום מתבצע בהגעה, במקום.',
    settlement: 'on_arrival',
    initialPaymentStatus: 'unpaid',
  },
  pay_later: {
    requiresGuestAction: false,
    requiresLiveProvider: false,
    callToAction: 'אשר הזמנה',
    explanation: 'נסגור את התשלום בהמשך. אין צורך לעשות דבר עכשיו.',
    settlement: 'separate',
    initialPaymentStatus: 'unpaid',
  },
  approval_first: {
    requiresGuestAction: false,
    requiresLiveProvider: false,
    callToAction: 'שלח בקשה',
    explanation:
      'נבדוק שאפשר לספק את זה בתאריך שביקשת ונחזור אליך. לא יחויב דבר עד שנאשר.',
    settlement: 'none',
    initialPaymentStatus: 'unpaid',
  },
  custom: {
    requiresGuestAction: false,
    requiresLiveProvider: false,
    callToAction: 'שלח הזמנה',
    explanation: 'נסדר את התשלום מולך ישירות.',
    settlement: 'separate',
    initialPaymentStatus: 'unpaid',
  },
}

/**
 * The instruction for a mode, without any port at all.
 *
 * Exported separately because the guest store has to render the call to action
 * while it is still deciding, before an order exists — and a screen that had
 * to construct a `PaymentPreparation` to learn what its own button says would
 * be a screen that constructs one from nothing.
 */
export function paymentInstructionFor(
  mode: StorePaymentMode,
): PaymentInstruction {
  return { mode, ...INSTRUCTIONS[mode] }
}

/**
 * The implementation this module ships with.
 *
 * It refuses `pay_now`, and that refusal is the point: reaching a live mode
 * through the null port would silently confirm an order nobody has paid for.
 * `mode.ts` and the schema both prevent an organization on `simple` from
 * choosing it, so this is the third net and should never fire — which is
 * exactly the property a net should have.
 */
export const manualPaymentPort: PaymentPort = {
  async prepare(request) {
    if (request.mode === 'pay_now') {
      throw new BusinessRuleError({
        code: 'store_live_payment_unavailable',
        userMessage:
          'תשלום מקוון אינו זמין כרגע. אפשר לאשר את ההזמנה ולשלם בהגעה או בהעברה.',
        message:
          'manualPaymentPort.prepare was asked for pay_now; the live payment ' +
          'implementation in src/lib/payments has not been wired yet',
      })
    }

    return paymentInstructionFor(request.mode)
  },

  async record(request) {
    if (request.amountAgorot === 0) {
      throw new BusinessRuleError({
        code: 'store_payment_zero',
        userMessage: 'לא ניתן לרשום תשלום על סכום אפס.',
        message: 'manualPaymentPort.record was given a zero amount',
      })
    }

    return {
      ...request,
      // A recorded manual payment is `paid` and not `pending_verification`:
      // a person looked at the bank and wrote it down. Verification is a
      // separate act with a separate status, used where a guest uploads a
      // receipt nobody has checked yet.
      status: request.amountAgorot < 0 ? 'refunded' : 'paid',
    }
  },
}

/* ---------------------------------------------------------- reconciliation -- */

/**
 * What an order's payment status is, from the money actually recorded.
 *
 * Derived rather than set, because a status somebody types and an amount
 * somebody records are two facts that drift. The one input is the sum of the
 * payment rows, which is the same discipline `store_orders.total_agorot` gets
 * from its lines.
 */
export function paymentStatusFor(input: {
  totalAgorot: Agorot
  /** Signed sum of every recorded payment. Refunds are negative. */
  recordedAgorot: Agorot
  /** True once any refund row exists at all. */
  hasRefund: boolean
}): StorePaymentStatus {
  const { totalAgorot, recordedAgorot, hasRefund } = input

  if (hasRefund && recordedAgorot <= 0) return 'refunded'
  if (recordedAgorot <= 0) return 'unpaid'
  if (recordedAgorot >= totalAgorot) return 'paid'
  return 'partially_paid'
}
