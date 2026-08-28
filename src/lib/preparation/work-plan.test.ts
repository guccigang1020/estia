/**
 * The plan a person works from.
 *
 * The claims: sections rather than one list, a count on every item, order that
 * is enforced rather than suggested, a critical path that answers "can this be
 * done by four o'clock", and an override that is possible, audited and never
 * silent.
 */

import { describe, expect, it } from 'vitest'
import { isAppError } from '../errors'
import { estimateStaffing } from './complexity'
import { computeRequirements, templateSections } from './requirements'
import { captureSnapshot } from './snapshot'
import {
  assessTurnover,
  buildWorkPlan,
  completeSection,
  criticalPath,
  outstandingItems,
  recordProgress,
} from './work-plan'
import type { PlanSectionKey, PreparationBooking, WorkPlan } from './types'
import {
  exampleBooking,
  exampleCatalogue,
} from './testing/example-configuration'

const CAPTURED_AT = '2026-08-27T08:00:00.000Z'
const PLAN_ID = 'plan-1'

function build(booking: PreparationBooking = exampleBooking()): WorkPlan {
  const snapshot = captureSnapshot({
    catalogue: exampleCatalogue(),
    booking,
    capturedAt: CAPTURED_AT,
  })
  const { facts, requirements } = computeRequirements(booking, snapshot)

  return buildWorkPlan({
    id: PLAN_ID,
    booking,
    snapshot,
    requirements,
    staffing: estimateStaffing({
      facts,
      configuration: snapshot.complexity,
      extraItems: booking.extras.length,
    }),
    extraSections: templateSections(snapshot, booking.eventType),
    version: 1,
    createdAt: CAPTURED_AT,
  })
}

/**
 * Tick every item in a section, with a photograph where one is demanded.
 *
 * Deliberately *only* ticking. A section whose items are all counted is not a
 * closed section — closing it is a separate, checked act. One of the tests
 * below depends on exactly that gap, which is why `close` is a second helper
 * and not a flag on this one.
 */
function tickAll(plan: WorkPlan, key: PlanSectionKey): WorkPlan {
  const section = plan.sections.find((entry) => entry.key === key)
  if (!section) return plan

  return section.items.reduce(
    (current, item) =>
      recordProgress(current, {
        section: section.key,
        itemId: item.itemId,
        completedCount: item.requiredCount,
        photoIds: item.requiresPhoto ? ['photo-1'] : undefined,
      }),
    plan,
  )
}

/** Tick a section and actually close it, so its dependants are unblocked. */
function close(plan: WorkPlan, key: PlanSectionKey): WorkPlan {
  return completeSection(tickAll(plan, key), { section: key, at: CAPTURED_AT })
    .plan
}

// ── Shape ─────────────────────────────────────────────────────────────────

describe('the plan', () => {
  const plan = build()

  it('is sectioned, in working order, and omits sections with nothing in them', () => {
    expect(plan.sections.map((section) => section.key)).toEqual([
      'cleaning',
      'bedrooms',
      'extra_sleeping',
      'bathrooms',
      'towels',
      'kitchen',
      'event_setup',
      'pool',
      'final_inspection',
    ])
  })

  it('gives every item a count rather than a tick', () => {
    const extras = plan.sections.find(
      (section) => section.key === 'extra_sleeping',
    )
    const mattresses = extras?.items.find(
      (item) => item.itemId === 'floor_mattress',
    )

    expect(mattresses?.requiredCount).toBe(15)
    expect(mattresses?.completedCount).toBe(0)
  })

  it('splits linen between the beds and the mattresses without changing the total', () => {
    const bedroomSheets = plan.sections
      .find((section) => section.key === 'bedrooms')
      ?.items.find((item) => item.itemId === 'single_fitted_sheet')
    const extraSheets = plan.sections
      .find((section) => section.key === 'extra_sleeping')
      ?.items.find((item) => item.itemId === 'single_fitted_sheet')

    expect(bedroomSheets?.requiredCount).toBe(10)
    expect(extraSheets?.requiredCount).toBe(15)
  })

  it('carries the photograph requirement and the instruction onto the item', () => {
    const kit = plan.sections
      .find((section) => section.key === 'bathrooms')
      ?.items.find((item) => item.itemId === 'bathroom_kit')

    expect(kit?.requiresPhoto).toBe(true)
    expect(kit?.instructions).toBe('לצלם כל חדר רחצה לאחר הסידור')
  })

  it('records which snapshot it was built from', () => {
    expect(plan.snapshotHash).toHaveLength(16)
  })
})

// ── Dependencies and the critical path ────────────────────────────────────

describe('the order of work', () => {
  const plan = build()

  it('never leaves a section waiting for one that does not exist', () => {
    const present = new Set(plan.sections.map((section) => section.key))

    for (const section of plan.sections) {
      for (const dependency of section.dependsOn) {
        expect(present.has(dependency)).toBe(true)
      }
    }
  })

  it('puts final inspection after cleaning and after the beds', () => {
    const inspection = plan.sections.find(
      (section) => section.key === 'final_inspection',
    )

    expect(inspection?.dependsOn).toContain('cleaning')
    expect(inspection?.dependsOn).toContain('bedrooms')
    expect(inspection?.dependsOn).toContain('extra_sleeping')
  })

  it('finds the longest chain, not the longest section', () => {
    expect(criticalPath(plan.sections)).toEqual([
      'cleaning',
      'bedrooms',
      'extra_sleeping',
      'final_inspection',
    ])
    expect(plan.criticalPathMinutes).toBe(305)
  })

  it('answers a same-day turnover honestly', () => {
    const tight = assessTurnover(plan, { availableMinutes: 240 })
    const roomy = assessTurnover(plan, { availableMinutes: 360 })

    expect(tight.feasible).toBe(false)
    expect(tight.shortfallMinutes).toBe(65)
    expect(roomy.feasible).toBe(true)
  })

  it('knows that adding people does not shorten the chain', () => {
    const crowd = assessTurnover(plan, { availableMinutes: 240, staff: 20 })

    expect(crowd.achievableMinutes).toBe(plan.criticalPathMinutes)
    expect(crowd.feasible).toBe(false)
  })
})

// ── Completion ────────────────────────────────────────────────────────────

describe('closing a section', () => {
  it('refuses while items are outstanding', () => {
    expect(() =>
      completeSection(build(), { section: 'cleaning', at: CAPTURED_AT }),
    ).toThrow(/outstanding/i)
  })

  it('refuses while a dependency is unfinished, even when its own items are done', () => {
    const plan = tickAll(build(), 'bedrooms')

    expect(() =>
      completeSection(plan, { section: 'bedrooms', at: CAPTURED_AT }),
    ).toThrow(/depends on/i)
  })

  it('refuses when the count is met but the photograph was never taken', () => {
    const plan = build()
    const withCounts = plan.sections
      .find((section) => section.key === 'bathrooms')
      ?.items.reduce(
        (current, item) =>
          recordProgress(current, {
            section: 'bathrooms',
            itemId: item.itemId,
            completedCount: item.requiredCount,
          }),
        close(plan, 'cleaning'),
      )

    expect(withCounts).toBeDefined()
    expect(() =>
      completeSection(withCounts as WorkPlan, {
        section: 'bathrooms',
        at: CAPTURED_AT,
      }),
    ).toThrow(/outstanding/i)
  })

  it('accepts a section whose items and photographs are all done', () => {
    const outcome = completeSection(tickAll(build(), 'cleaning'), {
      section: 'cleaning',
      at: CAPTURED_AT,
    })

    expect(outcome.overridden).toBe(false)
    expect(
      outcome.plan.sections.find((section) => section.key === 'cleaning')
        ?.status,
    ).toBe('completed')
  })

  it('names the section when it does not exist', () => {
    expect(() =>
      completeSection(build(), { section: 'outdoor', at: CAPTURED_AT }),
    ).toThrow(/not part of/i)
  })
})

// ── Override ──────────────────────────────────────────────────────────────

describe('a supervisor override', () => {
  const plan = close(build(), 'cleaning')

  it('closes the section and records who, why and what was missing', () => {
    const partly = recordProgress(plan, {
      section: 'bedrooms',
      itemId: 'pillow',
      completedCount: 7,
    })

    const outcome = completeSection(partly, {
      section: 'bedrooms',
      at: CAPTURED_AT,
      override: {
        supervisorUserId: 'user-michal',
        reason: 'האורחים הקדימו והמצעים בדרך מהמכבסה',
      },
    })

    expect(outcome.overridden).toBe(true)
    const section = outcome.plan.sections.find(
      (entry) => entry.key === 'bedrooms',
    )
    expect(section?.status).toBe('completed')
    expect(section?.override?.supervisorUserId).toBe('user-michal')
    expect(section?.override?.reason).toContain('הקדימו')
    expect(section?.override?.outstanding).toContainEqual({
      itemId: 'pillow',
      missing: 3,
    })
  })

  it('refuses an override with a blank reason', () => {
    // The stable machine code, not the sentence. The Hebrew wording is meant
    // to be improved freely; a test that pins it turns a copy edit into a
    // failing build.
    let code: string | null = null
    try {
      completeSection(plan, {
        section: 'bedrooms',
        at: CAPTURED_AT,
        override: { supervisorUserId: 'user-michal', reason: '   ' },
      })
    } catch (error) {
      code = isAppError(error) ? error.code : null
      expect(isAppError(error) && error.userMessage).toMatch(/נימוק/)
    }

    expect(code).toBe('plan_override_reason_required')
  })

  it('records no override when nothing was actually outstanding', () => {
    const outcome = completeSection(tickAll(plan, 'bedrooms'), {
      section: 'bedrooms',
      at: CAPTURED_AT,
      override: { supervisorUserId: 'user-michal', reason: 'לא נדרש' },
    })

    expect(outcome.overridden).toBe(false)
    expect(
      outcome.plan.sections.find((section) => section.key === 'bedrooms')
        ?.override,
    ).toBeNull()
  })
})

// ── Progress ──────────────────────────────────────────────────────────────

describe('recording progress', () => {
  it('clamps a miscount rather than refusing the update', () => {
    const plan = recordProgress(build(), {
      section: 'extra_sleeping',
      itemId: 'floor_mattress',
      completedCount: 99,
    })

    const item = plan.sections
      .find((section) => section.key === 'extra_sleeping')
      ?.items.find((entry) => entry.itemId === 'floor_mattress')

    expect(item?.completedCount).toBe(15)
  })

  it('moves a section to in progress on the first tick', () => {
    const plan = recordProgress(build(), {
      section: 'towels',
      itemId: 'bath_towel',
      completedCount: 1,
    })

    expect(
      plan.sections.find((section) => section.key === 'towels')?.status,
    ).toBe('in_progress')
  })

  it('lists what is outstanding, with the missing count', () => {
    const plan = recordProgress(build(), {
      section: 'towels',
      itemId: 'bath_towel',
      completedCount: 20,
    })
    const towels = plan.sections.find((section) => section.key === 'towels')

    expect(outstandingItems(towels!)).toContainEqual({
      itemId: 'bath_towel',
      label: 'מגבת רחצה',
      missing: 5,
      missingPhoto: false,
    })
  })
})
