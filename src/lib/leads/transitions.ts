/**
 * The lead state machine. Pure, and mirrored in the database.
 *
 * ══ THIS IS NOT THE ENFORCEMENT ═════════════════════════════════════════════
 *
 * `tg_lead_is_governed` in `0074_leads_and_guest_merges.sql` refuses every
 * transition this file refuses, and it is the floor: a state machine that
 * lives only in TypeScript is a state machine a crafted POST walks straight
 * past. What this one is for is the two things the database cannot do — tell a
 * screen which buttons to draw, and say in Hebrew why a move was refused
 * before the round trip.
 *
 * **If the two ever disagree, the database wins and this file is the bug.**
 * `transitions.test.ts` enumerates all forty-nine ordered pairs so a change to
 * either half shows up as a failing test rather than as a screen that offers a
 * button the database will refuse.
 *
 * ══ "A LEAD THAT BECAME A BOOKING STOPS BEING A LEAD" ═══════════════════════
 *
 * `booked` requires a booking, and the booking has to be one — not an
 * `inquiry`, a `quote` or an `option`, which are the three statuses
 * `src/lib/revenue/stays.ts` excludes from occupancy because they are demand
 * rather than a stay. That list is imported from there rather than restated,
 * so this module cannot come to hold a second, quieter opinion about what
 * counts as demand. It is also why there is deliberately no SQL check for it:
 * a copy of the list in the migration would be exactly the second opinion this
 * avoids.
 *
 * The consequence in the product: an enquiry linked to a booking that is still
 * `inquiry` stays in the pipeline as a lead and is not counted as a
 * conversion, and the stay it points at is not counted as occupancy either. It
 * is in one place, once.
 */

import { isDemand } from '../revenue/stays'
import type { BookingStatusName } from '../revenue/types'
import { LEAD_STATUSES, LEAD_STATUS_LABEL, type LeadStatus } from './types'

/**
 * Every move §4.1 allows, from → to.
 *
 * Read the absences as carefully as the entries:
 *
 *   · `new → booked` and `contacted → booked` are missing. A walk-in that
 *     books on the spot is a booking, not an enquiry that converted, and
 *     letting it be both is how a conversion rate becomes flattering fiction.
 *   · `booked → anything` is missing. Cancelling the stay does not put the
 *     enquiry back in the pipeline — that would count one person's business
 *     twice, once as a sale and once as an opportunity.
 *   · `lost → contacted` is the only way back in, and it clears the closing
 *     reason, so the "why we lose sales" breakdown never counts a lead that is
 *     being worked again.
 */
const ALLOWED: Readonly<Record<LeadStatus, readonly LeadStatus[]>> = {
  new: ['contacted', 'quote_sent', 'lost'],
  contacted: ['interested', 'quote_sent', 'lost'],
  interested: ['quote_sent', 'booked', 'lost'],
  quote_sent: ['negotiation', 'booked', 'lost'],
  negotiation: ['booked', 'lost'],
  booked: [],
  lost: ['contacted'],
}

/** Is this move in the table? A move to the status it already holds is not. */
export function canTransition(from: LeadStatus, to: LeadStatus): boolean {
  return ALLOWED[from].includes(to)
}

/** Where this lead may go from here, for drawing the controls. */
export function nextStatuses(from: LeadStatus): readonly LeadStatus[] {
  return ALLOWED[from]
}

/** Everything that is still being worked. */
export function isOpen(status: LeadStatus): boolean {
  return status !== 'booked' && status !== 'lost'
}

/**
 * What a move needs before it is allowed to happen.
 *
 * Returned as a list rather than thrown, because a form must not reveal its
 * problems one at a time. Empty means the move is legal and complete.
 */
export interface TransitionRequest {
  from: LeadStatus
  to: LeadStatus
  /** Required on the way to `lost` (ח40-21). */
  lostReason?: string | null
  /** Required when the reason is `other`. */
  lostNote?: string | null
  /** Required on the way to `booked`. */
  bookingId?: string | null
  /** The linked booking's status, for the demand test. */
  bookingStatus?: BookingStatusName | null
  /** Required when reopening a closed lead (§4.1). */
  reason?: string | null
}

export interface TransitionProblem {
  field: string
  message: string
}

export function problemsWith(
  request: TransitionRequest,
): readonly TransitionProblem[] {
  const problems: TransitionProblem[] = []
  const { from, to } = request

  if (from === to) {
    problems.push({
      field: 'status',
      message: `הליד כבר במצב ״${LEAD_STATUS_LABEL[to]}״.`,
    })
    return problems
  }

  if (!canTransition(from, to)) {
    problems.push({
      field: 'status',
      message:
        `אי אפשר להעביר ליד מ״${LEAD_STATUS_LABEL[from]}״ ` +
        `ל״${LEAD_STATUS_LABEL[to]}״.`,
    })
    // Nothing below this line is meaningful for a move that cannot happen.
    return problems
  }

  if (to === 'lost') {
    if (isBlank(request.lostReason)) {
      problems.push({ field: 'lostReason', message: 'יש לבחור סיבת סגירה.' })
    } else if (request.lostReason === 'other' && isBlank(request.lostNote)) {
      problems.push({
        field: 'lostNote',
        message: 'סיבה ״אחר״ דורשת הסבר קצר, אחרת אי אפשר ללמוד ממנה.',
      })
    }
  }

  if (to === 'booked') {
    if (isBlank(request.bookingId)) {
      problems.push({
        field: 'bookingId',
        message: 'ליד שהפך להזמנה חייב להצביע על ההזמנה שנוצרה.',
      })
    } else if (
      request.bookingStatus == null ||
      isDemand(request.bookingStatus)
    ) {
      // The whole rule, in one sentence a person can act on: a booking still
      // sitting in enquiry/quote/option has not converted anything, and
      // counting it would put the same person in the funnel and in the
      // occupancy figures at once.
      problems.push({
        field: 'bookingId',
        message:
          'ההזמנה המקושרת עדיין פנייה או הצעת מחיר, ולכן הליד לא הומר. ' +
          'קדם את ההזמנה קודם — אחרת אותו אדם ייספר גם בצנרת וגם בתפוסה.',
      })
    }
  }

  // §4.1 · reopening is the one move that undoes a decision somebody recorded,
  // and it erases the closing reason. It is not done without a sentence.
  if (from === 'lost' && isBlank(request.reason)) {
    problems.push({
      field: 'reason',
      message: 'פתיחה מחדש של ליד שנסגר דורשת נימוק.',
    })
  }

  return problems
}

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim().length === 0
}

/** Every ordered pair, for the test that keeps this file and the trigger level. */
export const ALL_STATUS_PAIRS: readonly (readonly [LeadStatus, LeadStatus])[] =
  LEAD_STATUSES.flatMap((from) =>
    LEAD_STATUSES.map((to) => [from, to] as const),
  )
