/**
 * Today's rows, sorted into the five things a manager actually asks.
 *
 * ── This is routing, not judgment ────────────────────────────────────────
 *
 * Every test below reads a stored enum and nothing else. There is no "at risk
 * because the deadline is within the hour" here — `warn_at` and `critical_at`
 * exist precisely so that the threshold belongs to the detector, and `risk` is
 * that detector's conclusion. There is no "needs a decision because the safety
 * level is high" either: `awaiting_approval` is the database's own word for a
 * row a person must decide, written by the policy engine when it ruled.
 *
 * If a section ever needs a fact that is not on the row, the fix is a column
 * or a stage, not a comparison in this file.
 *
 * ── Every row lands in exactly one section ───────────────────────────────
 *
 * The sections are tried in order and the first match wins, so an at-risk
 * upsell opportunity appears under הזדמנויות rather than twice. Two rules make
 * that a property rather than a hope, and both are asserted in the tests:
 *
 *   1. The buckets partition the input — every exception and every action is
 *      in exactly one, and nothing is dropped.
 *   2. `watching` is a real bucket and not a bin. An exception that is open,
 *      on track, and not an opportunity is not a problem and not nothing: it
 *      is what ESTIA is keeping an eye on, and the calm screen shows it. A
 *      "default: discard" branch is how a screen ends up quietly hiding rows
 *      somebody wrote a detector for.
 *
 * ── Why opportunities are a domain test and not a risk test ──────────────
 *
 * `sales_opportunity` and `optimization` are the last two members of
 * `AUTOPILOT_DOMAINS`, and the tuple's order IS the triage priority — safety
 * first, revenue last, and nothing reorders it per organization. Reading the
 * domain is therefore reading a decision the vocabulary already made, whereas
 * a keyword test over the title would be this file inventing one.
 */

import type { ActionView, ExceptionView } from '@/components/autopilot/views'
import type {
  AutopilotActionOutcome,
  AutopilotDomain,
  AutopilotExceptionState,
  AutopilotRiskState,
} from '@/lib/contracts/states'

/** The two domains that are about making money rather than not losing it. */
const OPPORTUNITY_DOMAINS: readonly AutopilotDomain[] = [
  'sales_opportunity',
  'optimization',
]

/** Somebody has picked this up. */
const WORKING_STATES: readonly AutopilotExceptionState[] = ['in_progress']

/** Nobody has picked this up yet. */
const OPEN_STATES: readonly AutopilotExceptionState[] = ['new', 'acknowledged']

const ALARMING: readonly AutopilotRiskState[] = ['at_risk', 'critical']

/** Queued, approved or retrying: ESTIA is on it and nobody need press a key. */
const WORKING_OUTCOMES: readonly AutopilotActionOutcome[] = [
  'planned',
  'approved',
  'retrying',
]

/**
 * Finished, one way or another — including the ways that are not "it worked".
 *
 * `suppressed` and `simulated` are first-class successes, as 0046 says: an
 * action correctly declined is the system working, and a customer worried
 * about what Autopilot might do is exactly the customer who needs to see the
 * refusals. `failed`, `needs_review` and `executed_unaudited` are here too
 * because they are done and they need a person to look — they are rendered
 * with their error, not as quiet successes.
 */
const SETTLED_OUTCOMES: readonly AutopilotActionOutcome[] = [
  'executed',
  'executed_unaudited',
  'simulated',
  'suppressed',
  'cancelled',
  'failed',
  'needs_review',
]

export type Triage = {
  /** Prepared and waiting for a human choice. */
  decisions: readonly ActionView[]
  /** Open, and the detector says it is going wrong. */
  atRisk: readonly ExceptionView[]
  /** Somebody or ESTIA is already working on it. */
  inProgressExceptions: readonly ExceptionView[]
  inProgressActions: readonly ActionView[]
  /** Revenue and optimisation, open. */
  opportunities: readonly ExceptionView[]
  /** What ESTIA did, including what it declined to do. */
  handled: readonly ActionView[]
  /** Open, on track, not an opportunity. Watched, and not a problem. */
  watching: readonly ExceptionView[]
}

export function triage(
  exceptions: readonly ExceptionView[],
  actions: readonly ActionView[],
): Triage {
  const atRisk: ExceptionView[] = []
  const inProgressExceptions: ExceptionView[] = []
  const opportunities: ExceptionView[] = []
  const watching: ExceptionView[] = []

  for (const row of exceptions) {
    if (WORKING_STATES.includes(row.state)) {
      inProgressExceptions.push(row)
    } else if (OPPORTUNITY_DOMAINS.includes(row.domain)) {
      opportunities.push(row)
    } else if (ALARMING.includes(row.risk) && OPEN_STATES.includes(row.state)) {
      atRisk.push(row)
    } else {
      watching.push(row)
    }
  }

  const decisions: ActionView[] = []
  const inProgressActions: ActionView[] = []
  const handled: ActionView[] = []

  for (const action of actions) {
    if (action.outcome === 'awaiting_approval') {
      decisions.push(action)
    } else if (WORKING_OUTCOMES.includes(action.outcome)) {
      inProgressActions.push(action)
    } else if (SETTLED_OUTCOMES.includes(action.outcome)) {
      handled.push(action)
    } else {
      // Unreachable while `AUTOPILOT_ACTION_OUTCOMES` has eleven members and
      // the three lists above cover all of them. Kept so that adding a twelfth
      // surfaces it on the screen rather than deleting it, and so the
      // partition test above has something to fail on.
      handled.push(action)
    }
  }

  return {
    decisions,
    atRisk,
    inProgressExceptions,
    inProgressActions,
    opportunities,
    handled,
    watching,
  }
}

/**
 * Is there anything at all that wants a person today?
 *
 * The four sections that represent work, and deliberately not `handled` or
 * `watching`: a day on which ESTIA did fourteen things and none of them needs
 * anybody is a calm day, and the screen should say so rather than look busy.
 */
export function needsAttention(result: Triage): boolean {
  return (
    result.decisions.length > 0 ||
    result.atRisk.length > 0 ||
    result.inProgressExceptions.length > 0 ||
    result.inProgressActions.length > 0 ||
    result.opportunities.length > 0
  )
}
