'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. What a person can do to one stay's plan.
 *
 * Six acts, and every one of them goes through `createPreparationOperations`.
 * There is no `db.from('work_plans').update(…)` anywhere on this screen,
 * because that call would look identical from the browser and would skip
 * authorization, validation, the domain rule, the optimistic lock, the
 * transaction, the audit event, the domain events and idempotency — eight
 * mechanisms, all of which exist and none of which announces itself when it is
 * missing.
 *
 * ── Idempotency, and which key each act uses ──────────────────────────────
 *
 * A Server Action is a POST. A person on a slow connection presses the button
 * twice, a mobile browser replays it after a tab restore, and a retry after a
 * timeout is the *correct* behaviour for a client that never saw the answer.
 * So every write here names a key, and the key is chosen so that a genuine
 * retry deduplicates and a genuine second act does not:
 *
 *   · **build** — `preparation.build:<bookingId>`. Stable for ever, and it can
 *     be: a booking has exactly one first plan. Pressing "build" twice is the
 *     same act, always, and the second press must not produce a second plan
 *     with a second snapshot. `buildPlan`'s own rule already refuses a booking
 *     that has a plan, but that refusal is an error message and this is a
 *     replayed success, which is what the person actually meant.
 *
 *   · **recompute / adjust / cancel** — keyed on the *version being edited*,
 *     `<act>:<bookingId>:<version>`. A double click retries the same edit; a
 *     second, deliberate edit is against a version that has moved, so it gets
 *     its own key and runs. Keying these on the booking alone would silently
 *     swallow the second real change; keying them on a random uuid would
 *     defeat the point.
 *
 *   · **complete / acknowledge** — `<act>:<bookingId>:<section>`. Ticking a
 *     section off is idempotent by nature and there is nothing to distinguish
 *     a retry from a repeat, because they are the same thing.
 *
 * A key is passed from the caller for none of them. The browser has no fact
 * the server does not, and a key it chose would be a key it could vary.
 *
 * ── Every action refuses on its own ───────────────────────────────────────
 *
 * `assertCan` runs here before anything is read, the operation's pipeline
 * checks the same permission again against the loaded booking, and row level
 * security refuses regardless. Three floors, because a Server Action is
 * reachable without the screen that rendered the form.
 */

import { revalidatePath } from 'next/cache'

import { assertCan, type Resource } from '@/lib/authz/can'
import type { Permission } from '@/lib/authz/permissions'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import {
  PLAN_SECTIONS,
  type PlanSectionKey,
  type PreparationOperations,
  type WorkPlan,
} from '@/lib/preparation'
import type {
  OperationContext,
  OperationOutcome,
  OperationServices,
} from '@/lib/service'

import { shellContext } from '../../_lib/context'
import { auditActorFor, planWiring } from './wiring'

export type PlanActionResult =
  { ok: true; version: number } | { ok: false; error: SafeErrorBody }

/* ------------------------------------------------------------- the gate -- */

async function requireReady() {
  const context = await shellContext()

  if (!context) {
    return {
      ok: false as const,
      error: refusal(
        'unauthenticated',
        'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
        'ניסיון חוזר לא יעזור עד שתתחבר מחדש.',
      ),
    }
  }

  if (context.status !== 'ready') {
    return {
      ok: false as const,
      error: refusal(
        'membership_not_active',
        'אין לך מרחב עבודה פעיל, ולכן לא ניתן לעדכן תוכנית הכנה.',
        'ניסיון חוזר לא יעזור עד שהחברות בארגון תופעל.',
      ),
    }
  }

  return { ok: true as const, context }
}

function refusal(
  code: string,
  message: string,
  retryMessage: string,
): SafeErrorBody {
  return {
    code,
    message,
    dataMessage: 'שום דבר לא נשמר. תוכנית ההכנה לא השתנתה.',
    retryMessage,
    dataOutcome: 'not_saved',
    retryable: false,
    correlationId: crypto.randomUUID(),
  }
}

function failure(
  cause: unknown,
  correlationId: string,
): { ok: false; error: SafeErrorBody } {
  return { ok: false, error: toSafeResponse(cause, correlationId).error }
}

/**
 * The one place a plan write is set up, so the eight mechanisms cannot be
 * skipped by one action forgetting one of them.
 */
async function run<T extends { plan: WorkPlan }>(
  permission: Permission,
  idempotencyKey: string,
  invoke: (args: {
    operations: PreparationOperations
    services: OperationServices
    idempotencyKey: string
    context: OperationContext
  }) => Promise<OperationOutcome<T>>,
): Promise<PlanActionResult> {
  const gate = await requireReady()
  if (!gate.ok) return gate

  const { context } = gate
  const correlationId = crypto.randomUUID()

  try {
    // The organization floor. The operation's own pipeline narrows again to
    // the loaded booking's property and unit, which is the check that can
    // actually see which house this is.
    const resource: Resource = {
      organizationId: context.actor.organizationId,
      family: 'operations',
    }
    assertCan(context.actor, permission, resource)

    const { operations, services } = await planWiring()

    const outcome = await invoke({
      operations,
      services,
      idempotencyKey,
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
    })

    revalidatePath('/preparation')
    revalidatePath(`/preparation/${outcome.data.plan.bookingId}`)
    return { ok: true, version: outcome.data.plan.version }
  } catch (cause) {
    return failure(cause, correlationId)
  }
}

/* ------------------------------------------------------------- the acts -- */

/**
 * Build the first plan for a booking.
 *
 * The act the whole chain was missing: `buildPlan` has existed and been tested
 * for weeks and no screen called it, so `work_plans` was empty in every
 * deployment and `/preparation` said "no plan built" for ever.
 */
export async function buildPlanAction(input: {
  bookingId: string
}): Promise<PlanActionResult> {
  return run(
    'task.create',
    `preparation.build:${input.bookingId}`,
    async ({ operations, services, idempotencyKey, context }) =>
      operations.buildPlan.run({
        request: { idempotencyKey, resourceId: input.bookingId, input },
        context,
        services,
      }),
  )
}

/**
 * The booking moved. Version the plan and say what changed.
 *
 * Never a rebuild-and-replace. `versionPlan` produces a new revision *and* a
 * delta in one step, so a plan cannot acquire a version without acquiring the
 * account of what moved — which is the mechanical form of "changes are never
 * silent". Twenty-five guests becoming thirty comes out as five more
 * mattresses, five more pillows, five more linen sets and five more towels,
 * and every section already under way goes back to needing an
 * acknowledgement.
 */
export async function recomputePlanAction(input: {
  bookingId: string
  expectedVersion: number
  reason?: string | null
}): Promise<PlanActionResult> {
  return run(
    'task.update',
    `preparation.recompute:${input.bookingId}:${input.expectedVersion}`,
    async ({ operations, services, idempotencyKey, context }) =>
      operations.recomputePlan.run({
        request: {
          idempotencyKey,
          resourceId: input.bookingId,
          expectedVersion: input.expectedVersion,
          input: { bookingId: input.bookingId },
        },
        context: { ...context, reason: input.reason ?? null },
        services,
      }),
  )
}

/** Overrule a computed quantity, keeping the computed figure beside it. */
export async function adjustItemAction(input: {
  bookingId: string
  expectedVersion: number
  section: PlanSectionKey
  itemId: string
  finalCount: number
  reason: string
}): Promise<PlanActionResult> {
  if (!(PLAN_SECTIONS as readonly string[]).includes(input.section)) {
    return {
      ok: false,
      error: refusal(
        'unknown_section',
        'המקטע המבוקש אינו קיים בתוכנית.',
        'רענן את המסך ונסה שוב.',
      ),
    }
  }

  return run(
    'checklist.manage',
    `preparation.adjust:${input.bookingId}:${input.expectedVersion}:${input.section}:${input.itemId}`,
    async ({ operations, services, idempotencyKey, context }) =>
      operations.adjustPlanItem.run({
        request: {
          idempotencyKey,
          resourceId: input.bookingId,
          expectedVersion: input.expectedVersion,
          input: {
            bookingId: input.bookingId,
            section: input.section,
            itemId: input.itemId,
            finalCount: input.finalCount,
          },
        },
        context: { ...context, reason: input.reason },
        services,
      }),
  )
}

/** "I have seen that it changed." The weakest grant of the six, deliberately. */
export async function acknowledgeSectionAction(input: {
  bookingId: string
  section: PlanSectionKey
}): Promise<PlanActionResult> {
  return run(
    'task.update',
    `preparation.acknowledge:${input.bookingId}:${input.section}`,
    async ({ operations, services, idempotencyKey, context }) =>
      operations.acknowledgePlanSection.run({
        request: { idempotencyKey, resourceId: input.bookingId, input },
        context,
        services,
      }),
  )
}

/** Close a section that is genuinely finished. */
export async function completeSectionAction(input: {
  bookingId: string
  section: PlanSectionKey
}): Promise<PlanActionResult> {
  return run(
    'task.complete',
    `preparation.complete:${input.bookingId}:${input.section}`,
    async ({ operations, services, idempotencyKey, context }) =>
      operations.completePlanSection.run({
        request: { idempotencyKey, resourceId: input.bookingId, input },
        context,
        services,
      }),
  )
}

/**
 * The stay is off.
 *
 * Stops the work still outstanding, keeps the work already done as history,
 * and raises `preparation.changed` carrying the cancellation — which is how
 * the laundry, the stock and the payment modules find out. This action does
 * not call any of them: reaching into another module's tables to un-order
 * linen is exactly the coupling the event exists to avoid.
 */
export async function cancelPlanAction(input: {
  bookingId: string
  expectedVersion: number
  reason: string
}): Promise<PlanActionResult> {
  return run(
    'task.update',
    `preparation.cancel:${input.bookingId}:${input.expectedVersion}`,
    async ({ operations, services, idempotencyKey, context }) =>
      operations.cancelPlan.run({
        request: {
          idempotencyKey,
          resourceId: input.bookingId,
          expectedVersion: input.expectedVersion,
          input: { bookingId: input.bookingId },
        },
        context: { ...context, reason: input.reason },
        services,
      }),
  )
}
