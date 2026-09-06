/**
 * Differences, never conclusions.
 *
 * The two tests that matter most here are the negative ones: a difference
 * carries no field that could hold a verdict, and "nobody looked" is reported
 * as not comparable rather than resolved into "it was fine". The second is
 * where a real system quietly starts keeping deposits — every item the
 * pre-stay walk skipped becomes a difference at checkout.
 */

import { describe, expect, it } from 'vitest'

import {
  DIFFERENCE_KINDS,
  DIFFERENCE_KIND_LABEL,
  INSPECTION_CONDITIONS,
  INSPECTION_CONDITION_LABEL,
  INSPECTION_STAGES,
  INSPECTION_STAGE_LABEL,
  byAttention,
  compareChain,
  compareInspections,
  hasBaseline,
  type InspectionItem,
  type InspectionRecord,
  type InspectionStage,
} from './inspection'

const ORG = 'org-1'

function item(overrides: Partial<InspectionItem> = {}): InspectionItem {
  return {
    key: 'kitchen.worktop',
    label: 'משטח המטבח',
    condition: 'intact',
    quantity: null,
    evidenceIds: [],
    note: null,
    ...overrides,
  }
}

function record(
  stage: InspectionStage,
  items: readonly InspectionItem[],
  at = '2026-04-01T10:00:00Z',
): InspectionRecord {
  return {
    id: `insp-${stage}`,
    organizationId: ORG,
    propertyId: 'prop-1',
    unitId: 'unit-1',
    bookingId: 'booking-1',
    caseId: null,
    stage,
    performedByUserId: 'user-1',
    performedAt: new Date(at),
    notes: null,
    items,
  }
}

describe('the vocabularies', () => {
  it('label every value', () => {
    for (const value of INSPECTION_STAGES) {
      expect(INSPECTION_STAGE_LABEL[value]).toBeTruthy()
    }
    for (const value of INSPECTION_CONDITIONS) {
      expect(INSPECTION_CONDITION_LABEL[value]).toBeTruthy()
    }
    for (const value of DIFFERENCE_KINDS) {
      expect(DIFFERENCE_KIND_LABEL[value]).toBeTruthy()
    }
  })
})

describe('a comparison', () => {
  it('reports a worsening as a worsening and nothing more', () => {
    const differences = compareInspections(
      record('pre_stay', [item({ condition: 'intact' })]),
      record('checkout', [item({ condition: 'damaged' })]),
    )

    expect(differences).toHaveLength(1)
    expect(differences[0]?.kind).toBe('condition_worsened')
    expect(differences[0]?.before).toBe('intact')
    expect(differences[0]?.after).toBe('damaged')
  })

  it('carries no field that could hold a verdict', () => {
    const [difference] = compareInspections(
      record('pre_stay', [item({ condition: 'intact' })]),
      record('checkout', [item({ condition: 'damaged' })]),
    )

    const keys = Object.keys(difference ?? {})
    for (const forbidden of [
      'liable',
      'liability',
      'responsible',
      'chargeable',
      'amount',
      'confidence',
      'severity',
    ]) {
      expect(keys).not.toContain(forbidden)
    }
    expect(keys.sort()).toEqual([
      'after',
      'before',
      'evidenceIds',
      'key',
      'kind',
      'label',
      'quantityAfter',
      'quantityBefore',
    ])
  })

  it('reads forwards even when the caller passes checkout first', () => {
    // "Before" is a fact about when somebody looked, not about how a function
    // was called.
    const differences = compareInspections(
      record('checkout', [item({ condition: 'damaged' })]),
      record('pre_stay', [item({ condition: 'intact' })]),
    )
    expect(differences[0]?.before).toBe('intact')
    expect(differences[0]?.after).toBe('damaged')
  })

  it('says nothing about the things that did not change', () => {
    const differences = compareInspections(
      record('pre_stay', [item(), item({ key: 'bathroom.mirror' })]),
      record('checkout', [item(), item({ key: 'bathroom.mirror' })]),
    )
    expect(differences).toEqual([])
  })

  it('reports an improvement as honestly as a worsening', () => {
    const differences = compareInspections(
      record('pre_stay', [item({ condition: 'worn' })]),
      record('checkout', [item({ condition: 'intact' })]),
    )
    expect(differences[0]?.kind).toBe('condition_improved')
  })
})

describe('when nobody looked', () => {
  it('is not comparable rather than unchanged', () => {
    // The failure this prevents: every item the pre-stay walk skipped becomes
    // a difference at checkout, and the business argues each one.
    const differences = compareInspections(
      record('pre_stay', [item({ condition: 'not_checked' })]),
      record('checkout', [item({ condition: 'damaged' })]),
    )

    expect(differences[0]?.kind).toBe('not_comparable')
    expect(differences[0]?.before).toBe('not_checked')
  })

  it('produces nothing when neither side looked', () => {
    const differences = compareInspections(
      record('pre_stay', [item({ condition: 'not_checked' })]),
      record('checkout', [item({ condition: 'not_checked' })]),
    )
    expect(differences).toEqual([])
  })

  it('reports an item that appears only on one side as such', () => {
    const differences = compareInspections(
      record('pre_stay', []),
      record('checkout', [item()]),
    )
    expect(differences[0]?.kind).toBe('appeared')
  })
})

describe('counted things', () => {
  it('reports a shortage when the count fell', () => {
    const differences = compareInspections(
      record('pre_stay', [
        item({ key: 'linen.towel', label: 'מגבות', quantity: 4 }),
      ]),
      record('checkout', [
        item({ key: 'linen.towel', label: 'מגבות', quantity: 2 }),
      ]),
    )

    expect(differences[0]?.kind).toBe('quantity_short')
    expect(differences[0]?.quantityBefore).toBe(4)
    expect(differences[0]?.quantityAfter).toBe(2)
  })

  it('reports a surplus too, which is usually a counting error', () => {
    const differences = compareInspections(
      record('pre_stay', [item({ key: 'linen.towel', quantity: 2 })]),
      record('checkout', [item({ key: 'linen.towel', quantity: 4 })]),
    )
    expect(differences[0]?.kind).toBe('quantity_over')
  })
})

describe('the chain', () => {
  it('compares adjacent stages, so a mid-stay record breaks the chain', () => {
    // The point of four stages: a difference that first appears between
    // `stay` and `checkout` happened during the stay, and one between
    // pre-stay and stay predates the guest's own time in the unit.
    const steps = compareChain([
      record('pre_stay', [item({ condition: 'intact' })], '2026-04-01T10:00Z'),
      record('stay', [item({ condition: 'damaged' })], '2026-04-03T10:00Z'),
      record('checkout', [item({ condition: 'damaged' })], '2026-04-05T10:00Z'),
    ])

    expect(steps).toHaveLength(2)
    expect(steps[0]?.differences[0]?.kind).toBe('condition_worsened')
    expect(steps[1]?.differences).toEqual([])
  })

  it('knows when there is no baseline to compare against at all', () => {
    // A business with no pre-stay record has a checkout record and nothing to
    // argue from, and the screen has to say so rather than show an empty
    // difference list that reads as "nothing changed".
    expect(hasBaseline([record('checkout', [item()])])).toBe(false)
    expect(hasBaseline([record('pre_stay', [item()])])).toBe(true)
  })
})

describe('ordering', () => {
  it('puts what costs money first and hides nothing', () => {
    const differences = compareInspections(
      record('pre_stay', [
        item({ key: 'a.worn', condition: 'worn' }),
        item({ key: 'b.towel', label: 'מגבות', quantity: 4 }),
        item({ key: 'c.checked', condition: 'not_checked' }),
      ]),
      record('checkout', [
        item({ key: 'a.worn', condition: 'intact' }),
        item({ key: 'b.towel', label: 'מגבות', quantity: 2 }),
        item({ key: 'c.checked', condition: 'intact' }),
      ]),
    )

    const ordered = byAttention(differences)
    expect(ordered[0]?.kind).toBe('quantity_short')
    // Nothing is filtered out — an improvement is a fact, and a comparison
    // that hid it would only ever argue in the business's direction.
    expect(ordered).toHaveLength(differences.length)
    expect(ordered.map((entry) => entry.kind)).toContain('condition_improved')
  })
})
