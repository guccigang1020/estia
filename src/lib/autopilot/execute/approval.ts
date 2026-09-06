/**
 * Somebody pressed the button.
 *
 * An `ask_approval` action was prepared and recorded, and then a person read
 * it and agreed. What happens next is deliberately the same path an `auto`
 * action takes — `executePreparedAction`, one claim, one audit — because the
 * alternative is a second execution path that quietly diverges from the first,
 * and the divergence is always discovered in production.
 *
 * ── Two actors, one record ───────────────────────────────────────────────
 *
 * The audit line reads "prepared by Autopilot, approved by <person>", the
 * actor type stays `system`, and the approver is on the record as
 * `onBehalfOfUserId`. Recording only the person would claim they wrote the
 * message; recording only Autopilot would hide that a human released it. Both
 * happened, so both are recorded.
 *
 * `autopilot_actions_approved_pair` requires `approved_by` and `approved_at` to
 * move together, and they are written in one patch here for that reason.
 *
 * ── What this file does not decide ───────────────────────────────────────
 *
 * Whether this person may approve anything at all is a permission question,
 * answered by `autopilot.approve` at the route that calls this, and whether
 * they may perform the underlying action is answered by the domain command's
 * own `assertCan`. Neither is re-answered here: a second opinion about a
 * permission is a second answer, and the day they disagree nobody knows which
 * one the customer is living in.
 *
 * ── Pressed twice ────────────────────────────────────────────────────────
 *
 * The second press finds the row no longer `awaiting_approval` and is refused
 * without touching anything. Two presses that genuinely race past that check
 * meet the ledger claim inside `executePreparedAction`, and the loser is
 * recorded as `suppressed` / `duplicate` rather than sending a second message.
 */

import type { AutopilotActionRow } from './repository'
import {
  executePreparedAction,
  type ApprovalStamp,
  type ExecutionDeps,
  type ExecutionReport,
} from './dispatch'

export type ApprovalRefusal =
  'not_found' | 'not_awaiting_approval' | 'simulation'

export type ApprovalResult =
  | { status: 'approved'; report: ExecutionReport }
  /** Nothing was written. `explanation` is Hebrew and is for the screen. */
  | { status: 'refused'; reason: ApprovalRefusal; explanation: string }

export interface ApproveActionInput {
  organizationId: string
  actionId: string
  approver: ApprovalStamp
  deps: ExecutionDeps
}

export async function approveAction(
  input: ApproveActionInput,
): Promise<ApprovalResult> {
  const { deps } = input

  const row = await deps.repository.findById(
    input.organizationId,
    input.actionId,
  )

  if (!row) {
    return {
      status: 'refused',
      reason: 'not_found',
      explanation: 'הפעולה המבוקשת אינה קיימת.',
    }
  }

  // A simulated action has nothing to approve, and the schema agrees: a
  // simulation row may only ever be simulated, suppressed, cancelled or
  // planned, so `approved` is a row the database would refuse.
  if (row.runMode === 'simulation') {
    return {
      status: 'refused',
      reason: 'simulation',
      explanation:
        'הפעולה נרשמה בהרצת סימולציה ולכן אין מה לאשר — היא לא הייתה מבוצעת.',
    }
  }

  if (row.outcome !== 'awaiting_approval') {
    return {
      status: 'refused',
      reason: 'not_awaiting_approval',
      explanation: `הפעולה כבר אינה ממתינה לאישור (מצבה: ${row.outcome}).`,
    }
  }

  const approved = await deps.repository.update(row, {
    outcome: 'approved',
    approvedBy: input.approver.userId,
    approvedAt: deps.now(),
  })

  return {
    status: 'approved',
    report: await executePreparedAction(approved, deps, {
      approval: input.approver,
    }),
  }
}

/** True when a person still has to look at this one. For the review screen. */
export function awaitsApproval(row: AutopilotActionRow): boolean {
  return row.outcome === 'awaiting_approval'
}
