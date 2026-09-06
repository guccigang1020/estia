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
 * ══ IT IS ADDITIVE, AND DELIBERATELY QUIET FOR NOW ══════════════════════════
 *
 * Webhooks is the only subscriber wired here. Notifications and automations
 * are the obvious next two and are NOT turned on in the same change: this bus
 * begins publishing events that nothing has published before, and starting
 * three consumers at once means any surprise has three possible causes. They
 * are one `subscribers` entry each when their own wiring is ready.
 *
 * A failure here never reaches the operation. `operation.ts` catches, reports
 * through `onEventError` and never rethrows — "a confirmation email that fails
 * must not un-create the booking". This file keeps that promise per event, so
 * one endpoint's problem cannot stop another event in the same batch.
 */

import type { Db } from '@/lib/persistence'
import type { DomainEvent, EventBus } from '@/lib/service'

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
        try {
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
          if (error) failures.push(error)
        } catch (error) {
          failures.push(error)
        }
      }

      // Collected and thrown together, never swallowed here. The pipeline is
      // what decides a failed event must not fail the operation — a bus that
      // absorbed everything itself would leave that guarantee untested, which
      // is the argument `InMemoryEventBus` makes about its own behaviour.
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `${failures.length} of ${events.length} domain event(s) could not be queued`,
        )
      }
    },
  }
}
