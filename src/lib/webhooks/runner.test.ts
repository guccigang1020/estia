import { describe, expect, it } from 'vitest'

import type { WebhookSenderStore, SendableEndpoint } from './repository'
import { runOneDelivery, runWebhookSweep } from './runner'
import type { WebhookTransport } from './sender'
import type { WebhookDelivery, WebhookEndpoint } from './types'

const ORG = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-09-06T12:00:00.000Z')
const SECRET = 'a'.repeat(64)

const endpoint = (over: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({
  id: 'wh-1',
  organizationId: ORG,
  url: 'https://hooks.example.com/estia',
  description: null,
  events: ['booking.created'],
  status: 'active',
  disabledReason: null,
  consecutiveFailures: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  createdAt: NOW,
  version: 1,
  ...over,
})

const delivery = (over: Partial<WebhookDelivery> = {}): WebhookDelivery => ({
  id: 'del-1',
  organizationId: ORG,
  endpointId: 'wh-1',
  eventName: 'booking.created',
  eventPayload: { bookingId: 'b-1' },
  propertyId: null,
  correlationId: 'corr-1',
  status: 'pending',
  attempts: 0,
  nextAttemptAt: NOW,
  lastStatusCode: null,
  lastError: null,
  createdAt: NOW,
  deliveredAt: null,
  ...over,
})

interface Recorded {
  outcomes: {
    id: string
    status: string
    attempts: number
    nextAttemptAt: Date | null
  }[]
  successes: string[]
  failures: { id: string; failures: number; disable: string | null }[]
}

function store(
  sendable: SendableEndpoint | null,
  extra: Partial<WebhookSenderStore> = {},
): { store: WebhookSenderStore; recorded: Recorded } {
  const recorded: Recorded = { outcomes: [], successes: [], failures: [] }
  const fake = {
    async sendable() {
      return sendable
    },
    async recordDeliveryOutcome(
      d: WebhookDelivery,
      next: Record<string, unknown>,
    ) {
      recorded.outcomes.push({
        id: d.id,
        status: String(next.status),
        attempts: Number(next.attempts),
        nextAttemptAt: (next.nextAttemptAt as Date | null) ?? null,
      })
    },
    async recordEndpointSuccess(_org: string, id: string) {
      recorded.successes.push(id)
    },
    async recordEndpointFailure(
      _org: string,
      id: string,
      failures: number,
      _at: Date,
      disable: string | null,
    ) {
      recorded.failures.push({ id, failures, disable })
    },
    ...extra,
  } as unknown as WebhookSenderStore
  return { store: fake, recorded }
}

const transport = (
  reply: Awaited<ReturnType<WebhookTransport['post']>>,
  addresses: readonly string[] = ['93.184.216.34'],
): WebhookTransport => ({
  async resolve() {
    return addresses
  },
  async post() {
    return reply
  },
})

describe('a delivery that lands', () => {
  it('is marked delivered and clears the endpoint streak', async () => {
    const { store: s, recorded } = store({
      endpoint: endpoint({ consecutiveFailures: 7 }),
      secrets: [SECRET],
    })
    const result = await runOneDelivery(
      delivery(),
      s,
      transport({ kind: 'responded', statusCode: 200 }),
      NOW,
    )

    expect(result).toEqual({ result: 'succeeded', disabled: false })
    expect(recorded.outcomes[0]).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      nextAttemptAt: null,
    })
    // A single success wipes the streak, so a merely flaky endpoint is never
    // disabled — only one that has stopped answering entirely.
    expect(recorded.successes).toEqual(['wh-1'])
    expect(recorded.failures).toEqual([])
  })
})

describe('a delivery that will be tried again', () => {
  it('stays pending with the next attempt scheduled', async () => {
    const { store: s, recorded } = store({
      endpoint: endpoint(),
      secrets: [SECRET],
    })
    const result = await runOneDelivery(
      delivery(),
      s,
      transport({ kind: 'responded', statusCode: 503 }),
      NOW,
    )

    expect(result.result).toBe('retrying')
    expect(recorded.outcomes[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
    })
    expect(recorded.outcomes[0].nextAttemptAt).toEqual(
      new Date(NOW.getTime() + 60_000),
    )
  })

  it('leaves the endpoint streak alone while it is still being retried', async () => {
    // A delivery still being retried has not failed yet. Counting it now
    // would disable an endpoint after three bad mornings.
    const { store: s, recorded } = store({
      endpoint: endpoint(),
      secrets: [SECRET],
    })
    await runOneDelivery(
      delivery(),
      s,
      transport({ kind: 'responded', statusCode: 500 }),
      NOW,
    )
    expect(recorded.failures).toEqual([])
  })
})

describe('a delivery that gives up', () => {
  it('is exhausted and counts once against the endpoint', async () => {
    const { store: s, recorded } = store({
      endpoint: endpoint({ consecutiveFailures: 3 }),
      secrets: [SECRET],
    })
    const result = await runOneDelivery(
      delivery({ attempts: 5 }),
      s,
      transport({ kind: 'responded', statusCode: 500 }),
      NOW,
    )

    expect(result).toEqual({ result: 'exhausted', disabled: false })
    expect(recorded.outcomes[0]).toMatchObject({
      status: 'exhausted',
      attempts: 6,
    })
    expect(recorded.failures).toEqual([
      { id: 'wh-1', failures: 4, disable: null },
    ])
  })

  it('gives up at once on a permanent rejection', async () => {
    const { store: s, recorded } = store({
      endpoint: endpoint(),
      secrets: [SECRET],
    })
    const result = await runOneDelivery(
      delivery(),
      s,
      transport({ kind: 'responded', statusCode: 404 }),
      NOW,
    )
    expect(result.result).toBe('exhausted')
    expect(recorded.outcomes[0].attempts).toBe(1)
  })

  it('turns the endpoint off once the streak is long enough', async () => {
    const { store: s, recorded } = store({
      endpoint: endpoint({ consecutiveFailures: 19 }),
      secrets: [SECRET],
    })
    const result = await runOneDelivery(
      delivery(),
      s,
      transport({ kind: 'responded', statusCode: 404 }),
      NOW,
    )
    expect(result.disabled).toBe(true)
    expect(recorded.failures[0]).toEqual({
      id: 'wh-1',
      failures: 20,
      disable: 'too_many_failures',
    })
  })

  it('turns it off immediately when the receiver says 410', async () => {
    const { store: s, recorded } = store({
      endpoint: endpoint(),
      secrets: [SECRET],
    })
    const result = await runOneDelivery(
      delivery(),
      s,
      transport({ kind: 'responded', statusCode: 410 }),
      NOW,
    )
    expect(result.disabled).toBe(true)
    expect(recorded.failures[0].disable).toBe('receiver_said_gone')
  })
})

describe('blocked is not exhausted', () => {
  it('blocks when the endpoint was paused after the row was queued', async () => {
    const { store: s, recorded } = store({
      endpoint: endpoint({ status: 'paused' }),
      secrets: [SECRET],
    })
    const result = await runOneDelivery(
      delivery(),
      s,
      transport({ kind: 'responded', statusCode: 200 }),
      NOW,
    )

    expect(result).toEqual({ result: 'blocked', disabled: false })
    expect(recorded.outcomes[0].status).toBe('blocked')
    // The crucial half: no failure recorded. Counting the product's own
    // refusal would disable a customer's perfectly good endpoint.
    expect(recorded.failures).toEqual([])
  })

  it('blocks when the endpoint is gone', async () => {
    const { store: s, recorded } = store(null)
    const result = await runOneDelivery(
      delivery(),
      s,
      transport({ kind: 'responded', statusCode: 200 }),
      NOW,
    )
    expect(result.result).toBe('blocked')
    expect(recorded.failures).toEqual([])
  })

  it('blocks AND disables when the address became unsafe', async () => {
    // Not the receiver's failure, so it does not touch the streak — but it
    // will be unsafe again in five minutes, so the endpoint goes off.
    const { store: s, recorded } = store({
      endpoint: endpoint({ consecutiveFailures: 2 }),
      secrets: [SECRET],
    })
    const result = await runOneDelivery(
      delivery(),
      s,
      transport({ kind: 'responded', statusCode: 200 }, ['10.0.0.5']),
      NOW,
    )

    expect(result).toEqual({ result: 'blocked', disabled: true })
    expect(recorded.outcomes[0].status).toBe('blocked')
    expect(recorded.failures[0]).toEqual({
      id: 'wh-1',
      failures: 2,
      disable: 'address_became_unsafe',
    })
  })
})

describe('the sweep', () => {
  it('does nothing when nothing is due', async () => {
    const { store: s } = store(null, {
      async tenantsWithDueDeliveries() {
        return []
      },
    } as Partial<WebhookSenderStore>)

    const report = await runWebhookSweep(
      s,
      transport({ kind: 'responded', statusCode: 200 }),
      NOW,
    )
    expect(report.tenants).toBe(0)
    expect(report.attempted).toBe(0)
  })

  it('takes one pass per tenant and counts the outcomes', async () => {
    const { store: s, recorded } = store(
      { endpoint: endpoint(), secrets: [SECRET] },
      {
        async tenantsWithDueDeliveries() {
          return [ORG]
        },
        async dueDeliveries() {
          return [delivery({ id: 'a' }), delivery({ id: 'b' })]
        },
      } as Partial<WebhookSenderStore>,
    )

    const report = await runWebhookSweep(
      s,
      transport({ kind: 'responded', statusCode: 200 }),
      NOW,
    )
    expect(report).toMatchObject({ tenants: 1, attempted: 2, succeeded: 2 })
    expect(recorded.outcomes.map((o) => o.id)).toEqual(['a', 'b'])
  })

  it('names a failing tenant and keeps going for the rest', async () => {
    // One organization with an unreadable row must not stop every other
    // organization's webhooks for the day.
    const OTHER = '22222222-2222-4222-8222-222222222222'
    const { store: s } = store({ endpoint: endpoint(), secrets: [SECRET] }, {
      async tenantsWithDueDeliveries() {
        return [ORG, OTHER]
      },
      async dueDeliveries(organizationId: string) {
        if (organizationId === ORG) throw new Error('unreadable')
        return [delivery({ id: 'b' })]
      },
    } as Partial<WebhookSenderStore>)

    const report = await runWebhookSweep(
      s,
      transport({ kind: 'responded', statusCode: 200 }),
      NOW,
    )
    expect(report.failedTenants).toEqual([ORG])
    expect(report.succeeded).toBe(1)
  })
})
