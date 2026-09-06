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
    operation: 'task.create',
    note: "src/lib/tasks. The operation moved out of the tasks route unchanged; the factory takes the permission as a parameter, so incident.create runs the same definition.",
  },
  // Not an action in the catalogue: undo.ts names it as the reversal for
  // tasks.createTask, and without an entry here that undo path resolved as
  // "the command is not in the catalogue" and stayed dead.
  'tasks.cancelTask': {
    operation: 'task.cancel',
    note: 'src/lib/tasks. The reversal for tasks.createTask. Refuses a completed task rather than applying, and requires a reason, which Autopilot supplies from the action prose.',
  },
  'tasks.assignTask': {
    operation: 'task.assign',
    note: "src/lib/tasks. Reassignment keeps the old row and stamps it rather than overwriting.",
  },
  'tasks.changePriority': {
    operation: 'task.priority.change',
    note: "src/lib/tasks.",
  },
  'preparation.publishWorkPlan': {
    operation: null,
    note: "Deliberately unbound. preparation.plan.build was investigated and rejected on three grounds: it is already bound to preparation.generateRequirements, so the activity feed would report publishing for work that built requirements; it throws preparation_plan_exists exactly when a plan already exists, which is when publishing is meaningful; and its grant is task.create while this action declares task.update. There is also no publish step in the model — work_plans has no status column and a built plan is already readable.",
  },
  'inventory.requestCount': {
    operation: 'inventory.count.request',
    note: "src/lib/inventory/commands. There is no stock-count table, so the request opens a task: counting the linen cupboard on Thursday is an errand a person performs. The task deliberately does not state what the ledger believes, because a stocktake shown the expected answer returns it.",
  },
  'laundry.requestEarlierDelivery': {
    operation: 'laundry.order.request_earlier_delivery',
    note: "src/lib/laundry/commands. Appends to the order metadata and never touches the deadline, the status or the sent body; the original expected return is kept beside the requested one, because what the provider committed to is evidence.",
  },
  'messaging.sendGuestMessage': {
    operation: 'messaging.guest_message.send',
    note: "src/lib/messaging. With no transport configured it records not_configured and publishes no event — a payment.instructions_sent raised for a message nobody received would tell every subscriber the guest was told.",
  },
  'messaging.notifyAssignee': {
    operation: 'messaging.assignee.notify',
    note: "src/lib/messaging, over the notifications engine from 0043 — route() and dispatch(), not a second delivery mechanism.",
  },
  'notifications.notifyTeam': {
    operation: 'messaging.team.notify',
    note: "src/lib/messaging, over the notifications engine from 0043.",
  },
  'store.chaseProvider': {
    operation: 'store.provider.chase',
    note: "src/lib/store/commands. Moves the request to unconfirmed, which store.provider_unconfirmed already routes to a person.",
  },
  'store.offerUpsell': {
    operation: 'store.upsell.offer',
    note: "src/lib/store/commands. PREPARES an offer and delivers nothing: it runs the real eligibility check — catalogue, property override, availability, day capacity, party, lead time — and returns sent: false.",
  },
  'agents.sendReminder': {
    operation: 'agent.reminder.prepare',
    note: "src/lib/agents/commands. PREPARES and delivers nothing. Supports an expiring hold only; there is no quote entity anywhere, so a quote reminder could verify nothing.",
  },
  'agents.publishOpportunity': {
    operation: 'agent.opportunity.prepare',
    note: "src/lib/agents/commands. PREPARES and publishes nothing. Runs the real availability check and refuses nights that are not empty, without forwarding blockers — a hold blocker would announce to the network that a rival is mid-deal.",
  },
  'inventory.draftProcurement': {
    operation: 'inventory.procurement.draft',
    note: "src/lib/inventory/commands. Raises an approval, where approvals_no_self_approval means Autopilot cannot decide its own draft — refused by Postgres, not by a policy somebody can relax.",
  },
  'payments.requestPayment': {
    operation: 'payment.request',
    note: "src/lib/payments/requests. Takes NO money and creates no link: it routes through resolveCollectionPolicy and nextGuestAction and records what was asked. It deliberately publishes no event — payment.instructions_sent already has an owner in guest-journey, and a second emitter from a command that sends nothing would be a delivery receipt for a delivery that did not happen.",
  },
  'access.issueCode': {
    operation: null,
    note: "Deliberately unbound. The only access_code in the schema is a column on the guest-journey table, which another session owns and which is off limits; building this would mean writing into that territory. Recorded as unavailable rather than worked around.",
  },
  'access.revokeCode': {
    operation: null,
    note: "Deliberately unbound, for the same reason as access.issueCode.",
  },

  /* ── withheld on purpose ─────────────────────────────────────────────── */

  'holds.releaseExpired': {
    operation: 'hold.release_expired',
    note: "src/lib/booking/holds-commands. The precondition the catalogue claims now EXISTS and is asserted: assertHoldHasExpired refuses not_expired, already_released, already_converted and expiry_unreadable, with the clock injected. This is why hold.release itself was deliberately never bound — it releases any hold, and the safe_internal rating rests entirely on the hold having already expired.",
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
