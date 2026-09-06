/**
 * An OTA cancelled a stay ESTIA already holds.
 *
 * ── Why this is not a modification with a different field ─────────────────
 *
 * A modification asks "which of these two versions of the stay is true". A
 * cancellation asks a different question — "the guest is not coming; what do
 * we now undo" — and the answer is a list of things that were *created*
 * because the booking existed and must now be released: the dates, the
 * preparation window, the cleaning task somebody may already be driving to,
 * the laundry that may already be in the machine, the amenities drawn from
 * stock, the door code, and the money.
 *
 * That list is the whole value of this file. A cancellation that only flips a
 * status leaves a cleaner arriving on Friday for a guest who cancelled on
 * Tuesday, and leaves the nights unsellable because nothing released them.
 *
 * ── The one case that is not a cancellation ───────────────────────────────
 *
 * **A stay that has already started.** An OTA can and does send a cancellation
 * for a booking whose guest is standing in the room — a channel-side dispute,
 * a chargeback, a mis-click by an agent. Applying it would release a unit that
 * is occupied and would put the next arrival into a bed somebody is asleep in.
 * So it is refused and raised as `cancellation_conflict`: the resolution is a
 * money conversation and a phone call, not a calendar operation, and no
 * automated rule should be allowed to make it.
 *
 * ── Cancelling twice is not an error ──────────────────────────────────────
 *
 * A cancellation redelivered, or a booking a person already cancelled here, is
 * `no_change`. Idempotency is the same rule ingestion states: the second
 * delivery must produce nothing, and "nothing" includes not producing an
 * exception, because an exception nobody needs to act on is what teaches
 * people to stop reading the queue.
 */

import { TERMINAL_STATUSES, type BookingStatus } from '../booking/types'
import type { Grant } from '../authz/permissions'

import {
  CHANNEL_LABEL,
  DOWNSTREAM_LABEL,
  DOWNSTREAM_SYSTEMS,
  type ChannelReservation,
  type DownstreamSystem,
} from './types'
import { draftException, type ChannelExceptionDraft } from './exceptions'
import type { LocalBookingState } from './modification'

/* ------------------------------------------------------------- the stages -- */

/**
 * Statuses after which a cancellation cannot simply be applied.
 *
 * The guest is in the building, or was. Everything from `checked_in` onward,
 * plus the terminal states — `completed` and `no_show` are finished stories
 * and re-opening one from a webhook is not something this module decides.
 *
 * Written as a set rather than as `!OCCUPYING_STATUSES.includes(...)`, because
 * occupancy is a question about the calendar and this is a question about the
 * guest. They are the same list today and will not stay that way.
 */
const ARRIVED_OR_FINISHED: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  'checked_in',
  'in_house',
  'checkout_pending',
  'checked_out',
  'inspection',
  'deposit_release',
  'completed',
  'review_requested',
])

export function hasArrivedOrFinished(status: BookingStatus): boolean {
  return ARRIVED_OR_FINISHED.has(status)
}

/* ------------------------------------------------------------------ plan -- */

/**
 * One thing to undo, and who may undo it.
 *
 * `automatic` is the honest half: releasing the dates happens as a consequence
 * of the status transition and needs nobody. Everything else is work somebody
 * has to do or approve, and marking it automatic would be this module claiming
 * a laundry order cancels itself.
 */
export interface ReleaseStep {
  system: DownstreamSystem
  /** Hebrew, imperative. What actually has to happen. */
  action: string
  automatic: boolean
  requires: Grant | null
}

export type CancellationPlan =
  /** Already cancelled here. The redelivery case, and not an error. */
  | { kind: 'no_change'; reason: 'already_cancelled' }
  | {
      kind: 'apply'
      /** The operation that performs it. Exists today. */
      command: {
        operation: 'booking.cancel'
        requires: Grant
        expectedVersion: number
      }
      releases: readonly ReleaseStep[]
      downstream: readonly DownstreamSystem[]
      /** True when the stay starts soon enough that somebody must be told now. */
      urgent: boolean
    }
  /** Held. The guest has arrived, or the stay is over. */
  | {
      kind: 'conflict'
      reason: 'stay_in_progress' | 'stay_completed'
      exception: ChannelExceptionDraft
    }

export interface CancellationInput {
  current: LocalBookingState
  incoming: ChannelReservation
  connectorId: string
  now: Date
  /**
   * Today, in the property's own timezone.
   *
   * Passed in rather than derived from `now`, for the reason
   * `action-center/_lib/queries.ts` states at length: an ISO slice of a UTC
   * instant files a cancellation at 00:30 in Israel under yesterday, and
   * "does this stay start tomorrow" is exactly the question that must not be
   * answered in the wrong day.
   */
  propertyToday: string
  /** Inside this many days of arrival, somebody has to be told now. */
  urgentWithinDays?: number
}

const DEFAULT_URGENT_WITHIN_DAYS = 3

export function planCancellation(input: CancellationInput): CancellationPlan {
  const { current, incoming, connectorId, now } = input

  if (current.status === 'cancelled') {
    return { kind: 'no_change', reason: 'already_cancelled' }
  }

  if (hasArrivedOrFinished(current.status)) {
    const finished =
      TERMINAL_STATUSES.includes(current.status) ||
      current.status === 'checked_out' ||
      current.status === 'inspection' ||
      current.status === 'deposit_release' ||
      current.status === 'review_requested'

    return {
      kind: 'conflict',
      reason: finished ? 'stay_completed' : 'stay_in_progress',
      exception: draftException('cancellation_conflict', {
        organizationId: current.organizationId,
        connectorId,
        channelCode: incoming.channelCode,
        occurredAt: now,
        subject: `${current.bookingId}:${incoming.externalReservationId}`,
        externalReservationId: incoming.externalReservationId,
        externalListingId: incoming.externalListingId,
        bookingId: current.bookingId,
        unitId: current.unitId,
        propertyId: current.propertyId,
        detail:
          `${CHANNEL_LABEL[incoming.channelCode]} ביטל הזמנה שכבר ` +
          `${finished ? 'הסתיימה' : 'התחילה'} (סטטוס: ${current.status}). ` +
          'הביטול לא הוחל: שחרור התאריכים כאן היה מפנה יחידה תפוסה. ' +
          'זו החלטה כספית — טפל בה דרך מסך ההזמנה.',
      }),
    }
  }

  const daysToArrival = daysBetween(input.propertyToday, current.stay.checkIn)
  const within = input.urgentWithinDays ?? DEFAULT_URGENT_WITHIN_DAYS

  const releases = releasesFor(current.status)

  return {
    kind: 'apply',
    command: {
      operation: 'booking.cancel',
      requires: 'booking.cancel',
      expectedVersion: current.version,
    },
    releases,
    downstream: DOWNSTREAM_SYSTEMS.filter((system) =>
      releases.some((release) => release.system === system),
    ),
    // Negative days — the arrival is in the past and the guest never turned up
    // — count as urgent too. Somebody is probably already preparing that unit.
    urgent: daysToArrival <= within,
  }
}

/* -------------------------------------------------------------- internals -- */

/**
 * What has to be undone, given how far the booking had got.
 *
 * Staged rather than flat: an enquiry that never became a booking has nothing
 * drawn from stock and no door code, and listing seven releases for it would
 * make the plan noise. Preparation, tasks and laundry only exist once the
 * booking is confirmed — which is the point at which
 * `preparation.calculated` runs — so that is the threshold used.
 */
function releasesFor(status: BookingStatus): readonly ReleaseStep[] {
  const releases: ReleaseStep[] = [
    {
      system: 'availability',
      action: 'התאריכים משתחררים ונפתחים מחדש למכירה.',
      // A consequence of the status transition itself, computed by the
      // availability engine from `OCCUPYING_STATUSES`. Nothing to do by hand.
      automatic: true,
      requires: null,
    },
  ]

  const prepared =
    status === 'confirmed' ||
    status === 'pre_arrival' ||
    status === 'ready_for_check_in'

  if (prepared) {
    releases.push(
      {
        system: 'preparation',
        action: 'בטל את תוכנית ההכנה של היחידה לתאריכים האלה.',
        automatic: false,
        // `task.update` and not a preparation grant of its own: the catalogue
        // is explicit that `preparation.view` / `preparation.manage` were
        // deliberately not created, because a second name for a right somebody
        // already holds can be revoked in one place and kept in the other.
        requires: 'task.update',
      },
      {
        system: 'tasks',
        action:
          'בטל את משימות הניקיון וההכנה. אם מישהו כבר בדרך — התקשר, לא רק בטל.',
        automatic: false,
        requires: 'task.update',
      },
      {
        system: 'laundry',
        action: 'בדוק אם הכביסה כבר נשלחה. הזמנה שיצאה לספק אינה מתבטלת מעצמה.',
        automatic: false,
        requires: 'laundry.manage',
      },
      {
        system: 'inventory',
        action: 'החזר למלאי פריטים שהוקצו לשהות ולא נצרכו.',
        automatic: false,
        requires: 'inventory.adjust',
      },
      {
        system: 'access',
        action: 'בטל את קוד הכניסה ואת הוראות ההגעה שנשלחו לאורח.',
        automatic: false,
        requires: 'booking.update',
      },
    )
  }

  releases.push({
    system: 'revenue',
    action:
      'ההכנסה יורדת מהתחזית. אם שולם פיקדון או תשלום — החזר או חיוב ביטול ' +
      'הם החלטה נפרדת ולא חלק מהביטול.',
    automatic: false,
    requires: 'payment.refund',
  })

  return releases
}

/** Whole days between two ISO dates. Negative when the second is in the past. */
function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end)) return 0
  return Math.round((end - start) / 86_400_000)
}

/** Every system a cancellation reaches, for the screen's summary line. */
export function cancellationSummary(plan: CancellationPlan): string {
  if (plan.kind !== 'apply') return ''
  return plan.downstream.map((system) => DOWNSTREAM_LABEL[system]).join(' · ')
}
