/**
 * The sweep: take what is due, send it, write down what happened.
 *
 * SERVER ONLY — it reaches `sender.ts`, which signs. Not in `index.ts`.
 *
 * ══ IT DECIDES NOTHING ══════════════════════════════════════════════════════
 *
 * `retry.ts` decides whether to try again. `sender.ts` decides whether the
 * address is safe. `subscription.ts` decides what the body is. This file only
 * sequences them and persists the consequence, which is why it is boring and
 * why it can be read in one sitting.
 *
 * ══ ONE TENANT AT A TIME, ALWAYS ════════════════════════════════════════════
 *
 * The sweep runs with no user signed in and therefore on the admin client,
 * with row level security bypassed entirely. `organization_id` is the only
 * tenant boundary left, so the shape is: ask which tenants have work, then
 * take one pass per tenant with that tenant's id in hand. A single global
 * loop over due rows would be shorter and one mistake away from signing one
 * customer's event with another customer's secret.
 *
 * ══ A FAILING TENANT DOES NOT STOP THE SWEEP ════════════════════════════════
 *
 * Each tenant's pass is caught. One organization with an unreadable row must
 * not mean every other organization's webhooks stop for the day — that is the
 * failure mode where a single bad tenant silently takes the feature down for
 * everybody, and nobody notices because the sweep still "ran".
 */

import { attemptDelivery, type WebhookTransport } from './sender'
import { buildEnvelope } from './subscription'
import {
  decideAfterAttempt,
  isSuccess,
  shouldDisableAfterFailures,
} from './retry'
import type { WebhookSenderStore } from './repository'
import type { AttemptOutcome, WebhookDelivery } from './types'

export interface SweepReport {
  readonly tenants: number
  readonly attempted: number
  readonly succeeded: number
  readonly retrying: number
  readonly exhausted: number
  readonly blocked: number
  readonly endpointsDisabled: number
  /** Tenants whose pass threw. Named, not swallowed. */
  readonly failedTenants: readonly string[]
}

const EMPTY: SweepReport = {
  tenants: 0,
  attempted: 0,
  succeeded: 0,
  retrying: 0,
  exhausted: 0,
  blocked: 0,
  endpointsDisabled: 0,
  failedTenants: [],
}

function describe(outcome: AttemptOutcome): string {
  switch (outcome.kind) {
    case 'responded':
      return `the receiver answered ${outcome.statusCode}`
    case 'timed_out':
      return 'the receiver did not answer in time'
    case 'network_error':
      return `the connection failed: ${outcome.detail}`
    case 'unsafe_address':
      return `refused before sending: ${outcome.detail}`
  }
}

/**
 * One delivery, start to finish.
 *
 * Exported for its own tests: the interesting behaviour is here, and a test
 * that has to drive a whole sweep to assert one retry is a test nobody reads.
 */
export async function runOneDelivery(
  delivery: WebhookDelivery,
  store: WebhookSenderStore,
  transport: WebhookTransport,
  now: Date,
): Promise<{
  readonly result: 'succeeded' | 'retrying' | 'exhausted' | 'blocked'
  readonly disabled: boolean
}> {
  const sendable = await store.sendable(
    delivery.organizationId,
    delivery.endpointId,
    now,
  )

  // The endpoint was deleted, paused or disabled after this row was queued.
  // `blocked`, never `exhausted`: nothing was attempted, and counting it as a
  // delivery failure would disable an endpoint for the product's own refusal.
  if (sendable === null || sendable.endpoint.status !== 'active') {
    await store.recordDeliveryOutcome(delivery, {
      status: 'blocked',
      attempts: delivery.attempts,
      nextAttemptAt: null,
      lastStatusCode: null,
      lastError:
        sendable === null
          ? 'the endpoint no longer exists'
          : `the endpoint is ${sendable.endpoint.status}`,
      deliveredAt: null,
    })
    return { result: 'blocked', disabled: false }
  }

  // Rebuilt from the stored row, not from anything live. A retry six hours
  // later must send the body the event had when it happened — re-deriving it
  // would deliver today's answer under yesterday's event.
  const envelope = buildEnvelope(delivery.id, {
    name: delivery.eventName,
    organizationId: delivery.organizationId,
    propertyId: delivery.propertyId,
    correlationId: delivery.correlationId ?? '',
    occurredAt: delivery.createdAt,
    payload: delivery.eventPayload,
  })

  const outcome = await attemptDelivery(
    envelope,
    sendable.endpoint.url,
    sendable.secrets,
    transport,
    now,
  )

  const attempts = delivery.attempts + 1
  const decision = decideAfterAttempt(outcome, attempts, now)
  const statusCode = outcome.kind === 'responded' ? outcome.statusCode : null

  if (isSuccess(outcome)) {
    await store.recordDeliveryOutcome(delivery, {
      status: 'succeeded',
      attempts,
      nextAttemptAt: null,
      lastStatusCode: statusCode,
      lastError: null,
      deliveredAt: now,
    })
    await store.recordEndpointSuccess(
      delivery.organizationId,
      delivery.endpointId,
      now,
    )
    return { result: 'succeeded', disabled: false }
  }

  // An address that became unsafe is not the receiver's failure and must not
  // count toward its streak — but it IS a reason to turn the endpoint off,
  // because it will be unsafe again in five minutes.
  if (outcome.kind === 'unsafe_address') {
    await store.recordDeliveryOutcome(delivery, {
      status: 'blocked',
      attempts,
      nextAttemptAt: null,
      lastStatusCode: null,
      lastError: describe(outcome),
      deliveredAt: null,
    })
    await store.recordEndpointFailure(
      delivery.organizationId,
      delivery.endpointId,
      sendable.endpoint.consecutiveFailures,
      now,
      'address_became_unsafe',
    )
    return { result: 'blocked', disabled: true }
  }

  if (decision.kind === 'retry') {
    await store.recordDeliveryOutcome(delivery, {
      status: 'pending',
      attempts,
      nextAttemptAt: decision.at,
      lastStatusCode: statusCode,
      lastError: describe(outcome),
      deliveredAt: null,
    })
    // The endpoint's streak is untouched until the delivery is finished. A
    // delivery still being retried has not failed yet.
    return { result: 'retrying', disabled: false }
  }

  await store.recordDeliveryOutcome(delivery, {
    status: 'exhausted',
    attempts,
    nextAttemptAt: null,
    lastStatusCode: statusCode,
    lastError: describe(outcome),
    deliveredAt: null,
  })

  const failures = sendable.endpoint.consecutiveFailures + 1
  const disable =
    decision.kind === 'disable_endpoint'
      ? ('receiver_said_gone' as const)
      : shouldDisableAfterFailures(failures)
        ? ('too_many_failures' as const)
        : null

  await store.recordEndpointFailure(
    delivery.organizationId,
    delivery.endpointId,
    failures,
    now,
    disable,
  )

  return { result: 'exhausted', disabled: disable !== null }
}

/**
 * Every tenant with work due, one pass each.
 *
 * `perTenant` bounds one organization's share of a single sweep, so a tenant
 * with ten thousand queued deliveries cannot starve everybody else — the next
 * sweep picks up where this one stopped.
 */
export async function runWebhookSweep(
  store: WebhookSenderStore,
  transport: WebhookTransport,
  now: Date,
  perTenant = 50,
): Promise<SweepReport> {
  const tenants = await store.tenantsWithDueDeliveries(now)
  if (tenants.length === 0) return EMPTY

  let attempted = 0
  let succeeded = 0
  let retrying = 0
  let exhausted = 0
  let blocked = 0
  let endpointsDisabled = 0
  const failedTenants: string[] = []

  for (const organizationId of tenants) {
    try {
      const due = await store.dueDeliveries(organizationId, now, perTenant)
      for (const delivery of due) {
        attempted += 1
        const { result, disabled } = await runOneDelivery(
          delivery,
          store,
          transport,
          now,
        )
        if (result === 'succeeded') succeeded += 1
        else if (result === 'retrying') retrying += 1
        else if (result === 'exhausted') exhausted += 1
        else blocked += 1
        if (disabled) endpointsDisabled += 1
      }
    } catch {
      // Named in the report, never rethrown. One organization with an
      // unreadable row must not stop every other organization's webhooks.
      failedTenants.push(organizationId)
    }
  }

  return {
    tenants: tenants.length,
    attempted,
    succeeded,
    retrying,
    exhausted,
    blocked,
    endpointsDisabled,
    failedTenants,
  }
}
