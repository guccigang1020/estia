/**
 * Which callable each `command` name resolves to, and which ones resolve to
 * nothing yet.
 *
 * ── The one rule this file exists to enforce ──────────────────────────────
 *
 * Autopilot writes no business table. Every command resolves to an operation
 * built with `defineOperation` — the same one a person's click calls — so
 * authorization, validation, the domain rule, the transaction, the audit event
 * and the domain events all happen exactly as they do for a human, and
 * "Autopilot did it" and "Dana did it" are the same kind of record with a
 * different actor.
 *
 * `DomainCommand` is the shape of that promise. It is deliberately the subset
 * of `Operation` this module needs, so any `defineOperation` result is
 * assignable to it and nothing else plausibly is: a bare function that wrote a
 * row would not carry a `definition.name`, and the handler factory below is the
 * only way to build a callable from anything.
 *
 * ── Why a command may be UNAVAILABLE, and why that is not a crash ─────────
 *
 * The action catalogue is a statement of intent — it names the command each
 * action would call — and it is ahead of the modules. Eighteen of the
 * twenty-four commands it names do not exist yet.
 *
 * The dishonest options are both worse than saying so. Inventing an operation
 * inside another module to make the name resolve would put a business write
 * outside the pipeline that owns it. Silently doing nothing would leave a row
 * saying `executed` beside a guest who was never messaged. So an unavailable
 * command resolves to a refusal carrying its own explanation, `dispatch`
 * records a clean `failed` with the code `command_not_implemented`, and the
 * activity screen can say which command is missing.
 *
 * ── Why a binding can be withheld on purpose ──────────────────────────────
 *
 * `holds.releaseExpired` is the interesting case. `hold.release` exists and
 * would run, and binding it would be wrong: that operation releases ANY hold,
 * and the catalogue's argument for calling this `safe_internal` is that the
 * hold has ALREADY expired — Autopilot applying a decision the business made,
 * not making a commercial one. Nothing in the command verifies the expiry, so
 * binding it would let a planning mistake release a live hold at
 * `safe_internal`. It stays unavailable until an operation asserts the
 * precondition its safety level is claimed from.
 */

import type {
  OperationContext,
  OperationRequest,
  OperationServices,
} from '../../service/operation'
import { AUTOPILOT_ACTIONS } from '../actions'
import type { PlannedAction } from '../types'

/* ------------------------------------------------------- the domain port -- */

/**
 * A `defineOperation` operation, as much of it as this module touches.
 *
 * Structural rather than a direct import of `Operation<TInput, TEntity,
 * TResult>` so that operations with different input and result types can be
 * held in one registry without a generic parameter nobody could satisfy at the
 * call site — and without `any`, which would let something that is not an
 * operation through.
 */
export interface DomainCommand {
  readonly definition: { readonly name: string }
  run(args: {
    request?: OperationRequest
    context: OperationContext
    services: OperationServices
  }): Promise<{
    data: unknown
    correlationId: string
    replayed: boolean
  }>
}

/* --------------------------------------------------------- the callable -- */

/**
 * One dispatch of one command.
 *
 * `idempotencyKey` is the planned action's own key and is handed to the domain
 * pipeline as well as claimed here, so a second dispatch of the same action
 * replays the stored result instead of charging the card again. Two independent
 * guarantees for the failure that matters most.
 */
export interface CommandInvocation {
  action: PlannedAction
  /** 1 for the first try. Passed so a handler can vary a message or a log. */
  attempt: number
  idempotencyKey: string
  correlationId: string
  now: Date
}

/** What the work returned. Stored verbatim in `autopilot_actions.result`. */
export type CommandResult = Readonly<Record<string, unknown>>

/**
 * The callable a command resolves to.
 *
 * Failure is signalled by throwing, as it is everywhere else in the codebase:
 * an `AppError` carries whether trying again could plausibly help, and
 * `dispatch` reads that rather than guessing.
 */
export type CommandHandler = (
  invocation: CommandInvocation,
) => Promise<CommandResult>

export type CommandResolution =
  | { status: 'available'; operation: string; run: CommandHandler }
  /** Hebrew: this lands in `error_detail` and a person reads it. */
  | { status: 'unavailable'; detail: string }

export interface CommandRegistry {
  resolve(command: string): CommandResolution
}

/* ---------------------------------------------------------- the bindings -- */

export interface CommandBinding {
  /**
   * The `defineOperation` name this command runs, or `null` when no operation
   * exists — or when one exists and binding it would be wrong.
   */
  operation: string | null
  /** For whoever reads this file next. English, and it is not user-facing. */
  note: string
}

/**
 * Every command the action catalogue names, and what it runs today.
 *
 * Written out rather than derived, because "which of these is real" is a fact
 * about the rest of the codebase that changes when somebody adds an operation,
 * and it should change here, visibly, in a diff a reviewer reads.
 */
export const COMMAND_BINDINGS: Readonly<Record<string, CommandBinding>> = {
  /* ── bound to an operation that exists today ─────────────────────────── */

  'preparation.generateRequirements': {
    operation: 'preparation.plan.build',
    note: 'Builds the preparation plan for a booking. Same grant, task.create.',
  },
  'laundry.draftOrder': {
    operation: 'laundry.order.create',
    note: 'Creates the order in status draft — nothing leaves the building.',
  },
  'laundry.sendOrder': {
    operation: 'laundry.order.send',
    note: 'Sends the draft to the laundry. Same grant, laundry.order_send.',
  },
  'inventory.transfer': {
    operation: 'inventory.transfer.request',
    note: 'Requests a transfer between properties; the source is asked, not raided.',
  },
  'bookings.cancelBooking': {
    operation: 'booking.cancel',
    note: 'Requires a version and a stated reason; the reason is the action prose.',
  },
  'payments.refund': {
    operation: 'payment.refund',
    note: 'Requires a version. Capped at ask_approval by the platform floor.',
  },

  /* ── no operation exists ─────────────────────────────────────────────── */

  'tasks.createTask': {
    operation: null,
    note: 'No task operations module exists. Nothing creates a task through the pipeline.',
  },
  'tasks.assignTask': {
    operation: null,
    note: 'No task operations module exists.',
  },
  'tasks.changePriority': {
    operation: null,
    note: 'No task operations module exists.',
  },
  'preparation.publishWorkPlan': {
    operation: null,
    note: 'preparation has build/recompute/complete/override; nothing publishes a work plan.',
  },
  'inventory.requestCount': {
    operation: null,
    note: 'inventory has adjust and discrepancy.resolve; nothing requests a count.',
  },
  'laundry.requestEarlierDelivery': {
    operation: null,
    note: 'laundry has create/adjust_line/send/advance; nothing asks for an earlier slot.',
  },
  'messaging.sendGuestMessage': {
    operation: null,
    note: 'There is no messaging module. Guest messages have no domain command yet.',
  },
  'messaging.notifyAssignee': {
    operation: null,
    note: 'There is no messaging module.',
  },
  'notifications.notifyTeam': {
    operation: null,
    note: 'notifications has settings.set only; delivery is not a domain command.',
  },
  'store.chaseProvider': {
    operation: null,
    note: 'store has product/order/settings operations; nothing chases a provider.',
  },
  'store.offerUpsell': {
    operation: null,
    note: 'store has no upsell operation.',
  },
  'agents.sendReminder': {
    operation: null,
    note: 'agents has invite/access/status/hold/discount/commission; no reminder.',
  },
  'agents.publishOpportunity': {
    operation: null,
    note: 'agents has no opportunity publication operation.',
  },
  'inventory.draftProcurement': {
    operation: null,
    note: 'Nothing drafts procurement; expense.rule.create is a different thing.',
  },
  'payments.requestPayment': {
    operation: null,
    note: 'payments owns policy, overrides, manual channels and proof — no payment link request.',
  },
  'access.issueCode': {
    operation: null,
    note: 'No access-code module. guest_journey link operations are a different concept.',
  },
  'access.revokeCode': {
    operation: null,
    note: 'No access-code module.',
  },

  /* ── withheld on purpose ─────────────────────────────────────────────── */

  'holds.releaseExpired': {
    operation: null,
    note: 'hold.release exists and releases ANY hold. The safe_internal level is claimed from the hold having already expired, and nothing checks that. See the header.',
  },
}

/** Every command the catalogue names, deduplicated. For the tests and the report. */
export function catalogueCommands(): readonly string[] {
  const names = new Set<string>()
  for (const spec of Object.values(AUTOPILOT_ACTIONS)) {
    if (spec.command !== null) names.add(spec.command)
  }
  return [...names].sort()
}

/** The commands that run something today. */
export function boundCommands(): readonly string[] {
  return catalogueCommands().filter(
    (command) => COMMAND_BINDINGS[command]?.operation != null,
  )
}

/** The commands that resolve to a refusal. */
export function unavailableCommands(): readonly string[] {
  return catalogueCommands().filter(
    (command) => COMMAND_BINDINGS[command]?.operation == null,
  )
}

/* ------------------------------------------------------- the operation --- */

/**
 * Keys of `commandInput` that are not part of the operation's input.
 *
 * The service pipeline takes the target and the version it believes it is
 * editing beside the input rather than inside it, so a planner names them here
 * and they are lifted out rather than validated as fields the schema has never
 * heard of.
 */
export const RESOURCE_ID_KEY = 'resourceId'
export const EXPECTED_VERSION_KEY = 'expectedVersion'

export interface OperationBinding {
  operation: DomainCommand
  services: OperationServices
  /**
   * Who Autopilot is acting as, resolved per invocation.
   *
   * A callback rather than a value because the actor and the audit label
   * belong to the composition root — the identity Autopilot runs under is a
   * deployment decision, not something this module may invent.
   */
  context: (invocation: CommandInvocation) => OperationContext
}

/**
 * Turn one operation into a callable.
 *
 * The action's own prose becomes the operation's stated reason. That is not a
 * convenience: `booking.cancel` refuses to run without one, and the honest
 * answer to "why was this cancelled" is exactly the sentence Autopilot composed
 * when it decided to.
 */
export function operationHandler(binding: OperationBinding): CommandHandler {
  return async (invocation) => {
    const { action } = invocation
    const input = { ...action.commandInput }

    const resourceId = input[RESOURCE_ID_KEY]
    const expectedVersion = input[EXPECTED_VERSION_KEY]
    delete input[RESOURCE_ID_KEY]
    delete input[EXPECTED_VERSION_KEY]

    const context = binding.context(invocation)

    const outcome = await binding.operation.run({
      request: {
        input,
        resourceId: typeof resourceId === 'string' ? resourceId : null,
        expectedVersion:
          typeof expectedVersion === 'number' ? expectedVersion : undefined,
        idempotencyKey: invocation.idempotencyKey,
      },
      context: { ...context, reason: context.reason ?? action.reason },
      services: binding.services,
    })

    return {
      operation: binding.operation.definition.name,
      correlationId: outcome.correlationId,
      replayed: outcome.replayed,
      data: outcome.data,
    }
  }
}

/* --------------------------------------------------------- the registry -- */

/**
 * The registry the executor is given.
 *
 * `handlers` is keyed by the COMMAND name — the string on the action spec — and
 * is supplied by whoever wired the operations. A command the catalogue does not
 * know, one with no operation behind it, and one whose operation exists but was
 * not wired are three different sentences, because they are three different
 * things to do about it.
 */
export function createCommandRegistry(
  handlers: Readonly<Record<string, CommandHandler>> = {},
): CommandRegistry {
  return {
    resolve(command) {
      const binding = COMMAND_BINDINGS[command]

      if (!binding) {
        return {
          status: 'unavailable',
          detail: `הפקודה ${command} אינה מוכרת בקטלוג הפעולות.`,
        }
      }

      if (binding.operation === null) {
        return {
          status: 'unavailable',
          detail: `הפקודה ${command} עדיין אינה ממומשת במערכת, ולכן הפעולה לא בוצעה.`,
        }
      }

      const run = handlers[command]
      if (!run) {
        return {
          status: 'unavailable',
          detail: `הפקודה ${command} קיימת אך לא חוברה להפעלה הזו (${binding.operation}).`,
        }
      }

      return { status: 'available', operation: binding.operation, run }
    },
  }
}
