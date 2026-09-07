import { describe, expect, it } from 'vitest'

import { AUTOMATION_ACTION_KINDS } from '@/lib/automation/types'
import { FakeSupabaseClient } from '@/lib/persistence/fake-client'

import { automationServices, operationHandlers } from './automation-handlers'

const ORG = '11111111-1111-4111-8111-111111111111'

function db() {
  return new FakeSupabaseClient().asDb()
}

describe('what an automation runs with', () => {
  it('has no event bus, which is what makes a loop impossible', () => {
    // Not an oversight, and the reason it is asserted rather than only
    // commented. With a bus, an action that writes publishes an event, which
    // reaches the performing subscriber, which can reach an action that
    // writes. The ledger does not bound that — each delivery keys separately,
    // so every turn of the loop looks like new work.
    expect(automationServices(db()).events).toBeUndefined()
  })

  it('still audits and still claims an idempotency key', () => {
    // The bus is what is left out. Everything that makes the write safe and
    // recorded stays, because an automation's write is a write like any other.
    const services = automationServices(db())

    expect(services.audit).toBeDefined()
    expect(services.idempotency).toBeDefined()
    expect(services.transactions).toBeDefined()
  })
})

describe('the handler list', () => {
  const handlers = () =>
    operationHandlers(db(), { organizationId: ORG } as never, {
      name: 'booking.confirmed',
      organizationId: ORG,
      resourceType: 'booking',
      resourceId: 'bk-1',
      propertyId: null,
      actorUserId: 'user-1',
      occurredAt: '2026-09-07T09:00:00.000Z',
      correlationId: 'corr-1',
      idempotencyKey: 'evt-1',
      payload: {},
    })

  it('supplies create_task, and only create_task', () => {
    // The list is the claim about what this product can genuinely do on an
    // automation's say-so. If it grows, somebody meant it to.
    expect(handlers().map(([kind]) => kind)).toEqual(['create_task'])
  })

  it('leaves every outward-facing action to nobody', () => {
    // Not silently skipped: `executionReadiness` reports each of these by name
    // and refuses the WHOLE run, so a rule that opens a task and messages a
    // guest performs neither. A business that saw the task would assume the
    // message went too.
    const supplied = new Set(handlers().map(([kind]) => kind))
    const outward = AUTOMATION_ACTION_KINDS.filter(
      (kind) => kind !== 'create_task',
    )

    for (const kind of outward) {
      expect(supplied.has(kind)).toBe(false)
    }
  })
})
