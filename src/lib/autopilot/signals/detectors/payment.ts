/**
 * Money that was expected and has not arrived.
 *
 * ── This file holds no opinion about whether a deposit was paid ───────────
 *
 * `payments/resolver.ts` is THE resolver: settings plus override plus what has
 * been collected, one answer, one Hebrew sentence per requirement. Everything
 * here is that answer, quoted. A second opinion about a deposit is not a
 * feature — it is the bug where the desk believes the payment was waived, the
 * guest is shown a demand, and no record can settle which is right.
 *
 * ── The contract is not detected here, on purpose ─────────────────────────
 *
 * `contract_signed` is a member of `CONFIRMATION_REQUIREMENTS` and it arrives
 * in the same `outstanding` list as the deposit. It is skipped here and
 * detected in `contract.ts`, because emitting both would put two exceptions on
 * one screen for one unsigned contract, and the manager who resolved one would
 * be left holding the other.
 */

import type { Signal } from '../../types'
import { fact, type DetectorContext } from '../facts'
import { signalKey } from '../keys'
import { isModuleEnabled } from '../modules'

/** One outstanding confirmation requirement, as the resolver reported it. */
export interface OutstandingRequirement {
  /** A `ConfirmationRequirement` member. Kept as a string: this file does not
   * switch on it, and narrowing it would make the payments enum a build-time
   * dependency of detection for no gain. */
  requirement: string
  label: string
  /** The resolver's own sentence. */
  detail: string
}

export interface PaymentFacts {
  bookingId: string
  propertyId: string | null
  label: string
  /** From `resolveCollectionPolicy`. Empty when the policy asks for nothing. */
  outstanding: readonly OutstandingRequirement[]
  /** Agorot still owed of what is due now. Never divided by anything here. */
  shortfallAgorot: number | null
  /** When the balance falls due, from the payment schedule. */
  balanceDueAt: string | null
  /** Whether the guest has actually been asked. */
  requestSentAt: string | null
}

/** The requirement `contract.ts` owns. See the header. */
const CONTRACT_REQUIREMENT = 'contract_signed'

export function detectPayment(
  bookings: readonly PaymentFacts[],
  context: DetectorContext,
): Signal[] {
  if (!isModuleEnabled(context.modules, 'payments')) return []

  const signals: Signal[] = []

  for (const booking of bookings) {
    for (const outstanding of booking.outstanding) {
      if (outstanding.requirement === CONTRACT_REQUIREMENT) continue

      signals.push({
        code: 'payment.requirement_unmet',
        domain: 'payment_risk',
        risk: 'at_risk',
        resourceType: 'booking',
        resourceId: booking.bookingId,
        propertyId: booking.propertyId,
        title: `${booking.label} — ${outstanding.label}`,
        detail: outstanding.detail,
        evidence: [
          fact(
            `payment.${outstanding.requirement}`,
            outstanding.label,
            outstanding.detail,
            'payments',
          ),
          ...(booking.shortfallAgorot === null
            ? []
            : [
                fact(
                  'payment.shortfall_agorot',
                  'חסר באגורות',
                  booking.shortfallAgorot,
                  'payments',
                ),
              ]),
          fact(
            'payment.request_sent',
            'נשלחה בקשת תשלום',
            booking.requestSentAt !== null,
            'payments',
            booking.requestSentAt ?? undefined,
          ),
        ],
        // The requirement is the aspect. Two outstanding requirements on one
        // booking are two problems a person resolves separately, and one key
        // for both would let resolving the deposit close the row that was
        // about the guest's confirmation.
        dedupeKey: signalKey({
          code: 'payment.requirement_unmet',
          resourceType: 'booking',
          resourceId: booking.bookingId,
          aspect: outstanding.requirement,
        }),
        ...(booking.balanceDueAt === null
          ? {}
          : { dueAt: booking.balanceDueAt }),
      })
    }

    const overdue =
      booking.balanceDueAt !== null &&
      new Date(booking.balanceDueAt).getTime() < context.now.getTime() &&
      (booking.shortfallAgorot ?? 0) > 0

    if (overdue && booking.balanceDueAt !== null) {
      signals.push({
        code: 'payment.balance_overdue',
        domain: 'payment_risk',
        risk: 'critical',
        resourceType: 'booking',
        resourceId: booking.bookingId,
        propertyId: booking.propertyId,
        title: `${booking.label} — היתרה באיחור`,
        detail: 'מועד תשלום היתרה חלף והכסף טרם נכנס.',
        evidence: [
          fact(
            'payment.balance_due_at',
            'מועד תשלום היתרה',
            booking.balanceDueAt,
            'payments',
            booking.balanceDueAt,
          ),
          fact(
            'payment.shortfall_agorot',
            'חסר באגורות',
            booking.shortfallAgorot,
            'payments',
          ),
        ],
        dedupeKey: signalKey({
          code: 'payment.balance_overdue',
          resourceType: 'booking',
          resourceId: booking.bookingId,
        }),
        dueAt: booking.balanceDueAt,
      })
    }
  }

  return signals
}
