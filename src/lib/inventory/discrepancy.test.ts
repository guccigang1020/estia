/**
 * Expected versus collected, and the five things it might mean.
 */

import { describe, expect, it } from 'vitest'

import { BusinessRuleError } from '../errors'

import {
  explainDiscrepancy,
  findDiscrepancies,
  isOpen,
  resolutionEffect,
  type CountBack,
} from './discrepancy'
import { capabilitiesFor, startingSettingsFor } from './settings'

const ADVANCED = capabilitiesFor(startingSettingsFor('org-1', 'advanced'))
const TRACKED = capabilitiesFor(startingSettingsFor('org-1', 'tracked'))

const COUNTS: readonly CountBack[] = [
  {
    propertyId: 'property-a',
    itemId: 'item-towel',
    label: 'מגבת גוף',
    bookingId: 'booking-1',
    expected: 12,
    collected: 9,
    countedOn: '2026-09-06',
  },
  {
    propertyId: 'property-a',
    itemId: 'item-sheet',
    label: 'סדין',
    bookingId: 'booking-1',
    expected: 8,
    collected: 8,
    countedOn: '2026-09-06',
  },
  {
    propertyId: 'property-a',
    itemId: 'item-pillow',
    label: 'כרית',
    bookingId: 'booking-1',
    expected: 10,
    collected: 11,
    countedOn: '2026-09-06',
  },
]

describe('finding differences', () => {
  it('records only the counts that actually differ', () => {
    const found = findDiscrepancies(COUNTS, ADVANCED)

    expect(found.map((one) => one.itemId)).toEqual([
      'item-towel',
      'item-pillow',
    ])
    expect(found[0].difference).toBe(-3)
    // A surplus is a discrepancy too: eleven pillows back out of ten is
    // somebody else's linen, or a miscount, and both are worth knowing.
    expect(found[1].difference).toBe(1)
  })

  it('leaves everything unresolved rather than deciding', () => {
    const found = findDiscrepancies(COUNTS, ADVANCED)

    // Defaulting to `correction` is exactly how guest loss stops being visible.
    expect(found.every((one) => one.resolution === 'unresolved')).toBe(true)
    expect(found.every((one) => isOpen(one))).toBe(true)
  })

  it('records nothing at all below advanced', () => {
    // Counting linen back in is fifteen minutes a changeover. A business that
    // has not asked for it must not get a screen with a badge on it.
    expect(findDiscrepancies(COUNTS, TRACKED)).toHaveLength(0)
  })
})

describe('the sentence a person reads', () => {
  it('shows the arithmetic, both ways round', () => {
    expect(
      explainDiscrepancy({
        label: 'מגבת גוף',
        expected: 12,
        collected: 9,
        difference: -3,
      }),
    ).toBe('מגבת גוף: יצאו 12, חזרו 9. חסרים 3.')

    expect(
      explainDiscrepancy({
        label: 'כרית',
        expected: 10,
        collected: 11,
        difference: 1,
      }),
    ).toBe('כרית: יצאו 10, חזרו 11. עודף 1.')
  })
})

describe('what closing it actually does', () => {
  const three = { difference: -3, label: 'מגבת גוף' }

  it('a find puts the stock back with a receipt', () => {
    const effect = resolutionEffect(three, 'found', 'היו בחדר הכביסה')

    expect(effect.movementKind).toBe('receipt')
    expect(effect.quantityDelta).toBe(3)
    expect(effect.toState).toBe('available')
  })

  it('guest loss lands in `lost`, never in `damaged`', () => {
    const effect = resolutionEffect(three, 'guest_loss', 'האורח לקח')

    expect(effect.movementKind).toBe('loss')
    expect(effect.quantityDelta).toBe(-3)
    // The contract keeps the two apart because one is investigated and
    // possibly charged, and the other is repaired or written off.
    expect(effect.toState).toBe('lost')
  })

  it('damage lands in `damaged`', () => {
    const effect = resolutionEffect(three, 'damaged', 'קרועות')
    expect(effect.toState).toBe('damaged')
  })

  it('a correction moves the count and nothing else', () => {
    const effect = resolutionEffect(three, 'correction', 'ספרנו לא נכון')

    expect(effect.movementKind).toBe('adjustment')
    expect(effect.quantityDelta).toBe(-3)
    expect(effect.toState).toBeNull()
  })

  it('an investigation writes nothing to the ledger', () => {
    // A movement recorded now would have to be reversed when the answer
    // arrives, and the ledger is append-only.
    const effect = resolutionEffect(three, 'investigating', 'שאלנו את המנקה')

    expect(effect.movementKind).toBeNull()
    expect(effect.quantityDelta).toBe(0)
  })

  it('refuses a resolution with no note', () => {
    expect(() => resolutionEffect(three, 'guest_loss', '   ')).toThrow(
      BusinessRuleError,
    )
  })

  it('refuses `unresolved` as a resolution', () => {
    expect(() => resolutionEffect(three, 'unresolved', 'משהו')).toThrow(
      BusinessRuleError,
    )
  })
})
