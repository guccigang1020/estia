/**
 * The webhook vocabulary.
 *
 * ══ WHAT THIS MODULE IS, AND WHAT IT IS NOT ═════════════════════════════════
 *
 * OUTBOUND only. A business registers an endpoint, subscribes it to some of
 * the domain events in `contracts/events.ts`, and ESTIA POSTs each matching
 * event to it, signed.
 *
 * It is **not** the inbound public API. That needs an API credential, a rate
 * limit and a read model, and it is deliberately not started here — §164 says
 * one module at a time. It is also **not** the channel manager's inbound
 * webhook: `channel_connections` already carries `receive_webhooks` and
 * `last_webhook_at`, that is somebody else's traffic arriving, and confusing
 * the two directions in one module is how a receiver ends up able to trigger
 * a send.
 *
 * ══ THE EVENT NAMES ARE NOT REDECLARED HERE ═════════════════════════════════
 *
 * A subscription's `events` are `DomainEventName`, imported from the frozen
 * catalogue. `service/events.ts` records what happened the one time this was
 * loosened to a template literal: fifteen event names were emitted that no
 * subscriber could ever hear, and every one passed a clean typecheck. A
 * webhook subscription to an event that does not exist is the same failure
 * wearing a customer's clothes — they would configure it, see no deliveries,
 * and conclude the product is broken.
 */

import type { DomainEventName } from '../contracts/events'

/* ------------------------------------------------------------ endpoints -- */

export const WEBHOOK_ENDPOINT_STATUSES = [
  /** Receiving deliveries. */
  'active',
  /** Paused by a person. Events are not queued while paused — see below. */
  'paused',
  /** Turned off by the product after sustained failure, or by the receiver
   *  answering 410. Needs a human to re-enable. */
  'disabled',
] as const

export type WebhookEndpointStatus = (typeof WEBHOOK_ENDPOINT_STATUSES)[number]

/**
 * Why the product turned an endpoint off. Null when a person did it.
 *
 * Recorded rather than inferred: "why did my webhook stop" is the first
 * question, and "we noticed it failing" is not an answer somebody can act on.
 */
export const WEBHOOK_DISABLE_REASONS = [
  'too_many_failures',
  'receiver_said_gone',
  'address_became_unsafe',
] as const

export type WebhookDisableReason = (typeof WEBHOOK_DISABLE_REASONS)[number]

export interface WebhookEndpoint {
  readonly id: string
  readonly organizationId: string
  readonly url: string
  readonly description: string | null
  /** Subscribed events. Empty means nothing is delivered, never "everything":
   *  a wildcard that arrives by accident is a data leak with a shrug. */
  readonly events: readonly DomainEventName[]
  readonly status: WebhookEndpointStatus
  readonly disabledReason: WebhookDisableReason | null
  readonly consecutiveFailures: number
  readonly lastSuccessAt: Date | null
  readonly lastFailureAt: Date | null
  readonly createdAt: Date
  readonly version: number
}

/* ----------------------------------------------------------- deliveries -- */

export const WEBHOOK_DELIVERY_STATUSES = [
  /** Waiting for its first attempt, or for the next one after a failure. */
  'pending',
  /** The receiver answered 2xx. Terminal. */
  'succeeded',
  /** Every attempt is spent. Terminal, and the endpoint's failure count
   *  carries the consequence. */
  'exhausted',
  /** Refused before anything was sent — an unsafe address, a disabled
   *  endpoint. Terminal, and deliberately NOT `exhausted`: nothing was
   *  attempted, and counting it as a delivery failure would disable an
   *  endpoint for the product's own refusal. */
  'blocked',
] as const

export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number]

export interface WebhookDelivery {
  readonly id: string
  readonly organizationId: string
  readonly endpointId: string
  readonly eventName: DomainEventName
  /** The event's payload, stored so a retry sends the same body a week
   *  later. The alternative — re-deriving it at send time — would deliver
   *  today's answer under yesterday's event, which is worse than not
   *  delivering. */
  readonly eventPayload: unknown
  readonly propertyId: string | null
  /** The same id as the operation, the audit row and the log line. */
  readonly correlationId: string | null
  readonly status: WebhookDeliveryStatus
  readonly attempts: number
  readonly nextAttemptAt: Date | null
  readonly lastStatusCode: number | null
  readonly lastError: string | null
  readonly createdAt: Date
  readonly deliveredAt: Date | null
}

/**
 * What actually happened on one attempt.
 *
 * A transport failure is not a status code, and modelling it as `0` would
 * make "connection refused" and "the receiver answered 0" the same row.
 */
export type AttemptOutcome =
  | { readonly kind: 'responded'; readonly statusCode: number }
  | { readonly kind: 'timed_out' }
  | { readonly kind: 'network_error'; readonly detail: string }
  | { readonly kind: 'unsafe_address'; readonly detail: string }
