/**
 * Turning one domain event into the rows that will be sent.
 *
 * Pure. This is the seam that decides a webhook exists at all, and it is
 * deliberately a function rather than something the event bus does inline:
 * the fan-out is the part a person will one day need to explain — "why did
 * my endpoint get three copies", "why did it get none" — and an answer that
 * lives inside a subscriber callback cannot be tested on its own.
 *
 * ══ THE QUEUE IS WRITTEN, NOT THE REQUEST ═══════════════════════════════════
 *
 * A `booking.created` handler must not POST to a customer's server. The
 * pipeline publishes events AFTER the transaction commits and a throwing
 * handler is recorded and never propagated — `service/events.ts` is explicit
 * that a flaky integration must not roll back a guest's reservation. Sending
 * inline would honour the letter of that and break its spirit: an HTTP call
 * with a ten second timeout, inside the request that just created a booking,
 * is a booking screen that hangs for ten seconds because somebody else's
 * server is slow.
 *
 * So this produces ROWS. The sweep sends them, on its own schedule, with its
 * own failures. That is also what makes retry possible at all — an in-process
 * attempt has nowhere to record that it should be tried again in five minutes.
 *
 * ══ ONE ROW PER SUBSCRIBER, NOT ONE PER EVENT ═══════════════════════════════
 *
 * Three endpoints subscribed to `booking.created` produce three deliveries,
 * each with its own id, attempts and next attempt. Sharing one row would mean
 * one slow receiver holding up two fast ones, and a retry re-sending to
 * endpoints that already answered 200.
 */

import type { DomainEvent } from '../service/events'
import { endpointsFor } from './subscription'
import type { WebhookEndpoint } from './types'

/** A row to insert. `id` is assigned by the database and becomes the
 *  receiver's deduplication key. */
export interface PlannedDelivery {
  readonly organizationId: string
  readonly endpointId: string
  readonly eventName: string
  readonly eventPayload: unknown
  readonly propertyId: string | null
  readonly correlationId: string | null
  /** Due immediately. The sweep is what makes "immediately" concrete. */
  readonly nextAttemptAt: Date
}

/**
 * The deliveries one event should produce.
 *
 * Returns an empty array when nothing subscribes, which is the overwhelmingly
 * common case — most organizations have no endpoints, and every event in the
 * product passes through here.
 */
export function planDeliveries(
  event: DomainEvent,
  endpoints: readonly WebhookEndpoint[],
  now: Date,
): readonly PlannedDelivery[] {
  return endpointsFor(event, endpoints).map((endpoint) => ({
    organizationId: event.organizationId,
    endpointId: endpoint.id,
    eventName: event.name,
    eventPayload: event.payload,
    propertyId: event.propertyId,
    correlationId: event.correlationId,
    nextAttemptAt: now,
  }))
}

/**
 * The same, for a batch — the shape `EventBus.publish` actually hands over.
 *
 * Flattened deliberately: the caller inserts once rather than once per event,
 * because an operation that emits four events with two subscribers should
 * cost one round trip and not eight.
 */
export function planDeliveriesForBatch(
  events: readonly DomainEvent[],
  endpoints: readonly WebhookEndpoint[],
  now: Date,
): readonly PlannedDelivery[] {
  return events.flatMap((event) => planDeliveries(event, endpoints, now))
}
