/**
 * Which endpoints hear an event, and what they are sent.
 *
 * Pure. No database, no clock beyond what is handed in, no network. The
 * sender does the I/O; this decides what the I/O should be.
 *
 * ══ THE ENVELOPE IS FIXED AND THE PAYLOAD IS NOT ENRICHED ═══════════════════
 *
 * A delivery is the domain event, wrapped:
 *
 *     { id, type, createdAt, organizationId, propertyId, data }
 *
 * `data` is the event's own payload, **verbatim**. This module never reads a
 * row to "helpfully" attach the guest's phone number or the booking's total,
 * and that restraint is the module's main privacy control: whatever a webhook
 * can leak is bounded by what the emitting operation already chose to put in
 * a domain event, which is a decision made once, in the domain, by somebody
 * thinking about that event.
 *
 * The alternative — an enriching sender — means every new webhook subscriber
 * silently widens what leaves the building, and no single file decides it.
 *
 * ══ AN EMPTY SUBSCRIPTION MEANS NOTHING, NEVER EVERYTHING ═══════════════════
 *
 * `matches` returns false for an endpoint with no events. The other reading —
 * empty means wildcard — is the shape of accident where a half-configured
 * endpoint starts receiving every guest's details the moment it is saved.
 * There is no wildcard in this module at all.
 */

import type { DomainEvent, DomainEventName } from '../service/events'
import type { WebhookEndpoint } from './types'

/** The body a receiver gets, before serialisation. */
export interface WebhookEnvelope {
  readonly id: string
  readonly type: DomainEventName
  readonly createdAt: string
  readonly organizationId: string
  readonly propertyId: string | null
  readonly data: unknown
}

/** Does this endpoint want this event, and is it in a state to receive? */
export function matches(
  endpoint: WebhookEndpoint,
  eventName: DomainEventName,
): boolean {
  if (endpoint.status !== 'active') return false
  if (endpoint.events.length === 0) return false
  return endpoint.events.includes(eventName)
}

/**
 * What a webhook needs from an event, and deliberately nothing more.
 *
 * ── Two reasons this is a `Pick` and not `DomainEvent` ────────────────────
 *
 * The envelope goes to somebody else's server. `DomainEvent` now carries
 * `actorUserId` — an id in `auth.users` — and a function that took the whole
 * event would be one careless spread away from sending a customer's internal
 * user ids to a third party. The type is the guard: what is not in it cannot
 * leave.
 *
 * And a retry rebuilds this from a stored `webhook_deliveries` row, which has
 * five of these fields and none of the other three. A parameter that demanded
 * them would force the replay path to invent an actor and a resource for an
 * event that happened six hours ago.
 */
export type PublishedEvent = Pick<
  DomainEvent,
  'name' | 'organizationId' | 'propertyId' | 'occurredAt' | 'payload'
>

/**
 * The endpoints one event should be delivered to.
 *
 * The organization is asserted rather than assumed. Everything else in this
 * module trusts its caller; this is the one place where getting it wrong
 * sends one tenant's booking to another tenant's server, so it is checked
 * here even though the query that produced `endpoints` filtered already.
 */
export function endpointsFor(
  event: PublishedEvent,
  endpoints: readonly WebhookEndpoint[],
): readonly WebhookEndpoint[] {
  return endpoints.filter(
    (endpoint) =>
      endpoint.organizationId === event.organizationId &&
      matches(endpoint, event.name),
  )
}

/**
 * The envelope for one event.
 *
 * `id` is the DELIVERY's id and is stable across retries, which is what lets
 * a receiver deduplicate. A receiver that sees the same id twice has seen one
 * event twice, and at-least-once delivery makes that a promise rather than an
 * edge case: a 200 that never reached us is indistinguishable from a timeout,
 * so the retry is correct and the duplicate is real.
 */
export function buildEnvelope(
  deliveryId: string,
  event: PublishedEvent,
): WebhookEnvelope {
  return {
    id: deliveryId,
    type: event.name,
    createdAt: event.occurredAt.toISOString(),
    organizationId: event.organizationId,
    propertyId: event.propertyId,
    data: event.payload,
  }
}

/**
 * The exact bytes that will be sent, and therefore the exact bytes signed.
 *
 * One function, so the signer and the sender cannot disagree. `signature.ts`
 * says it in the other direction: sign the string that will be sent, and do
 * not touch it afterwards. Anything that re-serialises between the two has
 * signed something the receiver will never see.
 */
export function serialiseEnvelope(envelope: WebhookEnvelope): string {
  return JSON.stringify(envelope)
}
