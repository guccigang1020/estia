import { describe, expect, it } from 'vitest'

import type { PerformInput } from '../automation/engine'
import type { AutomationRule } from '../automation/types'
import type { DomainEvent } from '../contracts/events'
import type { OperationContext, OperationServices } from '../service'

import { taskFromAutomation } from './automation'
import type { TaskCreationOperation } from './operations'

const ORG = '11111111-1111-4111-8111-111111111111'
const PROPERTY = '22222222-2222-4222-8222-222222222222'

const rule: AutomationRule = {
  id: 'rule-9',
  name: 'ניקיון אחרי עזיבה',
  description: '',
  when: 'booking.checked_out',
  conditions: [],
  actions: [{ kind: 'create_task', note: 'לבדוק את הסלון' }],
  enabled: true,
}

function eventWith(propertyId: string | null): DomainEvent {
  return {
    name: 'booking.checked_out',
    organizationId: ORG,
    resourceType: 'booking',
    resourceId: 'booking-1',
    propertyId,
    occurredAt: '2026-09-07T09:00:00.000Z',
    correlationId: 'corr-1',
    idempotencyKey: 'evt-1',
    payload: {},
  }
}

function input(propertyId: string | null): PerformInput {
  return {
    action: rule.actions[0],
    rule,
    event: eventWith(propertyId),
    attempt: 1,
  }
}

type RunArgs = Parameters<TaskCreationOperation['run']>[0]

/**
 * A stand-in for the operation, recording what it was handed.
 *
 * The point of every test below is what reaches the pipeline, so the double
 * captures arguments rather than returning a plausible task: a fake that
 * answered convincingly and recorded nothing would let a handler send the
 * wrong property and still pass.
 */
function spyOperation() {
  const calls: RunArgs[] = []
  const operation = {
    run: async (args: RunArgs) => {
      calls.push(args)
      return { ok: true } as never
    },
  } as unknown as TaskCreationOperation

  return { operation, calls }
}

function callAt(calls: readonly RunArgs[], index: number): RunArgs {
  const call = calls[index]
  if (!call) throw new Error(`the operation was not run ${index + 1} times`)
  return call
}

const context = {} as OperationContext
const services = {} as OperationServices

describe('taskFromAutomation', () => {
  it('opens the task through the operation, not the repository', async () => {
    // The claim `types.ts` makes about the action catalogue — that an
    // automation doing something and a person doing it are the same kind of
    // event in the audit trail — is only true if this runs the same pipeline.
    const { operation, calls } = spyOperation()

    await taskFromAutomation({ operation, context, services })(input(PROPERTY))

    expect(calls).toHaveLength(1)
    expect(callAt(calls, 0).context).toBe(context)
    expect(callAt(calls, 0).services).toBe(services)
  })

  it('takes the property from the event and names the rule on the board', async () => {
    const { operation, calls } = spyOperation()

    await taskFromAutomation({ operation, context, services })(input(PROPERTY))

    expect(callAt(calls, 0).request?.input).toMatchObject({
      propertyId: PROPERTY,
      title: 'ניקיון אחרי עזיבה',
      description: 'לבדוק את הסלון',
    })
  })

  it('opens it as custom and normal rather than guessing', async () => {
    // `cleaning` would put an automation-opened task into a cleaner's morning
    // and `high` would train the team to ignore the priority field. Neither is
    // something the rule actually said.
    const { operation, calls } = spyOperation()

    await taskFromAutomation({ operation, context, services })(input(PROPERTY))

    expect(callAt(calls, 0).request?.input).toMatchObject({
      taskType: 'custom',
      priority: 'normal',
      assignedToUserId: null,
      unitId: null,
      teamId: null,
      dueOn: null,
    })
  })

  it('refuses when the event carries no property, rather than inventing one', async () => {
    // A task belongs to a property. Guessing one would put work on somebody
    // else's board; returning quietly would record an action that never
    // happened.
    const { operation, calls } = spyOperation()

    await expect(
      taskFromAutomation({ operation, context, services })(input(null)),
    ).rejects.toMatchObject({ code: 'automation.task_has_no_property' })

    expect(calls).toHaveLength(0)
  })

  it('refuses non-retryably, so three attempts are not three alerts', async () => {
    const { operation } = spyOperation()

    await expect(
      taskFromAutomation({ operation, context, services })(input(null)),
    ).rejects.toMatchObject({ retryable: false })
  })

  it('carries an idempotency key that survives the engine retry loop', async () => {
    // The ledger stops a second DELIVERY. This key stops the retry loop inside
    // ONE delivery from opening three tasks when the first attempt committed
    // and the response was lost.
    const { operation, calls } = spyOperation()
    const handler = taskFromAutomation({ operation, context, services })

    await handler(input(PROPERTY))
    await handler({ ...input(PROPERTY), attempt: 2 })

    const first = callAt(calls, 0).request?.idempotencyKey
    const second = callAt(calls, 1).request?.idempotencyKey

    expect(first).toBe(second)
    expect(first).toContain('evt-1')
    expect(first).toContain('rule-9')
  })

  it('distinguishes two different actions of the same rule', async () => {
    // Same event, same rule, different THEN clause. One key for both would
    // perform only the first, which is the failure `executionKey` documents.
    const { operation, calls } = spyOperation()
    const handler = taskFromAutomation({ operation, context, services })

    await handler(input(PROPERTY))
    await handler({
      ...input(PROPERTY),
      action: { kind: 'create_task', note: 'ולבדוק את המרפסת' },
    })

    expect(callAt(calls, 0).request?.idempotencyKey).not.toBe(
      callAt(calls, 1).request?.idempotencyKey,
    )
  })

  it('pads a title the creation schema would refuse', async () => {
    // Two characters is the schema's floor. A rule named "א" would otherwise
    // fail validation inside the operation and surface as a failed automation,
    // which is a confusing way to say "your rule's name is too short".
    const { operation, calls } = spyOperation()

    await taskFromAutomation({ operation, context, services })({
      ...input(PROPERTY),
      rule: { ...rule, name: 'א' },
    })

    expect(callAt(calls, 0).request?.input).toMatchObject({
      title: 'משימה מאוטומציה',
    })
  })

  it('trims a title longer than the schema accepts', async () => {
    const { operation, calls } = spyOperation()

    await taskFromAutomation({ operation, context, services })({
      ...input(PROPERTY),
      rule: { ...rule, name: 'א'.repeat(300) },
    })

    const sent = callAt(calls, 0).request?.input as { title: string }
    expect(sent.title).toHaveLength(200)
  })
})
