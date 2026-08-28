import { describe, expect, it } from 'vitest'

import { OCCUPYING_STATUSES } from '@/lib/booking/types'

import {
  CALENDAR_STATE_META,
  legendStates,
  type CalendarDayState,
} from './state-meta'

const ALL: CalendarDayState[] = [
  'free',
  'booked',
  'held',
  'blocked',
  'unavailable',
]

describe('CALENDAR_STATE_META', () => {
  it('words every state the two engines can return', () => {
    for (const state of ALL) {
      const meta = CALENDAR_STATE_META[state]
      expect(meta.label, state).toMatch(/[֐-׿]/)
      expect(meta.description, state).toMatch(/[֐-׿]/)
      expect(meta.mark, state).not.toBe('')
    }
  })

  it('gives every state a mark, so colour is never the only signal', () => {
    const detailed = ['free', 'booked', 'held', 'blocked'] as const
    const marks = detailed.map((state) => CALENDAR_STATE_META[state].mark)
    // Within one vocabulary the marks must be distinguishable, or the fill is
    // doing the work after all.
    expect(new Set(marks).size).toBe(detailed.length)
  })

  it('carries no colour value of its own — tokens only', () => {
    for (const state of ALL) {
      expect(CALENDAR_STATE_META[state].className).not.toMatch(/#[0-9a-f]/i)
      expect(CALENDAR_STATE_META[state].className).not.toMatch(
        /\b(?:left|right)-/,
      )
    }
  })

  it('never tells a collapsed reader which kind of thing is in the way', () => {
    // The whole point of the collapsed vocabulary: "תפוס" must not distinguish
    // a booking from a hold, because that says a rival is mid-deal.
    const unavailable = CALENDAR_STATE_META.unavailable
    expect(unavailable.label).not.toBe(CALENDAR_STATE_META.booked.label)
    expect(unavailable.label).not.toBe(CALENDAR_STATE_META.held.label)
    expect(unavailable.description).not.toContain(
      CALENDAR_STATE_META.held.label,
    )
  })
})

describe('legendStates', () => {
  it('lists only the marks that were actually drawn', () => {
    expect(legendStates(['free', 'booked'])).toEqual(['free', 'booked'])
    expect(legendStates(['free', 'unavailable'])).toEqual([
      'free',
      'unavailable',
    ])
    expect(legendStates([])).toEqual([])
  })

  it('reads sellable first, whatever order the grid produced', () => {
    expect(legendStates(['blocked', 'booked', 'free'])).toEqual([
      'free',
      'booked',
      'blocked',
    ])
  })

  it('lists both vocabularies when both were drawn', () => {
    // A reader entitled to the internal diary on one property and not on
    // another sees both in one grid.
    expect(legendStates(['unavailable', 'held', 'free'])).toEqual([
      'free',
      'held',
      'unavailable',
    ])
  })

  it('deduplicates', () => {
    expect(legendStates(['free', 'free', 'booked', 'booked'])).toEqual([
      'free',
      'booked',
    ])
  })
})

describe('the vocabulary is the domain’s', () => {
  it('does not restate which booking statuses occupy the calendar', () => {
    // A guard against the obvious wrong turn: a calendar component that
    // listed occupying statuses of its own would be a second definition of
    // "taken". The set lives in the booking contract and is imported, never
    // copied — this asserts it is still non-empty there rather than here.
    expect(OCCUPYING_STATUSES.length).toBeGreaterThan(0)
    expect(Object.keys(CALENDAR_STATE_META)).not.toContain('confirmed')
  })
})
