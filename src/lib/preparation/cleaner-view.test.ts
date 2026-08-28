/**
 * What a cleaner may see.
 *
 * The charter's rule, tested rather than asserted in a comment: a cleaner gets
 * what, where, how many, when and the instructions, and never revenue, cost,
 * profit or commission.
 *
 * The strongest test here is the last one, which walks the produced object and
 * fails on any field whose *name* means money. It cannot catch a leak called
 * `x`, which is why the projection is explicit and this is the second line of
 * defence — but it does catch the realistic failure, which is somebody adding
 * `estimatedCost` to `WorkPlan` and the view inheriting it.
 */

import { describe, expect, it } from 'vitest'
import { estimateStaffing } from './complexity'
import { computeRequirements, templateSections } from './requirements'
import { captureSnapshot } from './snapshot'
import { buildWorkPlan } from './work-plan'
import { containsFinancialField, toCleanerView } from './cleaner-view'
import type { WorkPlan } from './types'
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

const PLAN: WorkPlan = buildWorkPlan({
  id: 'plan-1',
  booking: BOOKING,
  snapshot: SNAPSHOT,
  requirements,
  staffing: estimateStaffing({
    facts,
    configuration: SNAPSHOT.complexity,
    extraItems: BOOKING.extras.length,
  }),
  extraSections: templateSections(SNAPSHOT, BOOKING.eventType),
  version: 1,
  createdAt: CAPTURED_AT,
})

const VIEW = toCleanerView({
  plan: PLAN,
  propertyLabel: 'בית הזית',
  unitLabel: 'הווילה',
  arrivalAt: BOOKING.arrivalAt,
  guestCount: BOOKING.guests,
})

// ── What they do get ──────────────────────────────────────────────────────

describe("the cleaner's view", () => {
  it('says where, when and how many people', () => {
    expect(VIEW.propertyLabel).toBe('בית הזית')
    expect(VIEW.unitLabel).toBe('הווילה')
    expect(VIEW.arrivalAt).toBe(BOOKING.arrivalAt)
    expect(VIEW.guestCount).toBe(25)
  })

  it('keeps every section and every item, with its count', () => {
    expect(VIEW.sections.map((section) => section.key)).toEqual(
      PLAN.sections.map((section) => section.key),
    )

    const mattress = VIEW.sections
      .find((section) => section.key === 'extra_sleeping')
      ?.items.find((item) => item.itemId === 'floor_mattress')

    expect(mattress).toMatchObject({ requiredCount: 15, completedCount: 0 })
  })

  it('keeps the instructions and the photograph requirement', () => {
    const kit = VIEW.sections
      .find((section) => section.key === 'bathrooms')
      ?.items.find((item) => item.itemId === 'bathroom_kit')

    expect(kit?.requiresPhoto).toBe(true)
    expect(kit?.instructions).toBe('לצלם כל חדר רחצה לאחר הסידור')
    expect(kit?.photoCount).toBe(0)
  })

  it('shows the order of work, so nobody inspects a dirty house', () => {
    const inspection = VIEW.sections.find(
      (section) => section.key === 'final_inspection',
    )

    expect(inspection?.dependsOn).toContain('cleaning')
  })
})

// ── What they do not ──────────────────────────────────────────────────────

describe('what the view withholds', () => {
  it('contains no field whose name means money, anywhere in the tree', () => {
    expect(containsFinancialField(VIEW)).toEqual([])
  })

  it('carries no snapshot, and therefore no cost rule or price line', () => {
    const serialised = JSON.stringify(VIEW)

    expect(serialised).not.toContain('priceLines')
    expect(serialised).not.toContain('variableCosts')
    expect(serialised).not.toContain('commission')
    expect(serialised).not.toContain('hourlyRate')
  })

  it('does not carry the guest, the booking or the organization', () => {
    expect(Object.keys(VIEW)).not.toContain('bookingId')
    expect(Object.keys(VIEW)).not.toContain('organizationId')
    expect(Object.keys(VIEW)).not.toContain('guest')
  })

  it('is a projection rather than a filtered plan', () => {
    // Anything added to WorkPlan must be added here on purpose. If this ever
    // starts failing because the view grew a field automatically, the
    // projection has been replaced by a spread and the guarantee is gone.
    const planWithMoney: WorkPlan & { estimatedCost: number } = {
      ...PLAN,
      estimatedCost: 312_475,
    }

    const view = toCleanerView({
      plan: planWithMoney,
      propertyLabel: 'בית הזית',
      unitLabel: 'הווילה',
      arrivalAt: BOOKING.arrivalAt,
      guestCount: BOOKING.guests,
    })

    expect(Object.keys(view)).not.toContain('estimatedCost')
    expect(containsFinancialField(view)).toEqual([])
  })
})

// ── The scanner itself ────────────────────────────────────────────────────

describe('the financial field scanner', () => {
  it('names the path of anything it finds, not just that it found something', () => {
    expect(
      containsFinancialField({ sections: [{ items: [{ unitPrice: 10 }] }] }),
    ).toEqual(['sections[0].items[0].unitPrice'])
  })

  it('catches money by any of its usual names', () => {
    for (const key of [
      'revenue',
      'totalCost',
      'netProfit',
      'marginBasisPoints',
      'agentCommission',
      'amountPaid',
      'depositHeld',
      'hourlyRate',
      'invoiceId',
    ]) {
      expect(containsFinancialField({ [key]: 1 }), key).toHaveLength(1)
    }
  })

  it('does not cry wolf over ordinary preparation fields', () => {
    expect(
      containsFinancialField({
        itemId: 'pillow',
        requiredCount: 25,
        completedCount: 0,
        minutes: 60,
        requiresPhoto: true,
        recommendedStaff: 3,
        guestCount: 25,
      }),
    ).toEqual([])
  })
})
