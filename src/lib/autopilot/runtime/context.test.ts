/**
 * Gathering the safety engine's one record.
 *
 * The narrowings themselves are `policy/context.ts`'s and are tested there.
 * What is tested here is the part this file owns: that the grant question is
 * asked of the REAL actor through the real authorization engine, and that a
 * name the permission catalogue does not know answers no.
 */

import { describe, expect, it } from 'vitest'

import type { Actor } from '../../authz/can'
import type { Grant } from '../../authz/permissions'
import { InMemoryAutopilotPolicyRepository } from '../policy/repository'

import { gatherPolicyContext, grantsOf } from './context'

const ORG = '11111111-1111-4111-8111-111111111111'
const PROPERTY = '22222222-2222-4222-8222-222222222222'
const OWNER = '44444444-4444-4444-8444-444444444444'
const NOW = new Date('2026-09-06T09:00:00.000Z')

const OPEN_WINDOW = {
  enabled: false,
  start: '22:00',
  end: '07:00',
  timezone: 'Asia/Jerusalem',
}

function actorWith(grants: readonly Grant[]): Actor {
  return {
    userId: OWNER,
    organizationId: ORG,
    membershipStatus: 'active',
    grants: new Set<Grant>(grants),
    scope: { kind: 'all_organization' },
    entitlements: new Set(['operations']),
  }
}

describe('holdsGrant', () => {
  it('answers from the acting identity, not from a list of its own', () => {
    const holds = grantsOf(actorWith(['task.assign']))

    expect(holds('task.assign')).toBe(true)
    expect(holds('payment.refund')).toBe(false)
  })

  it('refuses a grant name the catalogue does not have', () => {
    const holds = grantsOf(actorWith(['task.assign']))

    // Fail closed. An unrecognised string being read as permission is the one
    // direction this must never fail in.
    expect(holds('task.assign.please')).toBe(false)
    expect(holds('')).toBe(false)
  })
})

describe('gathering', () => {
  it('carries the actor’s entitlements rather than re-reading the plan', async () => {
    const repository = new InMemoryAutopilotPolicyRepository()

    const { context } = await gatherPolicyContext(repository, {
      organizationId: ORG,
      propertyId: null,
      bookingId: null,
      actor: actorWith(['task.create']),
      quietWindow: OPEN_WINDOW,
      now: NOW,
    })

    expect(context.entitlements).toEqual(['operations'])
    expect(context.holdsGrant('task.create')).toBe(true)
  })

  it('falls back to off and simulating when nothing has been saved', async () => {
    const repository = new InMemoryAutopilotPolicyRepository()

    const { context, settings } = await gatherPolicyContext(repository, {
      organizationId: ORG,
      propertyId: null,
      bookingId: null,
      actor: actorWith([]),
      quietWindow: OPEN_WINDOW,
      now: NOW,
    })

    // A customer whose entitlement was granted this morning must not wake up
    // to messages having been sent overnight.
    expect(context.level).toBe('off')
    expect(context.runMode).toBe('simulation')
    expect(settings.lookaheadHours).toBe(72)
  })

  it('applies the property’s own level as a narrowing', async () => {
    const repository = new InMemoryAutopilotPolicyRepository()
    repository.settings.set(ORG, {
      organizationId: ORG,
      level: 'autopilot',
      runMode: 'live',
      enabled: true,
      pausedUntil: null,
      pausedReason: null,
      lookaheadHours: 24,
    })
    repository.propertyLevels.push({
      propertyId: PROPERTY,
      organizationId: ORG,
      level: 'advisory',
    })

    const { context } = await gatherPolicyContext(repository, {
      organizationId: ORG,
      propertyId: PROPERTY,
      bookingId: null,
      actor: actorWith([]),
      quietWindow: OPEN_WINDOW,
      now: NOW,
    })

    expect(context.level).toBe('advisory')
  })

  it('reads the quiet window as an already-answered boolean', async () => {
    const repository = new InMemoryAutopilotPolicyRepository()

    const { context } = await gatherPolicyContext(repository, {
      organizationId: ORG,
      propertyId: null,
      bookingId: null,
      actor: actorWith([]),
      quietWindow: { ...OPEN_WINDOW, enabled: true },
      // 09:00 UTC is noon in Jerusalem, which is outside 22:00–07:00.
      now: NOW,
    })

    expect(context.inQuietHours).toBe(false)
  })
})
