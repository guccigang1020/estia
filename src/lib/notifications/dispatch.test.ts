import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from './dispatch'
import { InMemoryNotificationRepository } from './repository'
import { route } from './routing'
import { NOW, actor, event, settings } from './testing'
import {
  NullTransport,
  TransportRegistry,
  type NotificationTransport,
  type TransportResult,
} from './transport'
import type { NotificationChannel } from './types'

let repository: InMemoryNotificationRepository

beforeEach(() => {
  repository = new InMemoryNotificationRepository()
})

const finance = actor('finance_manager')

function planFor(
  transports: TransportRegistry,
  channels: readonly NotificationChannel[] = ['in_app'],
) {
  return route({
    event: event('payment.failed', {
      resourceType: 'payment',
      resourceId: 'pay-1',
      idempotencyKey: 'stripe-evt-77',
    }),
    settings: settings({ enabledChannels: [...channels] }),
    candidates: [{ actor: finance, preferences: [] }],
    transports,
    now: NOW,
  })
}

describe('in-app delivery, end to end', () => {
  it('writes the notification and settles the in-app delivery', async () => {
    const transports = new TransportRegistry()
    const outcome = await dispatch({
      plan: planFor(transports),
      repository,
      transports,
      now: NOW,
    })

    expect(outcome.created).toHaveLength(1)
    expect(outcome.tally.delivered).toBe(1)

    // The row is the delivery: there is nothing in flight and nothing to wait
    // for, which is why in-app reports `delivered` rather than `sent`.
    expect(repository.deliveries[0]).toMatchObject({
      channel: 'in_app',
      status: 'delivered',
      provider: 'estia_in_app',
    })
    expect(repository.deliveries[0].settledAt).toEqual(NOW)
  })

  it('puts it in the recipient inbox and nobody else', async () => {
    const transports = new TransportRegistry()
    await dispatch({
      plan: planFor(transports),
      repository,
      transports,
      now: NOW,
    })

    const mine = await repository.listInbox(
      finance.organizationId,
      finance.userId,
    )
    const theirs = await repository.listInbox(
      finance.organizationId,
      'somebody-else',
    )

    expect(mine).toHaveLength(1)
    expect(mine[0].title).toBe('תשלום נכשל')
    expect(theirs).toHaveLength(0)
  })
})

describe('idempotency — a retried handler does not re-notify', () => {
  it('creates one notification and one set of deliveries for the same event twice', async () => {
    const transports = new TransportRegistry([new NullTransport('email')])

    const first = await dispatch({
      plan: planFor(transports, ['in_app', 'email']),
      repository,
      transports,
      now: NOW,
    })

    // The same logical event arrives again — a redelivered webhook, a retried
    // job. A NEW plan is routed, exactly as it would be in production.
    const second = await dispatch({
      plan: planFor(transports, ['in_app', 'email']),
      repository,
      transports,
      now: new Date(NOW.getTime() + 90_000),
    })

    expect(first.created).toHaveLength(1)
    expect(second.created).toHaveLength(0)
    expect(second.duplicates).toBe(1)

    expect(repository.notifications).toHaveLength(1)
    // Two channels, written once. The second pass wrote no deliveries at all,
    // which is the guarantee: deliveries are written only for a notification
    // this call created.
    expect(repository.deliveries).toHaveLength(2)
  })

  it('does re-notify for a genuinely different event', async () => {
    const transports = new TransportRegistry()

    await dispatch({
      plan: planFor(transports),
      repository,
      transports,
      now: NOW,
    })

    const different = route({
      event: event('payment.failed', {
        resourceType: 'payment',
        resourceId: 'pay-2',
        idempotencyKey: 'stripe-evt-78',
      }),
      settings: settings(),
      candidates: [{ actor: finance, preferences: [] }],
      transports,
      now: NOW,
    })

    const outcome = await dispatch({
      plan: different,
      repository,
      transports,
      now: NOW,
    })

    expect(outcome.created).toHaveLength(1)
    expect(repository.notifications).toHaveLength(2)
  })
})

describe('the absent transport', () => {
  it('records not_configured and attempts nothing', async () => {
    const transports = new TransportRegistry([
      new NullTransport('email'),
      new NullTransport('sms'),
    ])

    const outcome = await dispatch({
      plan: planFor(transports, ['in_app', 'email', 'sms']),
      repository,
      transports,
      now: NOW,
    })

    expect(outcome.tally.not_configured).toBe(2)
    expect(outcome.tally.delivered).toBe(1)

    const email = repository.deliveries.find((d) => d.channel === 'email')
    expect(email?.status).toBe('not_configured')
    // Nothing was attempted, so there is no attempt time. A timestamp here
    // would make an empty channel look like a channel that tried.
    expect(email?.attemptedAt).toBeNull()
    expect(email?.provider).toBeNull()
  })
})

describe('a transport that misbehaves', () => {
  it('cannot break the operation that raised the event', async () => {
    class ThrowingTransport implements NotificationTransport {
      readonly channel = 'email' as const
      readonly configured = true
      async send(): Promise<TransportResult> {
        throw new Error('SMTP connection reset')
      }
    }

    const transports = new TransportRegistry([new ThrowingTransport()])

    // No rejection. The port forbids throwing; this proves the promise is kept
    // for a transport that breaks it, which is the point of catching at all.
    const outcome = await dispatch({
      plan: planFor(transports, ['in_app', 'email']),
      repository,
      transports,
      now: NOW,
    })

    expect(outcome.created).toHaveLength(1)
    expect(outcome.tally.failed).toBe(1)

    const email = repository.deliveries.find((d) => d.channel === 'email')
    expect(email).toMatchObject({
      status: 'failed',
      errorCode: 'transport_threw',
    })
    expect(email?.errorDetail).toContain('SMTP connection reset')
  })
})
