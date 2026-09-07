/**
 * EXECUTION CONTEXT — SERVER ONLY. The event bus the product had never had.
 *
 * ══ WHAT WAS FOUND ══════════════════════════════════════════════════════════
 *
 * `OperationServices.events` is optional, and `operation.ts` falls back to
 * `nullEventBus` when it is absent. Every one of the twenty wiring files in
 * this app supplied `audit`, `idempotency`, `transactions` and an
 * `onEventError` handler — and none of them supplied `events`.
 * `InMemoryEventBus` was constructed only in tests.
 *
 * So no domain event had ever been published in the running product. Every
 * `events()` callback in every operation computed a value and handed it to a
 * bus that discarded it. The notification catalogue routes forty-odd names
 * nobody emitted; `ALERT_EVENTS` escalation could not fire;
 * `automation/engine.ts` waits on a stream that was never fed.
 *
 * That is the same failure Autopilot was found in — five complete stages and
 * nothing that ran them — one level lower, and it is what this file closes.
 *
 * ══ WHY THIS DOES NOT REACH FOR A SERVICE-ROLE CLIENT ═══════════════════════
 *
 * A booking clerk holds neither `integration.manage` nor any INSERT on
 * `webhook_deliveries`, and both refusals are correct. The obvious fix — hand
 * the request path an admin client and fan out in TypeScript — would put a
 * credential that bypasses row level security into twenty modules so that a
 * feature most tenants do not use can queue a row.
 *
 * The fan-out is a `SECURITY DEFINER` function instead
 * (`enqueue_webhook_deliveries`, 0061), which checks membership explicitly
 * because RLS is bypassed inside it. This bus calls it with the CALLER'S
 * client. Nothing privileged enters a user request.
 *
 * ══ IT IS ADDITIVE, AND DELIBERATELY QUIET ══════════════════════════════════
 *
 * Three subscribers, in order, and the third is the only one that can change
 * anything outside this product.
 *
 *   · `webhooks` — the fan-out to a customer's own servers.
 *   · `automations` — the EVALUATION half. It resolves which rules are on for
 *     the organization, evaluates their conditions and records what each one
 *     DECIDED (`automation_runs`, 0075). It performs nothing, ever.
 *   · `automations:performing` — the half that acts, and it is reachable
 *     rather than switched on. It refuses unless the organization has
 *     consented on a screen (`automation_execution_consent`, written by a
 *     named human), the event says who caused it, and a handler exists for
 *     every action the enabled rules need. No organization has consented,
 *     because there are no organizations.
 *
 * The split between the second and the third is the whole reason this is safe.
 * Nothing here can be watched working before it reaches a paying customer, and
 * a runner that acted untested against real data would message somebody's
 * guests on their first day. So the decisions are recorded live from the start
 * — that is the trail a person reads for a week before trusting any of it —
 * and the acting is behind a switch they turn on once they can watch it.
 *
 * The order matters: the third stamps `performed_at` on the row the second
 * writes, and `automation_run_performed` refuses a stamp with nothing to
 * attach to.
 *
 * Notifications remains the obvious next one and is NOT turned on in the same
 * change, for the reason this header gave about starting consumers all at
 * once: it is one `SUBSCRIBERS` entry when its own wiring is ready.
 *
 * ══ ONE SUBSCRIBER'S FAILURE IS ONLY ITS OWN ════════════════════════════════
 *
 * A failure here never reaches the operation. `operation.ts` catches, reports
 * through `onEventError` and never rethrows — "a confirmation email that fails
 * must not un-create the booking". This file keeps that promise per event AND
 * per subscriber: an automation rule that throws must not stop the webhook
 * fan-out for the same event, and neither may stop the next event in the batch.
 * Every failure is collected and thrown together at the end, exactly as before,
 * because deciding that a failed event does not fail the operation is the
 * pipeline's job and a bus that absorbed everything itself would leave that
 * guarantee untested.
 */

import { recordAutomationEvaluation } from '@/lib/automation/runs'
import type { Db } from '@/lib/persistence'
import type { DomainEvent, EventBus } from '@/lib/service'

import { performAutomations } from './automation-performing'

/** One consumer of the stream. Named, so a failure can say whose it was. */
interface Subscriber {
  name: string
  deliver: (db: Db, event: DomainEvent) => Promise<void>
}

/**
 * Everything that reacts to a domain event, in order.
 *
 * A list rather than a chain of `await`s, so that adding the third consumer is
 * an entry rather than an edit to the loop — and so that the isolation between
 * them is written once instead of once per subscriber.
 */
const SUBSCRIBERS: readonly Subscriber[] = [
  {
    name: 'webhooks',
    async deliver(db, event) {
      const { error } = await db.rpc('enqueue_webhook_deliveries', {
        p_organization_id: event.organizationId,
        p_event_name: event.name,
        // `?? null` rather than `?? {}`: an event with no payload has no
        // payload, and inventing an empty object would tell a receiver
        // something the emitting operation did not say.
        p_payload: event.payload ?? null,
        p_property_id: event.propertyId,
        p_correlation_id: event.correlationId,
      })
      if (error) throw error
    },
  },
  {
    name: 'automations',
    // Records what the rules decided. Performs nothing — see the header and
    // `src/lib/automation/performing.ts`. Costs no round trip for the ninety-odd
    // catalogue names no shipped rule listens to, because the check against the
    // frozen library is local.
    deliver: async (db, event) => {
      await recordAutomationEvaluation(db, event)
    },
  },
  {
    name: 'automations:performing',
    // AFTER the entry above, and the order is load-bearing: the stamp this
    // writes attaches to the decision row that one creates.
    //
    // Still performs nothing for anybody. `performAutomations` refuses unless
    // the organization has consented on a screen, the event names who caused
    // it, and a handler exists for every action the enabled rules need — and
    // no organization has consented, because there are no organizations. The
    // gates are listed in that file's header; this entry is only what makes
    // them reachable at all.
    deliver: async (db, event) => {
      await performAutomations(db, event)
    },
  },
]

/**
 * The production bus.
 *
 * Built per request from the caller's client, like everything else in
 * `wiring.ts`: one shared instance would be one shared identity.
 */
export function domainEventBus(db: Db): EventBus {
  return {
    async publish(events: readonly DomainEvent[]): Promise<void> {
      const failures: unknown[] = []

      for (const event of events) {
        for (const subscriber of SUBSCRIBERS) {
          try {
            await subscriber.deliver(db, event)
          } catch (error) {
            // Caught per subscriber, not per event. A rule that throws must not
            // cost the customer their webhook delivery, and neither may stop
            // the next event in the batch.
            failures.push(
              error instanceof Error
                ? new Error(
                    `${subscriber.name} failed for ${event.name}: ${error.message}`,
                    { cause: error },
                  )
                : error,
            )
          }
        }
      }

      // Collected and thrown together, never swallowed here. The pipeline is
      // what decides a failed event must not fail the operation — a bus that
      // absorbed everything itself would leave that guarantee untested, which
      // is the argument `InMemoryEventBus` makes about its own behaviour.
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `${failures.length} domain event subscriber call(s) failed across ${events.length} event(s)`,
        )
      }
    },
  }
}
