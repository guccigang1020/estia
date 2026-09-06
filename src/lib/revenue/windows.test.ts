import { describe, expect, it } from 'vitest'

import { isWindowName, windowFor } from './windows'

describe('the window a screen asks for', () => {
  it('ends today without including tonight', () => {
    // Tonight has not happened. Counting it would put a guess about the
    // future inside a report about the past.
    expect(windowFor('30d', new Date('2026-09-06T22:41:00Z'))).toEqual({
      from: '2026-08-07',
      to: '2026-09-06',
    })
  })

  it('is the same window whatever time of day it is asked', () => {
    const morning = windowFor('90d', new Date('2026-09-06T00:01:00Z'))
    const midnight = windowFor('90d', new Date('2026-09-06T23:59:00Z'))
    expect(morning).toEqual(midnight)
  })

  it('covers a leap year without drifting', () => {
    expect(windowFor('365d', new Date('2028-03-01T10:00:00Z'))).toEqual({
      from: '2027-03-02',
      to: '2028-03-01',
    })
  })

  it('refuses a name it does not know', () => {
    expect(isWindowName('30d')).toBe(true)
    expect(isWindowName('all')).toBe(false)
    expect(isWindowName(undefined)).toBe(false)
  })
})
