/**
 * Empty states.
 *
 * The expensive mistake this file guards is telling a customer with four
 * hundred bookings that they have never created one, because a filter was
 * active. Everything below exists to make that specific sentence impossible.
 */

import { describe, expect, it } from 'vitest'

import {
  emptyStateCopy,
  resolveEmptyReason,
  type EmptyModule,
} from './empty-presets'

const ALL_MODULES: EmptyModule[] = [
  'bookings',
  'properties',
  'units',
  'guests',
  'team',
  'invoices',
  'tasks',
  'messages',
]

describe('resolveEmptyReason — empty is not the same as filtered', () => {
  it('reports no empty state at all when rows are visible', () => {
    expect(
      resolveEmptyReason({
        visibleCount: 3,
        totalCount: 3,
        hasActiveFilters: false,
      }),
    ).toBeNull()
  })

  it('teaches the module when nothing exists and nothing is filtered', () => {
    expect(
      resolveEmptyReason({
        visibleCount: 0,
        totalCount: 0,
        hasActiveFilters: false,
      }),
    ).toBe('no_data')
  })

  it('blames the filter when data exists but none of it matches', () => {
    expect(
      resolveEmptyReason({
        visibleCount: 0,
        totalCount: 412,
        hasActiveFilters: true,
      }),
    ).toBe('no_results')
  })

  it('teaches the module when a filter is on but the module is genuinely empty', () => {
    // Clearing the filter would reveal nothing, so "try another filter" would
    // send the user in a circle.
    expect(
      resolveEmptyReason({
        visibleCount: 0,
        totalCount: 0,
        hasActiveFilters: true,
      }),
    ).toBe('no_data')
  })

  it('does not guess a first-run state when the total was never counted', () => {
    expect(
      resolveEmptyReason({ visibleCount: 0, hasActiveFilters: true }),
    ).toBe('no_results')
  })

  it('treats an uncounted, unfiltered list as a genuine first run', () => {
    expect(
      resolveEmptyReason({ visibleCount: 0, hasActiveFilters: false }),
    ).toBe('no_data')
  })
})

describe('emptyStateCopy — a first run explains the module', () => {
  it.each(ALL_MODULES)(
    "%s says what the module is for, not 'no data'",
    (module) => {
      const copy = emptyStateCopy({ module, reason: 'no_data' })

      expect(copy.title).not.toMatch(/^אין נתונים/)
      // Long enough to be an explanation rather than a label.
      expect(copy.body.length).toBeGreaterThan(60)
      expect(copy.actionLabel.length).toBeGreaterThan(0)
    },
  )

  it.each(ALL_MODULES)(
    '%s offers a creating action, never a filter action',
    (module) => {
      const copy = emptyStateCopy({ module, reason: 'no_data' })

      expect(copy.actionLabel).not.toContain('סינון')
      expect(copy.illustration).not.toBe('search')
    },
  )
})

describe('emptyStateCopy — a filtered list points at the filter', () => {
  it.each(ALL_MODULES)(
    '%s offers clearing the filter, not creating a record',
    (module) => {
      const copy = emptyStateCopy({ module, reason: 'no_results' })

      expect(copy.actionLabel).toBe('נקה סינון')
      expect(copy.illustration).toBe('search')
      expect(copy.secondaryActionLabel).toBeUndefined()
    },
  )

  it.each(ALL_MODULES)('%s never claims the module is untouched', (module) => {
    const filtered = emptyStateCopy({ module, reason: 'no_results' })
    const first = emptyStateCopy({ module, reason: 'no_data' })

    expect(filtered.title).not.toBe(first.title)
    expect(filtered.body).not.toBe(first.body)
    // Gender agrees with the module's plural noun, so the assertion allows
    // both forms — but it must always say the records still exist.
    expect(filtered.body).toMatch(/קיימ(ים|ות) במערכת/)
  })

  it.each([
    ['bookings', 'שתואמות', 'אחרות', 'אותן'],
    ['properties', 'שתואמים', 'אחרים', 'אותם'],
    ['team', 'שתואמים', 'אחרים', 'אותם'],
    ['invoices', 'שתואמות', 'אחרות', 'אותן'],
  ] as const)(
    '%s agrees grammatically, so the sentence does not read as broken Hebrew',
    (module, matching, other, them) => {
      const copy = emptyStateCopy({ module, reason: 'no_results' })

      expect(copy.title).toContain(matching)
      expect(copy.body).toContain(other)
      expect(copy.body).toContain(them)
    },
  )

  it('shows the active filter back to the user so they can see what is hiding the data', () => {
    const copy = emptyStateCopy({
      module: 'bookings',
      reason: 'no_results',
      filterSummary: 'ספטמבר · וילה הגליל',
    })

    expect(copy.body).toContain('ספטמבר · וילה הגליל')
  })

  it('still reads correctly when the filter cannot be summarised', () => {
    const copy = emptyStateCopy({ module: 'guests', reason: 'no_results' })

    expect(copy.body).toContain('הסינון הפעיל')
    expect(copy.body).not.toContain('undefined')
    expect(copy.body).not.toContain('()')
  })
})
