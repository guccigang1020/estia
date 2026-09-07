/**
 * `create_task`, performed.
 *
 * ══ WHY THIS FILE IS IN THE TASKS MODULE AND NOT IN THE AUTOMATION ONE ══════
 *
 * `performing.ts` draws the line and this file is the first thing on the other
 * side of it: "There is no code in this product that sends a guest a WhatsApp
 * message on an automation's say-so, opens a housekeeping task, or issues an
 * invoice — those belong to the modules that own those concepts, and inventing
 * them here would be inventing capabilities the product does not have."
 *
 * So the automation module stays free of task vocabulary — it does not know
 * what a `TaskType` is, and should not — and the module that owns tasks owns
 * the one sentence that turns an automation's THEN clause into a task.
 *
 * ══ IT GOES THROUGH THE SAME DOOR A PERSON GOES THROUGH ═════════════════════
 *
 * `defineTaskCreation`, the operation, not the repository. That is the whole
 * claim `types.ts` makes about the action catalogue — "each entry is a thing
 * the product already does through a screen, which is what makes 'the
 * automation did it' and 'somebody did it' the same kind of event in the audit
 * trail rather than two parallel worlds" — and it only stays true if the
 * automation path runs the same pipeline: the permission check, the schema, the
 * transaction, the audit record and the domain event.
 *
 * In particular the operation asks `assertCan` again with the actor it was
 * given. An automation is not a way around the authorization engine, and this
 * file adds no exemption to it.
 *
 * ══ THE THREE THINGS AN AUTOMATION CANNOT TELL US, AND WHAT IS DONE ═════════
 *
 * An `AutomationAction` is `{ kind, note }`. It carries no property, no task
 * type and no priority, and the honest answers are not the convenient ones.
 *
 *   · **Property** comes from the event and from nowhere else. When the event
 *     has none the handler REFUSES, permanently — a task belongs to a property
 *     and inventing one would put work on somebody else's board. Refusing is
 *     what makes the run record say `failed` with a reason instead of quietly
 *     reporting an action that did not happen.
 *
 *   · **Type** is `custom`, and deliberately not a guess. `cleaning` would put
 *     an automation-opened task on the housekeeping board and into a cleaner's
 *     morning; `custom` puts it where somebody triages it. A rule that knows
 *     it wants a cleaning task is a rule that should say so, and the vocabulary
 *     to say it does not exist yet — that is a gap in `AutomationAction`, not
 *     a licence to guess here.
 *
 *   · **Priority** is `normal`. Nothing in the rule expresses urgency, and an
 *     automation that opened every task as `high` would train a team to ignore
 *     the field within a week.
 *
 * ══ IDEMPOTENCY, TWICE, FOR TWO DIFFERENT RACES ═════════════════════════════
 *
 * The ledger (`automation_ledger`, 0078) stops a SECOND DELIVERY of the same
 * event from performing again. The operation's own idempotency key stops the
 * RETRY LOOP INSIDE one delivery — `runAction` calls the performer up to three
 * times on a retryable failure — from opening three tasks when the first
 * attempt actually committed and the response was lost.
 *
 * Those are different races and neither closes the other. The key is a
 * fingerprint of the action rather than the note itself, so it stays bounded
 * whatever a business writes in the rule.
 */

import type { PerformInput } from '../automation/engine'
import { BusinessRuleError } from '../errors'
import { fingerprint } from '../service'
import type { OperationContext, OperationServices } from '../service'

import type { TaskCreationOperation } from './operations'

export interface TaskAutomationDeps {
  operation: TaskCreationOperation
  /**
   * The actor the automation runs as, and the audit identity that will be on
   * the record. Built by the caller: this module does not decide who an
   * automation is.
   */
  context: OperationContext
  services: OperationServices
}

/**
 * The handler `ActionHandlerRegistry.register('create_task', …)` takes.
 *
 * Returns `Promise<void>` and throws on refusal, which is the contract
 * `ActionHandler` states and the reason it states it: "Returning quietly would
 * report the action as executed and write an audit line saying a guest was
 * messaged, which is the worst outcome available here."
 */
export function taskFromAutomation(
  deps: TaskAutomationDeps,
): (input: PerformInput) => Promise<void> {
  return async ({ action, rule, event }: PerformInput) => {
    const propertyId = event.propertyId ?? null

    if (propertyId === null) {
      throw new BusinessRuleError({
        code: 'automation.task_has_no_property',
        message: `automation rule ${rule.id} asked for a task on ${event.name}, which carries no property`,
        userMessage:
          'הכלל מבקש לפתוח משימה, אבל האירוע שהפעיל אותו אינו משויך לנכס — ולכן אין לאיזה נכס לפתוח אותה.',
      })
      // `BusinessRuleError` is `retryable: false` by construction, which is
      // what this case needs: the event will not grow a property on the second
      // attempt, so `runAction` breaks out of its loop instead of producing
      // three identical failures and three identical alerts — and it KEEPS the
      // ledger claim, so the next delivery does not reproduce them either.
    }

    await deps.operation.run({
      request: {
        input: {
          propertyId,
          unitId: null,
          teamId: null,
          // Nobody. `INITIAL_TASK_STATUSES` makes that `new`, which is the
          // state a triage board reads. Assigning to whoever happened to
          // trigger the event would put a booking clerk on a maintenance job.
          assignedToUserId: null,
          taskType: 'custom',
          priority: 'normal',
          // The rule's name, because that is the sentence a person recognises
          // on the board — "the automation opened this" is useless without
          // which automation. Bounded to the schema's 200.
          title: title(rule.name),
          description: action.note,
          dueOn: null,
        },
        idempotencyKey: `automation:${event.idempotencyKey}:${rule.id}:${fingerprint(action)}`,
      },
      context: deps.context,
      services: deps.services,
    })
  }
}

/**
 * The rule's name, trimmed to what the creation schema accepts.
 *
 * `s.string({ min: 2, max: 200 })`. A rule named with one character would fail
 * validation inside the operation and be reported as a failed automation,
 * which is a confusing way to say "your rule's name is too short" — so the
 * short case is padded with the word the board would have needed anyway.
 */
function title(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length < 2) return 'משימה מאוטומציה'
  return trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed
}
