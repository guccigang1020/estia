import { describe, expect, it } from 'vitest'

import {
  connectorHealth,
  describeAge,
  fleetHealth,
  type HealthInput,
} from './health'
import { aConnector } from './testing'
import type { SyncStatus } from './types'

const NOW = new Date('2026-03-01T12:00:00Z')

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000)
}

function input(patch: Partial<HealthInput> = {}): HealthInput {
  return {
    connector: aConnector({
      lastInboundSyncAt: minutesAgo(5),
      lastOutboundSyncAt: minutesAgo(5),
    }),
    pendingOutbound: 0,
    recentFailures: 0,
    failedEntities: [],
    openExceptions: 0,
    now: NOW,
    ...patch,
  }
}

describe('silence is a finding', () => {
  it('is healthy when both directions ran recently and nothing is queued', () => {
    const status = connectorHealth(input())
    expect(status.state).toBe('healthy')
    expect(status.concerns).toEqual([])
  })

  it('degrades on an outbound sync that has not run, with no error present', () => {
    // The dangerous case: nothing failed, nothing is logged, and nights that
    // are gone are still on sale.
    const status = connectorHealth(
      input({
        connector: aConnector({
          lastInboundSyncAt: minutesAgo(5),
          lastOutboundSyncAt: minutesAgo(240),
        }),
      }),
    )

    expect(status.state).toBe('degraded')
    expect(status.concerns[0]).toContain('זמינות')
  })

  it('holds outbound to a tighter threshold than inbound', () => {
    const stale = connectorHealth(
      input({
        connector: aConnector({
          lastInboundSyncAt: minutesAgo(45),
          lastOutboundSyncAt: minutesAgo(45),
        }),
      }),
    )

    // 45 minutes is past the outbound threshold and inside the inbound one.
    expect(stale.concerns).toHaveLength(1)
  })

  it('notices a channel that has stopped calling', () => {
    const status = connectorHealth(
      input({
        connector: aConnector({
          capabilities: ['receive_webhooks'],
          lastInboundSyncAt: minutesAgo(5),
          lastOutboundSyncAt: minutesAgo(5),
          lastWebhookAt: minutesAgo(600),
        }),
      }),
    )

    expect(status.concerns.some((line) => line.includes('יזום'))).toBe(true)
  })

  it('says nothing about webhooks for a connector that does not receive them', () => {
    const status = connectorHealth(
      input({
        connector: aConnector({
          lastInboundSyncAt: minutesAgo(5),
          lastOutboundSyncAt: minutesAgo(5),
          lastWebhookAt: minutesAgo(600),
        }),
      }),
    )

    expect(status.state).toBe('healthy')
  })
})

describe('the states', () => {
  it('never_synced is not a failure', () => {
    const status = connectorHealth(
      input({ connector: aConnector({ state: 'connecting' }) }),
    )
    expect(status.state).toBe('never_synced')
  })

  it('a paused connector is stopped, not failing', () => {
    // Rendering an off connector red teaches people that red means nothing.
    const status = connectorHealth(
      input({
        connector: aConnector({ state: 'paused' }),
        recentFailures: 9,
      }),
    )

    expect(status.state).toBe('stopped')
  })

  it('a disconnected connector says the channel did it', () => {
    const status = connectorHealth(
      input({ connector: aConnector({ state: 'disconnected' }) }),
    )
    expect(status.state).toBe('stopped')
    expect(status.concerns[0]).toContain('הערוץ ניתק')
  })

  it('an expired credential is failing, whatever else is true', () => {
    const status = connectorHealth(
      input({
        connector: aConnector({
          lastInboundSyncAt: minutesAgo(1),
          lastOutboundSyncAt: minutesAgo(1),
          credentialsExpireAt: minutesAgo(10),
        }),
      }),
    )

    expect(status.state).toBe('failing')
  })

  it('warns before a credential expires', () => {
    const status = connectorHealth(
      input({
        connector: aConnector({
          lastInboundSyncAt: minutesAgo(1),
          lastOutboundSyncAt: minutesAgo(1),
          credentialsExpireAt: new Date('2026-03-04T12:00:00Z'),
        }),
      }),
    )

    expect(status.state).toBe('degraded')
    expect(status.concerns[0]).toContain('2026-03-04')
  })

  it('fails after enough failures, and only degrades before that', () => {
    expect(connectorHealth(input({ recentFailures: 2 })).state).toBe('degraded')
    expect(connectorHealth(input({ recentFailures: 3 })).state).toBe('failing')
  })

  it('respects an overridden threshold', () => {
    const status = connectorHealth(
      input({ recentFailures: 2, thresholds: { failureThreshold: 2 } }),
    )
    expect(status.state).toBe('failing')
  })

  it('fails on a connector that answered unreachable', () => {
    const status = connectorHealth(
      input({
        probe: {
          reachable: false,
          channelLastSeenAt: null,
          credentialsExpireAt: null,
          notes: ['אין חיבור פעיל.'],
        },
      }),
    )

    expect(status.state).toBe('failing')
    expect(status.concerns).toContain('אין חיבור פעיל.')
  })

  it('does not fail merely because nobody probed', () => {
    expect(connectorHealth(input({ probe: null })).state).toBe('healthy')
  })
})

describe('queues and exceptions', () => {
  it('reports a queue that is not draining', () => {
    const status = connectorHealth(input({ pendingOutbound: 40 }))
    expect(status.state).toBe('degraded')
    expect(status.concerns[0]).toContain('40')
  })

  it('names the first few failed entities and says there are more', () => {
    const status = connectorHealth(
      input({
        recentFailures: 1,
        failedEntities: ['a', 'b', 'c', 'd', 'e', 'f'],
      }),
    )

    expect(status.concerns[0]).toContain('ועוד')
  })

  it('counts open exceptions as a concern', () => {
    const status = connectorHealth(input({ openExceptions: 3 }))
    expect(status.state).toBe('degraded')
    expect(status.openExceptions).toBe(3)
  })
})

describe('the fleet', () => {
  const status = (state: SyncStatus['state'], open = 0): SyncStatus => ({
    connectorId: `c-${state}`,
    channelCode: 'booking_com',
    state,
    lastInboundSyncAt: null,
    lastOutboundSyncAt: null,
    lastWebhookAt: null,
    pendingOutbound: 0,
    recentFailures: 0,
    failedEntities: [],
    credentialsExpireAt: null,
    openExceptions: open,
    concerns: [],
  })

  it('reports the worst state, never an average', () => {
    const fleet = fleetHealth([
      status('healthy'),
      status('healthy'),
      status('healthy'),
      status('failing'),
    ])

    expect(fleet.worst).toBe('failing')
    expect(fleet.healthy).toBe(3)
  })

  it('falls back through degraded and never_synced', () => {
    expect(fleetHealth([status('healthy'), status('degraded')]).worst).toBe(
      'degraded',
    )
    expect(fleetHealth([status('healthy'), status('never_synced')]).worst).toBe(
      'never_synced',
    )
  })

  it('is stopped only when nothing is running at all', () => {
    expect(fleetHealth([status('stopped')]).worst).toBe('stopped')
    expect(fleetHealth([status('stopped'), status('healthy')]).worst).toBe(
      'healthy',
    )
  })

  it('totals the open exceptions across channels', () => {
    const fleet = fleetHealth([status('healthy', 2), status('degraded', 3)])
    expect(fleet.totalOpenExceptions).toBe(5)
    expect(fleet.connectors).toBe(2)
  })
})

describe('describing an age in Hebrew', () => {
  it('rounds the way a person would say it', () => {
    expect(describeAge(0)).toBe('פחות מדקה')
    expect(describeAge(20)).toBe('20 דקות')
    expect(describeAge(60)).toBe('שעה')
    expect(describeAge(180)).toBe('3 שעות')
    expect(describeAge(1440)).toBe('יום')
    expect(describeAge(4320)).toBe('3 ימים')
  })
})
