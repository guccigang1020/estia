/**
 * The guest filter, as a pure function of the URL.
 *
 * Two of these assertions are about mistakes no screenshot reveals. The first
 * is `hasActiveGuestFilters`, which decides between "עוד לא נרשמו אורחים" and
 * "אין אורחים שתואמים לסינון" — show the first to a business with
 * twenty-seven guests and you have told them the system lost their customer
 * list. The second is that a hand-edited URL has the part that means nothing
 * ignored rather than passed to PostgREST, where it comes back as a database
 * error the reader cannot act on.
 */

import { describe, expect, it } from 'vitest'

import {
  EMPTY_GUEST_FILTERS,
  describeGuestFilters,
  hasActiveGuestFilters,
  parseGuestFilters,
  toGuestQueryString,
} from './filters'

describe('parsing the URL', () => {
  it('reads every key', () => {
    expect(
      parseGuestFilters({
        q: '  תמר  ',
        tag: 'חוזרת',
        status: 'blocked',
        consent: 'granted',
      }),
    ).toEqual({
      search: 'תמר',
      tag: 'חוזרת',
      status: 'blocked',
      consent: 'granted',
    })
  })

  it('returns the empty filter for an empty query string', () => {
    expect(parseGuestFilters({})).toEqual(EMPTY_GUEST_FILTERS)
  })

  it('drops a status and a consent value that are not in the vocabulary', () => {
    const filters = parseGuestFilters({
      status: 'deleted',
      consent: 'maybe',
    })

    expect(filters.status).toBeNull()
    expect(filters.consent).toBeNull()
  })

  it('keeps an unknown tag, because there is no vocabulary to check it against', () => {
    // `guests.tags` is free text the business invents. A tag nobody uses is a
    // filter that matches nothing, which is a truthful answer — and the empty
    // state then names the tag that emptied the list.
    expect(parseGuestFilters({ tag: 'לא-קיימת' }).tag).toBe('לא-קיימת')
  })

  it('treats a blank tag as no tag at all', () => {
    expect(parseGuestFilters({ tag: '   ' }).tag).toBeNull()
  })

  it('takes the first value when a key repeats', () => {
    // `?tag=a&tag=b` really does arrive as an array.
    expect(parseGuestFilters({ tag: ['חוזרת', 'עסקי'] }).tag).toBe('חוזרת')
  })
})

describe('is anything hiding rows', () => {
  it('says no for the empty filter', () => {
    expect(hasActiveGuestFilters(EMPTY_GUEST_FILTERS)).toBe(false)
  })

  it.each([
    ['search', { search: 'תמר' }],
    ['tag', { tag: 'חוזרת' }],
    ['status', { status: 'blocked' as const }],
    ['consent', { consent: 'withheld' as const }],
  ])('says yes for %s alone', (_label, partial) => {
    expect(hasActiveGuestFilters({ ...EMPTY_GUEST_FILTERS, ...partial })).toBe(
      true,
    )
  })
})

describe('saying the filter back to the person', () => {
  it('names every part, property first', () => {
    expect(
      describeGuestFilters(
        {
          search: 'תמר',
          tag: 'חוזרת',
          status: 'blocked',
          consent: 'granted',
        },
        'אחוזת רימונים',
      ),
    ).toBe('אחוזת רימונים · חיפוש: תמר · תגית: חוזרת · חסומים · אישרו דיוור')
  })

  it('is empty when nothing is filtered', () => {
    expect(describeGuestFilters(EMPTY_GUEST_FILTERS)).toBe('')
  })

  it('names the property even when the reader set no filter of their own', () => {
    // The shell's property switcher is the filter people forget about, and on
    // this screen it is the sharpest one: a guest with no stay at that
    // property disappears entirely.
    expect(describeGuestFilters(EMPTY_GUEST_FILTERS, 'וילה כחול ים')).toBe(
      'וילה כחול ים',
    )
  })
})

describe('back to a query string', () => {
  it('omits the keys that are not set', () => {
    expect(toGuestQueryString({ ...EMPTY_GUEST_FILTERS, search: 'תמר' })).toBe(
      '?q=%D7%AA%D7%9E%D7%A8',
    )
  })

  it('is empty for the empty filter, so a cleared filter has a clean URL', () => {
    expect(toGuestQueryString(EMPTY_GUEST_FILTERS)).toBe('')
  })

  it('round-trips through the parser', () => {
    const filters = {
      search: 'ג׳ורג׳',
      tag: 'תייר',
      status: 'active' as const,
      consent: 'withheld' as const,
    }

    const query = toGuestQueryString(filters)
    const params = Object.fromEntries(
      new URLSearchParams(query.slice(1)).entries(),
    )

    expect(parseGuestFilters(params)).toEqual(filters)
  })
})
