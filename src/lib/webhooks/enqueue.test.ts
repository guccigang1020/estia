import { describe, expect, it } from 'vitest'

import type { DomainEvent } from '../service/events'
import { planDeliveries, planDeliveriesForBatch } from './enqueue'
import type { WebhookEndpoint } from './types'

const ORG = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-09-06T12:00:00.000Z')

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

const event = (over: Partial<DomainEvent> = {}): DomainEvent => ({
  name: 'booking.created',
  organizationId: ORG,
  propertyId: '33333333-3333-4333-8333-333333333333',
  correlationId: 'corr-1',
  occurredAt: NOW,
  payload: { bookingId: 'b-1' },
  ...over,
})

describe('one row per subscriber', () => {
  it('plans nothing when nobody subscribes', () => {
    // The overwhelmingly common case: every event in the product comes here.
    expect(planDeliveries(event(), [], NOW)).toEqual([])
  })

  it('plans one delivery per subscribing endpoint', () => {
    const endpoints = [
      endpoint({ id: 'a' }),
      endpoint({ id: 'b' }),
      endpoint({ id: 'c', events: ['task.overdue'] }),
    ]
    const planned = planDeliveries(event(), endpoints, NOW)
    expect(planned.map((d) => d.endpointId)).toEqual(['a', 'b'])
  })

  it('gives each subscriber its own row, not a shared one', () => {
    // A shared row means one slow receiver holds up two fast ones, and a
    // retry re-sends to endpoints that already answered 200.
    const planned = planDeliveries(
      event(),
      [endpoint({ id: 'a' }), endpoint({ id: 'b' })],
      NOW,
    )
    expect(planned).toHaveLength(2)
    expect(new Set(planned.map((d) => d.endpointId)).size).toBe(2)
  })

  it('carries the event through without enriching it', () => {
    const planned = planDeliveries(event(), [endpoint()], NOW)
    expect(planned[0]).toEqual({
      organizationId: ORG,
      endpointId: 'wh-1',
      eventName: 'booking.created',
      eventPayload: { bookingId: 'b-1' },
      propertyId: '33333333-3333-4333-8333-333333333333',
      correlationId: 'corr-1',
      nextAttemptAt: NOW,
    })
  })

  it('is due immediately', () => {
    // The sweep is what makes "immediately" concrete; nothing here sends.
    expect(planDeliveries(event(), [endpoint()], NOW)[0].nextAttemptAt).toEqual(
      NOW,
    )
  })
})

describe('the batch the bus actually hands over', () => {
  it('flattens, so one operation costs one insert', () => {
    const events = [
      event({ name: 'booking.created' }),
      event({ name: 'task.overdue' }),
    ]
    const endpoints = [
      endpoint({ id: 'a', events: ['booking.created', 'task.overdue'] }),
      endpoint({ id: 'b', events: ['task.overdue'] }),
    ]
    const planned = planDeliveriesForBatch(events, endpoints, NOW)
    expect(planned.map((d) => `${d.eventName}->${d.endpointId}`)).toEqual([
      'booking.created->a',
      'task.overdue->a',
      'task.overdue->b',
    ])
  })

  it('keeps the tenant boundary across a batch', () => {
    const foreign = endpoint({
      id: 'x',
      organizationId: '22222222-2222-4222-8222-222222222222',
    })
    expect(planDeliveriesForBatch([event()], [foreign], NOW)).toEqual([])
  })
})
