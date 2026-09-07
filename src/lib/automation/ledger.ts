/**
 * `AutomationLedger`, backed by `public.automation_ledger` (0078).
 *
 * ══ THE THING THIS REPLACES, AND WHY IT HAD TO BE REPLACED ═══════════════════
 *
 * `performing.ts` names the gap in its own header, and it is worth keeping the
 * sentence next to the fix: `InMemoryAutomationLedger` "is atomic because
 * JavaScript is single-threaded and for no other reason. Two application
 * instances behind a load balancer would each keep their own idea of which keys
 * are taken, and the failure that produces — 'we sent the guest two payment
 * links' — is precisely what the ledger exists to prevent."
 *
 * On the deployment this product is heading for, "two instances" is the normal
 * case rather than the scaled one: two concurrent requests are two lambda
 * invocations with two heaps. The in-memory ledger does not deduplicate
 * anything the moment a business has two people using the system at once.
 *
 * ══ THERE IS NO DEDUPLICATION LOGIC IN THIS FILE ════════════════════════════
 *
 * Not a read, not a `has` check, not a set. `claim` is one RPC and the RPC is
 * one `insert … on conflict do nothing`, decided by the table's primary key.
 * Anything cleverer here would be a second answer to "has this already run",
 * and the day the two disagreed a guest would be messaged twice — which is the
 * one outcome this whole mechanism exists to prevent.
 *
 * ══ WHAT A FAILED CLAIM MEANS, AND WHAT A THROW MEANS ═══════════════════════
 *
 * `false` means somebody already holds the key: the engine reports
 * `skipped_duplicate` and does nothing, which is correct and not an error.
 *
 * A throw means the ledger could not be reached or refused the caller. That is
 * deliberately NOT flattened into `false`, because `false` tells the engine "it
 * already ran" and a network failure has told it no such thing. Swallowing the
 * error would turn a database blip into a permanent, silent decision never to
 * perform an action nobody has performed — the failure mode is invisible, which
 * is the worst kind to buy for an unhandled exception's sake.
 */

import type { Db } from '../persistence/client'

import type { AutomationLedger, RuleOutcome } from './engine'

/** Everything one delivery needs, so the engine's contract is unchanged. */
export class SupabaseAutomationLedger implements AutomationLedger {
  constructor(private readonly db: Db) {}

  async claim(organizationId: string, key: string): Promise<boolean> {
    const { data, error } = await this.db.rpc('automation_ledger_claim', {
      p_organization_id: organizationId,
      p_key: key,
    })

    if (error) throw error

    // `=== true` and not a truthy test. The function returns a boolean, and a
    // `null` from an RPC that failed to return anything must read as "not
    // claimed" — performing on an answer the ledger did not give is exactly
    // the double-send this prevents.
    return data === true
  }

  async release(organizationId: string, key: string): Promise<void> {
    const { error } = await this.db.rpc('automation_ledger_release', {
      p_organization_id: organizationId,
      p_key: key,
    })

    if (error) throw error
  }
}

/**
 * Stamp the decision record with what actually happened.
 *
 * Separate from the ledger interface on purpose: the engine claims and releases
 * and knows nothing about `automation_runs`. This is the caller's job, after a
 * run, and it is the only way those two columns are ever written — 0075 grants
 * UPDATE on that table to nobody and 0078 did not change that.
 *
 * `outcome` is one of the values `automation_runs_performed_outcome_shape`
 * accepts. The type below is the same list, so a value the database would
 * refuse does not compile.
 */
export type PerformedOutcome =
  | 'executed'
  | 'executed_unaudited'
  | 'failed'
  | 'refused_permission'
  | 'refused_plan'
  | 'skipped_duplicate'

/**
 * One rule's several actions, reduced to the one word the record keeps.
 *
 * ── THE WORST NEWS WINS, AND THAT IS THE WHOLE RULE ───────────────────────
 *
 * `automation_runs.performed_outcome` is a single value and a rule may have
 * several actions. A rule that opened a task and failed to message the guest
 * cannot be recorded as `executed`: a manager reading that word stops looking,
 * and the thing that did not happen is the thing they needed to know about.
 * So the order below is severity, not sequence.
 *
 * `skipped_duplicate` sits at the bottom deliberately. It is not a failure —
 * it means an earlier delivery already did this — so it only wins when it is
 * the whole story, and never masks an action that genuinely failed beside it.
 *
 * Returns `null` for a rule that never reached its actions. Those already have
 * their answer in `decision`, and `automation_run_performed` refuses to stamp
 * anything that did not decide `would_act` — so a caller that ignored this and
 * stamped anyway would be refused by the database as well.
 */
export function performedOutcome(
  outcome: RuleOutcome,
): PerformedOutcome | null {
  if (outcome.status !== 'ran') return null

  const statuses = new Set(outcome.actions.map((entry) => entry.outcome.status))

  if (statuses.has('failed')) return 'failed'
  if (statuses.has('refused_permission')) return 'refused_permission'
  if (statuses.has('refused_plan')) return 'refused_plan'
  if (statuses.has('executed_unaudited')) return 'executed_unaudited'
  if (statuses.has('executed')) return 'executed'
  if (statuses.has('skipped_duplicate')) return 'skipped_duplicate'

  // A rule with no actions cannot exist — `AutomationRule.actions` is a
  // non-empty tuple — so this is unreachable rather than a default. Null
  // rather than a guess, so an impossible state is not recorded as work.
  return null
}

export async function recordPerformed(
  db: Db,
  input: {
    organizationId: string
    eventKey: string
    templateId: string
    outcome: PerformedOutcome
  },
): Promise<void> {
  const { error } = await db.rpc('automation_run_performed', {
    p_organization_id: input.organizationId,
    p_event_key: input.eventKey,
    p_template_id: input.templateId,
    p_outcome: input.outcome,
  })

  if (error) throw error
}
