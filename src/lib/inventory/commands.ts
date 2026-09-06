/**
 * EXECUTION CONTEXT — SERVER ONLY. The two asks the stock engine could not
 * make.
 *
 * `operations.ts` can change what the ledger says. Neither of these does. They
 * are the two things a forecast six days out actually needs and had no way to
 * express: *send somebody to count*, and *propose that we buy some*. Both end
 * in a record somebody else has to act on, and neither moves a quantity.
 *
 * ══ Where each one lives, and why it is not a new table ═══════════════════
 *
 * There is no stock-count-session table in this database and no purchase-order
 * table either. I looked. So the honest question for each command was not
 * "what shape should the row be" but "does something that already exists mean
 * the same thing".
 *
 * **A count request is a task.** `tasks` has `task_type = 'inventory'`, a
 * property, a due date and an assignee, and "go to the linen cupboard on
 * Thursday and count the bath towels" is an errand a person performs — which
 * is what a task is. The count comes back through the door it always did:
 * `inventory.adjust` with `kind: 'count'`, or a discrepancy. Inventing a
 * `stock_count_sessions` table would have added a second place where a counted
 * number lives, and the ledger is already the one place.
 *
 * **A procurement draft is an approval request.** `approvals` has
 * `approval_type = 'expense'`, `requested_agorot`, `status = 'requested'`, a
 * free `subject_type`/`subject_id` pointer, and a database constraint —
 * `approvals_no_self_approval` — saying the requester may not be the decider.
 * That is precisely a draft: it names a sum, it commits none of it, it names
 * no supplier, and it cannot become anything until a second person decides.
 *
 * `expense_rules` was the other candidate and would have been wrong. It is the
 * recurring-cost model: writing a towel purchase there would make the finance
 * engine allocate a share of it to every booking in the period, forever. A
 * draft that quietly changes the profit statement is worse than no draft.
 *
 * ══ Two grants each, and that is not belt-and-braces ══════════════════════
 *
 * `inventory.adjust` is the grant Autopilot's catalogue declares for a count
 * request; `tasks_insert` in 0011 demands `task.create`. `expense.create` is
 * the grant declared for a procurement draft; `approvals_insert` demands
 * `approval.request`. So each command asserts BOTH — the declared one through
 * the pipeline, the table's one in `rule` — because the alternative is an
 * actor who passes every application check and is refused by row level
 * security with a SQLSTATE. A refusal is fine. A refusal nobody can read, at
 * the end of a write path, is a defect.
 *
 * ══ Nothing here recomputes a shortage ════════════════════════════════════
 *
 * `forecast.ts` is the only thing in this codebase allowed to decide that
 * Saturday is five short. `draftProcurement` takes the forecast line as input
 * and copies it into the approval's metadata verbatim, as the evidence the
 * decider reads. It does not check the arithmetic and it does not redo it: a
 * second implementation of the walk is exactly how two screens end up showing
 * two numbers for one cupboard.
 */

import { assertCan } from '../authz/can'
import { BusinessRuleError } from '../errors'
import {
  defineOperation,
  s,
  type LoadArgs,
  type LoadedResource,
  type Operation,
} from '../service'

import { capabilitiesFor } from './settings'
import type { InventoryCapabilities, InventorySettings } from './types'

/* ----------------------------------------------------------------- ports -- */

/**
 * The item, as much of it as an ask needs.
 *
 * Note what is absent: the recorded quantity. A stocktake that tells the
 * counter what the answer is supposed to be gets that answer back — people
 * write down the number they were shown and stop looking. The count task
 * therefore names the item and the place and nothing else, and the comparison
 * happens afterwards, in `discrepancy.ts`, where it belongs.
 */
export interface CommandItem {
  itemId: string
  organizationId: string
  propertyId: string
  label: string
  unitOfMeasure: string
  /** For the size of the ask. `null` when the business never recorded one. */
  unitCostAgorot: number | null
}

/** What lands in `tasks`. Composed here; written by the adapter. */
export interface CountTaskDraft {
  organizationId: string
  propertyId: string
  taskType: 'inventory'
  title: string
  description: string
  /** ISO. `null` when the request carries no date. */
  dueAt: string | null
  /** `{ kind: 'stock_count', itemId }`, so the count can be tied back. */
  metadata: Readonly<Record<string, unknown>>
}

/** What lands in `approvals`. Status is the table's default, `requested`. */
export interface ProcurementApprovalDraft {
  organizationId: string
  propertyId: string
  approvalType: 'expense'
  subjectType: 'inventory_item'
  subjectId: string
  /** `approvals.reason` is NOT NULL. The operation's stated reason. */
  reason: string
  /** `quantity × unitCostAgorot`, or `null` when no cost is recorded. */
  requestedAgorot: number | null
  metadata: Readonly<Record<string, unknown>>
}

/**
 * What these two commands are allowed to do.
 *
 * `loadSettings` is declared with the same signature as the one on
 * `InventoryPorts` in `operations.ts` on purpose, so one repository satisfies
 * both interfaces rather than growing a second, subtly different, settings
 * read.
 */
export interface InventoryCommandPorts {
  loadSettings(organizationId: string): Promise<{
    settings: InventorySettings
    provisioned: boolean
  }>
  loadItem(args: {
    organizationId: string
    itemId: string
  }): Promise<CommandItem | null>
  openCountTask(draft: CountTaskDraft): Promise<{ id: string }>
  requestProcurementApproval(
    draft: ProcurementApprovalDraft,
  ): Promise<{ id: string }>
}

/* -------------------------------------------------------------- refusals -- */

/**
 * The capability is off, which is a configuration answer and not a stock one.
 *
 * The same distinction `assertReservationsEnabled` makes: telling somebody
 * "there is no procurement here" when the truth is "the module is set to
 * `basic`" sends them to look for a cupboard problem that does not exist.
 */
function assertCapability(
  capabilities: InventoryCapabilities,
  which: 'counting' | 'procurement',
): void {
  if (capabilities[which]) return

  throw new BusinessRuleError({
    code: `inventory_${which}_disabled`,
    message: `inventory capability '${which}' is off for this organization`,
    userMessage:
      which === 'counting'
        ? 'ניהול המלאי אינו פעיל בארגון הזה, ולכן אין למי לבקש ספירה. ' +
          'אפשר להפעיל אותו בהגדרות המלאי.'
        : 'הצעות רכש אינן פעילות בארגון הזה. אפשר להפעיל אותן בהגדרות ' +
          'המלאי — החוסר עצמו מדווח גם בלעדיהן.',
  })
}

/**
 * `approvals.requested_agorot` is an `integer`.
 *
 * A draft whose estimate does not fit the column would reach a person as a
 * numeric overflow at the end of the write. Refused here, in a sentence,
 * before the transaction opens.
 */
const INT4_MAX = 2_147_483_647

class ProcurementEstimateTooLargeError extends BusinessRuleError {
  constructor(estimate: number) {
    super({
      code: 'inventory.procurement_estimate_too_large',
      message: `estimated ${estimate} agorot exceeds approvals.requested_agorot`,
      userMessage:
        'האומדן של הרכש הזה גדול מכפי שהמערכת יכולה לרשום בבקשת אישור. ' +
        'פצל את הבקשה לכמויות קטנות יותר.',
    })
  }
}

/* --------------------------------------------------------------- schemas -- */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The forecast line this draft answers, copied rather than recomputed.
 *
 * Every field here comes from a `ForecastRow` that `forecast.ts` already
 * produced. It is carried so the person deciding sees the arithmetic that
 * caused the ask — "נדרשים 30, צפויים נקיים 25, חסרים 5" — instead of a
 * quantity with no story.
 */
const FORECAST_LINE = s.object({
  date: s.string({
    label: 'תאריך החוסר',
    pattern: ISO_DATE,
    patternMessage: 'תאריך אינו בתבנית YYYY-MM-DD.',
  }),
  required: s.number({ label: 'נדרשים', integer: true, min: 0 }),
  expectedClean: s.number({ label: 'צפויים נקיים', integer: true, min: 0 }),
  shortage: s.number({ label: 'חסרים', integer: true, min: 1 }),
})

const REQUEST_COUNT_INPUT = s.object({
  itemId: s.uuid({ label: 'פריט' }),
  /** When the count has to be done. `null` when nothing depends on a date. */
  dueAt: s.nullable(s.isoDateTime({ label: 'מועד יעד' })),
})

const DRAFT_PROCUREMENT_INPUT = s.object({
  itemId: s.uuid({ label: 'פריט' }),
  quantity: s.number({ label: 'כמות', integer: true, min: 1 }),
  neededBy: s.nullable(s.isoDateTime({ label: 'נדרש עד' })),
  /** `null` for a draft raised by hand rather than off the forecast. */
  forecast: s.nullable(FORECAST_LINE),
})

/* ------------------------------------------------------------- the shape -- */

export interface RequestCountInput {
  itemId: string
  dueAt: Date | null
}

export interface DraftProcurementInput {
  itemId: string
  quantity: number
  neededBy: Date | null
  forecast: {
    date: string
    required: number
    expectedClean: number
    shortage: number
  } | null
}

export interface InventoryCommands {
  requestCount: Operation<RequestCountInput, CommandItem, { taskId: string }>
  draftProcurement: Operation<
    DraftProcurementInput,
    CommandItem,
    { approvalId: string; estimatedAgorot: number | null }
  >
}

/* ------------------------------------------------------------ the build -- */

export function defineInventoryCommands(
  ports: InventoryCommandPorts,
): InventoryCommands {
  /**
   * The item, as the pipeline's resource.
   *
   * Loaded through `loadResource` rather than inside `rule` so the second
   * `assertCan` — the one that settles tenant and property scope — actually
   * runs. A member scoped to one villa asking for a count in another is
   * refused by the pipeline, before either of these commands has an opinion.
   */
  const loadItem = async (
    args: LoadArgs<{ itemId: string }>,
  ): Promise<LoadedResource<CommandItem> | null> => {
    const item = await ports.loadItem({
      organizationId: args.context.actor.organizationId,
      itemId: args.input.itemId,
    })
    if (item === null) return null

    return {
      resource: {
        organizationId: item.organizationId,
        propertyId: item.propertyId,
        family: 'operations',
      },
      entity: item,
    }
  }

  return {
    /**
     * Ask somebody to physically count one item.
     *
     * `requiresReason: true` although `inventory.adjust` is not in
     * `SENSITIVE_ACTIONS`. A count is an hour of somebody's afternoon, and a
     * task that says only "count the towels" gets deprioritised by whoever
     * opens it. The reason becomes the task's description, so the person
     * standing at the cupboard reads why they are there — and when Autopilot
     * raises it, that sentence is Autopilot's own reasoning rather than a
     * template.
     */
    requestCount: defineOperation<
      RequestCountInput,
      CommandItem,
      { taskId: string }
    >({
      name: 'inventory.count.request',
      permission: 'inventory.adjust',
      // What the audit row is about is the task that came out, because that is
      // the row a person will go looking for.
      resourceType: 'task',
      requiresReason: true,
      input: REQUEST_COUNT_INPUT,
      loadResource: loadItem,

      async rule({ entity, context }) {
        const { settings } = await ports.loadSettings(
          context.actor.organizationId,
        )
        assertCapability(capabilitiesFor(settings), 'counting')

        // The table's own grant. See the header: without this the refusal
        // arrives as a row level security error instead of a sentence.
        assertCan(context.actor, 'task.create', {
          organizationId: entity.organizationId,
          propertyId: entity.propertyId,
          family: 'operations',
        })
      },

      async execute({ input, entity, context }) {
        const reason = context.reason ?? ''

        const task = await ports.openCountTask({
          organizationId: entity.organizationId,
          propertyId: entity.propertyId,
          taskType: 'inventory',
          title: `ספירת מלאי: ${entity.label}`,
          description:
            `${reason}\n\n` +
            `ספרו את הכמות בפועל של ${entity.label} ` +
            `(${entity.unitOfMeasure}) ורשמו אותה במסך המלאי כתנועת ספירה. ` +
            'אין צורך להשוות למספר שבמערכת — ההשוואה נעשית אחרי הרישום.',
          dueAt: input.dueAt?.toISOString() ?? null,
          metadata: { kind: 'stock_count', itemId: entity.itemId },
        })

        return { taskId: task.id }
      },

      audit({ input, entity, result, context }) {
        return {
          resourceId: result.taskId,
          propertyId: entity.propertyId,
          summary:
            `${context.auditActor.label} ביקש ספירה של ״${entity.label}״ ` +
            (input.dueAt === null
              ? 'ופתח משימה. '
              : `עד ${input.dueAt.toISOString().slice(0, 10)} ופתח משימה. `) +
            'לא בוצע שינוי בכמות.',
          after: {
            taskId: result.taskId,
            itemId: entity.itemId,
            dueAt: input.dueAt?.toISOString() ?? null,
          },
        }
      },

      events({ entity, result }) {
        return [
          {
            name: 'task.created' as const,
            propertyId: entity.propertyId,
            payload: {
              taskId: result.taskId,
              taskType: 'inventory',
              kind: 'stock_count',
              itemId: entity.itemId,
              label: entity.label,
            },
          },
        ]
      },
    }),

    /**
     * Propose a purchase. Nothing is bought and nobody outside is contacted.
     *
     * The result is one `approvals` row in `requested`, and the whole design
     * of that table is what makes this safe to call it a draft: it has no
     * supplier column, its `decided_at` is null until somebody decides, and
     * `approvals_no_self_approval` means the person who raised it is not
     * allowed to be the person who approves it. Autopilot raising a draft and
     * Autopilot approving it is therefore refused by the database, not by a
     * policy somebody could relax.
     *
     * `expense.create` and not `expense.approve`, deliberately. Drafting a
     * purchase and agreeing to it are two decisions and this is the first one.
     */
    draftProcurement: defineOperation<
      DraftProcurementInput,
      CommandItem,
      { approvalId: string; estimatedAgorot: number | null }
    >({
      name: 'inventory.procurement.draft',
      permission: 'expense.create',
      resourceType: 'approval',
      requiresReason: true,
      input: DRAFT_PROCUREMENT_INPUT,
      loadResource: loadItem,

      async rule({ input, entity, context }) {
        const { settings } = await ports.loadSettings(
          context.actor.organizationId,
        )
        assertCapability(capabilitiesFor(settings), 'procurement')

        assertCan(context.actor, 'approval.request', {
          organizationId: entity.organizationId,
          propertyId: entity.propertyId,
          family: 'operations',
        })

        const estimate = estimateFor(input.quantity, entity.unitCostAgorot)
        if (estimate !== null && estimate > INT4_MAX) {
          throw new ProcurementEstimateTooLargeError(estimate)
        }
      },

      async execute({ input, entity, context }) {
        const estimatedAgorot = estimateFor(
          input.quantity,
          entity.unitCostAgorot,
        )

        const approval = await ports.requestProcurementApproval({
          organizationId: entity.organizationId,
          propertyId: entity.propertyId,
          approvalType: 'expense',
          subjectType: 'inventory_item',
          subjectId: entity.itemId,
          reason: context.reason ?? '',
          requestedAgorot: estimatedAgorot,
          metadata: {
            itemId: entity.itemId,
            label: entity.label,
            quantity: input.quantity,
            unitOfMeasure: entity.unitOfMeasure,
            unitCostAgorot: entity.unitCostAgorot,
            neededBy: input.neededBy?.toISOString() ?? null,
            // Verbatim from the forecast. This is evidence, not a calculation
            // repeated here — see the header.
            forecast: input.forecast,
          },
        })

        return { approvalId: approval.id, estimatedAgorot }
      },

      audit({ input, entity, result, context }) {
        return {
          resourceId: result.approvalId,
          propertyId: entity.propertyId,
          summary:
            `${context.auditActor.label} הכין טיוטת רכש של ${input.quantity} ` +
            `${entity.unitOfMeasure} מ״${entity.label}״` +
            (input.neededBy === null
              ? ''
              : ` עד ${input.neededBy.toISOString().slice(0, 10)}`) +
            (result.estimatedAgorot === null
              ? ' (לא נרשמה עלות ליחידה, ולכן אין אומדן). '
              : ` באומדן ${result.estimatedAgorot} אגורות. `) +
            'הבקשה ממתינה לאישור — לא הוזמן דבר ולא נוצר קשר עם ספק.',
          after: {
            approvalId: result.approvalId,
            itemId: entity.itemId,
            quantity: input.quantity,
            requestedAgorot: result.estimatedAgorot,
            status: 'requested',
            forecast: input.forecast,
          },
        }
      },

      events({ input, entity, result }) {
        return [
          {
            name: 'approval.requested' as const,
            propertyId: entity.propertyId,
            payload: {
              approvalId: result.approvalId,
              approvalType: 'expense',
              subjectType: 'inventory_item',
              subjectId: entity.itemId,
              quantity: input.quantity,
              requestedAgorot: result.estimatedAgorot,
              neededBy: input.neededBy?.toISOString() ?? null,
            },
          },
        ]
      },
    }),
  }
}

/**
 * The size of the ask, or an honest absence of one.
 *
 * `null` rather than zero when the item has no recorded unit cost: zero would
 * read on the approval screen as "this costs nothing", which is the one thing
 * it certainly does not mean.
 */
function estimateFor(
  quantity: number,
  unitCostAgorot: number | null,
): number | null {
  return unitCostAgorot === null ? null : quantity * unitCostAgorot
}
