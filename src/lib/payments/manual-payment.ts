/**
 * Recording money that arrived outside the product — through the one
 * operation that already records money.
 *
 * ── Why this is a function and not an operation ───────────────────────────
 *
 * `defineFinanceOperations().recordPayment` writes the payment: the
 * idempotency key, the state machine, the audit row, the `payment.received`
 * event, the effect on the booking's balance. All of it already works for a
 * bank transfer, because `PAYMENT_METHODS` has always carried
 * `bank_transfer`, `bit`, `paybox` and `cash`, and `COLLECTION_CHANNELS` has
 * always carried `manual`.
 *
 * What did not exist was the translation. A person at the desk chooses a
 * *channel* — "the transfer came into the Bit number" — and the payment record
 * wants a *method*. Left to each caller, that mapping would be written three
 * times and one of them would record a cheque as a card.
 *
 * So: one pure function, no I/O, that turns a channel and an amount into the
 * exact input `recordPayment` takes. Manual collection is first-class because
 * it goes through the same operation as a card capture, not because it has an
 * operation of its own.
 */

import type { Agorot } from '../booking/types'
import type { PaymentMethod } from '../contracts/states'
import type { CollectionChannel, PaymentPurpose } from '../finance'

import {
  PAYMENT_METHOD_FOR_CHANNEL,
  type ManualPaymentChannel,
} from './channels'

/** Exactly the shape `defineFinanceOperations().recordPayment` validates. */
export interface RecordPaymentInput {
  paymentId: string
  bookingId: string
  propertyId: string
  amountAgorot: Agorot
  settledAgorot: Agorot
  method: PaymentMethod
  channel: CollectionChannel
  purpose: PaymentPurpose
  providerId: null
  providerRef: string | null
  note?: string
}

export interface ManualPaymentRequest {
  /** Client-generated, so the record and its idempotency key agree. */
  paymentId: string
  bookingId: string
  propertyId: string
  channel: ManualPaymentChannel
  /** What was asked for. */
  amountAgorot: Agorot
  /**
   * What actually arrived. Defaults to the full amount, because somebody
   * recording a transfer after the fact is recording money that is already in
   * the account — but a partial transfer is real and is passed through rather
   * than rounded up into a lie.
   */
  settledAgorot?: Agorot
  purpose: PaymentPurpose
  /** The bank's reference, the Bit confirmation, the cheque number. */
  reference?: string | null
  note?: string
}

/**
 * The channel, as the payment record will describe it.
 *
 * `channel: 'manual'` always — that is what `COLLECTION_CHANNELS` means by it,
 * and it is what keeps reconciliation honest: only provider-collected payments
 * have anything to reconcile against, and a bank transfer counted as missing
 * from the provider's file would report a difference on every till.
 */
export function manualPaymentInput(
  request: ManualPaymentRequest,
): RecordPaymentInput {
  const settled = request.settledAgorot ?? request.amountAgorot

  return {
    paymentId: request.paymentId,
    bookingId: request.bookingId,
    propertyId: request.propertyId,
    amountAgorot: request.amountAgorot,
    settledAgorot: settled,
    method: PAYMENT_METHOD_FOR_CHANNEL[request.channel],
    channel: 'manual',
    purpose: request.purpose,
    // No provider took this money, so there is no provider id. Naming one
    // would put a payment in a reconciliation queue that will never match it.
    providerId: null,
    providerRef: request.reference ?? null,
    ...(request.note === undefined ? {} : { note: request.note }),
  }
}
