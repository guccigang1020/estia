/**
 * Undo, where undo is a real thing.
 *
 * ── A fake Undo button is worse than none ────────────────────────────────
 *
 * A sent WhatsApp is sent. A guest who has read "your door code is 4417" has
 * read it, and no row this system writes changes that. An interface offering
 * to undo it would teach a manager that Autopilot's external actions are
 * provisional — which is exactly the belief that gets somebody to let it send
 * something they were not sure about, at 23:00, on the strength of a button
 * that cannot do what it says.
 *
 * So reversal is offered only for what is genuinely reversible: an assignment
 * put back, an unsent draft cancelled, an internal status restored. Everything
 * at `external_communication` or above returns an explicit refusal with a
 * sentence saying why, and the screen shows the sentence instead of a button.
 *
 * ── The reversal is a domain command too ─────────────────────────────────
 *
 * Undoing an assignment is assigning it back, through the same operation a
 * person would use. Nothing here writes a business table, for the same reason
 * nothing in `dispatch.ts` does — and so an undo is validated, authorized and
 * audited exactly like the action it reverses.
 *
 * ── What is reversible today ─────────────────────────────────────────────
 *
 * The reversals below name the commands that would perform them. None of those
 * commands exists yet — the task and laundry-cancellation operations are not
 * written — so every one of these currently resolves to
 * `command_unavailable`, which is a refusal that names the missing piece rather
 * than a button that does nothing. The table is written out anyway because the
 * reversal is a property of the action, decided once, and not something to
 * invent under pressure the day the operation lands.
 */

import { recordAuditEvent } from '../../audit/pipeline'
import { ACTION_SAFETY_LEVELS } from '../../contracts/states'
import type { ActionSafetyLevel } from '../../contracts/states'
import { AUTOPILOT_ACTIONS, type AutopilotActionKind } from '../actions'

import type { ExecutionDeps } from './dispatch'
import { plannedFromRow, type AutopilotActionRow } from './repository'
import type { CommandRegistry, CommandResult } from './registry'

/* ---------------------------------------------------------- reversals --- */

interface Reversal {
  /** The domain command that puts it back. */
  command: string
  /** Hebrew. What the button would do. */
  describe: string
  /**
   * The command's input, or `null` when the row does not carry what the
   * reversal needs — the previous assignee, the previous priority. A reversal
   * that guessed the old value would not be a reversal.
   */
  input: (row: AutopilotActionRow) => Record<string, unknown> | null
  /** Hebrew, naming the missing fact when `input` returns null. */
  requires: string
}

function fieldOf(row: AutopilotActionRow, key: string): unknown {
  return row.result[key] ?? row.commandInput[key]
}

function stringOf(row: AutopilotActionRow, key: string): string | null {
  const value = fieldOf(row, key)
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Which internal actions can be put back, and how.
 *
 * Keyed by action kind and deliberately not derived from the safety level: not
 * everything internal is reversible. Releasing a hold that had expired is
 * `safe_internal` and is NOT here, because the dates may already have been sold
 * to somebody else and "un-releasing" it would be a new commercial decision
 * wearing an undo button.
 */
export const REVERSALS: Readonly<
  Partial<Record<AutopilotActionKind, Reversal>>
> = {
  'task.create': {
    command: 'tasks.cancelTask',
    describe: 'ביטול המשימה שנפתחה',
    input: (row) => {
      const taskId = stringOf(row, 'taskId')
      return taskId === null ? null : { taskId }
    },
    requires: 'מזהה המשימה שנוצרה',
  },
  'task.assign': {
    command: 'tasks.assignTask',
    describe: 'החזרת השיוך למי שהיה קודם',
    input: (row) => {
      const taskId = stringOf(row, 'taskId')
      const previous = stringOf(row, 'previousAssigneeId')
      return taskId === null || previous === null
        ? null
        : { taskId, assigneeId: previous }
    },
    requires: 'המשויך הקודם',
  },
  'maintenance.raise_priority': {
    command: 'tasks.changePriority',
    describe: 'החזרת הדחיפות לערך הקודם',
    input: (row) => {
      const taskId = stringOf(row, 'taskId')
      const previous = stringOf(row, 'previousPriority')
      return taskId === null || previous === null
        ? null
        : { taskId, priority: previous }
    },
    requires: 'הדחיפות הקודמת',
  },
  'laundry.draft_order': {
    command: 'laundry.cancelDraftOrder',
    describe: 'ביטול טיוטת ההזמנה שטרם נשלחה',
    input: (row) => {
      const orderId = stringOf(row, 'orderId') ?? stringOf(row, 'id')
      return orderId === null ? null : { orderId }
    },
    requires: 'מזהה ההזמנה',
  },
}

/* ------------------------------------------------------------- the plan -- */

export type UndoRefusal =
  /** It left the building. Sent is sent. */
  | 'external_action'
  | 'not_executed'
  | 'already_undone'
  | 'no_reversal'
  | 'command_unavailable'

export type UndoPlan =
  | {
      reversible: true
      command: string
      input: Readonly<Record<string, unknown>>
      /** Hebrew, for the button. */
      describe: string
    }
  /** Hebrew, for the sentence that replaces the button. */
  | { reversible: false; reason: UndoRefusal; explanation: string }

function rank(level: ActionSafetyLevel): number {
  return ACTION_SAFETY_LEVELS.indexOf(level)
}

/**
 * Whether this action can be put back, and how.
 *
 * Pure. A screen calls it to decide whether to render a button at all, and
 * `undoAction` calls it again before doing anything — so the answer cannot
 * drift between what was offered and what happens.
 */
export function planUndo(
  row: AutopilotActionRow,
  registry: CommandRegistry,
): UndoPlan {
  if (row.undoneAt !== null) {
    return {
      reversible: false,
      reason: 'already_undone',
      explanation: 'הפעולה כבר בוטלה.',
    }
  }

  if (row.outcome !== 'executed' && row.outcome !== 'executed_unaudited') {
    return {
      reversible: false,
      reason: 'not_executed',
      explanation: `אין מה לבטל: הפעולה לא בוצעה (מצבה: ${row.outcome}).`,
    }
  }

  if (rank(row.safetyLevel) >= rank('external_communication')) {
    return {
      reversible: false,
      reason: 'external_action',
      explanation:
        'הפעולה יצאה החוצה — הודעה שנשלחה נשלחה, ואי אפשר לבטל אותה. ' +
        'אפשר לשלוח הודעה מתקנת.',
    }
  }

  const reversal = REVERSALS[row.actionKind]
  if (!reversal) {
    return {
      reversible: false,
      reason: 'no_reversal',
      explanation: `אין ביטול אוטומטי ל${AUTOPILOT_ACTIONS[row.actionKind].label}.`,
    }
  }

  const input = reversal.input(row)
  if (input === null) {
    return {
      reversible: false,
      reason: 'no_reversal',
      explanation: `לא ניתן לבטל: חסר ${reversal.requires} ברישום הפעולה.`,
    }
  }

  if (registry.resolve(reversal.command).status !== 'available') {
    return {
      reversible: false,
      reason: 'command_unavailable',
      explanation: `הפקודה ${reversal.command} אינה ממומשת, ולכן אין ביטול אוטומטי.`,
    }
  }

  return {
    reversible: true,
    command: reversal.command,
    input,
    describe: reversal.describe,
  }
}

/* ----------------------------------------------------------- the doing --- */

export interface UndoActor {
  userId: string
  label: string
}

export type UndoResult =
  | { status: 'undone'; action: AutopilotActionRow; result: CommandResult }
  | { status: 'refused'; reason: UndoRefusal; explanation: string }
  | { status: 'failed'; code: string; detail: string }

/**
 * Put it back.
 *
 * The undo takes its own idempotency claim, derived from the action's key, so
 * a button pressed twice reverses once. The row keeps its outcome — the action
 * did happen, and a log that erased it would be a log the party who most wants
 * it gone can edit — and gains `undone_at` and `undone_by`, which
 * `autopilot_actions_undone_pair` requires to move together.
 */
export async function undoAction(
  row: AutopilotActionRow,
  deps: ExecutionDeps,
  actor: UndoActor,
): Promise<UndoResult> {
  const plan = planUndo(row, deps.registry)
  if (!plan.reversible) {
    return {
      status: 'refused',
      reason: plan.reason,
      explanation: plan.explanation,
    }
  }

  const resolution = deps.registry.resolve(plan.command)
  if (resolution.status !== 'available') {
    return {
      status: 'refused',
      reason: 'command_unavailable',
      explanation: `הפקודה ${plan.command} אינה ממומשת, ולכן אין ביטול אוטומטי.`,
    }
  }

  const undoKey = `${row.idempotencyKey}::undo`
  const claimed = await deps.ledger.claim(row.organizationId, undoKey)
  if (!claimed) {
    return {
      status: 'refused',
      reason: 'already_undone',
      explanation: 'ביטול הפעולה כבר התבצע או מתבצע כעת.',
    }
  }

  const undoneAt = deps.now()
  const planned = plannedFromRow(row)

  let result: CommandResult
  try {
    result = await resolution.run({
      action: {
        ...planned,
        command: plan.command,
        commandInput: plan.input,
        idempotencyKey: undoKey,
        reason: `ביטול פעולת אוטופיילוט: ${plan.describe}`,
      },
      attempt: 1,
      idempotencyKey: undoKey,
      correlationId: row.correlationId ?? deps.correlationId,
      now: undoneAt,
    })
  } catch (cause) {
    // The claim goes back: an undo that failed on a blip is one a person should
    // be able to press again, and unlike a forward action there is no risk of
    // it having half-happened outside the business.
    await deps.ledger.release(row.organizationId, undoKey)
    return {
      status: 'failed',
      code: 'undo_failed',
      detail: cause instanceof Error ? cause.message : String(cause),
    }
  }

  const spec = AUTOPILOT_ACTIONS[row.actionKind]

  // A person did this one, and the timeline says so.
  let auditError: string | null = null
  try {
    await recordAuditEvent(
      {
        actor: { type: 'user', userId: actor.userId, label: actor.label },
        context: {
          organizationId: row.organizationId,
          propertyId: row.propertyId,
          requestId: row.correlationId ?? deps.correlationId,
        },
        action: spec.grant,
        resourceType: 'autopilot_action',
        resourceId: row.id,
        before: { undoneAt: null },
        after: { undoneAt: undoneAt.toISOString(), command: plan.command },
        summary:
          `${actor.label} ביטלה פעולה של אוטופיילוט · ` +
          `${spec.label}: ${plan.describe}`,
      },
      deps.audit,
      { occurredAt: undoneAt },
    )
  } catch (cause) {
    // The reversal happened. Reporting it as failed would be a lie, and
    // dropping the audit failure silently would be the other one, so the row
    // carries both facts — the same argument `executed_unaudited` makes.
    auditError = cause instanceof Error ? cause.message : String(cause)
  }

  const updated = await deps.repository.update(row, {
    undoneAt,
    undoneBy: actor.userId,
    ...(auditError === null
      ? {}
      : { errorCode: 'audit_write_failed', errorDetail: auditError }),
  })

  return { status: 'undone', action: updated, result }
}
