/**
 * ESTIA says one thing. The channel says another. Now what.
 *
 * ── This file resolves nothing ────────────────────────────────────────────
 *
 * It produces differences and, for each, a **decision for a person** — never
 * an applied change, and never a silent one. That is not caution for its own
 * sake. Every automatic resolution available here amplifies whichever side is
 * wrong: closing a night on four channels because ESTIA believes it is sold
 * takes four listings off sale on the strength of one possibly-bad ingestion,
 * and accepting the channel's version because the channel is "authoritative"
 * overwrites a booking somebody took on the phone. The one thing a
 * reconciliation engine must not do is be confident.
 *
 * So `automatable` is `false` on every decision in this file, and it is a
 * field rather than an omission so that a future caller reaching for
 * "resolve everything" finds a flat no rather than an absence.
 *
 * ── Authority is an input, not a belief ───────────────────────────────────
 *
 * `AuthorityPolicy` is passed in and says, per domain, which side the business
 * considers correct when the two disagree. It sets the *recommendation* on
 * each decision and nothing else — the person still presses the button. A
 * business that sells mostly through Booking.com will set
 * `availability: 'channel'`; one that treats its own diary as the book of
 * record sets `estia`. Both are legitimate and neither is this module's to
 * assume, which is exactly why it is a parameter.
 *
 * ── One availability truth ────────────────────────────────────────────────
 *
 * The local side of every availability comparison is `DayAvailability[]` from
 * `src/lib/booking/availability.ts`. This file does not compute overlap, does
 * not know what a minimum stay is, and does not decide which statuses occupy a
 * night. It compares two already-computed answers. A second implementation of
 * "is this night taken" is the failure this whole module is written to avoid.
 */

import type { DayAvailability, DayState } from '../booking/availability'
import type { Agorot } from '../booking/types'

import { CHANNEL_LABEL, type ChannelCode, type ChannelException } from './types'
import { draftException, type ChannelExceptionDraft } from './exceptions'
import type { ListingRef } from './mapping'

/* -------------------------------------------------------------- authority -- */

export const RECONCILIATION_AUTHORITIES = ['estia', 'channel', 'ask'] as const

export type ReconciliationAuthority =
  (typeof RECONCILIATION_AUTHORITIES)[number]

/**
 * Which side the business considers correct, per domain.
 *
 * Three domains and not one, because the answers genuinely differ: most
 * businesses want their own calendar to win on availability and the channel to
 * win on what a guest was actually charged, since the channel is the one that
 * took the money.
 */
export interface AuthorityPolicy {
  availability: ReconciliationAuthority
  rates: ReconciliationAuthority
  reservations: ReconciliationAuthority
}

/** Neither side wins by default. The safe policy, and the one to ship with. */
export const ASK_ALWAYS: AuthorityPolicy = {
  availability: 'ask',
  rates: 'ask',
  reservations: 'ask',
}

/* ------------------------------------------------------------ differences -- */

export const DIFFERENCE_KINDS = [
  /** ESTIA has the night sold; the channel is still offering it. */
  'oversold_risk',
  /** The channel has it closed; ESTIA thinks it is free. Lost nights. */
  'undersold',
  /** Both closed, for different reasons. Worth knowing, not urgent. */
  'blocked_both_ways',
  'rate_differs',
  /** The channel holds a reservation ESTIA has never seen. */
  'reservation_only_at_channel',
  /** ESTIA holds a channel booking the channel no longer lists. */
  'reservation_only_in_estia',
] as const

export type DifferenceKind = (typeof DIFFERENCE_KINDS)[number]

export type RecommendedAction =
  'push_to_channel' | 'accept_from_channel' | 'investigate'

/**
 * `0` first. What the comparison screen sorts on.
 *
 * `oversold_risk` is alone at the top and by a distance: it is the only kind
 * on this list that can put two families in one house.
 */
export const DIFFERENCE_PRIORITY: Readonly<Record<DifferenceKind, number>> = {
  oversold_risk: 0,
  reservation_only_at_channel: 1,
  reservation_only_in_estia: 2,
  undersold: 3,
  rate_differs: 4,
  blocked_both_ways: 5,
}

export interface ReconciliationDecision {
  kind: DifferenceKind
  channelCode: ChannelCode
  listing: ListingRef
  unitId: string
  /** The night in question. `null` for a whole-reservation difference. */
  date: string | null
  /** Hebrew. What ESTIA holds. */
  localSays: string
  /** Hebrew. What the channel holds. */
  channelSays: string
  /** What the authority policy points at. A recommendation, never an action. */
  recommended: RecommendedAction
  /** Hebrew. Why that is the recommendation, in the policy's own terms. */
  rationale: string
  /**
   * Always `false`. See the header — the field exists so that reaching for an
   * automatic resolution finds a refusal rather than nothing.
   */
  automatable: false
  externalReservationId: string | null
  bookingId: string | null
}

export interface ReconciliationReport {
  channelCode: ChannelCode
  listing: ListingRef
  unitId: string
  comparedFrom: string
  comparedTo: string
  decisions: readonly ReconciliationDecision[]
  /** Nights both sides agree on. The denominator that makes a count mean something. */
  nightsAgreed: number
  nightsCompared: number
}

/* ------------------------------------------------------------------ input -- */

/** One night, as the channel reports it. */
export interface ExternalDay {
  date: string
  /** `0` means the channel is not selling that night. */
  unitsAvailable: number
  /** What the channel is asking, when it reports a rate. */
  rateAgorot: Agorot | null
}

/** One reservation the channel says it holds, reduced to what is compared. */
export interface ExternalReservationRef {
  externalReservationId: string
  checkIn: string
  checkOut: string
  cancelled: boolean
}

/** One booking ESTIA holds that came from this channel. */
export interface LocalReservationRef {
  bookingId: string
  externalReservationId: string
  checkIn: string
  checkOut: string
  cancelled: boolean
}

export interface ReconciliationInput {
  organizationId: string
  connectorId: string
  channelCode: ChannelCode
  listing: ListingRef
  unitId: string
  /** From `availabilityCalendar`. The one engine. Never recomputed here. */
  localDays: readonly DayAvailability[]
  externalDays: readonly ExternalDay[]
  /** What ESTIA would ask for these nights, when a rate is known. */
  localRates?: Readonly<Record<string, Agorot>>
  localReservations?: readonly LocalReservationRef[]
  externalReservations?: readonly ExternalReservationRef[]
  authority: AuthorityPolicy
  now: Date
}

/* ----------------------------------------------------------------- engine -- */

export function reconcile(input: ReconciliationInput): ReconciliationReport {
  const decisions: ReconciliationDecision[] = []

  const external = new Map(
    input.externalDays.map((day) => [day.date, day] as const),
  )

  let agreed = 0
  let compared = 0

  for (const local of input.localDays) {
    const remote = external.get(local.date)
    // A night the channel did not report on is not a disagreement. It is a
    // shorter window, and inventing a difference for it would fill the screen
    // with rows about dates nobody asked about.
    if (!remote) continue

    compared += 1

    const localFree = local.state === 'free'
    const remoteFree = remote.unitsAvailable > 0

    if (localFree === remoteFree) {
      agreed += 1
      if (!localFree && local.state !== 'booked') {
        // Both closed, and ESTIA's reason is a block or a hold rather than a
        // sale. Reported at the bottom of the list: not a problem, but the
        // thing somebody looks for when they ask why a week is not selling.
        decisions.push(
          dayDecision(input, local, remote, 'blocked_both_ways', {
            localSays: describeLocal(local.state),
            channelSays: 'סגור למכירה',
            recommended: 'investigate',
            rationale:
              'שני הצדדים סגורים, ולא בגלל הזמנה. שווה לבדוק אם החסימה עדיין נחוצה.',
          }),
        )
      }
    } else if (!localFree && remoteFree) {
      decisions.push(
        dayDecision(input, local, remote, 'oversold_risk', {
          localSays: describeLocal(local.state),
          channelSays: `פתוח למכירה (${remote.unitsAvailable})`,
          // The recommendation is the same whatever the policy says, and the
          // rationale explains why: `channel` authority means "believe the
          // channel about what was sold", never "let the channel resell a
          // night we have already sold to somebody".
          recommended: 'push_to_channel',
          rationale:
            input.authority.availability === 'channel'
              ? 'גם במדיניות שבה הערוץ קובע — ערוץ שמוכר לילה שכבר נמכר אצלך ' +
                'הוא הזמנה כפולה, ולכן ההמלצה היא לסגור אותו שם.'
              : 'הלילה תפוס אצלך והערוץ עדיין מוכר אותו. זו הדרך שבה אותו ' +
                'לילה נמכר פעמיים.',
        }),
      )
    } else {
      decisions.push(
        dayDecision(input, local, remote, 'undersold', {
          localSays: 'פנוי למכירה',
          channelSays: 'סגור בערוץ',
          recommended:
            input.authority.availability === 'channel'
              ? 'accept_from_channel'
              : 'push_to_channel',
          rationale:
            input.authority.availability === 'channel'
              ? 'לפי המדיניות שלך הערוץ קובע — כלומר הלילה באמת אינו למכירה, ' +
                'וכדאי לחסום אותו גם כאן.'
              : 'הלילה פנוי אצלך ואינו נמכר בערוץ. זו הכנסה שאובדת בשקט.',
        }),
      )
    }

    const wanted = input.localRates?.[local.date]
    if (
      wanted !== undefined &&
      remote.rateAgorot !== null &&
      wanted !== remote.rateAgorot
    ) {
      decisions.push(
        dayDecision(input, local, remote, 'rate_differs', {
          localSays: `${wanted} אגורות`,
          channelSays: `${remote.rateAgorot} אגורות`,
          recommended:
            input.authority.rates === 'channel'
              ? 'accept_from_channel'
              : input.authority.rates === 'estia'
                ? 'push_to_channel'
                : 'investigate',
          rationale: rateRationale(input.authority.rates),
        }),
      )
    }
  }

  decisions.push(...reservationDecisions(input))

  return {
    channelCode: input.channelCode,
    listing: input.listing,
    unitId: input.unitId,
    comparedFrom: input.localDays[0]?.date ?? '',
    comparedTo: input.localDays[input.localDays.length - 1]?.date ?? '',
    decisions: [...decisions].sort(byPriority),
    nightsAgreed: agreed,
    nightsCompared: compared,
  }
}

export function byPriority(
  a: ReconciliationDecision,
  b: ReconciliationDecision,
): number {
  const rank = DIFFERENCE_PRIORITY[a.kind] - DIFFERENCE_PRIORITY[b.kind]
  if (rank !== 0) return rank
  return (a.date ?? '').localeCompare(b.date ?? '')
}

/**
 * The exception a difference becomes when nobody has looked at it.
 *
 * Only the kinds that can cost a bed or a booking are promoted. A rate that
 * differs by two shekels is a decision, not an emergency, and putting it in
 * the same queue as a double booking is how the queue stops being read.
 */
export function exceptionsFrom(
  report: ReconciliationReport,
  context: { organizationId: string; connectorId: string; occurredAt: Date },
): readonly ChannelExceptionDraft[] {
  return report.decisions
    .filter(
      (decision) =>
        decision.kind === 'oversold_risk' ||
        decision.kind === 'reservation_only_at_channel',
    )
    .map((decision) =>
      decision.kind === 'oversold_risk'
        ? draftException('availability_mismatch', {
            organizationId: context.organizationId,
            connectorId: context.connectorId,
            channelCode: decision.channelCode,
            occurredAt: context.occurredAt,
            subject: `${decision.unitId}:${decision.date ?? ''}`,
            externalListingId: decision.listing.externalListingId,
            unitId: decision.unitId,
            detail:
              `${decision.date}: אצלך ${decision.localSays}, ` +
              `וב-${CHANNEL_LABEL[decision.channelCode]} ${decision.channelSays}. ` +
              'הלילה הזה יכול להימכר פעמיים.',
          })
        : draftException('unknown_booking', {
            organizationId: context.organizationId,
            connectorId: context.connectorId,
            channelCode: decision.channelCode,
            occurredAt: context.occurredAt,
            subject: decision.externalReservationId ?? decision.unitId,
            externalReservationId: decision.externalReservationId,
            externalListingId: decision.listing.externalListingId,
            unitId: decision.unitId,
            detail:
              `${CHANNEL_LABEL[decision.channelCode]} מחזיק הזמנה ` +
              `${decision.externalReservationId} שאינה קיימת אצלך כלל. ` +
              'התאריכים אינם חסומים.',
          }),
    )
}

/** Open exceptions for this connector, for the header count on the screen. */
export function openFor(
  exceptions: readonly ChannelException[],
  connectorId: string,
): readonly ChannelException[] {
  return exceptions.filter(
    (exception) =>
      exception.connectorId === connectorId &&
      (exception.state === 'open' || exception.state === 'acknowledged'),
  )
}

/* -------------------------------------------------------------- internals -- */

function describeLocal(state: DayState): string {
  switch (state) {
    case 'free':
      return 'פנוי למכירה'
    case 'booked':
      return 'תפוס בהזמנה'
    case 'held':
      return 'מוחזק זמנית'
    case 'blocked':
      return 'חסום'
  }
}

function rateRationale(authority: ReconciliationAuthority): string {
  switch (authority) {
    case 'estia':
      return 'לפי המדיניות שלך המחיר במערכת קובע, ולכן יש לשלוח אותו לערוץ.'
    case 'channel':
      return 'לפי המדיניות שלך המחיר בערוץ קובע — זה מה שהאורח באמת שילם.'
    case 'ask':
      return 'לא הוגדרה מדיניות מחירים. אף צד לא נבחר אוטומטית.'
  }
}

function dayDecision(
  input: ReconciliationInput,
  local: DayAvailability,
  _remote: ExternalDay,
  kind: DifferenceKind,
  parts: {
    localSays: string
    channelSays: string
    recommended: RecommendedAction
    rationale: string
  },
): ReconciliationDecision {
  return {
    kind,
    channelCode: input.channelCode,
    listing: input.listing,
    unitId: input.unitId,
    date: local.date,
    localSays: parts.localSays,
    channelSays: parts.channelSays,
    recommended: parts.recommended,
    rationale: parts.rationale,
    automatable: false,
    externalReservationId: null,
    bookingId: local.bookingId ?? null,
  }
}

function reservationDecisions(
  input: ReconciliationInput,
): readonly ReconciliationDecision[] {
  const local = input.localReservations ?? []
  const external = input.externalReservations ?? []
  if (local.length === 0 && external.length === 0) return []

  const localById = new Map(
    local.map((entry) => [entry.externalReservationId, entry] as const),
  )
  const externalById = new Map(
    external.map((entry) => [entry.externalReservationId, entry] as const),
  )

  const decisions: ReconciliationDecision[] = []

  for (const remote of external) {
    if (remote.cancelled) continue
    if (localById.has(remote.externalReservationId)) continue

    decisions.push({
      kind: 'reservation_only_at_channel',
      channelCode: input.channelCode,
      listing: input.listing,
      unitId: input.unitId,
      date: remote.checkIn,
      localSays: 'אין הזמנה כזו',
      channelSays: `${remote.checkIn} עד ${remote.checkOut}`,
      // Always investigate, whatever the policy. "Accept from channel" here
      // would mean creating a booking from a reconciliation sweep instead of
      // through ingestion, and a second door into `bookings` is the thing this
      // module exists not to build.
      recommended: 'investigate',
      rationale:
        'הזמנה שקיימת רק בערוץ. משוך מחדש את ההזמנות; אם היא עדיין חסרה, ' +
        'זו קליטה שנכשלה ולא הזמנה חדשה.',
      automatable: false,
      externalReservationId: remote.externalReservationId,
      bookingId: null,
    })
  }

  for (const mine of local) {
    if (mine.cancelled) continue
    const remote = externalById.get(mine.externalReservationId)
    if (remote && !remote.cancelled) continue

    decisions.push({
      kind: 'reservation_only_in_estia',
      channelCode: input.channelCode,
      listing: input.listing,
      unitId: input.unitId,
      date: mine.checkIn,
      localSays: `${mine.checkIn} עד ${mine.checkOut}`,
      channelSays: remote ? 'מבוטלת בערוץ' : 'אינה מופיעה בערוץ',
      recommended:
        input.authority.reservations === 'channel'
          ? 'accept_from_channel'
          : 'investigate',
      rationale: remote
        ? 'הערוץ מסמן את ההזמנה כמבוטלת ואצלך היא פעילה. ביטול משחרר ' +
          'תאריכים ומבטל עבודה — לכן הוא לא מוחל אוטומטית.'
        : 'ההזמנה אינה מופיעה יותר בערוץ. ייתכן שהיא בוטלה שם וההודעה אבדה.',
      automatable: false,
      externalReservationId: mine.externalReservationId,
      bookingId: mine.bookingId,
    })
  }

  return decisions
}
