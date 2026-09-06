/**
 * A contract that was required and is not signed.
 *
 * Two states, and they are not the same problem. A contract that was never
 * SENT is somebody in the office forgetting; a contract that was sent and not
 * signed is the guest, and chasing the guest for a document nobody sent them
 * is the fastest way to look foolish. Separate codes, separate keys, separate
 * sentences.
 *
 * The domain is `payment_risk` rather than a domain of its own — see
 * `never-forget.ts`, which makes the argument at length. Adding a member to
 * `AUTOPILOT_DOMAINS` is a contract change and belongs to the coordinator.
 */

import type { Signal } from '../../types'
import { fact, type DetectorContext } from '../facts'
import { signalKey } from '../keys'
import { isModuleEnabled } from '../modules'

export interface ContractFacts {
  bookingId: string
  propertyId: string | null
  label: string
  /** Whether this booking's policy asks for a signature at all. */
  required: boolean
  sentAt: string | null
  signedAt: string | null
  /** For the deadline the screen shows. */
  arrivalAt: string | null
}

export function detectContract(
  bookings: readonly ContractFacts[],
  context: DetectorContext,
): Signal[] {
  if (!isModuleEnabled(context.modules, 'contracts')) return []

  const signals: Signal[] = []

  for (const booking of bookings) {
    if (!booking.required || booking.signedAt !== null) continue

    const unsent = booking.sentAt === null
    const code = unsent ? 'contract.not_sent' : 'contract.unsigned'

    signals.push({
      code,
      domain: 'payment_risk',
      risk: 'at_risk',
      resourceType: 'booking',
      resourceId: booking.bookingId,
      propertyId: booking.propertyId,
      title: `${booking.label} — ${unsent ? 'החוזה טרם נשלח' : 'החוזה טרם נחתם'}`,
      detail: unsent
        ? 'ההזמנה דורשת חוזה חתום, והחוזה עדיין לא נשלח לאורח.'
        : 'החוזה נשלח לאורח ועדיין לא נחתם.',
      evidence: [
        fact('contract.required', 'נדרש חוזה', true, 'contracts'),
        fact(
          'contract.sent',
          'נשלח לאורח',
          booking.sentAt !== null,
          'contracts',
          booking.sentAt ?? undefined,
        ),
        fact('contract.signed', 'נחתם', false, 'contracts'),
      ],
      dedupeKey: signalKey({
        code,
        resourceType: 'booking',
        resourceId: booking.bookingId,
      }),
      ...(booking.arrivalAt === null ? {} : { dueAt: booking.arrivalAt }),
    })
  }

  return signals
}
