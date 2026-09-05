/**
 * Turning a routing plan into rows, and rows into attempts.
 *
 * `routing.ts` decides and writes nothing. This is the other half: it persists
 * what was decided and then asks each transport to do its part. The split is
 * what lets every rule in the engine be tested against a table of inputs while
 * this file — which is mostly sequencing — is tested against an in-memory
 * repository and a null transport.
 *
 * ══ IDEMPOTENCY LIVES HERE, IN ONE `if` ═════════════════════════════════════
 *
 *     const { record, created } = await repository.insertNotification(planned)
 *     if (!created) continue
 *
 * That is the whole guarantee, and it is worth being explicit about why it is
 * correct rather than merely present.
 *
 *   · The insert is what claims the key, and the claim is atomic because it is
 *     a unique constraint in Postgres rather than a look-then-write in
 *     JavaScript. Two handlers processing the same redelivered webhook eight
 *     milliseconds apart both reach the insert; exactly one leaves it with
 *     `created: true`. This is the same argument `service/idempotency.ts`
 *     makes about `begin()`, applied to the same problem.
 *
 *   · **Deliveries are written only for a notification this call created.**
 *     A retried handler therefore sends nothing — not "sends and the transport
 *     deduplicates", which would be relying on a provider this product does
 *     not have. If the row was already there, somebody has already been told,
 *     or has already been recorded as not-tellable, and there is nothing left
 *     to do.
 *
 *   · The key itself is stable across retries because it is derived from the
 *     event's own `idempotencyKey`. See `dedupe.ts` for why every part of it
 *     is in there.
 *
 * ══ A TRANSPORT MAY NEVER BREAK THE THING THAT CAUSED IT ════════════════════
 *
 * `service/events.ts` states the rule: "a failed WhatsApp message must not undo
 * a confirmed booking". The port already says `send` must not throw — but a
 * port is a promise and this is where the promise is kept for a transport that
 * breaks it. Every call is wrapped, and a throw becomes a `failed` delivery row
 * with `transport_threw` as its code. Nothing propagates.
 */

import type { NotificationRepository } from './repository'
import type {
  PlannedDelivery,
  PlannedNotification,
  RoutingPlan,
} from './routing'
import type { TransportRegistry, TransportResult } from './transport'
import type { TransactionHandle } from '../service'
import type {
  DeliveryRecord,
  NotificationDeliveryStatus,
  NotificationRecord,
} from './types'

type DeliveryDraft = Omit<
  DeliveryRecord,
  'id' | 'organizationId' | 'notificationId'
>

export interface DispatchOutcome {
  /** Rows this call actually created. */
  created: readonly NotificationRecord[]
  /**
   * Planned notifications the dedupe constraint already held.
   *
   * Not a failure and not an error — see the header. Counted because a spike
   * here means a handler is being redelivered, which is worth being able to
   * see rather than infer.
   */
  duplicates: number
  /** How every delivery this call wrote ended up. */
  tally: Record<NotificationDeliveryStatus, number>
}

export async function dispatch(args: {
  plan: RoutingPlan
  repository: NotificationRepository
  transports: TransportRegistry
  now: Date
  tx?: TransactionHandle
}): Promise<DispatchOutcome> {
  const { plan, repository, transports, now, tx } = args

  const created: NotificationRecord[] = []
  let duplicates = 0
  const tally = {} as Record<NotificationDeliveryStatus, number>

  const count = (status: NotificationDeliveryStatus) => {
    tally[status] = (tally[status] ?? 0) + 1
  }

  for (const planned of plan.notifications) {
    const { record, created: isNew } = await repository.insertNotification(
      planned,
      tx,
    )

    if (!isNew) {
      duplicates += 1
      continue
    }

    created.push(record)

    const drafts: DeliveryDraft[] = []
    for (const delivery of planned.deliveries) {
      const draft = await attempt({
        planned,
        record,
        delivery,
        transports,
        now,
      })
      drafts.push(draft)
      count(draft.status)
    }

    await repository.insertDeliveries(
      planned.organizationId,
      record.id,
      drafts,
      tx,
    )
  }

  return { created, duplicates, tally }
}

/* --------------------------------------------------------- one delivery -- */

async function attempt(args: {
  planned: PlannedNotification
  record: NotificationRecord
  delivery: PlannedDelivery
  transports: TransportRegistry
  now: Date
}): Promise<DeliveryDraft> {
  const { planned, record, delivery, transports, now } = args

  // The engine already settled these three. Nothing is asked of a transport
  // for a channel that was suppressed, deferred or has nothing behind it —
  // asking would be the product doing work it has already decided not to do,
  // and for `not_configured` it would mean instantiating a client that does
  // not exist.
  if (delivery.status !== 'pending') {
    return {
      channel: delivery.channel,
      status: delivery.status,
      attempt: 1,
      scheduledFor: delivery.scheduledFor,
      provider: null,
      providerMessageId: null,
      errorCode: null,
      errorDetail: null,
      suppressedReason: delivery.suppressedReason,
      attemptedAt: null,
      settledAt: null,
    }
  }

  const transport = transports.for(delivery.channel)

  let result: TransportResult
  try {
    result = await transport.send({
      organizationId: planned.organizationId,
      notificationId: record.id,
      channel: delivery.channel,
      to: { userId: planned.recipientUserId },
      severity: planned.severity,
      subject: planned.title,
      body: planned.body,
      actionHref: planned.actionHref,
      correlationId: planned.correlationId,
    })
  } catch (cause) {
    // The port forbids this. Caught anyway, because "the port forbids it" is
    // not a runtime guarantee and a throw from here would reach the operation
    // that raised the event.
    result = {
      status: 'failed',
      provider: delivery.channel,
      errorCode: 'transport_threw',
      errorDetail: cause instanceof Error ? cause.message : String(cause),
      retryable: true,
    }
  }

  return fromResult(delivery.channel, result, now)
}

function fromResult(
  channel: DeliveryDraft['channel'],
  result: TransportResult,
  now: Date,
): DeliveryDraft {
  const base = {
    channel,
    attempt: 1,
    scheduledFor: null,
    providerMessageId: null,
    errorCode: null,
    errorDetail: null,
    suppressedReason: null,
    attemptedAt: now,
  }

  switch (result.status) {
    case 'sent':
      return {
        ...base,
        status: 'sent',
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        // Not settled: a provider that accepted a message may still report a
        // bounce, and a `settled_at` written now would close a row that has
        // not finished happening.
        settledAt: null,
      }

    case 'delivered':
      return {
        ...base,
        status: 'delivered',
        provider: result.provider,
        settledAt: now,
      }

    case 'failed':
      return {
        ...base,
        status: 'failed',
        provider: result.provider,
        errorCode: result.errorCode,
        errorDetail: result.errorDetail,
        settledAt: now,
      }

    case 'not_configured':
      return {
        ...base,
        status: 'not_configured',
        provider: null,
        // Not `attempted_at`: nothing was attempted. A timestamp here would
        // make an empty channel look like a channel that tried.
        attemptedAt: null,
        errorDetail: result.reason,
        settledAt: now,
      }
  }
}
