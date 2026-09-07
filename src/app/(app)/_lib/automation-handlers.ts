/**
 * EXECUTION CONTEXT — SERVER ONLY. What an automation can actually do here.
 *
 * ══ THIS FILE IS THE LIST, AND THE LIST IS SHORT ════════════════════════════
 *
 * `ActionHandlerRegistry` ships empty and `performing.ts` says why: "There is
 * no code in this product that sends a guest a WhatsApp message on an
 * automation's say-so, opens a housekeeping task, or issues an invoice — those
 * belong to the modules that own those concepts, and inventing them here would
 * be inventing capabilities the product does not have."
 *
 * So this is the wiring and not the capability. Each entry hands the automation
 * engine a function a module already owns, built on the caller's client with
 * the caller's actor. Adding a line here is a claim that the product can
 * genuinely do that thing.
 *
 * ══ ONE ENTRY, AND SEVEN DELIBERATE ABSENCES ════════════════════════════════
 *
 * `create_task` is here because `defineTaskCreation` exists and is the one path
 * a task row is written along. The other seven are absent, and the absence is
 * the honest state rather than an oversight:
 *
 *   · `notify_team` — `src/lib/notifications` already routes team
 *     notifications from the event itself, keyed by `DomainEventName`. An
 *     automation path would be a SECOND notification for the same event, with
 *     a dedupe key the first one does not share. What is missing is not a
 *     handler but a decision about which of the two owns "tell the team when X
 *     happens", and that is not a decision to make inside a wiring file.
 *   · `message_guest`, `request_review`, `send_payment_link`, `issue_invoice`,
 *     `block_availability` — every one is visible outside the business.
 *     `library.ts` ships all of them OFF for that reason, and no handler for
 *     them should be written before there is an organization whose owner can
 *     watch the first one happen.
 *   · `request_approval` — there is no approval queue behind the grant.
 *
 * An unhandled action is not silently skipped. `executionReadiness` reports it
 * as a blocker BY NAME and refuses the whole run, so a rule that opens a task
 * and messages a guest performs neither — half a rule is worse than none,
 * because a business that sees the task assumes the message went too.
 */

import type { ActionHandler } from '@/lib/automation/performing'
import type { AutomationActionKind } from '@/lib/automation/types'
import type { Actor } from '@/lib/authz/can'
import type { DomainEvent } from '@/lib/contracts/events'
import {
  AtomicTransactionUnavailableError,
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
  postgresUnitOfWork,
  sequentialUnitOfWork,
  type Db,
} from '@/lib/persistence'
import type { OperationServices } from '@/lib/service'
import { taskFromAutomation } from '@/lib/tasks/automation'

import { defineTaskCreation } from '../tasks/_lib/operations'

/**
 * The handlers this deployment can supply, as `[kind, handler]` pairs.
 *
 * A list rather than a registry, so the caller does the registering and this
 * file cannot quietly become the place a handler is switched on.
 */
export function operationHandlers(
  db: Db,
  actor: Actor,
  event: DomainEvent,
): readonly (readonly [AutomationActionKind, ActionHandler])[] {
  const services = automationServices(db)

  return [
    [
      'create_task',
      taskFromAutomation({
        operation: defineTaskCreation({
          // Named for the automation and not for the screen, so both the audit
          // trail and the idempotency scope say what actually opened it.
          name: 'automation.task.create',
          permission: 'task.create',
          db,
        }),
        context: {
          actor,
          // `system`, on behalf of the person whose action raised the event.
          // Not `user`: a manager reading the timeline has to be able to tell
          // "the receptionist opened this" from "a rule opened this while the
          // receptionist was taking a booking". Those are different facts
          // about who decided, and `ActorType` has more than one member
          // precisely so a timeline can say so.
          auditActor: {
            type: 'system',
            userId: null,
            label: 'אוטומציה',
            onBehalfOfUserId: event.actorUserId ?? null,
          },
          correlationId: event.correlationId,
        },
        services,
      }),
    ],
  ]
}

/**
 * What an automation's own writes run with — and, pointedly, what they do not.
 *
 * ══ NO EVENT BUS, AND THAT IS THE LOOP GUARD ════════════════════════════════
 *
 * `events` is absent. An action that writes would otherwise publish a domain
 * event, which would reach the performing subscriber, which could reach an
 * action that writes. Nothing in the engine bounds that: the ledger keys each
 * delivery separately, so every turn of the loop looks like new work.
 *
 * Leaving the bus out makes the loop structurally impossible rather than
 * merely unlikely. The alternative — trusting that no library template reacts
 * to an event another template's action raises — is true today and is a
 * property somebody could break by adding one template, in a file that has no
 * reason to be thinking about cycles.
 *
 * The cost is real and named rather than hidden: a task opened by an
 * automation does not fire the webhook that a task opened by a person fires,
 * and does not notify. Closing that needs a depth limit carried on the event
 * itself, which is a design decision and not a line to add here.
 *
 * Exported so a test can assert the absence. A missing field is exactly the
 * kind of guard that gets "fixed" by somebody who reads it as an oversight.
 */
export function automationServices(db: Db): OperationServices {
  return {
    audit: new SupabaseAuditWriter(db),
    idempotency: new SupabaseIdempotencyStore(db),
    transactions: transactionRunner(db),
  }
}

/** Logged once, not once per automation. */
let warnedAboutTransactions = false

/**
 * The same fallback every wiring file makes, and for the same reason.
 *
 * `postgresUnitOfWork` needs `DATABASE_URL` and this deployment does not set
 * one, so the alternative to falling back is every automation crashing with a
 * wiring error. `sequentialUnitOfWork` is explicitly NOT a transaction: it runs
 * the writes in order and raises `PartialCommitError` naming what committed.
 * Setting `DATABASE_URL` closes it with no code change.
 */
function transactionRunner(db: Db): OperationServices['transactions'] {
  try {
    return postgresUnitOfWork(db)
  } catch (cause) {
    if (!(cause instanceof AtomicTransactionUnavailableError)) throw cause

    if (!warnedAboutTransactions) {
      warnedAboutTransactions = true
      console.warn(
        '[automation] DATABASE_URL is not set, so an automation write and its ' +
          'audit event are sequential rather than transactional. Point ' +
          'DATABASE_URL at the Supabase transaction pooler (port 6543) to ' +
          'restore atomicity.',
        cause.message,
      )
    }

    return sequentialUnitOfWork(db)
  }
}
