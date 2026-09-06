/**
 * The guest standing outside a locked door.
 *
 * ── Why this is its own domain and sits near the top ──────────────────────
 *
 * `guest_access` is fourth in `AUTOPILOT_DOMAINS`, above the money and above
 * the preparation, and the reason is that every other failure is recoverable
 * by a phone call from the office. This one is a person with luggage in a
 * street at 15:00 who cannot get in, and by the time they call, the damage —
 * the review, the refund, the WhatsApp to their friends — is already done.
 *
 * ── Two failures, and they belong to two different people ─────────────────
 *
 * The code not existing is the operation's failure. The information not
 * reaching the guest is the guest journey's — the code exists, the door works,
 * and nobody pressed release. Separate signals because the second is fixed in
 * one click by whoever is at a desk and the first needs somebody at the
 * property.
 *
 * The instructions are gated on `guest_portal` rather than on `access`: a
 * business with no smart locks still sends an address, and a business with
 * locks and no portal has nowhere to send anything.
 */

import type { Signal } from '../../types'
import { fact, type DetectorContext } from '../facts'
import { signalKey } from '../keys'
import { isModuleEnabled } from '../modules'

export interface AccessFacts {
  bookingId: string
  propertyId: string | null
  label: string
  arrivalAt: string | null
  /** Whether this property is entered with a code at all. */
  codeRequired: boolean
  codeGeneratedAt: string | null
  /** Whether the business sends arrival information through the portal. */
  instructionsRequired: boolean
  instructionsReleasedAt: string | null
}

export function detectAccess(
  bookings: readonly AccessFacts[],
  context: DetectorContext,
): Signal[] {
  const hasAccess = isModuleEnabled(context.modules, 'access')
  const hasPortal = isModuleEnabled(context.modules, 'guest_portal')
  if (!hasAccess && !hasPortal) return []

  const signals: Signal[] = []

  for (const booking of bookings) {
    if (hasAccess && booking.codeRequired && booking.codeGeneratedAt === null) {
      signals.push(
        emit(
          booking,
          'access.code_missing',
          'לא הופק קוד כניסה',
          'הנכס נפתח בקוד ולא הופק קוד להזמנה הזו.',
          [
            fact('access.code_required', 'נדרש קוד', true, 'access'),
            fact('access.code_generated', 'הופק', false, 'access'),
          ],
        ),
      )
    }

    if (
      hasPortal &&
      booking.instructionsRequired &&
      booking.instructionsReleasedAt === null
    ) {
      signals.push(
        emit(
          booking,
          'access.instructions_unreleased',
          'הוראות ההגעה טרם שוחררו',
          'האורח עדיין אינו רואה כתובת והוראות הגעה.',
          [
            fact(
              'access.instructions_required',
              'נדרשות הוראות הגעה',
              true,
              'guest_portal',
            ),
            fact(
              'access.instructions_released',
              'שוחררו',
              false,
              'guest_portal',
            ),
          ],
        ),
      )
    }
  }

  return signals
}

function emit(
  booking: AccessFacts,
  code: string,
  headline: string,
  detail: string,
  evidence: Signal['evidence'],
): Signal {
  return {
    code,
    domain: 'guest_access',
    risk: 'at_risk',
    resourceType: 'booking',
    resourceId: booking.bookingId,
    propertyId: booking.propertyId,
    title: `${booking.label} — ${headline}`,
    detail,
    evidence,
    dedupeKey: signalKey({
      code,
      resourceType: 'booking',
      resourceId: booking.bookingId,
    }),
    ...(booking.arrivalAt === null ? {} : { dueAt: booking.arrivalAt }),
  }
}
