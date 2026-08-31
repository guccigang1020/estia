/**
 * The automation engine.
 *
 * One event in, one report out. Everything it touches is injected — the
 * ledger, the thing that performs an action, the audit writer, the clock and
 * even the sleep between retries — so every quality claimed below is a
 * statement a test makes rather than one a comment asserts.
 *
 * ── The order of the refusals, and why it is this order ───────────────────
 *
 *   1. **Is this event real?** `isDomainEvent` re-checks the name at runtime.
 *      The type says it is a member of the frozen catalogue; an event arriving
 *      as JSON from a queue has no type. A name outside the catalogue is not
 *      "no rules matched" — it is a bug or a forgery, and it is refused loudly.
 *   2. **Is this event ours?** An event whose `organizationId` is not the
 *      actor's refuses the entire run. This is the most serious failure the
 *      engine can have: an automation that messaged another tenant's guest
 *      would be a data leak with a delivery receipt.
 *   3. **Does this organization have automation at all?** The module is a plan
 *      feature. A rule that would otherwise have fired is reported as blocked
 *      by the package, never as "did not match" — the two look identical on a
 *      screen and only one of them is fixable by the customer.
 *   4. **Does the rule's trigger match, and do its conditions hold?**
 *   5. **May this actor perform the action?** Per action, through `holdsGrant`,
 *      which asks the permission and the plan as one question.
 *   6. **Has this exact action already run for this exact event?**
 *
 * Steps 5 and 6 are per action rather than per rule. A rule whose first action
 * the actor may perform and whose second it may not performs the first, and
 * says so — silently dropping the whole rule would hide work that did happen.
 *
 * ── Idempotency, and where the claim is taken ─────────────────────────────
 *
 * `DomainEvent.idempotencyKey` is stable across redeliveries of one logical
 * event. The execution key adds the rule and the position of the action within
 * it, because one event legitimately drives several actions and each must be
 * deduplicated on its own.
 *
 * The claim is taken **before** the action runs, not after. Taking it after
 * would leave a window in which a second delivery of the same webhook starts
 * the same charge, and "we sent the guest two payment links" is precisely the
 * failure this exists to prevent. The cost of claiming first is that an action
 * which crashes mid-flight is not retried by a later delivery — so the claim is
 * released when every attempt failed for a reason that is worth retrying, and
 * deliberately kept when the failure was permanent, because a retry of a
 * validation error is a second identical failure and a third delivery is not.
 *
 * ── Audit is not optional, and a failed audit is not a failed action ──────
 *
 * Every executed action writes an audit record through `recordAuditEvent`,
 * with `actorType: 'system'` and the rule's own name as the label — so
 * "the system did this at 03:14" reads differently from "Dana did this", which
 * is the whole reason `ActorType` has more than one member.
 *
 * If the action succeeded and the audit write then failed, the engine reports
 * `executed_unaudited` rather than `executed` or `failed`. Both alternatives
 * are lies: the work happened, and there is no record of it. That state is
 * rare and it is exactly the state somebody needs to be told about.
 */

import { recordAuditEvent, type AuditWriter } from '../audit/pipeline'
import { holdsGrant, type Actor } from '../authz/can'
import type { Grant } from '../authz/permissions'
import { isDomainEvent, type DomainEvent } from '../contracts/events'
import { isAppError } from '../errors/app-error'
import { ENTITLEMENT_FOR_GRANT, type Entitlement } from '../plans/entitlements'

import { evaluateConditions, type ConditionFailure } from './conditions'
import {
  AUTOMATION_ACTIONS,
  AUTOMATION_ENTITLEMENT,
  type AutomationAction,
  type AutomationFacts,
  type AutomationRule,
} from './types'

/* -------------------------------------------------------------- ledger --- */

/**
 * What has already been done, so it is not done twice.
 *
 * `claim` is the whole interface: it must be atomic in the implementation that
 * backs it — an insert on a unique key, not a read followed by a write — or
 * two concurrent deliveries will both be told they claimed it. The in-memory
 * implementation below is atomic by virtue of being single-threaded, and says
 * so rather than implying that any implementation would be.
 */
export interface AutomationLedger {
  /** True when this caller took the key; false when it was already held. */
  claim(organizationId: string, key: string): Promise<boolean>
  /** Hand the key back, so a later delivery may try again. */
  release(organizationId: string, key: string): Promise<void>
}

/** Atomic because JavaScript is single-threaded here, and for no other reason. */
export class InMemoryAutomationLedger implements AutomationLedger {
  private readonly held = new Set<string>()

  async claim(organizationId: string, key: string): Promise<boolean> {
    const scoped = `${organizationId}::${key}`
    if (this.held.has(scoped)) return false
    this.held.add(scoped)
    return true
  }

  async release(organizationId: string, key: string): Promise<void> {
    this.held.delete(`${organizationId}::${key}`)
  }

  get keys(): readonly string[] {
    return [...this.held]
  }
}

/* ----------------------------------------------------------- performing --- */

export interface PerformInput {
  action: AutomationAction
  rule: AutomationRule
  event: DomainEvent
  /** 1 for the first try. Passed so a performer can log or vary a message. */
  attempt: number
}

/**
 * The thing that actually does the work.
 *
 * Injected rather than implemented here, because "send a WhatsApp message" and
 * "open a housekeeping task" belong to the modules that own those concepts.
 * The engine's job is to decide *whether*, in what order, and exactly once.
 *
 * A performer signals failure by throwing. An `AppError` with
 * `retryable: false` stops the retry loop; anything else is tried again.
 */
export interface AutomationPerformer {
  perform(input: PerformInput): Promise<void>
}

/* ------------------------------------------------------------- outcomes --- */

export interface RetryPolicy {
  /** Total tries, not retries. `1` disables retrying. */
  maxAttempts: number
  /** Milliseconds before attempt n+1. Multiplied by the attempt number. */
  backoffMs: number
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, backoffMs: 250 }

export type ActionOutcome =
  | { status: 'executed'; attempts: number }
  /** Done, and the trail does not know. See the header. */
  | { status: 'executed_unaudited'; attempts: number; auditError: string }
  | { status: 'skipped_duplicate' }
  | { status: 'refused_permission'; grant: Grant }
  | { status: 'refused_plan'; grant: Grant; entitlement: Entitlement | null }
  | { status: 'failed'; attempts: number; retryable: boolean; error: string }

export interface ActionResult {
  action: AutomationAction
  /** The idempotency key this action was claimed under. */
  key: string
  outcome: ActionOutcome
}

export type RuleOutcome =
  | { status: 'ran'; actions: readonly ActionResult[] }
  | { status: 'skipped_trigger' }
  | { status: 'skipped_disabled' }
  | { status: 'skipped_conditions'; failures: readonly ConditionFailure[] }
  | { status: 'refused_plan'; entitlement: Entitlement }

export interface RuleResult {
  rule: AutomationRule
  outcome: RuleOutcome
}

export type AutomationRunOutcome =
  | { status: 'evaluated'; rules: readonly RuleResult[] }
  /** The name is not in the frozen catalogue. Nothing was evaluated. */
  | { status: 'refused_unknown_event'; name: string }
  /** The event belongs to another tenant. Nothing was evaluated. */
  | { status: 'refused_cross_organization'; eventOrganizationId: string }

export interface AutomationRun {
  event: DomainEvent
  outcome: AutomationRunOutcome
}

/* --------------------------------------------------------------- inputs --- */

export interface RunAutomationsInput {
  event: DomainEvent
  /** The event, flattened for comparison. See `conditions.ts`. */
  facts: AutomationFacts
  rules: readonly AutomationRule[]
  /** Whose authority the automation runs under. */
  actor: Actor
  performer: AutomationPerformer
  ledger: AutomationLedger
  audit: AuditWriter
  /** Ties every audit record produced by one delivery together. */
  requestId: string
  now?: Date
  retry?: RetryPolicy
  /** Injected so a retry test does not take a second of wall clock. */
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/* -------------------------------------------------------------- the run --- */

export async function runAutomations(
  input: RunAutomationsInput,
): Promise<AutomationRun> {
  const { event, actor } = input

  if (!isDomainEvent(event.name)) {
    return {
      event,
      outcome: { status: 'refused_unknown_event', name: event.name },
    }
  }

  if (event.organizationId !== actor.organizationId) {
    return {
      event,
      outcome: {
        status: 'refused_cross_organization',
        eventOrganizationId: event.organizationId,
      },
    }
  }

  const moduleAvailable = actor.entitlements.has(AUTOMATION_ENTITLEMENT)

  const rules: RuleResult[] = []
  for (const rule of input.rules) {
    rules.push({
      rule,
      outcome: await evaluateRule(rule, input, moduleAvailable),
    })
  }

  return { event, outcome: { status: 'evaluated', rules } }
}

async function evaluateRule(
  rule: AutomationRule,
  input: RunAutomationsInput,
  moduleAvailable: boolean,
): Promise<RuleOutcome> {
  if (rule.when !== input.event.name) return { status: 'skipped_trigger' }
  if (!rule.enabled) return { status: 'skipped_disabled' }

  // Asked after the trigger so that a business without the feature is not told
  // about every rule in the library on every event it happens to raise.
  if (!moduleAvailable) {
    return { status: 'refused_plan', entitlement: AUTOMATION_ENTITLEMENT }
  }

  const conditions = evaluateConditions(rule.conditions, input.facts)
  if (!conditions.met) {
    return { status: 'skipped_conditions', failures: conditions.failures }
  }

  const actions: ActionResult[] = []
  for (const [index, action] of rule.actions.entries()) {
    const key = executionKey(input.event, rule, index, action)
    actions.push({
      action,
      key,
      outcome: await runAction(action, key, rule, input),
    })
  }

  return { status: 'ran', actions }
}

/**
 * The execution key for one action of one rule for one event.
 *
 * Every component is load-bearing. Without the rule id, two rules on the same
 * event deduplicate each other. Without the index, a rule that messages the
 * guest and then messages the team performs only the first. Without the kind,
 * reordering a rule's actions silently re-runs work that had already been done
 * under the old position.
 */
export function executionKey(
  event: DomainEvent,
  rule: AutomationRule,
  index: number,
  action: AutomationAction,
): string {
  return `${event.idempotencyKey}::${rule.id}::${index}::${action.kind}`
}

async function runAction(
  action: AutomationAction,
  key: string,
  rule: AutomationRule,
  input: RunAutomationsInput,
): Promise<ActionOutcome> {
  const { actor } = input
  const grant = AUTOMATION_ACTIONS[action.kind].requires

  // One question, asked the way every screen asks it: `holdsGrant` is the
  // permission and the plan together, so an action the role does not carry and
  // an action the package does not include are distinguished here rather than
  // flattened into "not allowed".
  if (!actor.grants.has(grant)) {
    return { status: 'refused_permission', grant }
  }
  if (!holdsGrant(actor, grant)) {
    return {
      status: 'refused_plan',
      grant,
      entitlement: ENTITLEMENT_FOR_GRANT[grant] ?? null,
    }
  }

  const claimed = await input.ledger.claim(actor.organizationId, key)
  if (!claimed) return { status: 'skipped_duplicate' }

  const retry = input.retry ?? DEFAULT_RETRY
  const sleep = input.sleep ?? realSleep

  let attempts = 0
  let lastError = 'unknown failure'
  let retryable = true

  while (attempts < Math.max(1, retry.maxAttempts)) {
    attempts += 1
    try {
      await input.performer.perform({
        action,
        rule,
        event: input.event,
        attempt: attempts,
      })
      return await auditExecution(action, rule, input, attempts)
    } catch (cause) {
      lastError = messageOf(cause)
      retryable = isAppError(cause) ? cause.retryable : true
      if (!retryable) break
      if (attempts < retry.maxAttempts) await sleep(retry.backoffMs * attempts)
    }
  }

  // Released only when trying again could plausibly succeed. A permanent
  // failure keeps its claim so the next delivery of the same event does not
  // reproduce the identical failure and the identical alert.
  if (retryable) await input.ledger.release(actor.organizationId, key)

  return { status: 'failed', attempts, retryable, error: lastError }
}

async function auditExecution(
  action: AutomationAction,
  rule: AutomationRule,
  input: RunAutomationsInput,
  attempts: number,
): Promise<ActionOutcome> {
  const { event } = input
  try {
    await recordAuditEvent(
      {
        actor: {
          // Not a user. The whole point of `ActorType` having more than one
          // member is that a timeline can say "the system did this".
          type: 'system',
          userId: null,
          label: `אוטומציה · ${rule.name}`,
        },
        context: {
          organizationId: input.actor.organizationId,
          propertyId: event.propertyId ?? null,
          requestId: input.requestId,
        },
        // The permission that authorised it, exactly as a human action records.
        action: AUTOMATION_ACTIONS[action.kind].requires,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        after: {
          rule: rule.id,
          trigger: event.name,
          attempts,
        },
        summary: `${rule.name}: ${action.note}`,
      },
      input.audit,
      { occurredAt: input.now ?? new Date() },
    )
    return { status: 'executed', attempts }
  } catch (cause) {
    return {
      status: 'executed_unaudited',
      attempts,
      auditError: messageOf(cause),
    }
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/* ------------------------------------------------------------- reading --- */

/** Every action the run actually performed, audited or not. */
export function executedActions(run: AutomationRun): readonly ActionResult[] {
  if (run.outcome.status !== 'evaluated') return []
  return run.outcome.rules.flatMap((entry) =>
    entry.outcome.status === 'ran'
      ? entry.outcome.actions.filter(
          (result) =>
            result.outcome.status === 'executed' ||
            result.outcome.status === 'executed_unaudited',
        )
      : [],
  )
}

/** Everything that needs a person: a failure, or work with no audit trail. */
export function needsAttention(run: AutomationRun): readonly ActionResult[] {
  if (run.outcome.status !== 'evaluated') return []
  return run.outcome.rules.flatMap((entry) =>
    entry.outcome.status === 'ran'
      ? entry.outcome.actions.filter(
          (result) =>
            result.outcome.status === 'failed' ||
            result.outcome.status === 'executed_unaudited',
        )
      : [],
  )
}
