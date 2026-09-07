/**
 * The half that ACTS — built, tested, and switched off.
 *
 * ══ READ THIS BEFORE WIRING ANYTHING HERE INTO A LIVE PATH ══════════════════
 *
 * Nothing in this deployment calls `performEvaluatedEvent`. `(app)/_lib/events.ts`
 * subscribes the EVALUATION half and only that half, and it says so in its own
 * header. This file exists so that the code which would act is written,
 * constrained and unit-tested BEFORE somebody needs it in a hurry — not so that
 * it can be switched on by finding it.
 *
 * The reason is one sentence and it governs everything below: **there is no
 * organization on this database, so nothing built here can be watched working
 * before it reaches a paying customer.** An automation runner sends messages to
 * real guests, issues real documents and blocks real dates. Shipping one that
 * performs, untested against any real data, would be the most dangerous thing
 * this repository could do. So the decisions are recorded live — that is
 * `evaluation.ts` and `runs.ts`, and it is the audit trail a person reads for a
 * week before trusting any of this — and the acting is gated behind a switch
 * that a named human turns on per organization once they can watch it.
 *
 * ══ THE THREE GATES, AND WHY THERE ARE THREE ════════════════════════════════
 *
 *   1. **Consent.** `automation_execution_consent` (0075). Absent by default,
 *      and absent for every organization. The CHECK on that table refuses
 *      `performing_enabled` without a `consented_by`, which a trigger takes
 *      from `auth.uid()` — so a service_role import cannot set it and no
 *      environment variable reaches it. It is a row a person writes on a
 *      screen, with a sentence saying what they agreed to.
 *
 *   2. **A handler per action.** `ActionHandlerRegistry` ships EMPTY. There is
 *      no code in this product that sends a guest a WhatsApp message on an
 *      automation's say-so, opens a housekeeping task, or issues an invoice —
 *      those belong to the modules that own those concepts, and inventing them
 *      here would be inventing capabilities the product does not have. A rule
 *      whose action has no handler is reported absent WITH ITS REASON and is
 *      never quietly treated as done.
 *
 *   3. **The engine's own floors.** `runAutomations` asks `holdsGrant` per
 *      action and claims an idempotency key before performing. Those are not
 *      re-implemented here; this module supplies the actor, the ledger and the
 *      audit writer and lets the engine refuse.
 *
 * A caller must pass all three. `executionReadiness` is the function that says,
 * in one place, which of them are missing — and it is what a screen renders
 * instead of a switch that looks live.
 *
 * ══ THE DURABLE LEDGER — WAS MISSING, NOW EXISTS ════════════════════════════
 *
 * This header used to end by naming a gap: `AutomationLedger` was injected and
 * the only implementation was `InMemoryAutomationLedger`, which is atomic
 * because JavaScript is single-threaded and for no other reason. Two
 * application instances behind a load balancer would each have kept their own
 * idea of which keys were taken, and the failure that produces — "we sent the
 * guest two payment links" — is precisely what the ledger exists to prevent.
 *
 * `SupabaseAutomationLedger` in `ledger.ts` closes it, over
 * `public.automation_ledger` from 0078. The claim is one
 * `insert … on conflict do nothing` and the primary key decides it, so two
 * concurrent deliveries cannot both perform however many instances are running.
 *
 * This module still TAKES a ledger rather than choosing one, and that is not
 * leftover indirection: every test in `performing.test.ts` and `engine.test.ts`
 * runs against the in-memory one, and a module that reached for a database
 * client itself could not be tested without a database.
 *
 * ══ WHAT IS STILL MISSING ═══════════════════════════════════════════════════
 *
 * The handlers, and only the handlers. `shippedActionHandlers()` returns an
 * empty registry, `executionReadiness` reports every unhandled action as a
 * blocker with its name, and a rule whose action has no handler is refused
 * rather than reported done. That gap is closed one action at a time, by the
 * module that owns the concept — not here.
 */

import { holdsGrant, type Actor } from '../authz/can'
import type { AuditWriter } from '../audit/pipeline'
import type { DomainEvent } from '../contracts/events'
import { BusinessRuleError } from '../errors'

import {
  runAutomations,
  type AutomationLedger,
  type AutomationPerformer,
  type AutomationRun,
  type PerformInput,
  type RetryPolicy,
} from './engine'
import type { AutomationExecutionConsent } from './runs'
import {
  AUTOMATION_ACTIONS,
  AUTOMATION_ENTITLEMENT,
  type AutomationActionKind,
  type AutomationFacts,
  type AutomationRule,
} from './types'

/* ------------------------------------------------------------ handlers --- */

/** What one action kind actually does, when something can do it. */
export type ActionHandler = (input: PerformInput) => Promise<void>

/**
 * The performer, assembled from whatever the product can genuinely do.
 *
 * Ships empty, and `shippedActionHandlers()` below says so as code rather than
 * as a comment, so a test can assert the shipped state is "nothing" and fail
 * the day somebody registers a handler without meaning to.
 *
 * An unregistered kind THROWS, and throws a non-retryable error. Returning
 * quietly would report the action as executed and write an audit line saying a
 * guest was messaged, which is the worst outcome available here: a false record
 * of contact with somebody's customer.
 */
export class ActionHandlerRegistry implements AutomationPerformer {
  private readonly handlers = new Map<AutomationActionKind, ActionHandler>()

  register(kind: AutomationActionKind, handler: ActionHandler): this {
    this.handlers.set(kind, handler)
    return this
  }

  has(kind: AutomationActionKind): boolean {
    return this.handlers.has(kind)
  }

  /** The kinds these rules need and this registry cannot do, deduplicated. */
  missingFor(
    rules: readonly AutomationRule[],
  ): readonly AutomationActionKind[] {
    const needed = new Set<AutomationActionKind>()
    for (const rule of rules) {
      if (!rule.enabled) continue
      for (const action of rule.actions) {
        if (!this.handlers.has(action.kind)) needed.add(action.kind)
      }
    }
    return [...needed]
  }

  async perform(input: PerformInput): Promise<void> {
    const handler = this.handlers.get(input.action.kind)
    if (!handler) {
      throw new BusinessRuleError({
        code: 'automation.action_not_implemented',
        userMessage: `אין עדיין מי שמבצע את הפעולה ״${AUTOMATION_ACTIONS[input.action.kind].label}״, ולכן היא לא בוצעה.`,
        message: `no handler registered for automation action ${input.action.kind}`,
      })
    }
    await handler(input)
  }
}

/**
 * What ESTIA ships: nothing.
 *
 * A function rather than a shared instance, because a registry is mutable and
 * one shared instance would be one shared registration — the same argument
 * `(app)/_lib/events.ts` makes about building the bus per request.
 */
export function shippedActionHandlers(): ActionHandlerRegistry {
  return new ActionHandlerRegistry()
}

/* ----------------------------------------------------------- readiness --- */

export type ExecutionBlocker =
  /** No row. Nobody has authorised anything, which is every organization. */
  | { kind: 'no_consent' }
  /** A row that says no, or one that said yes and was withdrawn. */
  | { kind: 'consent_withheld'; revokedAt: string | null }
  /** The package does not include the module at all. */
  | { kind: 'no_entitlement' }
  /** A rule is on and nothing in the product can carry out its action. */
  | { kind: 'no_handler'; action: AutomationActionKind }

export interface ExecutionReadiness {
  ready: boolean
  blockers: readonly ExecutionBlocker[]
}

/**
 * May this organization's automations act, and if not, exactly why not.
 *
 * Every blocker is returned rather than the first, because the answer a person
 * needs is the whole list: consenting to something that still has no handler
 * behind it would change nothing and would look like it had.
 */
export function executionReadiness(input: {
  consent: AutomationExecutionConsent | null
  registry: ActionHandlerRegistry
  actor: Actor
  rules: readonly AutomationRule[]
}): ExecutionReadiness {
  const blockers: ExecutionBlocker[] = []

  if (input.consent === null) {
    blockers.push({ kind: 'no_consent' })
  } else if (!input.consent.performingEnabled) {
    blockers.push({
      kind: 'consent_withheld',
      revokedAt: input.consent.revokedAt,
    })
  }

  if (!input.actor.entitlements.has(AUTOMATION_ENTITLEMENT)) {
    blockers.push({ kind: 'no_entitlement' })
  }

  for (const action of input.registry.missingFor(input.rules)) {
    blockers.push({ kind: 'no_handler', action })
  }

  return { ready: blockers.length === 0, blockers }
}

/* ------------------------------------------------------------ the door --- */

export type PerformOutcome =
  /** Nothing was attempted. `run` is absent because there was no run. */
  | { status: 'refused'; blockers: readonly ExecutionBlocker[] }
  | { status: 'performed'; run: AutomationRun }

export interface PerformEvaluatedEventInput {
  event: DomainEvent
  facts: AutomationFacts
  /** As `resolveRules` produced them: this organization's answers applied. */
  rules: readonly AutomationRule[]
  actor: Actor
  consent: AutomationExecutionConsent | null
  registry: ActionHandlerRegistry
  /**
   * Injected so the tests can run without a database. The durable one is
   * `SupabaseAutomationLedger` in `ledger.ts`; see the header.
   */
  ledger: AutomationLedger
  audit: AuditWriter
  requestId: string
  now?: Date
  retry?: RetryPolicy
  sleep?: (ms: number) => Promise<void>
}

/**
 * The one entrance to acting, and it is shut.
 *
 * Called by nothing in this deployment. When it is called, it refuses before
 * touching the engine unless all three gates are open — so a caller that
 * forgot to check readiness gets a refusal rather than a partial run, and the
 * refusal names what was missing.
 *
 * Note the order: readiness first, engine second. `runAutomations` would refuse
 * most of this on its own — an actor without the entitlement has every action
 * refused on the plan — but it would do so ACTION BY ACTION, having already
 * claimed idempotency keys along the way. A run that should never have started
 * must not leave claims behind that make a later, legitimate run report
 * `skipped_duplicate`.
 */
export async function performEvaluatedEvent(
  input: PerformEvaluatedEventInput,
): Promise<PerformOutcome> {
  const readiness = executionReadiness({
    consent: input.consent,
    registry: input.registry,
    actor: input.actor,
    rules: input.rules,
  })

  if (!readiness.ready) {
    return { status: 'refused', blockers: readiness.blockers }
  }

  const run = await runAutomations({
    event: input.event,
    facts: input.facts,
    rules: input.rules,
    actor: input.actor,
    performer: input.registry,
    ledger: input.ledger,
    audit: input.audit,
    requestId: input.requestId,
    now: input.now,
    retry: input.retry,
    sleep: input.sleep,
  })

  return { status: 'performed', run }
}

/**
 * Would this actor be allowed to consent at all?
 *
 * The same two grants 0075's policies demand, asked in the code so a screen can
 * decide whether to render the control rather than offering one the database
 * will refuse. `automation.manage` is the right to choose which rules a
 * business wants; letting software act on the business without a person in the
 * loop is a change to how the organization runs, which is what
 * `organization.settings.edit` names.
 */
export function mayConsentToPerforming(actor: Actor): boolean {
  return (
    holdsGrant(actor, 'automation.manage') &&
    holdsGrant(actor, 'organization.settings.edit')
  )
}
