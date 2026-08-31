'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. The one thing the agents screen changes.
 *
 * ── Suspension is the whole point of the screen ───────────────────────────
 *
 * `lifecycle.ts` opens with the reason: suspension is the button an owner
 * presses **the moment they discover something**, and a mechanism that takes
 * effect "within five minutes" or "at their next login" is a mechanism that was
 * not there when it was needed. It takes effect immediately for a structural
 * reason rather than a hopeful one — an `Actor` is rebuilt from the database on
 * every request and `authorize()` refuses a membership that is not `active`
 * before it looks at a grant — and this action's only job is to write the row
 * that makes that true.
 *
 * **A suspension that does not visibly take effect is a security failure.** So
 * this function writes nothing itself. It hands the request to
 * `operations.setStatus`, which is the only path to that row carrying
 * authorization, validation, optimistic locking, the domain rule, the
 * transaction, the audit event and idempotency in that order — and which
 * refuses up front when the caller holds `agent.manage` but not the authority
 * over the *membership*, because `memberships_update` would otherwise match
 * zero rows and the button would report success having changed nothing.
 *
 * ── Why `assertCan` is called here as well ────────────────────────────────
 *
 * The pipeline checks the same permission. This check is the independent one: a
 * Server Action is a POST endpoint, the screen hiding a control is not
 * authorization, and this must refuse on its own terms before it has read
 * anything. Deny by default, twice, on purpose.
 *
 * ── Nothing cascades ──────────────────────────────────────────────────────
 *
 * `changeAgentStatus` returns new settings, a Hebrew sentence and a list of what
 * was preserved. It returns no instruction to touch anything else, and this file
 * adds none: a suspended agent is still owed money on stays that have not
 * happened, and the bookings, commissions, attribution and audit trail are
 * untouched. `PRESERVED_ON_REMOVAL` is carried back to the caller so the screen
 * can say so rather than leaving the owner to wonder.
 */

import { revalidatePath } from 'next/cache'

import { assertCan } from '@/lib/authz/can'
import { MEMBERSHIP_STATUSES, type MembershipStatus } from '@/lib/authz/can'
import { PRESERVED_ON_REMOVAL } from '@/lib/agents'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'

import { shellContext } from '../../_lib/context'
import { agentResource } from './queries'
import { agentWiring, auditActorFor } from './wiring'

/* --------------------------------------------------------------- shape -- */

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

/**
 * The context every action needs, or the refusal that replaces it.
 *
 * The same gate the bookings actions use, worded for this module. A signed-out
 * or workspace-less caller is refused here rather than allowed to reach an
 * operation with a fabricated actor, and `shellContext()` is the same
 * resolution the screen rendered with — React `cache` shares it — so the action
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
        message:
          'אין לך מרחב עבודה פעיל, ולכן לא ניתן לשנות את מצבם של סוכנים.',
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

/* --------------------------------------------------------- set status --- */

export type SetAgentStatusInput = {
  agentUserId: string
  to: MembershipStatus
  /** What the screen believes it is editing. Optimistic locking depends on it. */
  version: number
  /**
   * Mandatory. `agent.set_status` declares `requiresReason` and the pipeline
   * refuses without one — which is correct: "why is this seller blocked" is the
   * question the audit trail exists to answer six months later.
   */
  reason: string
  /** For the audit sentence, so it names a person rather than a uuid. */
  displayName?: string | null
  phoneE164?: string | null
}

export type AgentStatusChanged = {
  status: MembershipStatus
  version: number
  /** The Hebrew sentence the domain wrote. Not reworded here. */
  summary: string
  /** What did not change, so the screen can say so out loud. */
  preserved: readonly string[]
}

export async function setAgentStatusAction(
  input: SetAgentStatusInput,
): Promise<ActionResult<AgentStatusChanged>> {
  const gate = await requireReady()
  if (!gate.ok) return gate

  const { context } = gate
  const correlationId = crypto.randomUUID()

  try {
    if (!MEMBERSHIP_STATUSES.includes(input.to)) {
      // Refused here rather than left to the schema, because the message the
      // schema would produce names a field the person never filled in.
      throw new Error(`Unknown membership status: ${input.to}`)
    }

    // The independent refusal, before anything is read, against the same
    // resource shape `settingsResource` in the domain builds — so an actor
    // whose scope does not reach this agent is refused here and not only by
    // the pipeline's own second check.
    assertCan(
      context.actor,
      'agent.manage',
      agentResource(context.actor.organizationId, input.agentUserId),
    )

    const { operations, services } = await agentWiring()

    const outcome = await operations.setStatus.run({
      request: {
        input: {
          agentUserId: input.agentUserId,
          status: input.to,
          ...(input.displayName ? { displayName: input.displayName } : {}),
          ...(input.phoneE164 ? { phoneE164: input.phoneE164 } : {}),
        },
        resourceId: input.agentUserId,
        expectedVersion: input.version,
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
        reason: input.reason,
      },
      services,
    })

    revalidatePath('/agents')
    revalidatePath(`/agents/${input.agentUserId}`)

    return {
      ok: true,
      data: {
        status: outcome.data.settings.status,
        version: outcome.data.settings.version,
        summary: outcome.data.summary,
        preserved: [...PRESERVED_ON_REMOVAL],
      },
    }
  } catch (cause) {
    // Never a throw. A throw inside a Server Action reaches the browser as a
    // digest and an empty screen, and the person learns nothing about whether
    // the agent they just tried to block is blocked.
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
