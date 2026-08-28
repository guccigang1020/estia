import { describe, expect, it } from 'vitest'

import {
  EMPTY_BOOKING_FILTERS,
  dateRangeIssue,
  describeFilters,
  hasActiveFilters,
  parseBookingFilters,
  toQueryString,
} from './filters'

describe('parseBookingFilters — a hand-edited URL cannot reach the query', () => {
  it('reads the four filters it knows', () => {
    const filters = parseBookingFilters({
      q: 'דנה',
      status: 'confirmed',
      from: '2026-09-01',
      to: '2026-09-30',
    })

    expect(filters).toEqual({
      search: 'דנה',
      status: 'confirmed',
      from: '2026-09-01',
      to: '2026-09-30',
    })
  })

  it('drops a status the contract does not contain', () => {
    // Reaching PostgREST, this would come back as a database error the user
    // cannot act on. Ignoring the meaningless part is the honest behaviour.
    expect(parseBookingFilters({ status: 'confirmed_ish' }).status).toBeNull()
    expect(parseBookingFilters({ status: "'; drop table" }).status).toBeNull()
  })

  it('drops a date that is not a day, pattern or no pattern', () => {
    expect(parseBookingFilters({ from: '2026-02-30' }).from).toBeNull()
    expect(parseBookingFilters({ from: 'yesterday' }).from).toBeNull()
    expect(parseBookingFilters({ from: '2026-09-01' }).from).toBe('2026-09-01')
  })

  it('takes the first value when a key repeats', () => {
    expect(parseBookingFilters({ q: ['a', 'b'] }).search).toBe('a')
  })

  it('trims the search, so a stray space is not an active filter', () => {
    expect(parseBookingFilters({ q: '   ' }).search).toBe('')
    expect(hasActiveFilters(parseBookingFilters({ q: '   ' }))).toBe(false)
  })

  it('reads an empty query string as no filter at all', () => {
    expect(parseBookingFilters({})).toEqual(EMPTY_BOOKING_FILTERS)
  })
})

describe('hasActiveFilters — the decision the empty state depends on', () => {
  it('is false for the empty filter', () => {
    expect(hasActiveFilters(EMPTY_BOOKING_FILTERS)).toBe(false)
  })

  it.each([
    ['search', { ...EMPTY_BOOKING_FILTERS, search: 'דנה' }],
    ['status', { ...EMPTY_BOOKING_FILTERS, status: 'inquiry' as const }],
    ['from', { ...EMPTY_BOOKING_FILTERS, from: '2026-09-01' }],
    ['to', { ...EMPTY_BOOKING_FILTERS, to: '2026-09-30' }],
  ])('is true when %s alone is set', (_name, filters) => {
    expect(hasActiveFilters(filters)).toBe(true)
  })
})

describe('describeFilters — what is hiding the data, said back', () => {
  it('names the property even though the user did not set it here', () => {
    // The property comes from the shell switcher, which is exactly the filter
    // a person forgets is on.
    expect(describeFilters(EMPTY_BOOKING_FILTERS, 'וילה הגליל')).toBe(
      'וילה הגליל',
    )
  })

  it('renders a status by its Hebrew name, never its enum value', () => {
    const summary = describeFilters({
      ...EMPTY_BOOKING_FILTERS,
      status: 'confirmed',
    })

    expect(summary).toBe('מאושרת')
    expect(summary).not.toContain('confirmed')
  })

  it('joins every active part', () => {
    expect(
      describeFilters(
        {
          search: 'דנה',
          status: 'option',
          from: '2026-09-01',
          to: '2026-09-30',
        },
        'וילה הגליל',
      ),
    ).toBe('וילה הגליל · חיפוש: דנה · אופציה · 1.9.2026 – 30.9.2026')
  })

  it('says which end of an open-ended window is set', () => {
    expect(
      describeFilters({ ...EMPTY_BOOKING_FILTERS, from: '2026-09-01' }),
    ).toBe('מ-1.9.2026')
    expect(
      describeFilters({ ...EMPTY_BOOKING_FILTERS, to: '2026-09-30' }),
    ).toBe('עד 30.9.2026')
  })

  it('is empty when nothing is filtered', () => {
    expect(describeFilters(EMPTY_BOOKING_FILTERS)).toBe('')
  })
})

describe('toQueryString — a filter is a link', () => {
  it('writes nothing for the empty filter', () => {
    expect(toQueryString(EMPTY_BOOKING_FILTERS)).toBe('')
  })

  it('omits the keys that are not set rather than writing them empty', () => {
    const query = toQueryString({
      ...EMPTY_BOOKING_FILTERS,
      status: 'confirmed',
    })

    expect(query).toBe('?status=confirmed')
    expect(query).not.toContain('q=')
  })

  it('round-trips through parse', () => {
    const filters = {
      search: 'דנה לוי',
      status: 'in_house' as const,
      from: '2026-09-01',
      to: '2026-09-30',
    }

    const params = Object.fromEntries(
      new URLSearchParams(toQueryString(filters).slice(1)),
    )

    expect(parseBookingFilters(params)).toEqual(filters)
  })
})

describe('dateRangeIssue — a reversed window is stated, not rendered empty', () => {
  it('is silent for a window that makes sense', () => {
    expect(
      dateRangeIssue({
        ...EMPTY_BOOKING_FILTERS,
        from: '2026-09-01',
        to: '2026-09-30',
      }),
    ).toBeNull()
  })

  it('allows a single day, which is a legitimate window', () => {
    expect(
      dateRangeIssue({
        ...EMPTY_BOOKING_FILTERS,
        from: '2026-09-01',
        to: '2026-09-01',
      }),
    ).toBeNull()
  })

  it('complains when the end is before the start', () => {
    // Without this the list renders empty, which is indistinguishable from a
    // business that has never taken a booking.
    expect(
      dateRangeIssue({
        ...EMPTY_BOOKING_FILTERS,
        from: '2026-09-30',
        to: '2026-09-01',
      }),
    ).toContain('מוקדם')
  })

  it('is silent when only one end is set', () => {
    expect(
      dateRangeIssue({ ...EMPTY_BOOKING_FILTERS, from: '2026-09-30' }),
    ).toBeNull()
  })
})
