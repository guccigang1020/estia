/**
 * Consolidation, turnaround and the key that stops a second van.
 */

import { describe, expect, it } from 'vitest'

import { consolidate, meetsMinimum, totalsFrom } from './consolidation'
import { buildOrder, orderReference, orderRequirementKey } from './orders'
import { buildLaundryRequirements } from './requirements'
import {
  CARMEL,
  CARMEL_REQUIREMENTS,
  GALILEE,
  GALILEE_REQUIREMENTS,
  ORGANIZATION,
  PICKUP_AT,
  PROFILES,
  PROVIDER_ROW,
  REQUIRED_BY,
  SETTINGS,
} from './testing/example-configuration'
import { assessTurnaround, atRisk, latestPickupFor } from './turnaround'

function requirementsFor(propertyId: string, requiredBy = REQUIRED_BY) {
  return buildLaundryRequirements({
    settings: SETTINGS,
    profiles: PROFILES,
    requirements:
      propertyId === GALILEE ? GALILEE_REQUIREMENTS : CARMEL_REQUIREMENTS,
    propertyId,
    requiredBy,
    bookingId: `booking-${propertyId}`,
  }).requirements
}

function bothProperties() {
  return [...requirementsFor(GALILEE), ...requirementsFor(CARMEL)]
}

// ── Consolidation ─────────────────────────────────────────────────────────

describe('one van, several houses', () => {
  it('puts both properties in one run', () => {
    const runs = consolidate(bothProperties())

    expect(runs).toHaveLength(1)
    expect(runs[0]?.properties.map((entry) => entry.propertyId).sort()).toEqual(
      [CARMEL, GALILEE].sort(),
    )
  })

  it('PRESERVES the per-property breakdown and never collapses it', () => {
    const run = consolidate(bothProperties())[0]
    const linen = run?.totals.find((entry) => entry.itemId === 'linen_set')

    // The total exists...
    expect(linen?.quantity).toBeGreaterThan(0)

    // ...and it is reconstructible from the breakdown, which is the actual
    // requirement. A total that cannot be taken apart again is a number
    // somebody has to divide at the back of a van in the dark.
    const fromBreakdown = linen?.byProperty.reduce(
      (sum, part) => sum + part.quantity,
      0,
    )
    expect(fromBreakdown).toBe(linen?.quantity)
    expect(linen?.byProperty).toHaveLength(2)

    // Each property's own share is named, not inferred.
    for (const part of linen?.byProperty ?? []) {
      expect([GALILEE, CARMEL]).toContain(part.propertyId)
      expect(part.quantity).toBeGreaterThan(0)
    }
  })

  it('derives the totals from the breakdown rather than the reverse', () => {
    const run = consolidate(bothProperties())[0]
    const recomputed = totalsFrom(run?.properties ?? [])

    expect(recomputed.map((entry) => entry.quantity)).toEqual(
      run?.totals.map((entry) => entry.quantity),
    )
  })

  it('explains each consolidated total with its breakdown', () => {
    const run = consolidate(bothProperties())[0]
    const linen = run?.totals.find((entry) => entry.itemId === 'linen_set')
    const last = linen?.explanation.at(-1)

    expect(last?.kind).toBe('aggregate')
    expect(last?.text).toContain(GALILEE)
    expect(last?.text).toContain(CARMEL)
  })

  it('takes the tightest deadline in the run, never the loosest', () => {
    const earlier = '2026-09-04T09:00:00.000Z'
    const runs = consolidate([
      ...requirementsFor(GALILEE),
      ...requirementsFor(CARMEL, earlier),
    ])

    expect(runs[0]?.requiredBy).toBe(earlier)
  })

  it('separates runs that are needed on different days', () => {
    const runs = consolidate([
      ...requirementsFor(GALILEE),
      ...requirementsFor(CARMEL, '2026-09-06T13:00:00.000Z'),
    ])

    expect(runs).toHaveLength(2)
  })

  it("reports a provider's minimum rather than enforcing it", () => {
    const run = consolidate(requirementsFor(CARMEL))[0]
    if (!run) throw new Error('no run')

    // The order is still built. Waiting a day or adding a property is a
    // decision a person makes, and refusing would leave a shortage with no
    // record of why.
    expect(typeof meetsMinimum(run, PROVIDER_ROW.minimumOrderUnits)).toBe(
      'boolean',
    )
  })
})

// ── Turnaround ────────────────────────────────────────────────────────────

describe('turnaround risk', () => {
  it('raises a risk when the linen cannot be back in time', () => {
    // Collected two hours before it is needed, against a turnaround measured
    // in days. Nothing about this is exotic — it is a Thursday afternoon.
    const late = new Date(
      new Date(REQUIRED_BY).getTime() - 2 * 60 * 60 * 1000,
    ).toISOString()

    const risks = atRisk(
      assessTurnaround({
        requirements: requirementsFor(GALILEE),
        pickupAt: late,
      }),
    )

    expect(risks.length).toBeGreaterThan(0)
  })

  it('never silently assumes availability — every item is assessed', () => {
    const requirements = requirementsFor(GALILEE)
    const assessed = assessTurnaround({ requirements, pickupAt: PICKUP_AT })

    // Everything comes back, safe and unsafe alike. A screen listing only
    // risks cannot show that the rest were checked.
    expect(assessed).toHaveLength(requirements.length)
    for (const assessment of assessed) {
      expect(assessment.expectedReturnAt.length).toBeGreaterThan(0)
      expect(assessment.requiredBy).toBe(REQUIRED_BY)
    }
  })

  it('carries BOTH times and the shortfall, so nobody has to look them up', () => {
    const late = new Date(
      new Date(REQUIRED_BY).getTime() - 2 * 60 * 60 * 1000,
    ).toISOString()

    const risk = atRisk(
      assessTurnaround({
        requirements: requirementsFor(GALILEE),
        pickupAt: late,
      }),
    )[0]

    expect(risk?.pickupAt).toBe(late)
    expect(risk?.expectedReturnAt).toBeTruthy()
    expect(risk?.requiredBy).toBe(REQUIRED_BY)
    expect(risk?.shortfallHours).toBeGreaterThan(0)
    // And the sentence names them, in Hebrew, for a person.
    expect(risk?.explanation).toContain('באיחור')
  })

  it('reports no shortfall for an item that comes back in time', () => {
    const early = '2026-08-20T06:00:00.000Z'
    const assessed = assessTurnaround({
      requirements: requirementsFor(GALILEE),
      pickupAt: early,
    })

    for (const assessment of assessed) {
      expect(assessment.atRisk).toBe(false)
      expect(assessment.shortfallHours).toBe(0)
    }
  })

  it('says the latest moment a collection would still work', () => {
    const requirement = requirementsFor(GALILEE)[0]
    if (!requirement) throw new Error('no requirement')

    const latest = latestPickupFor(requirement)

    expect(new Date(latest).getTime()).toBeLessThan(
      new Date(requirement.requiredBy).getTime(),
    )
  })
})

// ── Idempotency ───────────────────────────────────────────────────────────

describe('the requirement key', () => {
  it('is the same for the same wash computed twice', () => {
    const a = consolidate(bothProperties())[0]
    const b = consolidate(bothProperties())[0]

    if (!a || !b) throw new Error('no run')
    expect(orderRequirementKey(a)).toBe(orderRequirementKey(b))
  })

  it('is the same however the requirements are ordered', () => {
    const forward = consolidate(bothProperties())[0]
    const backward = consolidate([...bothProperties()].reverse())[0]

    if (!forward || !backward) throw new Error('no run')
    expect(orderRequirementKey(forward)).toBe(orderRequirementKey(backward))
  })

  it('changes when a quantity changes, so a corrected order is allowed', () => {
    const original = consolidate(bothProperties())[0]

    const changed = consolidate(
      bothProperties().map((requirement, index) =>
        index === 0
          ? { ...requirement, quantity: requirement.quantity + 1 }
          : requirement,
      ),
    )[0]

    if (!original || !changed) throw new Error('no run')
    expect(orderRequirementKey(changed)).not.toBe(orderRequirementKey(original))
  })

  it('changes when a property joins the run', () => {
    const one = consolidate(requirementsFor(GALILEE))[0]
    const both = consolidate(bothProperties())[0]

    if (!one || !both) throw new Error('no run')
    expect(orderRequirementKey(both)).not.toBe(orderRequirementKey(one))
  })

  it('gives the reference the same stability', () => {
    const a = consolidate(bothProperties())[0]
    const b = consolidate([...bothProperties()].reverse())[0]

    if (!a || !b) throw new Error('no run')
    expect(orderReference(a)).toBe(orderReference(b))
    // Opaque: no sequence number a supplier could read a volume from.
    expect(orderReference(a)).not.toMatch(/-0*1$/)
  })
})

// ── Building the order ────────────────────────────────────────────────────

describe('building an order from a run', () => {
  const run = consolidate(bothProperties())[0]

  it('carries no property when the run spans several', () => {
    if (!run) throw new Error('no run')
    const order = buildOrder({
      run,
      settings: SETTINGS,
      organizationId: ORGANIZATION,
      orderId: 'order-1',
      lineIds: [],
    })

    // NULL means consolidated. The breakdown is on the lines, where it stays.
    expect(order.propertyId).toBeNull()
    expect(new Set(order.lines.map((line) => line.propertyId)).size).toBe(2)
  })

  it('names the property when the run is one house', () => {
    const single = consolidate(requirementsFor(GALILEE))[0]
    if (!single) throw new Error('no run')

    const order = buildOrder({
      run: single,
      settings: SETTINGS,
      organizationId: ORGANIZATION,
      orderId: 'order-2',
      lineIds: [],
    })

    expect(order.propertyId).toBe(GALILEE)
  })

  it('starts every line at calculated, with no adjustment and no reason', () => {
    if (!run) throw new Error('no run')
    const order = buildOrder({
      run,
      settings: SETTINGS,
      organizationId: ORGANIZATION,
      orderId: 'order-3',
      lineIds: [],
    })

    for (const line of order.lines) {
      expect(line.quantity.adjustment).toBe(0)
      expect(line.quantity.final).toBe(line.quantity.calculated)
      expect(line.quantity.reason).toBeNull()
      // The arithmetic travels with the line onto the order.
      expect(line.explanation.length).toBeGreaterThan(0)
    }
  })

  it('is born a draft and sends nothing', () => {
    if (!run) throw new Error('no run')
    const order = buildOrder({
      run,
      settings: SETTINGS,
      organizationId: ORGANIZATION,
      orderId: 'order-4',
      lineIds: [],
    })

    expect(order.status).toBe('draft')
    expect(order.sentAt).toBeNull()
    expect(order.sentBody).toBeNull()
    // The default is approval, and that is a safety decision rather than taste.
    expect(order.dispatchMode).toBe('approval_required')
  })
})
