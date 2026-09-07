import { describe, expect, it } from 'vitest'

import type { CalendarDayState } from '@/components/calendar/state-meta'

import type { UnitMonth } from './availability'
import { monthShape, occupancyPercent } from './month-shape'

/**
 * A grid row from a string, one character per night, so a case reads as the
 * month it describes rather than as an array of objects.
 *
 *   `.` free   `#` booked   `~` held   `x` blocked   `?` unavailable
 */
function row(cells: string): UnitMonth {
  const state: Record<string, CalendarDayState> = {
    '.': 'free',
    '#': 'booked',
    '~': 'held',
    x: 'blocked',
    '?': 'unavailable',
  }

  return {
    // Only `rows.length` is read from the unit, so the row carries no unit
    // rather than a fabricated one — a fixture with a plausible villa in it
    // invites a future assertion about a name this function never sees.
    unit: undefined as unknown as UnitMonth['unit'],
    days: [...cells].map((character, index) => {
      const value = state[character]
      if (!value) throw new Error(`unknown cell: ${character}`)
      return {
        date: `2026-09-${String(index + 1).padStart(2, '0')}`,
        state: value,
      }
    }),
  }
}

describe('monthShape', () => {
  it('counts the cells it was given, and nothing else', () => {
    const shape = monthShape([row('..##'), row('.#~x')])

    expect(shape.units).toBe(2)
    expect(shape.cells).toBe(8)
    expect(shape.blocked).toBe(1)
    expect(shape.sellable).toBe(7)
    expect(shape.free).toBe(3)
    expect(shape.occupied).toBe(4)
  })

  it('leaves blocked nights out of the denominator', () => {
    // Four nights, two of them never on the shelf, one of the rest sold.
    const shape = monthShape([row('#.xx')])

    expect(shape.sellable).toBe(2)
    expect(shape.occupancy).toBe(0.5)
  })

  it('is null and not zero when nothing in view was sellable', () => {
    // A villa closed for renovation for the whole month. 0% would read as a
    // catastrophic failure to sell; there was nothing to sell.
    const shape = monthShape([row('xxxx'), row('xxxx')])

    expect(shape.sellable).toBe(0)
    expect(shape.occupancy).toBeNull()
    expect(shape.occupancy).not.toBe(0)
  })

  it('is null for an empty grid rather than throwing', () => {
    const shape = monthShape([])

    expect(shape.cells).toBe(0)
    expect(shape.occupancy).toBeNull()
    expect(shape.held).toEqual({ known: true, count: 0 })
  })

  it('reports a full month as 1 and an open one as 0', () => {
    expect(monthShape([row('####')]).occupancy).toBe(1)
    expect(monthShape([row('....')]).occupancy).toBe(0)
  })

  it('counts a hold as occupied, because the night is not open', () => {
    const shape = monthShape([row('~~..')])

    expect(shape.occupied).toBe(2)
    expect(shape.free).toBe(2)
  })

  it('knows the hold count only when the whole grid is the detailed kind', () => {
    expect(monthShape([row('~#..')]).held).toEqual({ known: true, count: 1 })
  })

  it('refuses a partial hold count as soon as one row is collapsed', () => {
    // The second row is a unit this reader may not see the diary of, so its
    // holds are indistinguishable from its bookings. Reporting the first row's
    // single hold as the month's hold count would be believed and wrong.
    const shape = monthShape([row('~#..'), row('??..')])

    expect(shape.held).toEqual({ known: false })
    expect(shape.occupied).toBe(4)
  })

  it('treats a collapsed night as occupied, like the diary states it hides', () => {
    expect(monthShape([row('??..')]).occupancy).toBe(0.5)
  })
})

describe('occupancyPercent', () => {
  it('passes null through rather than turning it into a number', () => {
    expect(occupancyPercent(null)).toBeNull()
  })

  it('rounds down, so a month is never reported fuller than it is', () => {
    // 29 of 30 nights. Rounding to nearest would print 97%; flooring prints 96
    // and keeps "100%" meaning every night.
    expect(occupancyPercent(29 / 30)).toBe(96)
    expect(occupancyPercent(0.999)).toBe(99)
    expect(occupancyPercent(1)).toBe(100)
    expect(occupancyPercent(0)).toBe(0)
  })
})
