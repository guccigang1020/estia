/**
 * The channels a business accepts money through, outside the product.
 *
 * ── Why this is not `PAYMENT_METHODS` ─────────────────────────────────────
 *
 * `PAYMENT_METHODS` in `src/lib/contracts/states.ts` is frozen and is about
 * the payment *record*: what the money turned out to be when it landed. This
 * list is about the *instruction*: what a guest is told to do. They overlap
 * and they are not the same list, and two of the entries here have no method
 * of their own —
 *
 *   · a cheque is recorded as `other`, because the contract has no `cheque`
 *     and widening a frozen vocabulary that four modules read, to record a
 *     distinction only the instruction text cares about, is the wrong trade;
 *   · a card terminal in the lobby is recorded as `card`, because it is one.
 *
 * The mapping is stated once, here, and asserted in `channels.test.ts`. The
 * database enum `public.manual_payment_channel` is transcribed from
 * `MANUAL_PAYMENT_CHANNELS` in this exact order.
 *
 * ── Why this is first-class and not a fallback ────────────────────────────
 *
 * A bank transfer is how most Israeli guesthouses are paid. A product that
 * treats it as the degraded path — a note field beside the real payment form —
 * is a product that treats its majority customer as an exception.
 */

import type { PaymentMethod } from '../contracts/states'

/** Transcribed into `public.manual_payment_channel`, in this order. */
export const MANUAL_PAYMENT_CHANNELS = [
  'bank_transfer',
  'cash',
  'bit',
  'paybox',
  'cheque',
  'external_terminal',
  'other',
] as const

export type ManualPaymentChannel = (typeof MANUAL_PAYMENT_CHANNELS)[number]

export const MANUAL_CHANNEL_LABEL: Record<ManualPaymentChannel, string> = {
  bank_transfer: 'העברה בנקאית',
  cash: 'מזומן',
  bit: 'ביט',
  paybox: 'פייבוקס',
  cheque: 'המחאה',
  external_terminal: 'סליקה במסוף חיצוני',
  other: 'אחר',
}

/**
 * What the guest is asked to supply, so a settings screen can say what the
 * instruction text is expected to contain instead of leaving an empty box.
 */
export const MANUAL_CHANNEL_HINT: Record<ManualPaymentChannel, string> = {
  bank_transfer: 'שם המוטב, בנק, סניף וחשבון — או IBAN.',
  cash: 'היכן ולמי משלמים. אין צורך בפרטי חשבון.',
  bit: 'מספר הטלפון שאליו שולחים בביט.',
  paybox: 'מספר הטלפון או קישור הקבוצה בפייבוקס.',
  cheque: 'למי רושמים את ההמחאה ולאן שולחים אותה.',
  external_terminal: 'היכן נמצא המסוף ומתי אפשר להעביר בו כרטיס.',
  other: 'הסבר מלא לאורח — זה כל מה שהוא יראה.',
}

/**
 * The method a payment recorded through this channel carries.
 *
 * Stated as data rather than as a `switch`, so adding a channel without
 * deciding what it is recorded as does not compile.
 */
export const PAYMENT_METHOD_FOR_CHANNEL: Record<
  ManualPaymentChannel,
  PaymentMethod
> = {
  bank_transfer: 'bank_transfer',
  cash: 'cash',
  bit: 'bit',
  paybox: 'paybox',
  // No `cheque` in the frozen contract. See the header.
  cheque: 'other',
  // A physical terminal takes a card. That it is not our provider changes who
  // reconciles it, not what the guest handed over.
  external_terminal: 'card',
  other: 'other',
}

/**
 * Channels that need an account number, a phone or an address before they can
 * be offered.
 *
 * `cash` is the exception the database also makes: "cash on arrival" is a
 * complete instruction. Everything else, offered with an empty instruction
 * field, tells the guest to pay and not where.
 */
export function requiresInstructions(channel: ManualPaymentChannel): boolean {
  return channel !== 'cash'
}

export function isManualPaymentChannel(
  value: unknown,
): value is ManualPaymentChannel {
  return (MANUAL_PAYMENT_CHANNELS as readonly unknown[]).includes(value)
}
