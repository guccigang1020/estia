/**
 * What would have happened.
 *
 * Simulation is not a debug flag — 0046 says so twice — it is the rollout path.
 * A business runs it for a fortnight, reads what ESTIA would have done, and
 * switches on real automation having already seen it. That only works if the
 * record is honest, which means two things that are easy to get wrong:
 *
 *   1. **The same reason and the same evidence a live run would have carried.**
 *      Not a shorter version, not a template. The sentence a manager reads on
 *      the review screen is the sentence they would have read the morning
 *      after, so agreeing with the simulation is agreeing with the real thing.
 *
 *   2. **Including the failures.** A command that does not exist would have
 *      failed live, so the simulation says it would have failed. A review
 *      screen that showed fourteen tidy successes for actions that would all
 *      have hit `command_not_implemented` would sell a business an automation
 *      that does not work, and they would discover it in production.
 *
 * Nothing here touches anything. It reads the planned action and the registry —
 * which resolves, and never runs — and returns prose plus a record for the
 * `result` column.
 */

import { AUTOPILOT_ACTIONS } from '../actions'
import type { PlannedAction } from '../types'

import type { CommandRegistry } from './registry'

export interface SimulatedAction {
  kind: PlannedAction['kind']
  /** Hebrew, from the catalogue. */
  label: string
  disposition: PlannedAction['disposition']
  safetyLevel: PlannedAction['safetyLevel']
  command: string | null
  /** False when a live run would have failed on `command_not_implemented`. */
  wouldHaveRun: boolean
  /** Hebrew. The sentence the review screen shows. */
  wouldHave: string
  /** The reason the live run would have carried, unchanged. */
  reason: string
  evidence: PlannedAction['evidence']
  scheduledFor: string | null
}

/**
 * The sentence, per disposition.
 *
 * Three different things happen under the three dispositions and a single
 * "would have run" would flatten them: a business reviewing a fortnight of
 * simulation needs to see that fifty of these were only ever going to be
 * suggestions.
 */
function wouldHaveSentence(
  planned: PlannedAction,
  label: string,
  failure: string | null,
): string {
  const opening =
    planned.disposition === 'auto'
      ? `היה מבצע אוטומטית: ${label}`
      : planned.disposition === 'ask_approval'
        ? `היה מכין לאישור: ${label}`
        : `היה מציע: ${label}`

  return failure === null ? opening : `${opening} — אך ${failure}`
}

export function simulateAction(
  planned: PlannedAction,
  registry: CommandRegistry,
): SimulatedAction {
  const spec = AUTOPILOT_ACTIONS[planned.kind]

  // An action with no command completes inside Autopilot — raising an
  // exception, composing a brief — so there is nothing that could fail to
  // resolve, and saying it "would not have run" would be false.
  const resolution =
    planned.command === null ? null : registry.resolve(planned.command)

  const wouldHaveRun = resolution === null || resolution.status === 'available'

  return {
    kind: planned.kind,
    label: spec.label,
    disposition: planned.disposition,
    safetyLevel: planned.safetyLevel,
    command: planned.command,
    wouldHaveRun,
    wouldHave: wouldHaveSentence(
      planned,
      spec.label,
      resolution !== null && resolution.status === 'unavailable'
        ? resolution.detail
        : null,
    ),
    reason: planned.reason,
    evidence: planned.evidence,
    scheduledFor: planned.scheduledFor,
  }
}

/**
 * The simulation as it is stored in `autopilot_actions.result`.
 *
 * A plain record because the column is `jsonb` and because the review screen
 * reads it back without this module: nothing here is a class, a Date or a
 * function, so what is written is what is read.
 */
export function simulationResult(
  simulated: SimulatedAction,
): Readonly<Record<string, unknown>> {
  return {
    simulated: true,
    wouldHave: simulated.wouldHave,
    wouldHaveRun: simulated.wouldHaveRun,
    command: simulated.command,
    disposition: simulated.disposition,
    safetyLevel: simulated.safetyLevel,
    evidence: simulated.evidence,
  }
}
