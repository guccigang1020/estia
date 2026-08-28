/**
 * The agent's availability calendar.
 *
 * This is the single most dangerous read path in the product, and it is short
 * on purpose.
 *
 * ── Two calendars, not one ────────────────────────────────────────────────
 *
 * | the internal diary                        | the availability diary |
 * | ----------------------------------------- | ---------------------- |
 * | guest name · price paid · source · booking | free / taken           |
 * | ids · financials                           |                        |
 * | staff only                                 | what an agent sees     |
 *
 * An agent handed the internal diary "so it is convenient for them" has been
 * handed the business's customer list and its pricing structure — and they sell
 * for four competitors this afternoon. `ARCHITECTURE.md` §12 calls this the
 * module's most dangerous failure point, and it is right: the leak is not a bug
 * that throws, it is a field that quietly rides along in a response nobody
 * re-reads after the day it was written.
 *
 * ── How this file is isolated ─────────────────────────────────────────────
 *
 * Not by filtering. A filter is a list of fields to remove, which means every
 * field added to a booking in the next three years is a field somebody must
 * remember to add to that list — and the day they forget, it ships.
 *
 * Instead the agent's answer has **its own type**, `AgentAvailabilityDay`, with
 * exactly two properties: a date and a two-valued state. Every day returned is
 * *constructed*, field by field, from those two values. There is no spread, no
 * `delete`, no `Omit<>` over an internal shape, and no path by which an
 * internal object reaches a caller — so a new column on `bookings` cannot
 * appear here, because nothing here copies objects.
 *
 * What is *reused* is the arithmetic. `availabilityCalendar` in
 * `booking/availability.ts` decides what "occupied" means, over
 * `OCCUPYING_STATUSES` and live holds, and this file calls it. A second
 * availability engine would be two definitions of "free", and the day they
 * disagreed the product would either double-book or refuse a sellable night.
 * Reuse the engine; do not reuse the answer's shape.
 *
 * ── `taken` never says by whom ────────────────────────────────────────────
 *
 * The internal calendar distinguishes `booked`, `held` and `blocked`. All three
 * collapse to `unavailable` here. That is not laziness — telling an agent a
 * date is *held* tells them a rival agent is mid-deal on it, which is
 * commercial intelligence about another of the business's sellers. §4.4-א of
 * the 5.0 specification settles the open question in §15 the same way: not
 * available never says who, and never says how much.
 */

import {
  availabilityCalendar,
  checkAvailability,
  type AvailabilityOptions,
  type AvailabilitySource,
  type AvailabilityWindow,
} from '../booking/availability'
import type { DateRange } from '../booking/types'
import { assertCan, type Actor } from '../authz/can'
import { assertAgentReach, type AgentInventoryTarget } from './types'

// ── What an agent is allowed to be told ───────────────────────────────────

/**
 * Free, or not free.
 *
 * Two values, and there will not be a third. Anything finer — `booked` versus
 * `held`, or a reason — is information about the business's other dealings.
 */
export type AgentDayState = 'free' | 'unavailable'

/**
 * One day, as an agent may see it.
 *
 * The whole security property of this module is that this interface has two
 * properties and that nothing widens it. An index signature, an optional
 * `bookingId`, a `note` "just for debugging" — any of those reopens the leak,
 * and the test suite asserts the exact key set of every object returned so that
 * adding one fails a test rather than shipping.
 */
export interface AgentAvailabilityDay {
  date: string
  state: AgentDayState
}

/** Whether a whole stay can be sold, without saying what is in the way. */
export interface AgentSellability {
  sellable: boolean
  nights: number
  /** Agent-safe reasons. Never a booking reference and never a hold id. */
  reasons: readonly AgentBlockerReason[]
}

/**
 * Why an agent cannot sell these dates, in terms they are entitled to.
 *
 * `unavailable` covers a booking and a hold together, deliberately — the
 * internal engine distinguishes them and this must not. The rest are facts
 * about the *unit's own rules*, which an agent needs in order to sell it at
 * all: a three-night minimum is not a secret, it is the product.
 */
export type AgentBlockerReason =
  | 'unavailable'
  | 'minimum_nights'
  | 'no_arrival'
  | 'no_departure'
  | 'invalid_range'
  | 'unknown_unit'

export const AGENT_BLOCKER_MESSAGE: Record<AgentBlockerReason, string> = {
  unavailable: 'התאריכים אינם פנויים.',
  minimum_nights: 'השהות קצרה מהמינימום שנדרש בתאריכים אלה.',
  no_arrival: 'לא ניתן להגיע בתאריך זה.',
  no_departure: 'לא ניתן לעזוב בתאריך זה.',
  invalid_range: 'תאריך העזיבה חייב להיות מאוחר מתאריך ההגעה.',
  unknown_unit: 'היחידה אינה זמינה למכירה.',
}

// ── The read path ─────────────────────────────────────────────────────────

export interface AgentAvailabilityRequest {
  unit: AgentInventoryTarget
  range: DateRange
}

/**
 * Free/busy for an agent, for one unit, over a window.
 *
 * Two gates before any data is read, and they answer different questions:
 *
 *   1. `assertCan(actor, 'availability.view')` — does this person hold the
 *      right at all, and has their organization bought the feature? A referral
 *      agent fails here, because their calendar rung is `none` and the ladder
 *      never granted it.
 *   2. `assertAgentReach` — is this unit inside their inventory scope? This is
 *      the `inventory` family override, decided by the one engine, and it is
 *      also the cross-tenant check: an agent of organization A asking about a
 *      unit of organization B is refused as *not found*.
 *
 * The order matters. The permission is settled before a single row is read, so
 * a refusal cannot be undermined by a load that throws, logs or has a side
 * effect — and an agent with no right learns nothing about whether the unit
 * exists.
 */
export async function agentAvailabilityCalendar(
  actor: Actor,
  source: AvailabilitySource,
  request: AgentAvailabilityRequest,
  options: AvailabilityOptions,
): Promise<readonly AgentAvailabilityDay[]> {
  assertCan(actor, 'availability.view')
  assertAgentReach(actor, request.unit)

  const window: AvailabilityWindow = {
    organizationId: request.unit.organizationId,
    unitId: request.unit.unitId,
    range: request.range,
  }

  const days = await availabilityCalendar(source, window, options)

  // The projection. Each day is built from exactly two reads of the internal
  // object — never copied, never spread — so nothing on it can travel outward
  // by accident, today or after somebody adds a field to `DayAvailability`.
  return days.map((day) => ({
    date: day.date,
    state: day.state === 'free' ? ('free' as const) : ('unavailable' as const),
  }))
}

/**
 * Can this agent sell this stay?
 *
 * The quick-search answer. It runs the shared `checkAvailability` and then
 * throws its result away except for the shape of the refusal, because the
 * internal blockers are **not safe to forward**: a `booking` blocker's message
 * reads "התאריכים תפוסים על ידי הזמנה BK-1043", which hands an agent a booking
 * reference belonging to somebody else's sale, and a `hold` blocker's message
 * announces that a rival is mid-deal. Both collapse to `unavailable` with a
 * message of this module's own.
 *
 * Reasons are de-duplicated, so five occupied nights are one sentence rather
 * than five identical ones.
 */
export async function agentCanSell(
  actor: Actor,
  source: AvailabilitySource,
  request: AgentAvailabilityRequest,
  options: AvailabilityOptions,
): Promise<AgentSellability> {
  assertCan(actor, 'availability.view')
  assertAgentReach(actor, request.unit)

  const result = await checkAvailability(
    source,
    {
      organizationId: request.unit.organizationId,
      unitId: request.unit.unitId,
      range: request.range,
    },
    options,
  )

  const reasons = new Set<AgentBlockerReason>()
  for (const blocker of result.blockers) {
    reasons.add(toAgentReason(blocker.kind))
  }

  return {
    sellable: result.available,
    nights: result.nights,
    reasons: [...reasons],
  }
}

/**
 * Internal blocker kind → what an agent may be told.
 *
 * Written as a total mapping rather than a filter with a default, so a blocker
 * kind added to the availability engine tomorrow is a **compile error here**
 * rather than a value that falls through to whatever the default happened to
 * be. That is the difference between this file failing loudly when the engine
 * grows and it leaking quietly.
 */
const AGENT_REASON: Record<
  | 'invalid_range'
  | 'unknown_unit'
  | 'booking'
  | 'hold'
  | 'blocked_date'
  | 'no_arrival'
  | 'no_departure'
  | 'minimum_nights',
  AgentBlockerReason
> = {
  invalid_range: 'invalid_range',
  unknown_unit: 'unknown_unit',
  // The three that must never be distinguishable from one another.
  booking: 'unavailable',
  hold: 'unavailable',
  blocked_date: 'unavailable',
  no_arrival: 'no_arrival',
  no_departure: 'no_departure',
  minimum_nights: 'minimum_nights',
}

function toAgentReason(kind: keyof typeof AGENT_REASON): AgentBlockerReason {
  return AGENT_REASON[kind]
}

/**
 * The Hebrew sentence for a refusal, built only from agent-safe reasons.
 *
 * Exists so that no call site is tempted to reach for the internal blocker's
 * `message` field, which is the one that carries the booking reference.
 */
export function describeAgentRefusal(result: AgentSellability): string {
  if (result.sellable) return ''
  return result.reasons.map((reason) => AGENT_BLOCKER_MESSAGE[reason]).join(' ')
}
