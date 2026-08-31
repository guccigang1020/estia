/**
 * Readiness, which is the same question the engine asks, asked before the fact.
 *
 * The test that earns its place is the one about *partial* readiness. A rule
 * that notifies the team and opens a task, held by somebody who may notify and
 * may not open tasks, is neither ready nor blocked, and collapsing it into
 * either one produces a screen that lies: "blocked" hides work that would run,
 * and "ready" promises work that would not.
 */

import { describe, expect, it } from 'vitest'

import type { Actor } from '../authz/can'
import type { Grant } from '../authz/permissions'
import type { Entitlement } from '../plans/entitlements'

import { AUTOMATION_TEMPLATES, templateById } from './library'
import { READINESS_LABEL, actionReadiness, ruleReadiness } from './readiness'
import type { AutomationRule } from './types'

function actor(
  grants: readonly Grant[],
  entitlements: readonly Entitlement[] = ['core', 'automation'],
): Actor {
  return {
    userId: 'user-1',
    organizationId: 'org-1',
    membershipStatus: 'active',
    grants: new Set<Grant>(grants),
    scope: { kind: 'all_organization' },
    entitlements: new Set<Entitlement>(entitlements),
  }
}

const twoActions: AutomationRule = {
  id: 'two',
  name: 'שתי פעולות',
  description: '',
  when: 'booking.confirmed',
  conditions: [],
  actions: [
    { kind: 'notify_team', note: 'הצוות עודכן' },
    { kind: 'create_task', note: 'נפתחה משימה' },
  ],
  enabled: true,
}

describe('ruleReadiness', () => {
  it('is ready when every action would run', () => {
    const result = ruleReadiness(
      actor(
        ['message.send', 'task.create'],
        ['core', 'automation', 'operations'],
      ),
      twoActions,
    )
    expect(result.status).toBe('ready')
    expect(result.missingGrants).toEqual([])
    expect(result.missingFeatures).toEqual([])
  })

  it('is partial when one action would run and one would not', () => {
    const result = ruleReadiness(actor(['message.send']), twoActions)
    expect(result.status).toBe('partial')
    expect(result.missingGrants).toEqual(['task.create'])
    expect(result.actions.map((entry) => entry.status)).toEqual([
      'ready',
      'missing_permission',
    ])
  })

  it('is blocked when no action would run', () => {
    const result = ruleReadiness(actor([]), twoActions)
    expect(result.status).toBe('blocked')
    expect(result.missingGrants).toEqual(['message.send', 'task.create'])
  })

  it('is module_locked without the automation feature, whatever the role holds', () => {
    const result = ruleReadiness(
      actor(['message.send', 'task.create'], ['core', 'operations']),
      twoActions,
    )
    expect(result.status).toBe('module_locked')
    expect(result.missingFeatures).toContain('automation')
    // Nothing about the role is wrong, and the screen must not imply it is.
    expect(result.missingGrants).toEqual([])
  })

  it('separates a missing feature from a missing permission', () => {
    // The role carries `task.create`; the package lacks `operations`.
    const result = ruleReadiness(actor(['task.create']), {
      ...twoActions,
      actions: [{ kind: 'create_task', note: 'משימה' }],
    })

    expect(result.status).toBe('blocked')
    expect(result.missingGrants).toEqual([])
    expect(result.missingFeatures).toEqual(['operations'])
  })
})

describe('actionReadiness', () => {
  it('asks the role before the package, so nobody is sold a feature that would not help', () => {
    const result = actionReadiness(
      actor([], ['core', 'automation', 'operations']),
      {
        kind: 'create_task',
        note: 'משימה',
      },
    )
    expect(result.status).toBe('missing_permission')
  })
})

describe('the whole library, read by one persona', () => {
  it('classifies every template without throwing', () => {
    const owner = actor(
      [
        'message.send',
        'task.create',
        'approval.request',
        'payment.request_link',
        'invoice.issue',
        'hold.create',
      ],
      ['core', 'automation', 'operations', 'approvals'],
    )

    for (const entry of AUTOMATION_TEMPLATES) {
      const result = ruleReadiness(owner, entry.rule)
      expect(READINESS_LABEL[result.status]).toBeTruthy()
      expect(result.status).toBe('ready')
    }
  })

  it('reports the money rules as blocked for a housekeeper', () => {
    const cleaner = actor(['task.update'], ['core', 'automation', 'operations'])
    const invoice = templateById('deposit-paid-invoice')
    expect(ruleReadiness(cleaner, invoice!.rule).status).toBe('blocked')
  })
})
