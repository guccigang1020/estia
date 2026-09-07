/**
 * Domain events.
 *
 * The last step of an operation, and the only optional one. `booking.created`
 * sends a confirmation, opens a cleaning task and pings the channel manager —
 * all things that matter, none of which are the booking.
 *
 * That distinction is the whole design. A confirmation email that fails must
 * not un-create the booking. So events are published *after* the transaction
 * commits, and a handler that throws is recorded and reported, never
 * propagated. The alternative — one flaky integration rolling back a guest's
 * reservation — is a much worse product than one that occasionally has to
 * resend an email.
 */

/**
 * The event catalogue, re-exported rather than restated.
 *
 * This was once a permissive `` `${string}.${string}` ``, and the cost was
 * concrete: fifteen event names were emitted that no subscriber could ever
 * hear, and every one of them passed a clean typecheck.
 *
 * Two engineers wrote this kind of code at the same time. The one who took
 * the type from here invented twelve names; the one who took it from
 * `contracts/events` found the catalogue lacked what they needed and left a
 * note asking for it instead. The only difference between them was which file
 * the type came from — which is the entire argument for a single source.
 *
 * Adding an event now means adding it to `contracts/events.ts`, where
 * automations, notification routing and `ALERT_EVENTS` can all see it.
 */
import type { DomainEventName } from '../contracts/events'

export type { DomainEventName }

/** What an operation declares. The pipeline stamps the rest. */
export interface DomainEventDraft<T = unknown> {
  name: DomainEventName
  payload: T
  propertyId?: string | null
}

export interface DomainEvent<T = unknown> {
  name: DomainEventName
  organizationId: string
  propertyId: string | null
  /** The same id as the operation, the audit event and the log line. */
  correlationId: string
  occurredAt: Date
  payload: T

  /**
   * Who caused it. Null for an event with no person behind it — a scheduled
   * job, a sweep, an inbound webhook.
   *
   * ── Why this is on the envelope and not left to the subscriber ──────────
   *
   * A subscriber that acts on an event has to act under SOMEBODY'S authority.
   * The automation engine asks `holdsGrant` per action — the same question a
   * button asks — and without this field there is nobody to ask about, so the
   * performing half could not be wired at all. Reading the session inside the
   * subscriber instead would work today and would be wrong tomorrow: an event
   * republished by a sweep would be attributed to whoever happened to be
   * signed in when the sweep ran.
   *
   * Null is a real answer and not a hole. A subscriber that needs an actor
   * must refuse rather than substitute one.
   */
  actorUserId: string | null

  /**
   * What the event is about, in the same words the audit record uses.
   *
   * `resourceType` is the operation's own declaration. `resourceId` is
   * whatever the audit record asserted — which for a creation is the id that
   * was just made, and is null only where the operation itself recorded none.
   * Taken from the audit event rather than derived a second time, so a
   * timeline and an event stream cannot disagree about which row they are
   * describing.
   */
  resourceType: string
  resourceId: string | null
}

export interface EventBus {
  publish(events: readonly DomainEvent[]): Promise<void>
}

export type EventHandler = (event: DomainEvent) => void | Promise<void>

/**
 * A bus that dispatches in-process.
 *
 * Note what it does *not* do: it does not swallow handler failures. It
 * collects them and throws, because the guarantee that a failing handler
 * cannot break an operation belongs to the service pipeline, and a bus that
 * quietly absorbed everything would leave that guarantee untested — passing
 * for the wrong reason is the same as not testing it.
 */
export class InMemoryEventBus implements EventBus {
  readonly published: DomainEvent[] = []
  private readonly handlers = new Map<string, EventHandler[]>()

  /** `'*'` subscribes to everything. */
  subscribe(name: DomainEventName | '*', handler: EventHandler): void {
    const existing = this.handlers.get(name)
    if (existing) existing.push(handler)
    else this.handlers.set(name, [handler])
  }

  async publish(events: readonly DomainEvent[]): Promise<void> {
    const failures: unknown[] = []

    for (const event of events) {
      this.published.push(event)
      const handlers = [
        ...(this.handlers.get(event.name) ?? []),
        ...(this.handlers.get('*') ?? []),
      ]
      for (const handler of handlers) {
        try {
          await handler(event)
        } catch (error) {
          failures.push(error)
        }
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${failures.length} domain event handler(s) failed`,
      )
    }
  }
}

/** A bus that discards. For operations run where nothing should react. */
export const nullEventBus: EventBus = {
  async publish() {
    /* deliberately nothing */
  },
}
