import { describe, expect, it } from 'vitest'

import type { DomainEvent } from '../service'
import { EventQuarantine } from './quarantine'

function event(name: DomainEvent['name']): DomainEvent {
  return {
    name,
    organizationId: 'org-1',
    propertyId: null,
    correlationId: 'req-1',
    occurredAt: new Date('2026-09-06T09:00:00.000Z'),
    payload: {},
  }
}

describe('the quarantine', () => {
  it('has no way to subscribe, so nothing can ever listen', () => {
    const quarantine = new EventQuarantine()
    // Not a style point: `InMemoryEventBus` has `subscribe` and this must not,
    // because a bus that can be subscribed to is a bus that will be.
    expect('subscribe' in quarantine).toBe(false)
  })

  it('keeps every event it swallows, as evidence for the report', () => {
    const quarantine = new EventQuarantine()
    quarantine.attributeTo(412)

    return quarantine
      .publish([event('booking.created'), event('guest.created')])
      .then(() => {
        expect(quarantine.count).toBe(2)
        expect(quarantine.suppressed.map((entry) => entry.name)).toEqual([
          'booking.created',
          'guest.created',
        ])
        expect(quarantine.suppressed[0]?.rowNumber).toBe(412)
      })
  })

  it('attributes each event to the row that was being written at the time', async () => {
    const quarantine = new EventQuarantine()

    quarantine.attributeTo(2)
    await quarantine.publish([event('guest.created')])
    quarantine.attributeTo(3)
    await quarantine.publish([event('booking.created')])

    expect(quarantine.suppressed.map((entry) => entry.rowNumber)).toEqual([
      2, 3,
    ])
  })

  it('carries a Hebrew reason by default rather than an empty string', async () => {
    const quarantine = new EventQuarantine()
    await quarantine.publish([event('booking.created')])
    expect(quarantine.suppressed[0]?.reason.length).toBeGreaterThan(0)
  })
})
