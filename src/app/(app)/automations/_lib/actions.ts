'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. What the automation screen can write.
 *
 * Three actions, matching the three operations exactly: switch a rule on,
 * switch it off, change a threshold inside it. There is no create action and
 * no delete action — the set of rules is the frozen library, and
 * `0067_automation_rules.sql` refuses `delete` to every role so that who
 * switched a rule on cannot be erased by switching it off.
 *
 * ── WHAT THESE ACTIONS DO NOT START ───────────────────────────────────────
 *
 * They record a decision. Nothing in this deployment yet hands
 * `runAutomations` a live event, so an enabled rule does not begin acting the
 * moment this returns — `(app)/_lib/events.ts` publishes domain events to
 * webhooks only, and says in its own header that automations are one
 * subscribers entry away and deliberately not switched on. The screen states
 * that in Hebrew above every control. It is stated here as well, because the
 * first person to wire the runner will read this file, and the second will be
 * whoever wonders why a rule that says "on" sent nothing.
 *
 * ── Idempotency, and why the key comes from the caller ────────────────────
 *
 * Every action takes an `idempotencyKey` the client generates once per click.
 * A double-submitted enable is the same enable, and the second one returns the
 * first one's answer rather than writing a second audit event that says
 * somebody switched the rule on twice.
 */

import { revalidatePath } from 'next/cache'

import { AutomationRuleRepository } from '@/lib/automation/repository'
import {
  defineAutomationOperations,
  type ParameterPair,
} from '@/lib/automation/operations'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
} from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { domainEventBus } from '../../_lib/events'
import { auditActorFor, transactionRunner } from '../../_lib/wiring'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

const SCREEN = '/automations'

/** The library screen shows the same rules and the same state. */
const TEMPLATES_SCREEN = '/templates'

async function ready(correlationId: string) {
  const context = await shellContext()

  if (!context || context.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: context ? 'membership_not_active' : 'unauthenticated',
        message: context
          ? 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לשנות אוטומציות.'
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

async function services() {
  const db = await createClient()
  const { transactions } = transactionRunner(db)
  const repository = new AutomationRuleRepository(db)

  return {
    operations: defineAutomationOperations({
      db,
      loadRule: (organizationId, templateId, propertyId) =>
        repository.rule(organizationId, templateId, propertyId),
    }),
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
  revalidatePath(TEMPLATES_SCREEN)
}

export interface AutomationWriteInput {
  templateId: string
  /** Null is the organization, for every property. Never inferred. */
  propertyId: string | null
  parameters?: ParameterPair[]
  idempotencyKey: string
  /**
   * The version of the stored row the screen was looking at, when there was
   * one. Omitted for a rule nobody has configured yet, which genuinely has no
   * version — the pipeline compares this against what it loads and refuses a
   * change made against a state somebody else has already moved.
   */
  expectedVersion?: number
}

export async function enableAutomationAction(
  input: AutomationWriteInput,
): Promise<ActionResult<{ id: string; enabled: boolean }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await services()
    const outcome = await wired.operations.enable.run({
      request: {
        input: {
          templateId: input.templateId,
          propertyId: input.propertyId,
          ...(input.parameters ? { parameters: input.parameters } : {}),
        },
        idempotencyKey: input.idempotencyKey,
        ...(input.expectedVersion === undefined
          ? {}
          : { expectedVersion: input.expectedVersion }),
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services: wired.services,
    })

    refresh()
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

export async function disableAutomationAction(
  input: Omit<AutomationWriteInput, 'parameters'>,
): Promise<ActionResult<{ id: string; enabled: boolean }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await services()
    const outcome = await wired.operations.disable.run({
      request: {
        input: {
          templateId: input.templateId,
          propertyId: input.propertyId,
        },
        idempotencyKey: input.idempotencyKey,
        ...(input.expectedVersion === undefined
          ? {}
          : { expectedVersion: input.expectedVersion }),
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services: wired.services,
    })

    refresh()
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/**
 * Change a threshold without touching whether the rule runs.
 *
 * A rule nobody has configured keeps the library's own answer to "is it on"
 * when this creates its first row, so adjusting a number can never quietly
 * switch something on — see `automation.set_parameters`.
 */
export async function setAutomationParametersAction(
  input: AutomationWriteInput & { parameters: ParameterPair[] },
): Promise<ActionResult<{ id: string; enabled: boolean }>> {
  const correlationId = crypto.randomUUID()
  const gate = await ready(correlationId)
  if (!gate.ok) return gate
  const { context } = gate

  try {
    const wired = await services()
    const outcome = await wired.operations.setParameters.run({
      request: {
        input: {
          templateId: input.templateId,
          propertyId: input.propertyId,
          parameters: input.parameters,
        },
        idempotencyKey: input.idempotencyKey,
        ...(input.expectedVersion === undefined
          ? {}
          : { expectedVersion: input.expectedVersion }),
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services: wired.services,
    })

    refresh()
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
