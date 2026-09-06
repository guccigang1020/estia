/**
 * The safety engine. One question, and eleven floors under the answer.
 *
 *     may Autopilot do THIS action, for THIS organization, right now —
 *     and if it may, how much of it may it do without a person?
 *
 * ── Narrowing only, and that is the whole design ──────────────────────────
 *
 * The layers run in a fixed order and each one may only make the answer
 * smaller. There is no layer that raises anything, which is why the order is
 * safe to read as a list of refusals rather than as an algorithm: whatever a
 * later floor decides, an earlier one has already put a lid on it. A customer
 * who sets a refund to `auto` and a platform rule that caps money at
 * `ask_approval` cannot produce an automatic refund in any order of
 * evaluation, and the test suite asserts that with the matrix set to `auto` on
 * purpose.
 *
 * The consequence worth stating: this file cannot grant anything. It starts at
 * `auto` and spends the rest of its length taking that away. A bug here fails
 * towards a suggestion — a person is asked about something they need not have
 * been asked about — and never towards an action nobody approved.
 *
 * ── Every refusal names itself ────────────────────────────────────────────
 *
 * There is no path out of `rule()` that returns "no" without an
 * `AutopilotSuppressionReason` and a Hebrew sentence saying which floor said
 * it. "Autopilot did nothing" with nothing attached is the single fastest way
 * to lose a business's trust in it, and the shape of `PolicyRuling` is what
 * makes writing that impossible rather than merely discouraged.
 *
 * ── `appliedFloors` is the answer to the question people actually ask ─────
 *
 * Nobody asks "was this allowed". They ask "why is this only a suggestion" at
 * 06:40 with a guest arriving at nine. So an allowed ruling carries an entry
 * for EVERY layer it passed through, in order, whether or not that layer
 * changed anything — and a layer that narrowed says what it narrowed to. The
 * ruling alone answers the question; nothing has to be re-derived from a
 * database whose rows may since have changed.
 *
 * ── Deterministic, and the boundary is upstream ───────────────────────────
 *
 * Nothing here is a heuristic. Whether the deposit was paid, whether the villa
 * is free, what a refund would cost — all decided by the engines that own
 * them, and they arrive as `Evidence` on the decision rather than as anything
 * this file recomputes. `confidence` is a statement about the JUDGMENT that
 * produced the proposal, never about the facts, and it appears here only as a
 * ceiling.
 */

import {
  ACTION_SAFETY_LEVELS,
  AUTOPILOT_DISPOSITIONS,
  type ActionSafetyLevel,
  type AutopilotConfidence,
  type AutopilotDisposition,
  type AutopilotSuppressionReason,
} from '../../contracts/states'
import { AUTOPILOT_ACTIONS, type AutopilotActionKind } from '../actions'
import type { PolicyContext, PolicyRuling } from '../types'

/* --------------------------------------------------------- the ordering -- */

/** Anything that may actually happen. `off` is a refusal, not a disposition. */
type ActiveDisposition = Exclude<AutopilotDisposition, 'off'>

function dispositionRank(disposition: AutopilotDisposition): number {
  return AUTOPILOT_DISPOSITIONS.indexOf(disposition)
}

function safetyRank(level: ActionSafetyLevel): number {
  return ACTION_SAFETY_LEVELS.indexOf(level)
}

/** Is this action's harm greater than an internal, reversible one? */
function reachesOutward(safety: ActionSafetyLevel): boolean {
  return safetyRank(safety) > safetyRank('safe_internal')
}

/* ------------------------------------------------------------ the floors -- */

/**
 * The running answer while the floors are applied.
 *
 * A tiny mutable object rather than eleven nested returns, because the thing
 * that must be obvious when reading `rule()` is the ORDER, and eleven early
 * returns hide it behind control flow.
 */
class Narrowing {
  private ceiling: ActiveDisposition = 'auto'
  private readonly floors: string[] = []

  /** Record that a layer was consulted and changed nothing. */
  note(layer: string, detail: string): void {
    this.floors.push(`${layer}:${detail}`)
  }

  /**
   * Record that a layer was consulted and put a lid on the answer.
   *
   * `Math.min` on the rank rather than an assignment: a layer that would raise
   * the ceiling is silently ignored, so adding a floor in the wrong place can
   * make the product more timid and can never make it act.
   */
  capAt(layer: string, detail: string, ceiling: ActiveDisposition): void {
    const narrowed = dispositionRank(ceiling) < dispositionRank(this.ceiling)
    if (narrowed) this.ceiling = ceiling
    this.floors.push(
      narrowed
        ? `${layer}:${detail}:capped_at_${ceiling}`
        : `${layer}:${detail}`,
    )
  }

  allow(): PolicyRuling {
    return {
      allowed: true,
      disposition: this.ceiling,
      appliedFloors: [...this.floors],
    }
  }
}

function refuse(
  reason: AutopilotSuppressionReason,
  explanation: string,
): PolicyRuling {
  return { allowed: false, reason, explanation }
}

/* ---------------------------------------------------------------- ruling -- */

/**
 * May this action happen, and how much of it?
 *
 * `confidence` is a third argument rather than a field on `PolicyContext`
 * because it belongs to the PROPOSAL and not to the organization: one pass
 * over one morning produces a high-confidence overdue balance and a
 * low-confidence guess about an extra cleaner, under one identical context.
 * `PolicyContext` is frozen shared shape, so this is where the proposal's own
 * judgment enters.
 *
 * It defaults to `low`, and that default is the fail-closed one. A caller that
 * states no judgment has not made one, and an action above `safe_internal`
 * that nobody is willing to put a confidence on is not an action that should
 * run unattended. Actions at `information` and `safe_internal` are unaffected
 * by the default, so the two-argument call is still the whole answer for them.
 */
export function rule(
  action: AutopilotActionKind,
  context: PolicyContext,
  confidence: AutopilotConfidence = 'low',
): PolicyRuling {
  const spec = AUTOPILOT_ACTIONS[action]
  const narrowing = new Narrowing()

  /* a · The kill switch. Nothing below this matters if it is off. */
  if (!context.enabled) {
    return refuse(
      'kill_switch',
      'הטייס האוטומטי כבוי במתג הראשי, ולכן לא בוצעה שום פעולה. ' +
        'ההגדרות נשמרו ויחזרו לפעול ברגע שהוא יידלק.',
    )
  }
  narrowing.note('kill_switch', 'enabled')

  /* b · A pause, but only a pause that has not run out.
   *
   * A `paused_until` in the past means NOTHING. 0046 says so in as many words
   * on the column, and the reason is that the alternative is a business that
   * paused Autopilot for an hour during an incident in March and is still
   * switched off in June without anybody having decided that. */
  if (context.pausedUntil !== null) {
    const until = new Date(context.pausedUntil)
    const expired =
      Number.isNaN(until.getTime()) || until.getTime() <= context.now.getTime()

    if (!expired) {
      return refuse(
        'paused',
        `הטייס האוטומטי מושהה עד ${context.pausedUntil}, ולכן הפעולה לא בוצעה.`,
      )
    }
    narrowing.note('pause', 'expired')
  } else {
    narrowing.note('pause', 'none')
  }

  /* c · The module. A business without inventory is never told to reserve
   * stock it does not have — see the header of `actions.ts`. */
  if (spec.requires !== null && !context.entitlements.includes(spec.requires)) {
    return refuse(
      'missing_entitlement',
      `הפעולה "${spec.label}" שייכת למודול ${spec.requires} שאינו כלול בחבילה.`,
    )
  }
  narrowing.note('entitlement', spec.requires ?? 'core')

  /* d · The grant. Asked exactly as a click is asked — permission and package
   * as one question, through `holdsGrant`. An automation is not a way around
   * the authorization engine. */
  if (!context.holdsGrant(spec.grant)) {
    return refuse(
      'missing_permission',
      `לזהות שמפעילה את הטייס האוטומטי אין את ההרשאה ${spec.grant}, ` +
        `ולכן "${spec.label}" לא בוצעה.`,
    )
  }
  narrowing.note('grant', spec.grant)

  /* e · How this one booking wants to be treated.
   *
   * Neither value stops the WATCHING, which is why neither refuses here: the
   * bookings somebody marks are the ones they most want to be warned about,
   * and a wedding flagged `manual_only` that produced silence would be the
   * exact opposite of what the flag was for. */
  switch (context.bookingHandling) {
    case 'manual_only':
      narrowing.capAt('booking_handling', 'manual_only', 'suggest')
      break
    case 'high_attention':
      if (reachesOutward(spec.safety)) {
        narrowing.capAt('booking_handling', 'high_attention', 'ask_approval')
      } else {
        narrowing.note('booking_handling', 'high_attention')
      }
      break
    default:
      narrowing.note('booking_handling', 'normal')
  }

  /* f · The ladder the customer chose, already narrowed by the property. */
  switch (context.level) {
    case 'off':
      return refuse(
        'level_too_low',
        'רמת הטייס האוטומטי היא "כבוי", ולכן לא מוצעת ולא מתבצעת שום פעולה.',
      )
    case 'advisory':
      narrowing.capAt('level', 'advisory', 'suggest')
      break
    case 'assisted':
      narrowing.capAt('level', 'assisted', 'ask_approval')
      break
    case 'autopilot':
      narrowing.note('level', 'autopilot')
      break
    case 'custom':
      // `custom` is off the ladder on purpose: it means the matrix decides
      // action by action, so the level itself must impose nothing. The next
      // floor is where the answer comes from.
      narrowing.note('level', 'custom')
      break
  }

  /* g · The matrix. A cell the customer wrote themselves. */
  const configured = context.dispositions[action]
  if (configured === undefined) {
    // A missing cell means the ladder's default rather than `off`, so a
    // business can move the whole level without first writing a row per
    // action. Under `custom` there is no ladder to fall back to, and the
    // timid reading is the right one: a matrix that has not been filled in
    // has not authorised anything.
    if (context.level === 'custom') {
      narrowing.capAt('matrix', 'unset_under_custom', 'suggest')
    } else {
      narrowing.note('matrix', 'unset')
    }
  } else if (configured === 'off') {
    return refuse(
      'policy_off',
      `מדיניות הארגון מכבה את הפעולה "${spec.label}".`,
    )
  } else {
    narrowing.capAt('matrix', configured, configured)
  }

  /* h · The platform's own floor, and it is the last word.
   *
   * `autopilot_safety_rules` carries no `organization_id` and no tenant role
   * may write it. Money, guest access and cancellation are capped at
   * `ask_approval` for every customer on every package, whatever their matrix
   * says — and because every floor only narrows, it does not matter that the
   * customer's cell was read first.
   *
   * Two maps, because `action_kind` on that table is nullable: a blanket rule
   * lands by safety level, and a rule written about ONE action after an
   * incident with that one thing lands by action. Whichever is stricter wins,
   * and the floor entry names the one that bit — a person asking why this is
   * only a suggestion needs to know whether to go and look at a rule about
   * money or a rule about this action. */
  const byLevel = context.safetyCeiling[spec.safety]
  const byAction = context.safetyCeilingByAction?.[action]

  let ceiling = byLevel
  let ceilingDetail: string = spec.safety
  if (
    byAction !== undefined &&
    (byLevel === undefined ||
      dispositionRank(byAction) < dispositionRank(byLevel))
  ) {
    ceiling = byAction
    ceilingDetail = action
  }

  if (ceiling === 'off') {
    return refuse(
      'platform_rule',
      `כלל בטיחות של ESTIA אוסר לחלוטין על "${spec.label}". ` +
        'זו מגבלת פלטפורמה שלא ניתן לשנות בהגדרות.',
    )
  }
  if (ceiling === undefined) {
    narrowing.note('platform_ceiling', 'none')
  } else {
    narrowing.capAt('platform_ceiling', ceilingDetail, ceiling)
  }

  /* i · How sure the proposal was.
   *
   * A guess may be offered and prepared; it may not be performed. The cap
   * applies only above `safe_internal` because a low-confidence internal task
   * that turns out to be unnecessary is closed in one click, and demanding
   * approval for those would train people to approve without reading. */
  if (confidence === 'low' && reachesOutward(spec.safety)) {
    narrowing.capAt('confidence', 'low', 'ask_approval')
  } else {
    narrowing.note('confidence', confidence)
  }

  /* j · Quiet hours, which are about not waking people and nothing else.
   *
   * So this never suppresses. A shortage noticed at 02:00 still opens the
   * task, still updates the readiness figure and is still on the morning
   * brief; what waits is the part somebody would have to read at 02:00. */
  if (context.inQuietHours && reachesOutward(spec.safety)) {
    narrowing.capAt('quiet_hours', 'inside', 'ask_approval')
  } else {
    narrowing.note('quiet_hours', context.inQuietHours ? 'inside' : 'outside')
  }

  /* k · Simulation, which is recorded here and capped NOWHERE.
   *
   * Deliberately not a suppression and — since this floor was reconsidered —
   * deliberately not a cap either. `rule()` answers "what would be allowed
   * here", and the run mode is not part of that question.
   *
   * A cap at `ask_approval` broke the only thing simulation is for. The review
   * screen a business reads before go-live exists to say "ESTIA would have
   * sent 14 reminders automatically"; under a cap the strongest sentence it
   * could ever produce was "would have asked you", so the feature that exists
   * to earn trust could no longer show the thing it was built to show. Worse,
   * `ask_approval` is a real instruction rather than a label: an executor
   * honouring it would raise genuine approval requests during a simulation,
   * which is precisely the zero-external-actions promise the mode sells.
   *
   * Nothing is lost by dropping it, because two other floors already stop a
   * simulation and neither one is this:
   *
   *   · the executor reads `runMode` first, records the action with outcome
   *     `simulated` and dispatches nothing;
   *   · `autopilot_actions_simulation_never_executes` in 0046 makes a
   *     simulated run structurally incapable of recording an execution.
   *
   * The entry is still pushed, because a ruling has to say the mode was seen —
   * a reader comparing a simulated ruling with a live one must be able to tell
   * that the difference is not that somebody forgot to look. */
  narrowing.note('run_mode', context.runMode)

  return narrowing.allow()
}

/**
 * The disposition alone, for a caller that has already decided a refusal is
 * simply "no". Returns `off` for a refusal, so the closed vocabulary still
 * covers the answer.
 */
export function dispositionOf(ruling: PolicyRuling): AutopilotDisposition {
  return ruling.allowed ? ruling.disposition : 'off'
}
