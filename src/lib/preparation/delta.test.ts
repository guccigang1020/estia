/**
 * What changed, said out loud.
 *
 * The case the specification names: twenty-five guests become thirty, and the
 * answer is "+5 mattresses, +5 pillows, +5 sheets, +5 towels" rather than a
 * quietly larger plan. The mirror case matters just as much — a party that
 * shrinks must produce removals, and a conditional rule that stops firing must
 * disappear rather than linger at its old count.
 */

import { describe, expect, it } from 'vitest'
import { estimateStaffing } from './complexity'
import {
  carryProgress,
  computeDelta,
  describeDelta,
  versionPlan,
} from './delta'
import { computeRequirements, templateSections } from './requirements'
import { captureSnapshot } from './snapshot'
import { buildWorkPlan, recordProgress } from './work-plan'
import type { PreparationBooking, PreparationSnapshot, WorkPlan } from './types'
import {
  exampleBooking,
  exampleCatalogue,
} from './testing/example-configuration'

const CAPTURED_AT = '2026-08-27T08:00:00.000Z'
const CHANGED_AT = '2026-09-01T11:00:00.000Z'
const SUPERVISOR = 'user-michal'

const SNAPSHOT: PreparationSnapshot = captureSnapshot({
  catalogue: exampleCatalogue(),
  booking: exampleBooking(),
  capturedAt: CAPTURED_AT,
})

/** Always the same snapshot — this file is about the booking changing. */
function build(guests: number, version = 1): WorkPlan {
  const booking: PreparationBooking = exampleBooking({ guests })
  const { facts, requirements } = computeRequirements(booking, SNAPSHOT)

  return buildWorkPlan({
    id: 'plan-1',
    booking,
    snapshot: SNAPSHOT,
    requirements,
    staffing: estimateStaffing({
      facts,
      configuration: SNAPSHOT.complexity,
      extraItems: booking.extras.length,
    }),
    extraSections: templateSections(SNAPSHOT, booking.eventType),
    version,
    createdAt: CAPTURED_AT,
  })
}

function changeOf(delta: ReturnType<typeof computeDelta>, itemId: string) {
  return [...delta.added, ...delta.removed].find(
    (change) => change.itemId === itemId,
  )
}

// ── Growth ────────────────────────────────────────────────────────────────

describe('twenty-five guests becoming thirty', () => {
  const delta = computeDelta(build(25), build(30, 2))

  it('adds five mattresses, five pillows, five sheets and five towels', () => {
    expect(changeOf(delta, 'floor_mattress')?.delta).toBe(5)
    expect(changeOf(delta, 'pillow')?.delta).toBe(5)
    expect(changeOf(delta, 'single_fitted_sheet')?.delta).toBe(5)
    expect(changeOf(delta, 'bath_towel')?.delta).toBe(5)
  })

  it('carries the before and after, not only the difference', () => {
    expect(changeOf(delta, 'pillow')).toMatchObject({
      from: 25,
      to: 30,
      delta: 5,
    })
  })

  it('moves a per-couple rule by its own arithmetic, not by the guest count', () => {
    // Thirteen hand towels for twenty-five, fifteen for thirty.
    expect(changeOf(delta, 'hand_towel')?.delta).toBe(2)
  })

  it('leaves the rules that did not move alone', () => {
    expect(changeOf(delta, 'table')).toBeUndefined()
    expect(changeOf(delta, 'urn')).toBeUndefined()
    expect(delta.unchanged).toBeGreaterThan(0)
  })

  it('records the version it moved between', () => {
    expect(delta.fromVersion).toBe(1)
    expect(delta.toVersion).toBe(2)
  })

  it('names the sections whose work changed', () => {
    expect(delta.affectedSections).toContain('extra_sleeping')
    expect(delta.affectedSections).toContain('towels')
    expect(delta.affectedSections).not.toContain('bedrooms')
  })

  it('reads as a sentence a person can act on', () => {
    const sentence = describeDelta(delta)

    expect(sentence).toContain('+5 מזרן רצפה')
    expect(sentence).toContain('+5 כרית')
  })
})

// ── Shrinkage ─────────────────────────────────────────────────────────────

describe('twenty-five guests becoming twenty', () => {
  const delta = computeDelta(build(25), build(20, 2))

  it('removes rather than silently keeping the larger numbers', () => {
    expect(changeOf(delta, 'floor_mattress')?.delta).toBe(-5)
    expect(changeOf(delta, 'pillow')?.delta).toBe(-5)
    expect(changeOf(delta, 'plate')?.delta).toBe(-6)
    expect(delta.added).toEqual([])
  })

  it('drops a conditional rule that has stopped firing, to zero', () => {
    // Two cleaning staff were required at twenty-five and above.
    expect(changeOf(delta, 'cleaning_staff')).toMatchObject({
      from: 2,
      to: 0,
      delta: -2,
    })
  })

  it('keeps a conditional rule whose threshold is still met', () => {
    // The second urn fires from twenty guests. Twenty is still twenty.
    expect(changeOf(delta, 'urn')).toBeUndefined()
  })

  it('signs the removals in the sentence', () => {
    expect(describeDelta(computeDelta(build(25), build(20, 2)))).toContain('−5')
  })
})

// ── No change ─────────────────────────────────────────────────────────────

describe('a recomputation with nothing to report', () => {
  it('reports no change rather than churn', () => {
    const delta = computeDelta(build(25), build(25, 2))

    expect(delta.added).toEqual([])
    expect(delta.removed).toEqual([])
    expect(describeDelta(delta)).toBe('ללא שינוי בכמויות')
  })
})

// ── Notification ──────────────────────────────────────────────────────────

describe('who gets told', () => {
  it('is whoever is already working an affected section', () => {
    const previous = build(25)
    const assigned: WorkPlan = {
      ...previous,
      sections: previous.sections.map((section) =>
        section.key === 'extra_sleeping'
          ? { ...section, assignedToUserId: 'user-yossi' }
          : section.key === 'kitchen'
            ? { ...section, assignedToUserId: 'user-rina' }
            : section,
      ),
    }

    const delta = computeDelta(assigned, build(30, 2))

    expect(delta.notifyUserIds).toContain('user-yossi')
  })

  it('is nobody when nobody has been assigned yet', () => {
    expect(computeDelta(build(25), build(30, 2)).notifyUserIds).toEqual([])
  })
})

// ── Progress survives ─────────────────────────────────────────────────────

describe('recomputing under a working cleaner', () => {
  it('keeps the ticks they have already made', () => {
    const previous = recordProgress(build(25), {
      section: 'towels',
      itemId: 'bath_towel',
      completedCount: 18,
    })

    const carried = carryProgress(previous, build(30, 2))
    const towel = carried.sections
      .find((section) => section.key === 'towels')
      ?.items.find((item) => item.itemId === 'bath_towel')

    expect(towel?.completedCount).toBe(18)
    expect(towel?.requiredCount).toBe(30)
  })

  it('clamps a count to a requirement that shrank', () => {
    const previous = recordProgress(build(25), {
      section: 'extra_sleeping',
      itemId: 'floor_mattress',
      completedCount: 15,
    })

    const carried = carryProgress(previous, build(20, 2))
    const mattress = carried.sections
      .find((section) => section.key === 'extra_sleeping')
      ?.items.find((item) => item.itemId === 'floor_mattress')

    expect(mattress?.completedCount).toBe(10)
    expect(mattress?.requiredCount).toBe(10)
  })

  it('reopens a section that was complete and has grown', () => {
    const previous = build(25)
    const closed: WorkPlan = {
      ...previous,
      sections: previous.sections.map((section) =>
        section.key === 'extra_sleeping'
          ? {
              ...section,
              status: 'completed' as const,
              items: section.items.map((item) => ({
                ...item,
                completedCount: item.requiredCount,
              })),
            }
          : section,
      ),
    }

    const carried = carryProgress(closed, build(30, 2))

    expect(
      carried.sections.find((section) => section.key === 'extra_sleeping')
        ?.status,
    ).toBe('in_progress')
  })
})

// ── Versioning ────────────────────────────────────────────────────────────

describe('versioning', () => {
  it('assigns the next version and the delta together', () => {
    const version = versionPlan({
      previous: build(25),
      rebuilt: build(30),
      changedByUserId: SUPERVISOR,
      changedAt: CHANGED_AT,
      reason: 'האורחים הוסיפו חמישה',
    })

    expect(version.plan.version).toBe(2)
    expect(version.supersedesVersion).toBe(1)
    expect(version.delta.fromVersion).toBe(1)
    expect(version.delta.toVersion).toBe(2)
    expect(version.changedByUserId).toBe(SUPERVISOR)
    expect(version.reason).toBe('האורחים הוסיפו חמישה')
  })

  it('leaves the previous version untouched', () => {
    const previous = build(25)
    const before = JSON.stringify(previous)

    versionPlan({
      previous,
      rebuilt: build(30),
      changedByUserId: SUPERVISOR,
      changedAt: CHANGED_AT,
    })

    expect(JSON.stringify(previous)).toBe(before)
  })
})
