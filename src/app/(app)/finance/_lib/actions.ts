'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. Everything the finance screens change.
 *
 * ── The rule this file exists to keep ─────────────────────────────────────
 *
 * Not one of these functions writes a row. Each resolves who is asking, checks
 * that they may, and hands the request to an operation from
 * `defineFinanceOperations`, which is the only path to a finance row that has
 * authorization, validation, the domain rule, the transaction, the audit event
 * and idempotency wired into it in that order. A
 * `db.from('expense_rules').insert(...)` here would look identical on screen
 * and would skip all six.
 *
 * ── Why `assertCan` is called inside the operation as well ────────────────
 *
 * The pipeline checks the same permission, and the operation's own `rule`
 * asserts it again against the scope its input describes — because a create
 * operation has no loaded resource for the pipeline to check scope against.
 * This action is the third refusal, and it is not redundant either: a Server
 * Action is a POST, reachable without the screen that rendered the form.
 *
 * ── What a caller gets back ───────────────────────────────────────────────
 *
 * Never a thrown error. A throw inside a Server Action reaches the browser as a
 * digest and an empty screen, and the user learns nothing. Every failure is the
 * `SafeErrorBody` that `src/lib/errors` already produced — Hebrew sentence,
 * whether the data was saved, whether retrying is safe, and a correlation id
 * that matches the server log.
 */

import { revalidatePath } from 'next/cache'

import { assertCan, type Resource } from '@/lib/authz/can'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import type {
  AllocationMethod,
  ExpenseFrequency,
  ExpenseKind,
  VariableFormula,
} from '@/lib/finance'

import { shellContext } from '../../_lib/context'
import { auditActorFor, financeWiring } from './wiring'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

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
        message: 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לבצע פעולות על הוצאות.',
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
  const safe = toSafeResponse(cause, correlationId)
  return { ok: false, error: safe.error }
}

/* ------------------------------------------------- expense rule · create -- */

export type CreateExpenseRuleInput = {
  label: string
  category: string
  kind: ExpenseKind
  frequency: ExpenseFrequency
  /** Integer agorot. Zero for a variable rule, whose cost is its formula. */
  amountAgorot: number
  allocation: AllocationMethod
  /** Null means the rule applies to the whole organization. */
  propertyId: string | null
  formula: VariableFormula | null
  effectiveFrom: string
  effectiveTo: string | null
  approvalRequired: boolean
  /**
   * Generated once per form instance in the browser, and used as the row's id
   * as well as the idempotency key. A second submission of the same form
   * replays the first answer instead of writing a second rule — the server half
   * of duplicate-submit protection, and the half a disabled button cannot
   * provide.
   */
  ruleId: string
  idempotencyKey: string
}

export type CreatedExpenseRule = {
  id: string
  label: string
  kind: ExpenseKind
}

export async function createExpenseRuleAction(
  input: CreateExpenseRuleInput,
): Promise<ActionResult<CreatedExpenseRule>> {
  const gate = await requireReady()
  if (!gate.ok) return gate

  const { context } = gate
  const correlationId = crypto.randomUUID()

  try {
    const resource: Resource = {
      organizationId: context.actor.organizationId,
      family: 'finance',
      ...(input.propertyId !== null ? { propertyId: input.propertyId } : {}),
    }

    // The independent refusal. Before anything is read, and regardless of what
    // the screen chose to render.
    assertCan(context.actor, 'expense.create', resource)

    const { operations, services } = await financeWiring()

    // Assembled key by key rather than spread. `s.object` refuses a field it
    // does not name — `allowUnknown` is off by design — so passing the form's
    // own `idempotencyKey` through as input would fail validation with a
    // message about a field the person never filled in.
    const outcome = await operations.createExpenseRule.run({
      request: {
        idempotencyKey: input.idempotencyKey,
        input: {
          ruleId: input.ruleId,
          label: input.label,
          category: input.category,
          kind: input.kind,
          frequency: input.frequency,
          amountAgorot: input.amountAgorot,
          allocation: input.allocation,
          scopeKind: input.propertyId === null ? 'organization' : 'property',
          scopePropertyId: input.propertyId,
          formulaKind: input.formula?.kind ?? null,
          formulaRateAgorot:
            input.formula !== null &&
            input.formula.kind !== 'percent_of_revenue'
              ? input.formula.rateAgorot
              : null,
          formulaPercent:
            input.formula !== null &&
            input.formula.kind === 'percent_of_revenue'
              ? input.formula.percent
              : null,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
          approvalRequired: input.approvalRequired,
        },
      },
      context: {
        actor: context.actor,
        auditActor: auditActorFor(context.user),
        correlationId,
      },
      services,
    })

    revalidatePath('/finance/expenses')

    return {
      ok: true,
      data: {
        id: outcome.data.id,
        label: outcome.data.label,
        kind: outcome.data.kind,
      },
    }
  } catch (cause) {
    return failure(cause, correlationId)
  }
}
