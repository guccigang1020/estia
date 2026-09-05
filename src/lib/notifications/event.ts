/**
 * The event this module routes, and the bridge from the one the service
 * pipeline publishes.
 *
 * ── There are two `DomainEvent` types in this codebase ────────────────────
 *
 * `src/lib/contracts/events.ts` declares the full envelope: the tenant, the
 * resource, the actor, `occurredAt`, `correlationId` and — the one that
 * matters here — `idempotencyKey`, documented as "stable across retries of the
 * same logical event, so a handler can refuse to act twice".
 *
 * `src/lib/service/events.ts` declares a narrower one, which is what
 * `defineOperation` actually publishes: name, organization, property,
 * correlation, `occurredAt`, payload. No resource, no actor, no idempotency
 * key. That is not an oversight in the pipeline — an operation's own
 * idempotency is handled a layer up, by the store — but it means the published
 * event alone cannot answer "have I already notified about this".
 *
 * So this module consumes the CONTRACT envelope, which is the frozen one, and
 * `notifiableFromServiceEvent` is the single documented place where the
 * narrower one is lifted into it. Whoever calls it has to supply the resource
 * and the key, because those are facts the pipeline does not carry and
 * inventing them here would produce a dedupe key that changes on every retry —
 * which is the same as having none.
 */

import type { DomainEvent as ContractEvent } from '../contracts/events'
import type { DomainEvent as ServiceEvent } from '../service/events'

/** What the routing engine takes. The frozen envelope, unchanged. */
export type NotifiableEvent = ContractEvent<unknown>

/**
 * Lift a published event into the routing envelope.
 *
 * `idempotencyKey` is required and has no default. A default would be the
 * correlation id, and a correlation id is per REQUEST rather than per logical
 * event — so a webhook delivered three times would carry three correlation ids
 * for one event, produce three dedupe keys, and send three messages. The
 * caller knows which key is stable for their event; this function does not.
 */
export function notifiableFromServiceEvent(
  event: ServiceEvent,
  facts: {
    resourceType: string
    resourceId: string
    idempotencyKey: string
    actorUserId?: string | null
  },
): NotifiableEvent {
  return {
    name: event.name,
    organizationId: event.organizationId,
    resourceType: facts.resourceType,
    resourceId: facts.resourceId,
    propertyId: event.propertyId,
    actorUserId: facts.actorUserId ?? null,
    occurredAt: event.occurredAt.toISOString(),
    correlationId: event.correlationId,
    idempotencyKey: facts.idempotencyKey,
    payload: event.payload,
  }
}

/**
 * An optional one-line detail a module may attach to its payload.
 *
 * Read defensively and never required. The message a person sees comes from
 * the catalogue, which is written by hand in Hebrew for each event; this is
 * the place a raising module can add "חדר 4, משפחת לוי" without every payload
 * in the product having to agree on a shape it does not have today.
 *
 * A payload without it is the ordinary case and produces a complete message.
 */
export function eventDetail(event: NotifiableEvent): string | null {
  const payload = event.payload
  if (payload === null || typeof payload !== 'object') return null

  const summary = (payload as Record<string, unknown>).summary
  if (typeof summary !== 'string') return null

  const trimmed = summary.trim()
  return trimmed.length > 0 ? trimmed : null
}
