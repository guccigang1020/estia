/**
 * EXECUTION CONTEXT — SERVER ONLY. The subscriber that lets automations act.
 *
 * ══ READ THE GATES BEFORE READING THE CODE ══════════════════════════════════
 *
 * Wiring this in changes nothing for anybody today, and that is deliberate.
 * Five things must all be true before a single action is performed, and any one
 * of them turns this function into an early `return`:
 *
 *   1. **A rule listens to this event.** Checked locally against the frozen
 *      library, so the ninety-odd catalogue names no template mentions cost
 *      nothing — not a round trip, not a consent read.
 *   2. **The event says who caused it.** An automation runs under a person's
 *      authority; an event with no actor has nobody to run as.
 *   3. **The organization consented.** `automation_execution_consent`, written
 *      by a named human on a screen. Absent for every organization that
 *      exists, and there are none.
 *   4. **A handler exists for every action the enabled rules need.**
 *      `executionReadiness` refuses the WHOLE run when one is missing, rather
 *      than performing the half it can. Half a rule is worse than none: a
 *      business that sees the task opened assumes the guest was messaged.
 *   5. **The actor holds the grant.** Per action, asked by the engine with
 *      `holdsGrant` — the same question a button asks. An automation is not a
 *      way around the authorization engine, and row level security refuses
 *      underneath regardless.
 *
 * ══ WHOSE AUTHORITY IT RUNS UNDER ═══════════════════════════════════════════
 *
 * The person the audit trail names for the operation that raised the event,
 * resolved through the same `resolveActor` a request uses. Not a service role,
 * not an elevated identity: an automation may do what that person could have
 * done by hand, and nothing more. A receptionist who cannot open tasks does not
 * acquire the right by triggering a rule that opens one.
 *
 * The cost is stated rather than hidden: an event with no actor — a scheduled
 * job, a sweep, an inbound webhook — performs nothing. Those are still
 * EVALUATED and recorded by the other subscriber, so the decision stays visible
 * even where the action is not. Widening this needs a service identity with its
 * own grants, which is a design somebody should approve rather than a fallback
 * this file reaches for.
 *
 * ══ ONE IDENTITY FOR THE EVENT, NOT TWO ═════════════════════════════════════
 *
 * The engine builds its execution key from `event.idempotencyKey`, which the
 * published envelope does not carry. Rather than invent a second identity here,
 * this uses `automationEventKey(event)` — the exact function the evaluation
 * half already uses for `automation_runs.event_key`. So the ledger claim and
 * the decision row are keyed off the same string, and the stamp at the end can
 * find the row the other subscriber wrote.
 *
 * ══ THE ORDER IN `SUBSCRIBERS` IS LOAD-BEARING ══════════════════════════════
 *
 * This runs AFTER `automations`, the evaluation half, because the stamp it
 * writes attaches to the decision row that subscriber creates.
 * `automation_run_performed` refuses a stamp with nothing to attach to, so
 * getting the order wrong is loud rather than silent — but it is written down
 * here so nobody has to discover it that way.
 *
 * ══ WHY THIS CANNOT LOOP ════════════════════════════════════════════════════
 *
 * An action that writes publishes a domain event, which would reach this
 * subscriber again. Two things stop it, and the first is structural:
 * `automationServices` builds the handlers with NO event bus, so an
 * automation's own writes do not re-enter the stream at all —
 * `automation-handlers.test.ts` asserts that absence, because a missing field
 * is the kind of guard somebody later "fixes" as an oversight.
 *
 * The second is that a customer cannot author a rule: `automation_rules`
 * stores which LIBRARY templates are on and what their numbers are, and the
 * WHEN and the THEN both come from `library.ts`, which is frozen. That one is
 * true today and could be broken by adding a template; the first cannot.
 */

import { resolveActor } from '@/lib/actor'
import type { AutomationRun } from '@/lib/automation/engine'
import { candidatesForEvent, factsForEvent } from '@/lib/automation/evaluation'
import {
  SupabaseAutomationLedger,
  performedOutcome,
  recordPerformed,
} from '@/lib/automation/ledger'
import {
  performEvaluatedEvent,
  shippedActionHandlers,
} from '@/lib/automation/performing'
import { AutomationRuleRepository } from '@/lib/automation/repository'
import {
  AutomationRunRepository,
  automationEventKey,
} from '@/lib/automation/runs'
import { effectiveRules, resolveRules } from '@/lib/automation/state'
import type { DomainEvent as PublishedEvent } from '@/lib/service'
import type { DomainEvent } from '@/lib/contracts/events'
import { SupabaseAuditWriter, type Db } from '@/lib/persistence'

import { SupabaseActorSource } from './actor-source'
import { operationHandlers } from './automation-handlers'

/**
 * Perform whatever this event's rules decided, or return having done nothing.
 *
 * Never throws for a business reason — every refusal is a `return`. It throws
 * only when something it was told to do failed, and the bus in `events.ts`
 * collects that per subscriber, so a failure here cannot cost the customer
 * their webhook delivery.
 */
export async function performAutomations(
  db: Db,
  published: PublishedEvent,
): Promise<void> {
  // Gate 1, and the cheapest. Local, against the frozen library.
  if (candidatesForEvent(published.name, published.payload).length === 0) return

  // Gate 2. Evaluated and recorded by the other subscriber; not performed,
  // because an automation runs under a person's authority and this event has
  // none. See the header.
  const actorUserId = published.actorUserId
  if (actorUserId === null) return

  // Gate 3. One read, and only for events a rule actually listens to.
  const consent = await new AutomationRunRepository(db).consent(
    published.organizationId,
  )
  if (consent === null || !consent.performingEnabled) return

  const resolution = await resolveActor(
    new SupabaseActorSource(),
    actorUserId,
    published.organizationId,
  )
  // A membership that ended, a plan that lapsed. The refusal is correct and is
  // not this file's to report: the person's own next request will say so.
  if (!resolution.ok) return

  const stored = await new AutomationRuleRepository(db).stored(
    published.organizationId,
  )
  const rules = effectiveRules(
    resolveRules(stored, published.propertyId),
  ).filter((rule) => rule.when === published.name)

  if (rules.length === 0) return

  const eventKey = automationEventKey(published)
  const event = engineEvent(published, eventKey)

  const registry = shippedActionHandlers()
  for (const [kind, handler] of operationHandlers(
    db,
    resolution.actor,
    event,
  )) {
    registry.register(kind, handler)
  }

  const outcome = await performEvaluatedEvent({
    event,
    facts: factsForEvent(published.payload),
    rules,
    actor: resolution.actor,
    consent,
    registry,
    ledger: new SupabaseAutomationLedger(db),
    audit: new SupabaseAuditWriter(db),
    requestId: published.correlationId,
  })

  // Gate 4 refused, or the module is not in the package. Nothing ran, and the
  // decision record already says what each rule decided — stamping a refusal
  // over it would claim the engine reached the rules, which it did not.
  if (outcome.status === 'refused') return

  await stamp(db, published.organizationId, eventKey, outcome.run)
}

/**
 * The envelope the engine takes, from the one the bus delivers.
 *
 * Every field is carried across; none is invented. `resourceType` and
 * `resourceId` are the ones the audit record already asserted for the
 * operation that raised this event, which is why the pipeline stamps them —
 * the engine writes its own audit line about the same row, and two derivations
 * of "which row" would eventually describe different ones.
 */
function engineEvent(published: PublishedEvent, eventKey: string): DomainEvent {
  return {
    name: published.name,
    organizationId: published.organizationId,
    resourceType: published.resourceType,
    // The audit record's own answer, and `''` only where it recorded none.
    // `DomainEvent.resourceId` is not nullable in the contract; the audit line
    // the engine writes takes `string | null` and reads the empty string back
    // as absent, which is the narrower of the two and the one that matters.
    resourceId: published.resourceId ?? '',
    propertyId: published.propertyId,
    actorUserId: published.actorUserId,
    occurredAt: published.occurredAt.toISOString(),
    correlationId: published.correlationId,
    idempotencyKey: eventKey,
    payload: published.payload,
  }
}

/**
 * Attach what happened to the decision record, one rule at a time.
 *
 * Failures are collected rather than allowed to abandon the remaining rules: a
 * stamp that could not be written is a gap in the record, and losing the other
 * four rules' records as well makes it worse. The first is rethrown at the end
 * so the bus reports it.
 */
async function stamp(
  db: Db,
  organizationId: string,
  eventKey: string,
  run: AutomationRun,
): Promise<void> {
  if (run.outcome.status !== 'evaluated') return

  const failures: unknown[] = []

  for (const result of run.outcome.rules) {
    const outcome = performedOutcome(result.outcome)
    if (outcome === null) continue

    try {
      await recordPerformed(db, {
        organizationId,
        eventKey,
        // `AutomationRule.id` IS the library's template id for a shipped rule,
        // which is what `automation_runs.template_id` holds — see `library.ts`.
        templateId: result.rule.id,
        outcome,
      })
    } catch (cause) {
      failures.push(cause)
    }
  }

  if (failures.length > 0) throw failures[0]
}
