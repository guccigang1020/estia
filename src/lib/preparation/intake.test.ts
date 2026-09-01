/**
 * The desk's answers, as things the engine can count.
 *
 * The case that matters is a booking with a baby: the cot is a physical object
 * somebody has to fetch, it provides no sleeping place, and until 0028 there
 * was nowhere on the row to record that anybody had asked for one.
 */

import { describe, expect, it } from 'vitest'

import { COT_BED_TYPE_ID, EXTRA_BED_ITEM_ID, sleepingExtras } from './intake'
import { computeRequirements } from './requirements'
import { captureSnapshot } from './snapshot'
import {
  BED_TYPES,
  PROPERTY,
  exampleBooking,
  exampleCatalogue,
} from './testing/example-configuration'
import type { BedType, SleepingShape } from './types'

const NOTHING: SleepingShape = {
  couples: 0,
  extraBedsRequested: 0,
  cotsRequested: 0,
}

describe('turning a sleeping request into extras', () => {
  it('produces nothing at all when nothing was asked for', () => {
    // A line reading "0 cots" is a line that teaches people to skim.
    expect(
      sleepingExtras({
        sleeping: NOTHING,
        extraBedTypeId: PROPERTY.extraSleepingBedTypeId,
        bedTypes: BED_TYPES,
      }),
    ).toEqual([])
  })

  it('asks for the property own extra-sleeping bed type, not a generic one', () => {
    // So that a requested spare bed and an allocated one merge into a single
    // line instead of appearing twice under two names.
    const [extra] = sleepingExtras({
      sleeping: { ...NOTHING, extraBedsRequested: 2 },
      extraBedTypeId: PROPERTY.extraSleepingBedTypeId,
      bedTypes: BED_TYPES,
    })

    expect(extra.itemId).toBe(PROPERTY.extraSleepingBedTypeId)
    expect(extra.quantity).toBe(2)
    expect(extra.section).toBe('extra_sleeping')
    expect(extra.category).toBe('sleeping')
  })

  it('takes the label and the setup minutes from configuration', () => {
    const configured = BED_TYPES.find(
      (type) => type.id === PROPERTY.extraSleepingBedTypeId,
    )
    if (!configured) throw new Error('the fixture lost its extra bed type')

    const [extra] = sleepingExtras({
      sleeping: { ...NOTHING, extraBedsRequested: 1 },
      extraBedTypeId: PROPERTY.extraSleepingBedTypeId,
      bedTypes: BED_TYPES,
    })

    expect(extra.label).toBe(configured.label)
    expect(extra.minutesPerUnit).toBe(configured.setupMinutes)
  })

  it('still shows a cot the catalogue has never heard of, with no invented duration', () => {
    // The guest asked for it and a cleaner has to see it. Guessing at how long
    // one takes would put a number this engine is forbidden to hold onto the
    // critical path; understating the estimate is the honest direction.
    const [cot] = sleepingExtras({
      sleeping: { ...NOTHING, cotsRequested: 2 },
      extraBedTypeId: null,
      bedTypes: [],
    })

    expect(cot.itemId).toBe(COT_BED_TYPE_ID)
    expect(cot.quantity).toBe(2)
    expect(cot.minutesPerUnit).toBe(0)
    expect(cot.label.length).toBeGreaterThan(0)
  })

  it('uses the fallback bed id only where the property has named none', () => {
    const [extra] = sleepingExtras({
      sleeping: { ...NOTHING, extraBedsRequested: 1 },
      extraBedTypeId: null,
      bedTypes: [],
    })

    expect(extra.itemId).toBe(EXTRA_BED_ITEM_ID)
  })

  it('reads a configured cot bed type when the organization declares one', () => {
    const cotType: BedType = {
      id: COT_BED_TYPE_ID,
      label: 'לול',
      capacity: 1,
      positions: 1,
      linen: [],
      setupMinutes: 7,
      usableAsExtra: false,
    }

    const [cot] = sleepingExtras({
      sleeping: { ...NOTHING, cotsRequested: 1 },
      extraBedTypeId: null,
      bedTypes: [cotType],
    })

    expect(cot.label).toBe('לול')
    expect(cot.minutesPerUnit).toBe(7)
  })
})

describe('the extras reach the plan', () => {
  it('adds to the rule-derived quantity rather than replacing it', () => {
    // `extraDrafts` merges extras with everything else, so a booking that asks
    // for one more bed than the allocation found short ends up with the sum
    // and the breakdown shows which part came from where.
    const snapshot = captureSnapshot({
      catalogue: exampleCatalogue(),
      booking: exampleBooking(),
      capturedAt: '2026-09-01T06:00:00.000Z',
    })

    const withoutRequest = computeRequirements(exampleBooking(), snapshot)
    const withRequest = computeRequirements(
      exampleBooking({
        extras: sleepingExtras({
          sleeping: { couples: 0, extraBedsRequested: 3, cotsRequested: 0 },
          extraBedTypeId: PROPERTY.extraSleepingBedTypeId,
          bedTypes: BED_TYPES,
        }),
      }),
      snapshot,
    )

    const before = withoutRequest.requirements.find(
      (entry) => entry.itemId === PROPERTY.extraSleepingBedTypeId,
    )
    const after = withRequest.requirements.find(
      (entry) => entry.itemId === PROPERTY.extraSleepingBedTypeId,
    )

    expect(after?.quantity).toBe((before?.quantity ?? 0) + 3)
    expect(after?.sources.some((source) => source.origin === 'extra')).toBe(
      true,
    )
    expect(after?.sources.some((source) => source.origin === 'bed')).toBe(true)
  })
})
