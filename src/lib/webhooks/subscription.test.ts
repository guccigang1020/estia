import { describe, expect, it } from 'vitest'

import type { DomainEvent } from '../service/events'
import {
  buildEnvelope,
  endpointsFor,
  matches,
  serialiseEnvelope,
} from './subscription'
import type { WebhookEndpoint } from './types'

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '22222222-2222-4222-8222-222222222222'

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
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  version: 1,
  ...over,
})

const event: DomainEvent = {
  name: 'booking.created',
  organizationId: ORG,
  propertyId: '33333333-3333-4333-8333-333333333333',
  correlationId: 'corr-1',
  occurredAt: new Date('2026-09-06T12:00:00.000Z'),
  payload: { bookingId: 'b-1', totalAgorot: 120_000 },
}

describe('who hears an event', () => {
  it('delivers to an active endpoint that subscribed', () => {
    expect(matches(endpoint(), 'booking.created')).toBe(true)
  })

  it('does not deliver an event nobody subscribed to', () => {
    expect(matches(endpoint(), 'booking.cancelled')).toBe(false)
  })

  it('treats an empty subscription as nothing, never everything', () => {
    // The other reading is the shape of accident where a half-configured
    // endpoint receives every guest's details the moment it is saved.
    expect(matches(endpoint({ events: [] }), 'booking.created')).toBe(false)
  })

  it('skips a paused or disabled endpoint', () => {
    expect(matches(endpoint({ status: 'paused' }), 'booking.created')).toBe(
      false,
    )
    expect(matches(endpoint({ status: 'disabled' }), 'booking.created')).toBe(
      false,
    )
  })
})

describe('the tenant boundary', () => {
  it('never hands one organization event to another organization endpoint', () => {
    const foreign = endpoint({ id: 'wh-2', organizationId: OTHER_ORG })
    expect(endpointsFor(event, [foreign])).toEqual([])
  })

  it('checks it even though the query already filtered', () => {
    // This is the one place where being wrong sends one tenant's booking to
    // another tenant's server, so it is asserted rather than assumed.
    const mine = endpoint()
    const theirs = endpoint({ id: 'wh-2', organizationId: OTHER_ORG })
    expect(endpointsFor(event, [mine, theirs]).map((e) => e.id)).toEqual([
      'wh-1',
    ])
  })

  it('fans out to every subscriber in the right organization', () => {
    const a = endpoint({ id: 'a' })
    const b = endpoint({ id: 'b', events: ['booking.created', 'task.overdue'] })
    const c = endpoint({ id: 'c', events: ['task.overdue'] })
    expect(endpointsFor(event, [a, b, c]).map((e) => e.id)).toEqual(['a', 'b'])
  })
})

describe('the envelope', () => {
  it('carries the event verbatim and adds nothing', () => {
    const envelope = buildEnvelope('del-1', event)
    expect(envelope).toEqual({
      id: 'del-1',
      type: 'booking.created',
      createdAt: '2026-09-06T12:00:00.000Z',
      organizationId: ORG,
      propertyId: '33333333-3333-4333-8333-333333333333',
      data: { bookingId: 'b-1', totalAgorot: 120_000 },
    })
  })

  it('does not enrich, which is the privacy control', () => {
    // Whatever a webhook can leak is bounded by what the emitting operation
    // put in the event. An enriching sender widens that with every new
    // subscriber, and no single file would decide it.
    const envelope = buildEnvelope('del-1', event)
    expect(envelope.data).toBe(event.payload)
    expect(Object.keys(envelope)).toEqual([
      'id',
      'type',
      'createdAt',
      'organizationId',
      'propertyId',
      'data',
    ])
  })

  it('uses the delivery id, so retries deduplicate', () => {
    // At-least-once is a promise, not an edge case: a 200 that never reached
    // us is indistinguishable from a timeout.
    const first = buildEnvelope('del-1', event)
    const retry = buildEnvelope('del-1', event)
    expect(retry.id).toBe(first.id)
  })

  it('serialises once, so signer and sender cannot disagree', () => {
    const envelope = buildEnvelope('del-1', event)
    const body = serialiseEnvelope(envelope)
    expect(JSON.parse(body)).toEqual(envelope)
    expect(serialiseEnvelope(envelope)).toBe(body)
  })
})
