import { describe, expect, it } from 'vitest'

import { escalationsDue } from './escalation'
import { ORG } from './testing'
import type { EscalationRule, NotificationRecord } from './types'

const RAISED = new Date('2026-03-11T02:00:00.000Z')

function notification(
  overrides: Partial<NotificationRecord> = {},
): NotificationRecord {
  return {
    id: 'n-1',
    organizationId: ORG,
    propertyId: null,
    recipientUserId: 'user-reception',
    eventName: 'payment.outcome_unknown',
    category: 'money',
    severity: 'critical',
    resourceType: 'payment',
    resourceId: 'pay-1',
    title: 'תוצאת תשלום לא ידועה',
    body: 'הסולק לא ענה.',
    actionHref: '/finance',
    requiredGrant: 'payment.view',
    dedupeKey: 'k1',
    correlationId: 'corr-1',
    occurredAt: RAISED,
    escalatedFrom: null,
    escalationLevel: 0,
    readAt: null,
    dismissedAt: null,
    actedAt: null,
    createdAt: RAISED,
    ...overrides,
  }
}

function rule(overrides: Partial<EscalationRule> = {}): EscalationRule {
  return {
    id: 'r-1',
    organizationId: ORG,
    eventName: null,
    minSeverity: 'urgent',
    afterMinutes: 30,
    escalateToRoleCode: 'general_manager',
    maxLevel: 2,
    enabled: true,
    ...overrides,
  }
}

const settings = { defaultEscalationMinutes: 30 }
const at = (minutes: number) => new Date(RAISED.getTime() + minutes * 60_000)

describe('escalation reads actedAt, never readAt', () => {
  it('escalates a notification somebody merely opened', () => {
    // 02:04: the clerk woke up, looked at the bell, and went back to sleep.
    // The payment is still unreconciled, and a rule keyed on `readAt` would
    // fall silent at exactly the moment it was most needed.
    const due = escalationsDue({
      notifications: [notification({ readAt: at(4) })],
      rules: [rule()],
      settings,
      now: at(31),
    })

    expect(due).toHaveLength(1)
    expect(due[0].roleCode).toBe('general_manager')
    expect(due[0].nextLevel).toBe(1)
  })

  it('stops the moment somebody actually acts', () => {
    const due = escalationsDue({
      notifications: [notification({ actedAt: at(10) })],
      rules: [rule()],
      settings,
      now: at(31),
    })

    expect(due).toEqual([])
  })

  it('stops when the recipient dismissed it', () => {
    const due = escalationsDue({
      notifications: [notification({ dismissedAt: at(10) })],
      rules: [rule()],
      settings,
      now: at(31),
    })

    expect(due).toEqual([])
  })
})

describe('the ladder', () => {
  it('waits the interval again for each level rather than firing them together', () => {
    const level1 = notification({ escalationLevel: 1, escalatedFrom: 'n-1' })

    // At 31 minutes level 2 is not yet due: it waits 2 × 30.
    expect(
      escalationsDue({
        notifications: [level1],
        rules: [rule()],
        settings,
        now: at(31),
      }),
    ).toEqual([])

    expect(
      escalationsDue({
        notifications: [level1],
        rules: [rule()],
        settings,
        now: at(61),
      }),
    ).toHaveLength(1)
  })

  it('stops at the rule ceiling', () => {
    const due = escalationsDue({
      notifications: [
        notification({ escalationLevel: 2, escalatedFrom: 'n-2' }),
      ],
      rules: [rule({ maxLevel: 2 })],
      settings,
      now: at(600),
    })

    expect(due).toEqual([])
  })

  it('falls back to the organization default when the rule names no interval', () => {
    const due = escalationsDue({
      notifications: [notification()],
      rules: [rule({ afterMinutes: null })],
      settings: { defaultEscalationMinutes: 45 },
      now: at(46),
    })

    expect(due[0].afterMinutes).toBe(45)
  })
})

describe('which rule applies', () => {
  it('prefers a rule naming the event over a catch-all', () => {
    const due = escalationsDue({
      notifications: [notification()],
      rules: [
        rule({ id: 'catch-all', eventName: null, afterMinutes: 30 }),
        rule({
          id: 'named',
          eventName: 'payment.outcome_unknown',
          afterMinutes: 5,
        }),
      ],
      settings,
      now: at(31),
    })

    expect(due).toHaveLength(1)
    expect(due[0].rule.id).toBe('named')
  })

  it('prefers the tighter interval among equals', () => {
    const due = escalationsDue({
      notifications: [notification()],
      rules: [
        rule({ id: 'slow', afterMinutes: 60 }),
        rule({ id: 'fast', afterMinutes: 5 }),
      ],
      settings,
      now: at(6),
    })

    expect(due[0].rule.id).toBe('fast')
  })

  it('ignores a rule whose severity floor is above the notification', () => {
    const due = escalationsDue({
      notifications: [notification({ severity: 'attention' })],
      rules: [rule({ minSeverity: 'urgent' })],
      settings,
      now: at(600),
    })

    expect(due).toEqual([])
  })

  it('ignores a disabled rule', () => {
    const due = escalationsDue({
      notifications: [notification()],
      rules: [rule({ enabled: false })],
      settings,
      now: at(600),
    })

    expect(due).toEqual([])
  })
})

describe('what is escalatable at all', () => {
  it('never escalates an event the catalogue does not mark as escalating', () => {
    // A catch-all rule would otherwise page a manager about an ordinary
    // reservation nobody was ever asked to act on.
    const due = escalationsDue({
      notifications: [
        notification({
          eventName: 'booking.created',
          category: 'booking',
          severity: 'critical',
        }),
      ],
      rules: [rule()],
      settings,
      now: at(600),
    })

    expect(due).toEqual([])
  })
})

describe('ordering', () => {
  it('puts the longest neglect first', () => {
    const older = notification({
      id: 'older',
      dedupeKey: 'k-older',
      occurredAt: new Date(RAISED.getTime() - 3_600_000),
    })

    const due = escalationsDue({
      notifications: [notification(), older],
      rules: [rule()],
      settings,
      now: at(120),
    })

    expect(due.map((entry) => entry.notification.id)).toEqual(['older', 'n-1'])
  })
})
