/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * The command handler map: every `command` the action catalogue names, bound
 * to the real `defineOperation` that performs it.
 *
 * ── This file constructs and decides nothing ──────────────────────────────
 *
 * `createCommandRegistry` takes a map from command name to a callable, and
 * this is the map. Every entry is `operationHandler({ operation, services,
 * context })` over an operation another module built — so authorization,
 * validation, the domain rule, the transaction, the audit event and the domain
 * events all happen exactly as they do when a person clicks, and "Autopilot did
 * it" and "Dana did it" are the same kind of record with a different actor.
 *
 * ── A missing command is honest; a stub is a lie ──────────────────────────
 *
 * Several catalogue commands need a PORT that has no implementation anywhere in
 * the codebase yet — not a database adapter that is merely unwritten here, but
 * a seam whose only honest filling is somebody else's module. Those commands
 * are simply absent from this map. `createCommandRegistry` then reports
 * `הפקודה … קיימת אך לא חוברה להפעלה הזו`, `dispatch` records a clean `failed`
 * with `command_not_implemented`, and the activity screen names the command.
 *
 * A stub that returned `{ ok: true }` would instead put `executed` in the
 * activity log beside a guest who was never messaged, and the log would repeat
 * that lie forever. So the ones below are omitted deliberately, each with the
 * reason it is omitted stated in `UNWIRED_COMMANDS` rather than in a comment
 * that a reader has to go looking for.
 */

import { defineAgentCommands } from '@/lib/agents'
import {
  defineBookingOperations,
  defineHoldExpiryCommands,
} from '@/lib/booking'
import { defineFinanceOperations } from '@/lib/finance'
import {
  defineInventoryOperations,
  type InventoryPorts,
} from '@/lib/inventory/operations'
import {
  SupabaseLaundryRepository,
  defineLaundryCommands,
  defineLaundryOrderOperations,
  laundryOperationPorts,
} from '@/lib/laundry'
import type { MessagingOperations } from '@/lib/messaging'
import {
  SupabaseAgentRepository,
  SupabaseBookingRepository,
  SupabaseFinanceRepository,
  SupabaseInventoryRepository,
  SupabasePreparationPorts,
  type Db,
} from '@/lib/persistence'
import { createPreparationOperations } from '@/lib/preparation'
import {
  defineTaskAssignment,
  defineTaskCancellation,
  defineTaskCreation,
  defineTaskPriorityChange,
} from '@/lib/tasks'
import type { OperationContext, OperationServices } from '@/lib/service'

import {
  operationHandler,
  type CommandHandler,
  type CommandInvocation,
  type DomainCommand,
} from '../execute'

/* ---------------------------------------------------------------- ports -- */

/**
 * What building the handler map needs, and nothing more.
 *
 * `context` is a callback rather than a value because the identity Autopilot
 * runs under is a deployment decision — `registry.ts` says so on
 * `OperationBinding` — and this module may not invent one. `wiring.ts` supplies
 * it from the request-scoped client's own session.
 */
export interface CommandHandlerPorts {
  db: Db
  services: OperationServices
  context: (invocation: CommandInvocation) => OperationContext
  /**
   * The organization the pass is running for.
   *
   * Closed over rather than read off a row, for the reason
   * `laundryOperationPorts` states: an adapter that read the tenant off the row
   * it was about to return would be asking the row to vouch for itself.
   */
  organizationId: string
  /**
   * The messaging commands, when a composition root for them exists.
   *
   * `defineMessagingOperations` needs a `GuestMessageSource` and a
   * `StaffRecipientSource`, and neither has an implementation in this codebase
   * — see `UNWIRED_COMMANDS`. Optional rather than constructed here, so the day
   * one lands this file gains a caller rather than a query of its own.
   */
  messaging?: MessagingOperations
}

/* ------------------------------------------------------- what is missing -- */

/**
 * The bound commands this map deliberately does not carry, and why.
 *
 * English, and not user-facing: `createCommandRegistry` composes the Hebrew a
 * person reads. This exists so "which of the twenty-two actually run" is a fact
 * a reviewer reads in a diff rather than one they reconstruct by grepping.
 */
export const UNWIRED_COMMANDS: Readonly<Record<string, string>> = {
  'laundry.draftOrder':
    'defineLaundryCreation closes over a ConsolidatedRun, the resolved ' +
    'settings, a pre-minted order id and its line ids — the run is the ' +
    'argument, not the input. There is no read path that assembles a run for a ' +
    'booking, so binding this would mean constructing an empty one, and an ' +
    'empty run is a silent zero-line order.',
  'inventory.requestCount':
    'InventoryCommandPorts.openCountTask has no implementation. Writing one ' +
    'over SupabaseTaskRepository.insertTask would drop the draft metadata — ' +
    'tasks has a metadata column and TaskDraft has no field for it — so the ' +
    'stock count could not be tied back to the item it is about.',
  'inventory.draftProcurement':
    'InventoryCommandPorts.requestProcurementApproval has no implementation ' +
    'and no module owns an approvals writer; the only inserts into approvals ' +
    'live inside src/lib/persistence/agents.ts for commissions.',
  'store.chaseProvider':
    'StoreCommandDeps.bookingFacts has no implementation reachable from the ' +
    'operator side. bookingFactsFrom needs a GuestSession — a guest capability ' +
    'token — and a scheduled Autopilot pass holds none.',
  'store.offerUpsell': 'Same port as store.chaseProvider.',
  'payments.requestPayment':
    'PaymentRequestDeps.collectionFacts has no implementation. The only ' +
    'assembly of CollectionFacts is guest-journey/collection.ts, which reads ' +
    'guest_collection_context(p_guest_token) — keyed by a guest capability ' +
    'token, not by an organization and a booking.',
  'messaging.sendGuestMessage':
    'MessagingOperationDeps needs a GuestMessageSource and a ' +
    'StaffRecipientSource, and neither interface has an implementation ' +
    'anywhere. Supplied through CommandHandlerPorts.messaging when one exists.',
  'messaging.notifyAssignee': 'Same ports as messaging.sendGuestMessage.',
  'notifications.notifyTeam': 'Same ports as messaging.sendGuestMessage.',
}

/* -------------------------------------------------------------- the map -- */

function bindAll(
  ports: CommandHandlerPorts,
  operations: Readonly<Record<string, DomainCommand>>,
): Record<string, CommandHandler> {
  const handlers: Record<string, CommandHandler> = {}

  for (const [command, operation] of Object.entries(operations)) {
    handlers[command] = operationHandler({
      operation,
      services: ports.services,
      context: ports.context,
    })
  }

  return handlers
}

/**
 * Every command that runs today, keyed by the name on the action spec.
 *
 * Built per call, never cached at module scope: the operations are constructed
 * over a request-scoped client, and one shared instance would be one shared
 * identity — the same argument `tasks/_lib/wiring.ts` makes at its own top.
 */
export function autopilotCommandHandlers(
  ports: CommandHandlerPorts,
): Readonly<Record<string, CommandHandler>> {
  const { db } = ports

  const bookings = new SupabaseBookingRepository(db)
  const laundry = laundryOperationPorts(
    new SupabaseLaundryRepository(db),
    ports.organizationId,
  )
  const laundryOrders = defineLaundryOrderOperations({ db, ports: laundry })
  const laundryCommands = defineLaundryCommands({ db, ports: laundry })
  const preparation = createPreparationOperations(
    new SupabasePreparationPorts(db),
  )
  const inventory = defineInventoryOperations(
    inventoryPortsOver(new SupabaseInventoryRepository(db)),
  )
  const finance = defineFinanceOperations(new SupabaseFinanceRepository(db))
  const agents = defineAgentCommands({
    repo: new SupabaseAgentRepository(db),
    // The calendar, as the booking module reads it. Injected rather than
    // re-derived, because "are these nights actually empty" already has an
    // owner and a second answer to it is a second product.
    availability: bookings,
  })

  const handlers = bindAll(ports, {
    // ── tasks ───────────────────────────────────────────────────────────
    // The factory takes the permission as a parameter, which is why
    // `incident.create` runs the same definition. Autopilot opens an ordinary
    // task, so it names `task.create` — the grant the catalogue declares.
    'tasks.createTask': defineTaskCreation({
      name: 'task.create',
      permission: 'task.create',
      db,
    }),
    'tasks.cancelTask': defineTaskCancellation({ db }),
    'tasks.assignTask': defineTaskAssignment({ db }),
    'tasks.changePriority': defineTaskPriorityChange({ db }),

    // ── preparation ─────────────────────────────────────────────────────
    'preparation.generateRequirements': preparation.buildPlan,

    // ── laundry ─────────────────────────────────────────────────────────
    'laundry.sendOrder': laundryOrders.sendOrder,
    'laundry.requestEarlierDelivery': laundryCommands.requestEarlierDelivery,

    // ── inventory ───────────────────────────────────────────────────────
    // The source property is asked, not raided: `proposeTransfer` writes a
    // request, and the other property's stock does not move until it agrees.
    'inventory.transfer': inventory.proposeTransfer,

    // ── sales ───────────────────────────────────────────────────────────
    'agents.sendReminder': agents.sendReminder,
    'agents.publishOpportunity': agents.publishOpportunity,

    // ── money, access, cancellation ─────────────────────────────────────
    // All three are capped at `ask_approval` by the platform floor in 0046, so
    // reaching any of them means a named person pressed the button and
    // `approval.ts` recorded both actors.
    'bookings.cancelBooking': defineBookingOperations(bookings).cancelBooking,
    'holds.releaseExpired': defineHoldExpiryCommands(bookings).releaseExpired,
    'payments.refund': finance.refundPayment,
  })

  if (ports.messaging) {
    Object.assign(
      handlers,
      bindAll(ports, {
        'messaging.sendGuestMessage': ports.messaging.sendGuestMessage,
        'messaging.notifyAssignee': ports.messaging.notifyAssignee,
        'notifications.notifyTeam': ports.messaging.notifyTeam,
      }),
    )
  }

  return handlers
}

/* ---------------------------------------------------------- the adapter -- */

/**
 * The stock repository, in the shape `operations.ts` declares.
 *
 * `SupabaseInventoryRepository` carries every method `InventoryPorts` names and
 * declares no `implements`, so the two are structurally compatible without
 * being nominally related. Forwarded method by method rather than asserted
 * through `unknown`: a cast would keep compiling on the day one of these
 * signatures changed, and the failure would then arrive as a runtime
 * `TypeError` inside a transaction.
 */
function inventoryPortsOver(
  repository: SupabaseInventoryRepository,
): InventoryPorts {
  return {
    loadSettings: (organizationId) => repository.loadSettings(organizationId),
    saveSettings: (settings) => repository.saveSettings(settings),
    createItem: (args) => repository.createItem(args),
    updateItem: (args) => repository.updateItem(args),
    recordMovement: (args) => repository.recordMovement(args),
    loadReservableItem: (args) => repository.loadReservableItem(args),
    reserve: (request) => repository.reserve(request),
    requestTransfer: (args) => repository.requestTransfer(args),
    loadDiscrepancy: (args) => repository.loadDiscrepancy(args),
    resolveDiscrepancy: (args) => repository.resolveDiscrepancy(args),
  }
}
