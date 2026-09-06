'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. What the agencies screen can write.
 *
 * Five actions, and until now the screen had none: `agencies` was read by
 * `/leads`, `/promotions` and this screen, referenced by `bookings.agency_id`
 * and `commissions.agency_id`, and had no write path anywhere in the product.
 *
 * ── Nothing here writes a row ─────────────────────────────────────────────
 *
 * Every one of these hands the request to an operation in
 * `src/lib/agents/agency-operations.ts`, which is the only path to these tables
 * carrying authorization, validation, optimistic locking, the domain rule, the
 * transaction, the audit event and idempotency, in that order. A Server Action
 * is a POST endpoint: the screen hiding a button is not authorization, so
 * `assertCan` is also called here, independently, before anything is read.
 * Deny by default, twice.
 *
 * ── A failure is returned, never thrown ───────────────────────────────────
 *
 * A throw inside a Server Action reaches the browser as a digest and an empty
 * screen. On this screen that would be worse than usual: after a failed
 * deactivation the person needs to know whether the agency they just tried to
 * stop working with is stopped.
 *
 * ── Deleting is not among them, and cannot be added here ──────────────────
 *
 * There is no delete action because there is no delete. 0070 installs a trigger
 * that refuses any write of `agencies.deleted_at`, and no role holds DELETE on
 * the table — an action added here to erase an agency would fail at the
 * database, which is why the rule lives there and not only in this file.
 */

import { revalidatePath } from 'next/cache'

import {
  agencyResource,
  defineAgencyOperations,
  type AgencyDeactivated,
  type AgencyTermsInput,
} from '@/lib/agents'
import { assertCan } from '@/lib/authz/can'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
} from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { domainEventBus } from '../../_lib/events'
import { auditActorFor, transactionRunner } from '../../_lib/wiring'
import { SupabaseAgencyStore } from './store'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

const SCREEN = '/agencies'

/**
 * The screens that read `agencies` and go stale the moment one changes.
 *
 * `/leads` and `/promotions` both read the table — they were reading a record
 * nothing could create — and `/agents` renders the agency an agent sells under.
 */
const DEPENDENT_SCREENS = ['/leads', '/promotions', '/agents'] as const

async function ready(correlationId: string) {
  const context = await shellContext()

  if (!context || context.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: context ? 'membership_not_active' : 'unauthenticated',
        message: context
          ? 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לנהל סוכנויות.'
          : 'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
        dataMessage: 'שום דבר לא נשמר.',
        retryMessage: context
          ? 'ניסיון חוזר לא יעזור עד שהחברות בארגון תופעל.'
          : 'ניסיון חוזר לא יעזור עד שתתחבר מחדש.',
        dataOutcome: 'not_saved' as const,
        retryable: false,
        correlationId,
      },
    }
  }

  return { ok: true as const, context }
}

/**
 * The domain, bound to this request.
 *
 * Built per call and never cached at module scope: the client carries the
 * caller's session, and one shared instance would be one shared identity.
 */
async function wired() {
  const db = await createClient()
  const { transactions } = transactionRunner(db)

  return {
    operations: defineAgencyOperations(new SupabaseAgencyStore(db)),
    services: {
      audit: new SupabaseAuditWriter(db),
      events: domainEventBus(db),
      idempotency: new SupabaseIdempotencyStore(db),
      transactions,
    },
  }
}

function refresh(): void {
  revalidatePath(SCREEN)
  for (const path of DEPENDENT_SCREENS) revalidatePath(path)
}

/* --------------------------------------------------------------- create -- */

export type AgencyContactFields = {
  name: string
  taxId?: string | null
  contactPhone?: string | null
  contactEmail?: string | null
  addressLine1?: string | null
  city?: string | null
  country?: string
  note?: string | null
}

export async function createAgencyAction(
  input: AgencyContactFields & AgencyTermsInput & { idempotencyKey: string },
): Promise<ActionResult<{ id: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    assertCan(
      context.actor,
      'agency.manage',
      agencyResource(context.actor.organizationId),
    )

    const { operations, services } = await wired()
    const { idempotencyKey, ...draft } = input

    const outcome = await operations.create.run({
      // The key is what makes a double-submitted form one agency rather than
      // two rows for one legal entity — the failure `agencies_tax_id_idx`
      // catches only when a tax id was typed in.
      request: { input: draft, idempotencyKey },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services,
    })

    refresh()
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* --------------------------------------------------------- edit contact -- */

export async function editAgencyContactAction(
  input: AgencyContactFields & {
    agencyId: string
    /** What the screen believes it is editing. Optimistic locking needs it. */
    version: number
  },
): Promise<ActionResult<{ id: string; version: number }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    assertCan(
      context.actor,
      'agency.manage',
      agencyResource(context.actor.organizationId),
    )

    const { operations, services } = await wired()
    const { version, ...draft } = input

    const outcome = await operations.editContact.run({
      request: {
        input: draft,
        resourceId: input.agencyId,
        expectedVersion: version,
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services,
    })

    refresh()
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* ------------------------------------------------------------ set terms -- */

export async function setAgencyTermsAction(
  input: AgencyTermsInput & {
    agencyId: string
    /** The **agreement's** version, not the agency's. */
    version: number
    /**
     * Mandatory. `agent_agreement.manage` is in `SENSITIVE_ACTIONS`, so the
     * pipeline refuses a blank one whatever this form does — which is right:
     * "why did our rate with this agency change in April" is the question the
     * audit trail exists to answer.
     */
    reason: string
  },
): Promise<ActionResult<{ agreementId: string; ruleId: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    assertCan(
      context.actor,
      'agent_agreement.manage',
      agencyResource(context.actor.organizationId),
    )

    const { operations, services } = await wired()
    const { version, reason, ...draft } = input

    const outcome = await operations.setTerms.run({
      request: {
        input: draft,
        resourceId: input.agencyId,
        expectedVersion: version,
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
        reason,
      },
      services,
    })

    refresh()
    // The commission ledger's figures were computed from a snapshotted rule and
    // do not move, but the screens that render the current terms do.
    revalidatePath('/commissions')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* -------------------------------------------------- deactivate/reactivate -- */

export async function deactivateAgencyAction(input: {
  agencyId: string
  reason: string
}): Promise<ActionResult<AgencyDeactivated>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    assertCan(
      context.actor,
      'agency.manage',
      agencyResource(context.actor.organizationId),
    )

    const { operations, services } = await wired()

    const outcome = await operations.deactivate.run({
      request: { input, resourceId: input.agencyId },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
        reason: input.reason,
      },
      services,
    })

    refresh()
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

export async function reactivateAgencyAction(input: {
  agencyId: string
  reason: string
}): Promise<ActionResult<{ agreementId: string }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    assertCan(
      context.actor,
      'agency.manage',
      agencyResource(context.actor.organizationId),
    )

    const { operations, services } = await wired()

    const outcome = await operations.reactivate.run({
      request: { input, resourceId: input.agencyId },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
        reason: input.reason,
      },
      services,
    })

    refresh()
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
