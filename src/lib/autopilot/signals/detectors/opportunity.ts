/**
 * Nights nobody is paying for.
 *
 * ── An opportunity is not a risk, and says so ─────────────────────────────
 *
 * Every signal carries an `AutopilotRiskState`, and an empty Tuesday is not
 * `at_risk` — nothing is going wrong, and dressing revenue up as an emergency
 * is how a manager learns that the red rows are not worth reading. So these
 * are emitted at `on_track` and their place in the day comes from the domain:
 * `sales_opportunity` is second to last in `AUTOPILOT_DOMAINS`, below every
 * operational failure, and that tuple is the priority order for the whole
 * product. Risk is severity; the domain is priority. Conflating them is what
 * would let a discount suggestion outrank a locked door.
 *
 * ── Availability is not recomputed here ───────────────────────────────────
 *
 * `booking/availability.ts` owns whether a night can be sold — holds, blocks,
 * minimum stays, the lot. This file receives nights it has already judged
 * bookable. A detector that decided for itself that a night was free would
 * eventually offer a night that is already held, and the guest who took it
 * would be the one who found out.
 *
 * ── The date is identity, not a clock reading ─────────────────────────────
 *
 * The dedupe key contains `2026-09-12` and that is correct: the twelfth is
 * WHICH empty night, and the same night noticed at 06:00 and at 06:05 is one
 * opportunity. `keys.ts` draws the line between a calendar date and an
 * instant precisely so this case is expressible and a timestamp is not.
 */

import { localDate } from '../../../booking/dates'
import type { Signal } from '../../types'
import { fact, type DetectorContext } from '../facts'
import { signalKey } from '../keys'

export interface EmptyNightFacts {
  propertyId: string
  label: string
  /** Property-local calendar date, `YYYY-MM-DD`. */
  date: string
  /** From `booking/availability.ts`. Never decided here. */
  bookable: boolean
  /**
   * How many consecutive empty nights this one belongs to.
   *
   * The number is what separates "a quiet week" from "a hole nobody can sell":
   * a single night between two bookings is an orphan that no ordinary
   * minimum-stay will ever fill, and it is worth a different conversation from
   * eleven empty nights in February.
   */
  gapNights: number
  /** The stay that ends here, when there is one. */
  previousCheckOut: string | null
  /** The stay that begins here, when there is one. */
  nextCheckIn: string | null
}

export function detectOpportunity(
  nights: readonly EmptyNightFacts[],
  context: DetectorContext,
): Signal[] {
  const signals: Signal[] = []
  // Today at the PROPERTY, through the same conversion the action centre uses.
  // An ISO slice would file 00:30 in Israel under yesterday and offer a night
  // that has already begun.
  const today = localDate(context.now, context.timeZone)

  for (const night of nights) {
    if (!night.bookable) continue
    // A night that has already started cannot be sold.
    if (night.date < today) continue

    const isGap = night.previousCheckOut !== null && night.nextCheckIn !== null

    const code = isGap ? 'opportunity.booking_gap' : 'opportunity.empty_night'

    signals.push({
      code,
      domain: 'sales_opportunity',
      // See the header. Nothing is wrong; this is money not yet earned.
      risk: 'on_track',
      resourceType: 'property',
      resourceId: night.propertyId,
      propertyId: night.propertyId,
      title: isGap
        ? `${night.label} — ${night.gapNights} לילות בין הזמנות`
        : `${night.label} — לילה פנוי`,
      detail: isGap
        ? `נותרו ${night.gapNights} לילות פנויים בין שתי הזמנות, החל מ-${night.date}.`
        : `${night.date} פנוי וניתן למכירה.`,
      evidence: [
        fact('availability.date', 'תאריך', night.date, 'availability'),
        fact('availability.bookable', 'ניתן למכירה', true, 'availability'),
        fact(
          'availability.gap_nights',
          'לילות ברצף',
          night.gapNights,
          'availability',
        ),
        ...(night.previousCheckOut === null
          ? []
          : [
              fact(
                'availability.previous_check_out',
                'יציאה קודמת',
                night.previousCheckOut,
                'booking',
              ),
            ]),
        ...(night.nextCheckIn === null
          ? []
          : [
              fact(
                'availability.next_check_in',
                'כניסה הבאה',
                night.nextCheckIn,
                'booking',
              ),
            ]),
      ],
      dedupeKey: signalKey({
        code,
        resourceType: 'property',
        resourceId: night.propertyId,
        aspect: night.date,
      }),
    })
  }

  return signals
}
