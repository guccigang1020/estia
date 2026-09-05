import { describe, expect, it } from 'vitest'

import { ENTITLEMENTS } from '../plans/entitlements'

import {
  ORG,
  PROPERTY,
  PROPERTY_B,
  PROPERTY_C,
  actor,
  propertyManager,
} from './testing'
import type { NotificationRecord } from './types'
import { isStillVisible, unreadCount, visibleTo } from './visibility'

function record(
  overrides: Partial<NotificationRecord> = {},
): NotificationRecord {
  return {
    id: 'n-1',
    organizationId: ORG,
    propertyId: PROPERTY,
    recipientUserId: 'user-finance_manager',
    eventName: 'payment.failed',
    category: 'money',
    severity: 'urgent',
    resourceType: 'payment',
    resourceId: 'pay-1',
    title: 'תשלום נכשל',
    body: 'חיוב לא עבר.',
    actionHref: '/finance',
    requiredGrant: 'payment.view',
    dedupeKey: 'k1',
    correlationId: 'corr-1',
    occurredAt: new Date('2026-03-11T10:00:00.000Z'),
    escalatedFrom: null,
    escalationLevel: 0,
    readAt: null,
    dismissedAt: null,
    actedAt: null,
    createdAt: new Date('2026-03-11T10:00:00.000Z'),
    ...overrides,
  }
}

describe('the grant is re-checked at display time', () => {
  it('shows the alert to somebody who still holds the grant', () => {
    expect(isStillVisible(actor('finance_manager'), record())).toBe(true)
  })

  it('hides yesterday alert from somebody whose role was narrowed today', () => {
    // The row is genuinely theirs — same user id, same organization — and the
    // right behind it is gone. `has_permission` in the policy cannot answer
    // this, because it knows nothing of plan entitlements; the real engine can.
    const demoted = actor('cleaner', { userId: 'user-finance_manager' })
    expect(isStillVisible(demoted, record())).toBe(false)
  })

  it('hides it when the plan stopped including the module', () => {
    const withoutLaundry = actor('operations_manager', {
      userId: 'user-ops',
      entitlements: ENTITLEMENTS.filter((e) => e !== 'laundry'),
    })

    const laundry = record({
      recipientUserId: 'user-ops',
      eventName: 'laundry.deadline_risk',
      category: 'operations',
      requiredGrant: 'laundry.view',
    })

    expect(isStillVisible(withoutLaundry, laundry)).toBe(false)
  })
})

describe('scope is re-checked too', () => {
  it('hides an alert about a property the person no longer holds', () => {
    const narrowed = propertyManager([PROPERTY, PROPERTY_B])

    const onC = record({
      recipientUserId: narrowed.userId,
      eventName: 'task.overdue',
      category: 'operations',
      requiredGrant: 'task.view',
      propertyId: PROPERTY_C,
    })

    expect(isStillVisible(narrowed, onC)).toBe(false)

    const onB = record({ ...onC, propertyId: PROPERTY_B })
    expect(isStillVisible(narrowed, onB)).toBe(true)
  })
})

describe('the row has to be yours', () => {
  it('refuses somebody else notification even with the grant', () => {
    const other = actor('finance_manager', { userId: 'somebody-else' })
    expect(isStillVisible(other, record())).toBe(false)
  })

  it('refuses across organizations', () => {
    const elsewhere = actor('finance_manager', {
      organizationId: '99999999-9999-4999-8999-999999999999',
    })
    expect(isStillVisible(elsewhere, record())).toBe(false)
  })
})

describe('a row with no grant recorded', () => {
  it('stays visible to its own recipient', () => {
    // Written by something that stated no grant, or predating the catalogue
    // entry. Refusing it would hide history for a reason nobody can explain.
    const owner = actor('organization_owner', { userId: 'user-owner' })
    const personal = record({
      recipientUserId: 'user-owner',
      eventName: 'security.new_device_login',
      category: 'security',
      propertyId: null,
      requiredGrant: null,
    })

    expect(isStillVisible(owner, personal)).toBe(true)
  })
})

describe('filtering a fetched inbox', () => {
  it('drops what is no longer readable and keeps the rest', () => {
    const finance = actor('finance_manager')

    const rows = [
      record({ id: 'a' }),
      record({ id: 'b', recipientUserId: 'somebody-else', dedupeKey: 'k2' }),
      record({ id: 'c', dedupeKey: 'k3' }),
    ]

    expect(visibleTo(finance, rows).map((row) => row.id)).toEqual(['a', 'c'])
  })
})

describe('the badge', () => {
  it('counts what is neither read nor dismissed', () => {
    const rows = [
      record({ id: 'a' }),
      record({ id: 'b', readAt: new Date() }),
      record({ id: 'c', dismissedAt: new Date() }),
      record({ id: 'd' }),
    ]

    expect(unreadCount(rows)).toBe(2)
  })

  it('is zero rather than a fabricated number when there is nothing', () => {
    expect(unreadCount([])).toBe(0)
  })
})
