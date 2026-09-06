'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. Everything the case screens change.
 *
 * ── The rule this file exists to keep ─────────────────────────────────────
 *
 * None of these functions writes a row. Each resolves who is asking, checks
 * that they may, and hands the request to an operation from
 * `defineIncidentOperations` — the only path to an incident case row that has
 * authorization, validation, the domain rule, the transaction, the audit event,
 * the domain event and idempotency wired into it in that order.
 *
 * ── Why `assertCan` is called here as well ────────────────────────────────
 *
 * The pipeline checks the same permission. This check is not redundant, it is
 * the independent one: the screen hides controls the actor cannot use, and
 * hiding a control is not authorization. A Server Action is a POST endpoint,
 * and it must refuse on its own terms before it has read anything.
 *
 * ── The decision, and the sentence that is not optional ───────────────────
 *
 * `decideLiabilityAction` passes the typed rationale as the operation's
 * `reason`. That is not a convenience: `requiresReason` on the operation makes
 * a missing one a validation failure, and `evaluateLiability` refuses a blank
 * one independently. Both have to be satisfied, and the sentence the person
 * wrote is what ends up on the decision row and in the audit trail.
 *
 * **No action here moves money.** Applying a deposit is
 * `money_access_cancellation` and goes through `src/lib/payments` with its own
 * grants and its own approval.
 *
 * ── What a caller gets back ───────────────────────────────────────────────
 *
 * Never a thrown error. A throw inside a Server Action reaches the browser as a
 * digest and an empty screen. Every failure is turned into the `SafeErrorBody`
 * that `src/lib/errors` already produced — Hebrew sentence, whether the data
 * was saved, whether retrying is safe, and a correlation id matching the log.
 */

import { revalidatePath } from 'next/cache'

import { assertCan } from '@/lib/authz/can'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import type {
  IncidentCase,
  IncidentCaseStatus,
  LiabilityBasis,
  LiabilityDecision,
  LiabilityOutcome,
} from '@/lib/incidents'

import { shellContext } from '../../../_lib/context'
import { auditActorFor, caseWiring } from './wiring'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

export type AdvanceCaseRequest = {
  caseId: string
  status: IncidentCaseStatus
}

export type DecideLiabilityRequest = {
  caseId: string
  outcome: LiabilityOutcome
  basis: LiabilityBasis
  /** The person's own words. Stored as the decision's rationale. */
  rationale: string
  assessedTotalAgorot: number
  guestChargeAgorot: number
  ownerChargeAgorot: number
  businessAbsorbedAgorot: number
  supportingEvidenceIds: string[]
  supersedesDecisionId: string | null
  /**
   * Generated once per form instance in the browser. A resubmission replays
   * the first answer rather than recording a second decision — which would
   * otherwise leave two contradictory rulings on one case.
   */
  idempotencyKey: string
}

export type CloseCaseRequest = { caseId: string }

/**
 * The context every action needs, or the refusal that replaces it.
 *
 * A signed-out or workspace-less caller is refused here rather than allowed to
 * reach an operation with a fabricated actor. `shellContext()` is the same
 * resolution the screen rendered with — React `cache` shares it — so an action
 * cannot disagree with the screen about which organization it is in.
 */
async function requireReady() {
  const context = await shellContext()

  if (!context) {
    return {
      ok: false as const,
      error: refusal(
        'unauthenticated',
        'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
      ),
    }
  }

  if (context.status !== 'ready') {
    return {
      ok: false as const,
      error: refusal(
        'membership_not_active',
        'אין לך מרחב עבודה פעיל, ולכן לא ניתן לעדכן תיקי נזק.',
      ),
    }
  }

  return { ok: true as const, context }
}

function refusal(code: string, message: string): SafeErrorBody {
  return {
    code,
    message,
    dataMessage: 'הנתונים לא נשמרו. שום דבר במערכת לא השתנה.',
    retryMessage: 'ניסיון חוזר לא יעזור עד שהמצב הזה ישתנה.',
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

/** Three screens read this case. Revalidated together. */
function revalidateCase(caseId: string): void {
  revalidatePath('/incidents/cases')
  revalidatePath(`/incidents/cases/${caseId}`)
}

/* ------------------------------------------------------------- advancing -- */

/** Move a case along the workflow. `incident.update`. */
export async function advanceCaseAction(
  request: AdvanceCaseRequest,
): Promise<ActionResult<IncidentCase>> {
  const ready = await requireReady()
  if (!ready.ok) return ready

  const { actor, user } = ready.context
  const correlationId = crypto.randomUUID()

  try {
    // Without a resource on purpose: the case's property is not known until it
    // is loaded, and the pipeline asks again with it immediately after the
    // load. This is the membership, the grant and the plan.
    assertCan(actor, 'incident.update')

    const wiring = await caseWiring()
    const outcome = await wiring.operations.advanceCase.run({
      request: { input: { caseId: request.caseId, status: request.status } },
      context: {
        actor,
        auditActor: auditActorFor(user),
        correlationId,
      },
      services: wiring.services,
    })

    revalidateCase(request.caseId)
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return failure(cause, correlationId)
  }
}

/* ------------------------------------------------------------- deciding -- */

/**
 * Record who pays. `incident.resolve`.
 *
 * The rationale travels as the operation's `reason`, which is what makes it
 * mandatory in two independent places and what puts it in the audit trail
 * beside the amounts.
 */
export async function decideLiabilityAction(
  request: DecideLiabilityRequest,
): Promise<ActionResult<LiabilityDecision>> {
  const ready = await requireReady()
  if (!ready.ok) return ready

  const { actor, user } = ready.context
  const correlationId = crypto.randomUUID()

  try {
    assertCan(actor, 'incident.resolve')

    const wiring = await caseWiring()
    const outcome = await wiring.operations.decideLiability.run({
      request: {
        input: {
          caseId: request.caseId,
          outcome: request.outcome,
          basis: request.basis,
          assessedTotalAgorot: request.assessedTotalAgorot,
          guestChargeAgorot: request.guestChargeAgorot,
          ownerChargeAgorot: request.ownerChargeAgorot,
          businessAbsorbedAgorot: request.businessAbsorbedAgorot,
          supportingEvidenceIds: request.supportingEvidenceIds,
          supersedesDecisionId: request.supersedesDecisionId,
        },
        idempotencyKey: request.idempotencyKey,
      },
      context: {
        actor,
        // A person. The domain refuses `system` and `ai_agent` outright, and
        // this is the only actor type a Server Action can produce.
        auditActor: auditActorFor(user),
        correlationId,
        reason: request.rationale,
      },
      services: wiring.services,
    })

    revalidateCase(request.caseId)
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return failure(cause, correlationId)
  }
}

/* -------------------------------------------------------------- closing -- */

/** Close a case. `incident.resolve`. */
export async function closeCaseAction(
  request: CloseCaseRequest,
): Promise<ActionResult<IncidentCase>> {
  const ready = await requireReady()
  if (!ready.ok) return ready

  const { actor, user } = ready.context
  const correlationId = crypto.randomUUID()

  try {
    assertCan(actor, 'incident.resolve')

    const wiring = await caseWiring()
    const outcome = await wiring.operations.closeCase.run({
      request: { input: { caseId: request.caseId } },
      context: {
        actor,
        auditActor: auditActorFor(user),
        correlationId,
      },
      services: wiring.services,
    })

    revalidateCase(request.caseId)
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return failure(cause, correlationId)
  }
}
