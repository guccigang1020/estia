/**
 * The manual override, and the acknowledgement.
 *
 * The single property worth proving here is negative: after somebody overrules
 * a quantity, the engine's own figure is still on the item. Every other
 * assertion in this file is a consequence of that one.
 */

import { describe, expect, it } from 'vitest'

import {
  CHANGE_NOTICE,
  acknowledgeSection,
  adjustItem,
  adjustedItems,
  finalCount,
  itemOutstanding,
  needsAcknowledgement,
  unacknowledgedSections,
} from './adjustment'
import { toCleanerView } from './cleaner-view'
import { carryProgress } from './delta'
import type { PlanItem, PlanSection, WorkPlan } from './types'

function item(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: 'plan-1:towels:towels:bath_towel',
    itemId: 'bath_towel',
    label: 'מגבת רחצה',
    category: 'towels',
    unit: 'piece',
    requiredCount: 25,
    completedCount: 0,
    requiresPhoto: false,
    photoIds: [],
    instructions: null,
    minutes: 25,
    ...overrides,
  }
}

function section(overrides: Partial<PlanSection> = {}): PlanSection {
  return {
    key: 'towels',
    label: 'מגבות',
    items: [item()],
    dependsOn: [],
    status: 'new',
    minutes: 25,
    assignedToUserId: null,
    override: null,
    ...overrides,
  }
}

function plan(overrides: Partial<WorkPlan> = {}): WorkPlan {
  return {
    id: 'plan-1',
    organizationId: 'org-a',
    bookingId: 'book-1',
    propertyId: 'prop-a',
    unitId: 'unit-a',
    version: 1,
    snapshotHash: 'sha256:abc',
    createdAt: '2026-09-01T06:00:00.000Z',
    sections: [section()],
    criticalPathMinutes: 90,
    recommendedStaff: 2,
    ...overrides,
  }
}

const AT = '2026-09-02T08:00:00.000Z'

function adjusted(finalTo: number, reason = 'ספרתי במחסן') {
  return adjustItem(plan(), {
    section: 'towels',
    itemId: 'bath_towel',
    finalCount: finalTo,
    reason,
    byUserId: 'user-1',
    at: AT,
  })
}

describe('a manual adjustment keeps the calculated figure', () => {
  it('stores the difference and leaves requiredCount alone', () => {
    const next = adjusted(30)
    const changed = next.sections[0].items[0]

    // The whole point. Overwriting `requiredCount` would answer "how many
    // towels" and destroy "why", and only the second question is ever asked
    // three weeks later.
    expect(changed.requiredCount).toBe(25)
    expect(changed.adjustment).toEqual({
      delta: 5,
      reason: 'ספרתי במחסן',
      byUserId: 'user-1',
      at: AT,
    })
    expect(finalCount(changed)).toBe(30)
  })

  it('takes a negative adjustment and floors the result at zero', () => {
    const changed = adjusted(0).sections[0].items[0]

    expect(changed.requiredCount).toBe(25)
    expect(changed.adjustment?.delta).toBe(-25)
    expect(finalCount(changed)).toBe(0)
    expect(itemOutstanding(changed)).toBe(0)
  })

  it('setting the number back to the computed one removes the adjustment', () => {
    // Not "an adjustment of zero". The item goes back to reading as a plain
    // computed figure with nobody standing beside it.
    const changed = adjusted(25).sections[0].items[0]

    expect(changed.adjustment).toBeNull()
    expect(adjustedItems(adjusted(25))).toEqual([])
  })

  it('refuses an empty reason and a negative quantity', () => {
    expect(() => adjusted(30, '   ')).toThrow(/reason/i)
    expect(() =>
      adjustItem(plan(), {
        section: 'towels',
        itemId: 'bath_towel',
        finalCount: -1,
        reason: 'למה לא',
        byUserId: 'user-1',
        at: AT,
      }),
    ).toThrow()
  })

  it('refuses an item that is not in the plan rather than silently doing nothing', () => {
    expect(() =>
      adjustItem(plan(), {
        section: 'towels',
        itemId: 'nothing_like_this',
        finalCount: 3,
        reason: 'סיבה',
        byUserId: 'user-1',
        at: AT,
      }),
    ).toThrow()
  })

  it('survives a recomputation, because the person who decided it is still right', () => {
    const previous = adjusted(30)
    // The rules now say twenty-six rather than twenty-five — the booking grew
    // by a guest. The supervisor's "+5, I counted the cupboard" stands.
    const rebuilt = plan({
      sections: [section({ items: [item({ requiredCount: 26 })] })],
    })

    const carried = carryProgress(previous, rebuilt).sections[0].items[0]

    expect(carried.requiredCount).toBe(26)
    expect(carried.adjustment?.delta).toBe(5)
    expect(finalCount(carried)).toBe(31)
  })

  it('reaches the cleaner as three numbers rather than one', () => {
    const view = toCleanerView({
      plan: adjusted(30),
      propertyLabel: 'וילה',
      unitLabel: 'יחידה',
      arrivalAt: AT,
      guestCount: 25,
    })

    const line = view.sections[0].items[0]
    expect(line.calculatedCount).toBe(25)
    expect(line.adjustmentDelta).toBe(5)
    expect(line.requiredCount).toBe(30)
    expect(line.adjustmentReason).toBe('ספרתי במחסן')
  })
})

describe('acknowledgement', () => {
  it('is not asked of a section nobody has started', () => {
    // A banner on every untouched section is a banner nobody reads.
    const current = plan({ version: 3, sections: [section({ status: 'new' })] })

    expect(needsAcknowledgement(current, current.sections[0])).toBe(false)
    expect(unacknowledgedSections(current)).toEqual([])
  })

  it('is asked of a section already under way when the plan has moved', () => {
    const current = plan({
      version: 2,
      sections: [section({ status: 'in_progress' })],
    })

    expect(needsAcknowledgement(current, current.sections[0])).toBe(true)
    expect(unacknowledgedSections(current)).toEqual(['towels'])
  })

  it('is satisfied by acknowledging, and asked again after the next change', () => {
    const current = plan({
      version: 2,
      sections: [section({ status: 'in_progress' })],
    })

    const seen = acknowledgeSection(current, 'towels')
    expect(unacknowledgedSections(seen)).toEqual([])

    // A boolean would have been cleared once and never re-armed. The version
    // is what makes the notice able to come back.
    const moved = { ...seen, version: 3 }
    expect(unacknowledgedSections(moved)).toEqual(['towels'])
  })

  it('puts the sentence on the cleaner view rather than leaving it to a screen', () => {
    const current = plan({
      version: 2,
      sections: [section({ status: 'in_progress' })],
    })

    const view = toCleanerView({
      plan: current,
      propertyLabel: 'וילה',
      unitLabel: 'יחידה',
      arrivalAt: AT,
      guestCount: 25,
    })

    expect(view.changeNotice).toBe(CHANGE_NOTICE)
    expect(view.sections[0].changed).toBe(true)
  })

  it('refuses a section that is not in the plan', () => {
    expect(() => acknowledgeSection(plan(), 'pool')).toThrow()
  })
})
