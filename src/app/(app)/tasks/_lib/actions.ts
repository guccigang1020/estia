'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. Everything the operations screens change.
 *
 * ── The rule this file exists to keep ─────────────────────────────────────
 *
 * Neither of these functions writes a row. Each resolves who is asking, checks
 * that they may, and hands the request to an operation from
 * `defineTaskCreation`, which is the only path to a task row that has
 * authorization, validation, the domain rule, the transaction, the audit event,
 * the domain event and idempotency wired into it in that order. A
 * `db.from('tasks').insert(...)` here would look identical on screen and would
 * skip all seven.
 *
 * ── Why `assertCan` is called here as well ────────────────────────────────
 *
 * The pipeline checks the same permission. This check is not redundant, it is
 * the independent one: the screen hides controls the actor cannot use, and
 * hiding a control is not authorization. An action reached by a crafted POST —
 * which is all a Server Action is — must refuse on its own terms, before it has
 * read anything. Deny by default, twice, on purpose.
 *
 * And the resource matters here more than usual. A cleaner scoped to the
 * housekeeping team may report a fault; `assertCan` with a resource carrying
 * the property she named is what stops her opening one against a property she
 * has no reach into by posting a different `propertyId`. The form's `<select>`
 * offers only what she may see; this is what enforces it.
 *
 * ── What a caller gets back ───────────────────────────────────────────────
 *
 * Never a thrown error. A throw inside a Server Action reaches the browser as a
 * digest and an empty screen, and the user learns nothing. Every failure is
 * turned into the `SafeErrorBody` that `src/lib/errors` already produced —
 * Hebrew sentence, whether the data was saved, whether retrying is safe, and a
 * correlation id that matches the server log.
 */

import { revalidatePath } from 'next/cache'

import { assertCan } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import {
  ValidationError,
  toSafeResponse,
  type SafeErrorBody,
} from '@/lib/errors'

import { shellContext } from '../../_lib/context'
import type { CreateTaskInput, CreatedTask } from './operations'
import { isReachableTarget, listTaskTargets } from './targets'
import { auditActorFor, operationsWiring } from './wiring'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

/** What the two forms send. The type is fixed by the wiring for a fault report. */
export type OpenTaskInput = CreateTaskInput & {
  /**
   * Generated once per form instance in the browser. A second submission of the
   * same form replays the first answer instead of opening a second task — the
   * server half of duplicate-submit protection, and the half a disabled button
   * cannot provide.
   */
  idempotencyKey: string
}

/**
 * The context every action needs, or the refusal that replaces it.
 *
 * A signed-out or workspace-less caller is refused here rather than allowed to
 * reach an operation with a fabricated actor. `shellContext()` is the same
 * resolution the shell rendered with — React `cache` shares it — so an action
 * cannot disagree with the screen about which organization it is in.
 */
async function requireReady() {
  const context = await shellContext()

  if (!context) {
    return {
      ok: false as const,
      error: {
        code: 'unauthenticated',
        message: 'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
        dataMessage: 'הנתונים לא נשמרו. שום דבר במערכת לא השתנה.',
        retryMessage: 'ניסיון חוזר לא יעזור עד שתתחבר מחדש.',
        dataOutcome: 'not_saved' as const,
        retryable: false,
        correlationId: crypto.randomUUID(),
      },
    }
  }

  if (context.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: 'membership_not_active',
        message: 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לפתוח משימות.',
        dataMessage: 'הנתונים לא נשמרו. שום דבר במערכת לא השתנה.',
        retryMessage: 'ניסיון חוזר לא יעזור עד שהחברות בארגון תופעל.',
        dataOutcome: 'not_saved' as const,
        retryable: false,
        correlationId: crypto.randomUUID(),
      },
    }
  }

  return { ok: true as const, context }
}

/** One place that turns a thrown failure into the three sentences a user is owed. */
function failure(
  cause: unknown,
  correlationId: string,
): { ok: false; error: SafeErrorBody } {
  return { ok: false, error: toSafeResponse(cause, correlationId).error }
}

async function open(
  input: OpenTaskInput,
  permission: Grant,
  which: 'task' | 'incident',
): Promise<ActionResult<CreatedTask>> {
  const ready = await requireReady()
  if (!ready.ok) return ready

  const { actor, user } = ready.context
  const correlationId = crypto.randomUUID()

  try {
    // ── The grant, plan and membership ───────────────────────────────────
    // Asked without a resource on purpose. `scopeReaches` answers a `team`
    // scope by looking for `resource.teamId`, and a *property* does not carry
    // one — so `can(cleaner, 'incident.create', { propertyId })` is false for
    // every cleaner in the product, and a cleaner reporting a fault is the
    // entire point of the incidents screen. The scope question is answered
    // immediately below in the one form that can answer it for every scope
    // kind, and it is a refusal rather than a silent narrowing.
    assertCan(actor, permission)

    const wiring = await operationsWiring()

    // ── The scope ────────────────────────────────────────────────────────
    // Re-derived here rather than trusted from the form. `listTaskTargets` is
    // the same function that filled the `<select>`, so what was not offered is
    // also not accepted — and a crafted POST naming somebody else's property
    // is refused with a field error rather than a database constraint.
    const targets = await listTaskTargets(wiring.db, actor)
    if (!isReachableTarget(targets, input)) {
      throw new ValidationError([
        {
          field: 'propertyId',
          code: 'out_of_scope',
          message:
            'הנכס או היחידה שנבחרו אינם בטווח ההרשאה שלך, ולכן לא ניתן לפתוח כאן עבודה.',
          label: 'נכס',
        },
      ])
    }

    const operation =
      which === 'incident' ? wiring.reportIncident : wiring.createTask

    const outcome = await operation.run({
      request: {
        input: {
          propertyId: input.propertyId,
          unitId: input.unitId,
          teamId: input.teamId,
          assignedToUserId: input.assignedToUserId,
          taskType: input.taskType,
          priority: input.priority,
          title: input.title,
          description: input.description,
          dueOn: input.dueOn,
        },
        idempotencyKey: input.idempotencyKey,
      },
      context: {
        actor,
        auditActor: auditActorFor(user),
        correlationId,
      },
      services: wiring.services,
    })

    // Three boards read the same table, and a fault report appears on all of
    // them. Revalidated together rather than left for the next hard navigation.
    revalidatePath('/tasks')
    revalidatePath('/maintenance')
    revalidatePath('/incidents')

    return { ok: true, data: outcome.data }
  } catch (cause) {
    return failure(cause, correlationId)
  }
}

/** Open an ordinary task. `task.create`. */
export async function createTaskAction(
  input: OpenTaskInput,
): Promise<ActionResult<CreatedTask>> {
  return open(input, 'task.create', 'task')
}

/**
 * Report a fault. `incident.create`.
 *
 * The one write in this product a cleaner may perform against work that is not
 * already hers. The task type is fixed by the wiring, not by the caller.
 */
export async function reportIncidentAction(
  input: OpenTaskInput,
): Promise<ActionResult<CreatedTask>> {
  return open(input, 'incident.create', 'incident')
}
