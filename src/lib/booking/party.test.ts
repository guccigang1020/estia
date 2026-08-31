/**
 * The intake vocabulary, on its own.
 *
 * These functions are the *one* statement of the party rules: the create form
 * calls them to decide what to show in red, and `booking.create` calls the same
 * ones to decide what to refuse. That is the only arrangement under which a
 * screen and a server cannot disagree about what is wrong with a booking, and
 * it is worth testing directly rather than only through the two callers — a
 * rule that is right in the operation and wrong on the screen still costs
 * somebody a round trip and a confusing sentence.
 */

import { describe, expect, it } from 'vitest'

import {
  EVENT_TYPE_LABEL,
  describeParty,
  legacyParty,
  partyIssues,
  sleepingGuests,
  suggestedCouples,
  totalGuests,
  type BookingParty,
  type SleepingRequest,
} from './party'
import { EVENT_TYPES } from '../preparation/types'

const NOTHING_ASKED: SleepingRequest = {
  couples: 0,
  extraBedsRequested: 0,
  cotsRequested: 0,
}

function party(overrides: Partial<BookingParty> = {}): BookingParty {
  return { adults: 2, children: 0, infants: 0, ...overrides }
}

function fields(
  input: BookingParty,
  sleeping: SleepingRequest = NOTHING_ASKED,
  options: { maxGuests?: number } = {},
): string[] {
  return partyIssues(input, sleeping, options).map((issue) => issue.field)
}

describe('counting a party', () => {
  it('counts every head, and separately everyone who needs a bed', () => {
    const family = party({ adults: 4, children: 2, infants: 1 })

    expect(totalGuests(family)).toBe(7)
    // The infant is a guest and is not a sleeping place. Collapsing these two
    // numbers is what buys a bed nobody lies in.
    expect(sleepingGuests(family)).toBe(6)
  })

  it('suggests a couple for every two adults, and never more', () => {
    expect(suggestedCouples(party({ adults: 2 }))).toBe(1)
    expect(suggestedCouples(party({ adults: 5 }))).toBe(2)
    expect(suggestedCouples(party({ adults: 1 }))).toBe(0)
  })

  it('reads a count-only booking as the whole party in adults', () => {
    // Exactly what the Supabase adapter has always written, named rather than
    // left as an accident of the mapping.
    expect(legacyParty(5)).toEqual({ adults: 5, children: 0, infants: 0 })
  })
})

describe('refusing a party that cannot be one', () => {
  it('accepts the ordinary booking without complaint', () => {
    expect(fields(party(), { ...NOTHING_ASKED, couples: 1 })).toEqual([])
  })

  it('demands at least one adult', () => {
    expect(fields(party({ adults: 0 }))).toContain('adults')
  })

  it('refuses a count that is not a whole number of people', () => {
    expect(fields(party({ children: 1.5 }))).toContain('children')
    expect(fields(party({ infants: -1 }))).toContain('infants')
    expect(fields(party({ adults: NaN }))).toContain('adults')
  })

  it('refuses more couples than the adults can make', () => {
    const issues = partyIssues(party({ adults: 4 }), {
      ...NOTHING_ASKED,
      couples: 3,
    })

    expect(issues[0].field).toBe('couples')
    expect(issues[0].message).toContain('4 מבוגרים')
  })

  it('allows every adult to be in a couple, and none of them', () => {
    expect(
      fields(party({ adults: 4 }), { ...NOTHING_ASKED, couples: 2 }),
    ).toEqual([])
    expect(
      fields(party({ adults: 4 }), { ...NOTHING_ASKED, couples: 0 }),
    ).toEqual([])
  })

  it('counts infants against the unit’s capacity, because they are guests', () => {
    // A baby occupies no bed and does occupy the fire count and the towel
    // count. A capacity check that ignored them would sell a four-person cabin
    // to five people.
    const issues = partyIssues(
      party({ adults: 4, infants: 1 }),
      NOTHING_ASKED,
      {
        maxGuests: 4,
      },
    )

    expect(issues[0].field).toBe('adults')
    expect(issues[0].message).toContain('5')
  })

  it('says nothing about capacity when no unit has been chosen', () => {
    expect(fields(party({ adults: 40 }))).toEqual([])
  })

  it('reports every problem at once rather than the first', () => {
    // A form that reveals its problems one at a time is a form somebody submits
    // five times.
    expect(
      fields(party({ adults: 0, children: -1 }), {
        ...NOTHING_ASKED,
        cotsRequested: -2,
      }),
    ).toEqual(['adults', 'children', 'cotsRequested'])
  })
})

describe('saying the party out loud', () => {
  it('drops the zeroes, so an ordinary couple reads as one', () => {
    expect(describeParty(party())).toBe('2 מבוגרים')
    expect(describeParty(party({ adults: 1 }))).toBe('מבוגר אחד')
  })

  it('names children and infants when there are any', () => {
    expect(describeParty(party({ adults: 4, children: 2, infants: 1 }))).toBe(
      '4 מבוגרים, 2 ילדים, תינוק אחד',
    )
  })
})

describe('the event types, in Hebrew', () => {
  it('names every one of them', () => {
    // The map is a total `Record<EventType, string>`, so this cannot fail
    // without the build failing first — which is the point of asserting it: it
    // documents that adding to `EVENT_TYPES` obliges somebody to write the
    // Hebrew, rather than shipping `day_event` to a villa owner.
    for (const type of EVENT_TYPES) {
      expect(EVENT_TYPE_LABEL[type]).toBeTruthy()
    }
    expect(Object.keys(EVENT_TYPE_LABEL)).toHaveLength(EVENT_TYPES.length)
  })
})
