/**
 * One pass: detect → decide → rule → execute.
 *
 * This is the ignition. Everything under `signals/`, `decide/`, `policy/` and
 * `execute/` was complete and tested and had no caller; this file is the
 * sentence that runs them in order, and it decides nothing of its own.
 *
 *     signals   →   decide   →   policy   →   execute
 *     what is    what matters   may we do    do it, through
 *     wrong        and why       it, and      the same command
 *                                how much     a person uses
 *
 * ── Everything is injected, and there is no session anywhere ──────────────
 *
 * The clock, the fact sources, the policy repository, the command registry, the
 * ledger, the audit writer and the actor all arrive as arguments. That is what
 * makes this callable from a Server Action and from a scheduled job with no
 * request behind it — and it is what makes the whole pass exercisable in a test
 * with no Supabase project, which is the property the four stages below already
 * have and would otherwise have lost the moment they acquired a caller.
 *
 * ── Simulation is decided by the executor, not here ───────────────────────
 *
 * `dispatchAction` checks the run mode before it resolves a command, and
 * `autopilot_actions_simulation_never_executes` in 0046 refuses the row a
 * simulated execution would produce. This file adds no third path around
 * either: it plans exactly the same actions in simulation as it does live, and
 * hands every one of them to the same executor. A pass that decided for itself
 * what to skip in simulation would be a pass whose simulation proved nothing
 * about the live run.
 *
 * ── A refusal is an outcome, and it is returned ───────────────────────────
 *
 * A decision the safety engine refuses produces no row — nothing was planned,
 * so there is nothing to record — but it does produce a Hebrew sentence naming
 * the floor that refused, and that sentence is on the report. "Autopilot did
 * nothing" with nothing attached is the fastest way to lose a business's trust
 * in it.
 */

import type { Actor } from '@/lib/authz/can'

import { AUTOPILOT_ACTIONS } from '../actions'
import { decide } from '../decide'
import {
  dispatchAction,
  type ExecutionDeps,
  type ExecutionReport,
} from '../execute'
import { rule } from '../policy/rule'
import type { AutopilotPolicyRepository } from '../policy/repository'
import {
  detectAccess,
  detectCleaning,
  detectContract,
  detectInventory,
  detectLaundry,
  detectMaintenance,
  detectOpportunity,
  detectPayment,
  detectPreparation,
  linkCauses,
  type DetectorContext,
} from '../signals'
import type { Decision, PlannedAction, PolicyContext, Signal } from '../types'

import { gatherPolicyContext } from './context'
import type { AutopilotFactPorts, FactScope, StatedModules } from './ports'

/* --------------------------------------------------------------- input --- */

export interface AutopilotPassInput {
  organizationId: string
  /** `null` runs across every property the reader may see. */
  propertyId: string | null
  /** Who Autopilot is acting as. Resolved elsewhere; never invented here. */
  actor: Actor
  facts: AutopilotFactPorts
  policies: AutopilotPolicyRepository
  /**
   * The executor's dependencies, minus the clock this pass already holds.
   *
   * Passed whole rather than assembled here: the repository, the registry, the
   * ledger and the audit writer are all composition-root decisions, and a pass
   * that built its own registry would be a pass that could quietly bind a
   * command nobody reviewed.
   */
  execution: ExecutionDeps
  /**
   * What triggered this pass — a domain event's id, or the identifier of the
   * scheduled window. It goes into every idempotency key, so a redelivered
   * event produces the same key and a genuinely new pass produces a new one.
   * Never a clock reading: a clock would make every redelivery unique, which is
   * the exact failure the key exists to prevent.
   */
  trigger: string
  /** The four modules no table records. See `ports.ts`. */
  modules: StatedModules
  /** How much of the operation one pass looks at. Stated, never defaulted. */
  pageSize: number
  now: Date
}

/* -------------------------------------------------------------- report --- */

/** A decision the safety engine refused, with the sentence that refused it. */
export interface RefusedDecision {
  decision: Decision
  kind: PlannedAction['kind']
  reason: string
  /** Hebrew. Says which floor refused and why. */
  explanation: string
}

export interface AutopilotPassReport {
  /** After `linkCauses`, so the chain is reconstructable. */
  signals: readonly Signal[]
  decisions: readonly Decision[]
  /** One per action that reached the executor, in triage order. */
  executed: readonly ExecutionReport[]
  refused: readonly RefusedDecision[]
  /**
   * Detectors that did not run because nothing can supply their facts.
   *
   * Reported rather than silently skipped: a readiness picture missing its
   * payment requirements is a different claim from one that found none, and a
   * screen that cannot tell them apart tells the business it is fine.
   */
  unsourced: readonly string[]
  context: PolicyContext
}

/* ------------------------------------------------------------ the pass --- */

const HOUR_MS = 3_600_000

export async function runAutopilotPass(
  input: AutopilotPassInput,
): Promise<AutopilotPassReport> {
  const { organizationId, propertyId, now } = input

  const quietWindow = await input.facts.quietWindow(organizationId)
  const { context, settings } = await gatherPolicyContext(input.policies, {
    organizationId,
    propertyId,
    // A pass covers many bookings, so it has no single booking override. The
    // per-booking narrowing belongs to a pass triggered by one booking's own
    // event, which passes the id here.
    bookingId: null,
    actor: input.actor,
    quietWindow,
    now,
  })

  const [modules, timeZone] = await Promise.all([
    input.facts.modules(organizationId, input.modules),
    input.facts.timeZone(organizationId),
  ])

  const scope: FactScope = {
    organizationId,
    propertyId,
    from: now,
    // The organization's own horizon, from `autopilot_settings`. Not a number
    // chosen here: how far ahead a business wants to be warned is its decision.
    to: new Date(now.getTime() + settings.lookaheadHours * HOUR_MS),
    modules,
    pageSize: input.pageSize,
  }

  const detector: DetectorContext = { modules, now, timeZone }

  const { signals, unsourced } = await detect(input.facts, scope, detector)

  const { decisions } = decide(
    signals,
    {
      entitlements: [...input.actor.entitlements],
      trigger: input.trigger,
    },
    { observedAt: now.toISOString() },
  )

  const executed: ExecutionReport[] = []
  const refused: RefusedDecision[] = []

  for (const decision of decisions) {
    // The first proposal is what the screen offers as the button, and it is
    // what a pass acts on. The alternatives stay on the decision for a person
    // who disagrees with it; acting on all of them would be acting on a list
    // that was deliberately ordered so only its head is the answer.
    const proposed = decision.actions[0]
    if (proposed === undefined) continue

    const ruling = rule(proposed.kind, context, proposed.confidence)

    if (!ruling.allowed) {
      refused.push({
        decision,
        kind: proposed.kind,
        reason: ruling.reason,
        explanation: ruling.explanation,
      })
      continue
    }

    executed.push(
      await dispatchAction(
        planned(decision, proposed, ruling.disposition, context),
        input.execution,
      ),
    )
  }

  return { signals, decisions, executed, refused, unsourced, context }
}

/* ------------------------------------------------------------ planning --- */

/**
 * The decision, the ruling and the catalogue, in the shape the executor stores.
 *
 * `safetyLevel` and `disposition` are copied on rather than looked up again at
 * execution time. Reading them live would let a customer change the matrix at
 * noon and have the morning's queued actions behave under rules nobody applied
 * to them — the argument `types.ts` makes on `PlannedAction` itself.
 */
function planned(
  decision: Decision,
  proposed: Decision['actions'][number],
  disposition: PlannedAction['disposition'],
  context: PolicyContext,
): PlannedAction {
  const spec = AUTOPILOT_ACTIONS[proposed.kind]

  return {
    organizationId: context.organizationId,
    propertyId: decision.signal.propertyId,
    kind: proposed.kind,
    safetyLevel: spec.safety,
    disposition,
    runMode: context.runMode,
    confidence: proposed.confidence,
    // Composed by `decide` in Hebrew and stored, never re-derived. It is also
    // what the domain command is given as its stated justification, which is
    // why `booking.cancel` can refuse to run without one and still be reachable.
    reason: proposed.reason,
    // A sweep has no triggering domain event. Naming one would attribute the
    // action to something that did not happen.
    triggerEvent: null,
    evidence: decision.signal.evidence,
    command: spec.command,
    commandInput: proposed.input,
    idempotencyKey: proposed.idempotencyKey,
    correlationId: null,
    exceptionDedupeKey: decision.signal.dedupeKey,
    scheduledFor: proposed.scheduledFor ?? null,
  }
}

/* ----------------------------------------------------------- detection --- */

/**
 * The detectors that have a fact source, and the names of the ones that do not.
 *
 * `linkCauses` runs over the whole set and is not optional: without it a
 * laundry delay, the shortage it caused, the preparation risk that followed and
 * the arrival risk at the end are four unrelated alarms at 06:00 on a Friday,
 * and the manager reads none of them.
 */
async function detect(
  facts: AutopilotFactPorts,
  scope: FactScope,
  context: DetectorContext,
): Promise<{ signals: readonly Signal[]; unsourced: readonly string[] }> {
  const [
    cleaning,
    maintenance,
    laundry,
    preparation,
    contracts,
    payments,
    shortages,
    access,
    nights,
  ] = await Promise.all([
    facts.loadCleaning(scope),
    facts.loadMaintenance(scope),
    facts.loadLaundry(scope),
    facts.loadPreparation(scope),
    facts.loadContracts(scope),
    facts.loadPayments(scope),
    facts.loadShortages(scope),
    facts.loadAccess(scope),
    facts.loadEmptyNights(scope),
  ])

  const signals: Signal[] = [
    ...detectCleaning(cleaning, context),
    ...detectMaintenance(maintenance, context),
    ...detectLaundry(laundry, context),
    ...detectPreparation(preparation, context),
    ...detectContract(contracts, context),
  ]

  // The four with no source today. Each is run the moment something can
  // supply it, so a port implementation landing needs no change here — and
  // until then the detector's NAME is reported rather than its silence being
  // mistaken for its answer.
  const unsourced: string[] = []

  if (payments === null) unsourced.push('payment')
  else signals.push(...detectPayment(payments, context))

  if (shortages === null) unsourced.push('inventory')
  else signals.push(...detectInventory(shortages, context))

  if (access === null) unsourced.push('access')
  else signals.push(...detectAccess(access, context))

  if (nights === null) unsourced.push('opportunity')
  else signals.push(...detectOpportunity(nights, context))

  return { signals: linkCauses(signals), unsourced }
}
