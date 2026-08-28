/**
 * Readiness, and the alert that is the point of it.
 *
 * A single overall percentage is the number that hides the problem: ninety
 * percent ready with the beds untouched is not ninety percent ready. So the
 * components are tested separately, and the critical alert — low readiness
 * *close to arrival*, which is a different thing from low readiness at nine in
 * the morning — is tested on both sides of both thresholds.
 *
 * The staffing estimate lives here too, because it is the other half of the
 * same question: how ready are we, and how many people would it take.
 */

import { describe, expect, it } from 'vitest'
import { estimateStaffing, labourCostOf } from './complexity'
import { computeReadiness, hoursUntil } from './readiness'
import { computeRequirements, templateSections } from './requirements'
import { captureSnapshot } from './snapshot'
import { buildWorkPlan, recordProgress } from './work-plan'
import type { PlanSectionKey, ReadinessPolicy, WorkPlan } from './types'
import {
  exampleBooking,
  exampleCatalogue,
} from './testing/example-configuration'

const CAPTURED_AT = '2026-08-27T08:00:00.000Z'
const BOOKING = exampleBooking()
const SNAPSHOT = captureSnapshot({
  catalogue: exampleCatalogue(),
  booking: BOOKING,
  capturedAt: CAPTURED_AT,
})

const { facts, requirements } = computeRequirements(BOOKING, SNAPSHOT)
const STAFFING = estimateStaffing({
  facts,
  configuration: SNAPSHOT.complexity,
  extraItems: BOOKING.extras.length,
})

const PLAN: WorkPlan = buildWorkPlan({
  id: 'plan-1',
  booking: BOOKING,
  snapshot: SNAPSHOT,
  requirements,
  staffing: STAFFING,
  extraSections: templateSections(SNAPSHOT, BOOKING.eventType),
  version: 1,
  createdAt: CAPTURED_AT,
})

const POLICY: ReadinessPolicy = SNAPSHOT.readinessPolicy

/** Tick every item in a section to its full count. */
function tickAll(plan: WorkPlan, key: PlanSectionKey): WorkPlan {
  const section = plan.sections.find((entry) => entry.key === key)
  if (!section) return plan

  return section.items.reduce(
    (current, item) =>
      recordProgress(current, {
        section: key,
        itemId: item.itemId,
        completedCount: item.requiredCount,
      }),
    plan,
  )
}

function readiness(
  plan: WorkPlan,
  overrides: {
    paid?: number
    due?: number
    contractSigned?: boolean
    now?: Date
  } = {},
) {
  return computeReadiness({
    plan,
    payment: { paid: overrides.paid ?? 0, due: overrides.due ?? 640_000 },
    contractSigned: overrides.contractSigned ?? false,
    policy: POLICY,
    arrivalAt: BOOKING.arrivalAt,
    now: overrides.now ?? new Date('2026-09-01T14:00:00.000Z'),
  })
}

// ── Components ────────────────────────────────────────────────────────────

describe('readiness by component', () => {
  it('starts at nothing done and nothing paid', () => {
    const report = readiness(PLAN)

    expect(report.lines.map((line) => line.component)).toEqual([
      'cleaning',
      'sleeping',
      'towels',
      'kitchen',
      'payment',
      'contract',
    ])
    for (const line of report.lines) {
      expect(line.percent, line.component).toBe(0)
    }
  })

  it('counts sleeping across the permanent beds and the mattresses together', () => {
    // Bedrooms done, extra sleeping untouched: half ready to sleep in, and
    // reporting the two separately would let one reach a hundred while nobody
    // can go to bed.
    const report = readiness(tickAll(PLAN, 'bedrooms'))
    const sleeping = report.lines.find((line) => line.component === 'sleeping')

    expect(sleeping?.percent).toBeGreaterThan(0)
    expect(sleeping?.percent).toBeLessThan(100)
  })

  it('reaches a hundred when the work is done', () => {
    const done = ['bedrooms', 'extra_sleeping'].reduce(
      (plan, key) => tickAll(plan, key as PlanSectionKey),
      PLAN,
    )

    expect(
      readiness(done).lines.find((line) => line.component === 'sleeping')
        ?.percent,
    ).toBe(100)
  })

  it('reports a component with nothing to do as finished, not unstarted', () => {
    const noKitchen: WorkPlan = {
      ...PLAN,
      sections: PLAN.sections.filter((section) => section.key !== 'kitchen'),
    }

    const kitchen = readiness(noKitchen).lines.find(
      (line) => line.component === 'kitchen',
    )

    expect(kitchen?.percent).toBe(100)
    expect(kitchen?.detail).toBe('אין דרישות פתוחות')
  })

  it('tracks payment as a proportion of what is owed', () => {
    expect(
      readiness(PLAN, { paid: 320_000 }).lines.find(
        (line) => line.component === 'payment',
      )?.percent,
    ).toBe(50)
  })

  it('never reports more than fully paid', () => {
    expect(
      readiness(PLAN, { paid: 900_000 }).lines.find(
        (line) => line.component === 'payment',
      )?.percent,
    ).toBe(100)
  })

  it('treats nothing owed as paid', () => {
    expect(
      readiness(PLAN, { due: 0 }).lines.find(
        (line) => line.component === 'payment',
      )?.percent,
    ).toBe(100)
  })

  it('treats the contract as all or nothing, because it is', () => {
    expect(
      readiness(PLAN, { contractSigned: true }).lines.find(
        (line) => line.component === 'contract',
      )?.percent,
    ).toBe(100)
  })

  it('counts a supervisor-closed section as done', () => {
    const closed: WorkPlan = {
      ...PLAN,
      sections: PLAN.sections.map((section) =>
        section.key === 'towels'
          ? { ...section, status: 'completed' as const }
          : section,
      ),
    }

    expect(
      readiness(closed).lines.find((line) => line.component === 'towels')
        ?.percent,
    ).toBe(100)
  })
})

// ── The alert ─────────────────────────────────────────────────────────────

describe('the critical alert', () => {
  const nearlyThere = [
    'bedrooms',
    'extra_sleeping',
    'towels',
    'kitchen',
  ].reduce((plan, key) => tickAll(plan, key as PlanSectionKey), PLAN)

  it('does not fire when readiness is low but arrival is days away', () => {
    const report = readiness(PLAN, {
      now: new Date('2026-09-01T14:00:00.000Z'),
    })

    expect(report.hoursToArrival).toBeGreaterThan(POLICY.criticalHours)
    expect(report.alerts.some((alert) => alert.severity === 'critical')).toBe(
      false,
    )
  })

  it('fires when readiness is low and the guests are nearly here', () => {
    const report = readiness(PLAN, {
      now: new Date('2026-09-04T12:00:00.000Z'),
    })

    expect(report.hoursToArrival).toBeLessThanOrEqual(POLICY.criticalHours)
    const critical = report.alerts.find(
      (alert) => alert.severity === 'critical',
    )

    expect(critical).toBeDefined()
    expect(critical?.component).toBe('overall')
    expect(critical?.message).toContain('שעות')
  })

  it('does not fire close to arrival when the house is actually ready', () => {
    const report = readiness(nearlyThere, {
      paid: 640_000,
      contractSigned: true,
      now: new Date('2026-09-04T12:00:00.000Z'),
    })

    expect(report.overallPercent).toBeGreaterThanOrEqual(POLICY.criticalPercent)
    expect(report.alerts.some((alert) => alert.severity === 'critical')).toBe(
      false,
    )
  })

  it('warns per component at any distance', () => {
    const report = readiness(PLAN)

    expect(
      report.alerts.filter((alert) => alert.severity === 'warning').length,
    ).toBeGreaterThan(0)
  })

  it('puts the critical alert first, where a person will read it', () => {
    const report = readiness(PLAN, {
      now: new Date('2026-09-04T12:00:00.000Z'),
    })

    expect(report.alerts[0].severity).toBe('critical')
  })
})

// ── The countdown ─────────────────────────────────────────────────────────

describe('hours until arrival', () => {
  it('counts down', () => {
    expect(
      hoursUntil(
        '2026-09-04T14:00:00.000Z',
        new Date('2026-09-04T10:00:00.000Z'),
      ),
    ).toBe(4)
  })

  it('is never negative for a guest who has already arrived', () => {
    expect(
      hoursUntil(
        '2026-09-04T14:00:00.000Z',
        new Date('2026-09-05T10:00:00.000Z'),
      ),
    ).toBe(0)
  })

  it('is zero rather than NaN for an unparseable date', () => {
    expect(hoursUntil('not a date', new Date())).toBe(0)
  })
})

// ── Staffing ──────────────────────────────────────────────────────────────

describe('complexity and staffing', () => {
  it('scores the booking from configured weights and shows the parts', () => {
    // 25×2 + 5×3 + 3×4 + 15×1 + shabbat 20 + pool 10 + outdoor 5 = 127
    expect(STAFFING.score).toBe(127)
    expect(STAFFING.contributions).toContainEqual({ key: 'guests', points: 50 })
    expect(STAFFING.contributions).toContainEqual({
      key: 'event:shabbat',
      points: 20,
    })
    expect(STAFFING.contributions).toContainEqual({
      key: 'flag:pool',
      points: 10,
    })
  })

  it('leaves out a weight that came to nothing', () => {
    expect(
      STAFFING.contributions.some(
        (entry) => entry.key === 'flag:kosher_kitchen',
      ),
    ).toBe(false)
  })

  it('recommends a crew, rounding up', () => {
    // 127 ÷ 50 per person = 2.54 → three.
    expect(STAFFING.recommendedStaff).toBe(3)
  })

  it('separates duration from what the business pays for', () => {
    expect(STAFFING.estimatedMinutes).toBe(381)
    expect(STAFFING.staffMinutes).toBe(1_143)
  })

  it('costs the crew at the configured hourly rate', () => {
    // 1,143 minutes × ₪55/hour ÷ 60 = ₪1,047.75.
    expect(STAFFING.labourCost).toBe(104_775)
    expect(labourCostOf(60, 5_500)).toBe(5_500)
  })

  it('honours the floors for a trivial booking', () => {
    const tiny = estimateStaffing({
      facts: {
        ...facts,
        guests: 1,
        bedrooms: 1,
        bathrooms: 1,
        extraBeds: 0,
        eventType: 'accommodation',
        flags: {},
      },
      configuration: SNAPSHOT.complexity,
      extraItems: 0,
    })

    expect(tiny.recommendedStaff).toBe(SNAPSHOT.complexity.minimumStaff)
    expect(tiny.estimatedMinutes).toBe(SNAPSHOT.complexity.minimumMinutes)
  })

  it('scales with the event type, not only the head count', () => {
    const wedding = estimateStaffing({
      facts: { ...facts, eventType: 'wedding' },
      configuration: SNAPSHOT.complexity,
      extraItems: 0,
    })

    expect(wedding.score).toBeGreaterThan(STAFFING.score)
  })
})
