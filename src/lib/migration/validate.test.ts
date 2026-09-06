import { describe, expect, it } from 'vitest'

import {
  inferDateOrder,
  isTruthy,
  slugFrom,
  toAgorot,
  toCount,
  toIsoDate,
  validateRows,
} from './validate'
import type { FieldMapping, SourceRow } from './types'

function rows(...cells: Readonly<Record<string, string>>[]): SourceRow[] {
  return cells.map((entry, index) => ({ rowNumber: index + 2, cells: entry }))
}

const GUEST_MAP: FieldMapping[] = [
  { column: 'שם', field: 'fullName' },
  { column: 'טלפון', field: 'phone' },
  { column: 'אימייל', field: 'email' },
  { column: 'אזרחות', field: 'nationality' },
  { column: 'דיוור', field: 'marketingConsent' },
  { column: 'תוויות', field: 'tags' },
]

const BOOKING_MAP: FieldMapping[] = [
  { column: 'יחידה', field: 'unitName' },
  { column: 'אורח', field: 'guestName' },
  { column: 'הגעה', field: 'checkIn' },
  { column: 'עזיבה', field: 'checkOut' },
  { column: 'סכום', field: 'totalAgorot' },
  { column: 'מזהה', field: 'externalId' },
]

describe('the date ambiguity, which is the real hazard', () => {
  it('settles the whole file from one unambiguous value', () => {
    expect(inferDateOrder(['03/04/2026', '13/04/2026'])).toEqual({
      order: 'dmy',
      inferred: false,
      ambiguous: 1,
    })
    expect(inferDateOrder(['04/13/2026'])).toEqual({
      order: 'mdy',
      inferred: false,
      ambiguous: 0,
    })
  })

  it('says out loud when it had to assume', () => {
    expect(inferDateOrder(['03/04/2026'])).toEqual({
      order: 'dmy',
      inferred: true,
      ambiguous: 1,
    })

    const result = validateRows(
      rows({
        יחידה: 'וילה',
        אורח: 'דנה',
        הגעה: '03/04/2026',
        עזיבה: '07/04/2026',
      }),
      { entity: 'bookings', mappings: BOOKING_MAP },
    )

    expect(result.dateOrderInferred).toBe(true)
    const notice = result.issues.find((issue) => issue.severity === 'info')
    expect(notice?.message).toContain('יום/חודש/שנה')
  })

  it('reads the file the way the file says, not the way a locale says', () => {
    const result = validateRows(
      rows(
        {
          יחידה: 'וילה',
          אורח: 'א',
          הגעה: '13/04/2026',
          עזיבה: '17/04/2026',
        },
        {
          יחידה: 'וילה',
          אורח: 'ב',
          הגעה: '03/05/2026',
          עזיבה: '07/05/2026',
        },
      ),
      { entity: 'bookings', mappings: BOOKING_MAP },
    )

    expect(result.dateOrder).toBe('dmy')
    const second = result.records[1]
    expect(second?.values.entity === 'bookings' && second.values.booking.checkIn)
      .toBe('2026-05-03')
  })

  it('refuses a day the calendar does not have', () => {
    expect(toIsoDate('2026-04-31', 'ymd')).toBeNull()
    expect(toIsoDate('31/04/2026', 'dmy')).toBeNull()
    expect(toIsoDate('29/02/2024', 'dmy')).toBe('2024-02-29')
    expect(toIsoDate('3.4.2026', 'dmy')).toBe('2026-04-03')
    expect(toIsoDate('', 'dmy')).toBeNull()
  })
})

describe('money', () => {
  it('keeps the fraction, because dropping it divides revenue by a hundred', () => {
    expect(toAgorot('1250.5')).toBe(125_050)
    expect(toAgorot('₪1,250.50')).toBe(125_050)
    expect(toAgorot('1,250')).toBe(125_000)
    expect(toAgorot('שלוש מאות')).toBeNull()
  })

  it('reads a count without inventing a zero', () => {
    expect(toCount('4')).toBe(4)
    expect(toCount('1,200')).toBe(1200)
    expect(toCount('x')).toBeNull()
  })
})

describe('every refusal names the row, the column and the value', () => {
  it('never says only that a row is invalid', () => {
    const result = validateRows(
      rows({
        יחידה: 'וילה',
        אורח: 'דנה',
        הגעה: 'לא תאריך',
        עזיבה: '2026-04-07',
      }),
      { entity: 'bookings', mappings: BOOKING_MAP },
    )

    const issue = result.issues.find((entry) => entry.code === 'not_a_date')
    expect(issue?.rowNumber).toBe(2)
    expect(issue?.column).toBe('הגעה')
    expect(issue?.value).toBe('לא תאריך')
    expect(issue?.message).toContain('לא תאריך')
    expect(issue?.message).toContain('2026-04-03')
  })

  it('names a missing required field and points at the mapping step', () => {
    const result = validateRows(rows({ שם: '' }), {
      entity: 'guests',
      mappings: GUEST_MAP,
    })

    expect(result.records).toEqual([])
    expect(result.issues[0]?.code).toBe('missing_required')
    expect(result.issues[0]?.message).toContain('מיפוי')
  })

  it('refuses a reversed stay and explains what to do about it', () => {
    const result = validateRows(
      rows({
        יחידה: 'וילה',
        אורח: 'דנה',
        הגעה: '2026-04-07',
        עזיבה: '2026-04-03',
      }),
      { entity: 'bookings', mappings: BOOKING_MAP },
    )

    expect(result.records).toEqual([])
    expect(result.issues[0]?.code).toBe('range_reversed')
    expect(result.issues[0]?.message).toContain('החלף')
  })
})

describe('a bad field loses the field, not the record', () => {
  it('keeps the booking when the telephone number is unreadable', () => {
    const result = validateRows(rows({ שם: 'דנה', טלפון: '03-1234567' }), {
      entity: 'guests',
      mappings: GUEST_MAP,
    })

    expect(result.records).toHaveLength(1)
    const values = result.records[0]?.values
    expect(values?.entity === 'guests' && values.guest.phone).toBeNull()
    expect(result.issues[0]?.severity).toBe('warning')
    expect(result.issues[0]?.code).toBe('phone_unreadable')
  })

  it('normalises a good number through the one shared normaliser', () => {
    const result = validateRows(rows({ שם: 'דנה', טלפון: '050-123-4567' }), {
      entity: 'guests',
      mappings: GUEST_MAP,
    })

    const values = result.records[0]?.values
    expect(values?.entity === 'guests' && values.guest.phone).toBe(
      '+972501234567',
    )
  })

  it('drops a malformed address with a warning', () => {
    const result = validateRows(rows({ שם: 'דנה', אימייל: 'dana@' }), {
      entity: 'guests',
      mappings: GUEST_MAP,
    })

    const values = result.records[0]?.values
    expect(values?.entity === 'guests' && values.guest.email).toBeNull()
    expect(result.issues[0]?.code).toBe('email_malformed')
  })
})

describe('consent defaults to no', () => {
  it('does not turn marketing consent on because a column was blank', () => {
    const result = validateRows(rows({ שם: 'דנה' }), {
      entity: 'guests',
      mappings: GUEST_MAP,
    })

    const values = result.records[0]?.values
    expect(values?.entity === 'guests' && values.guest.marketingConsent).toBe(
      false,
    )
  })

  it('accepts the Hebrew and the English affirmative', () => {
    expect(isTruthy('כן')).toBe(true)
    expect(isTruthy('YES')).toBe(true)
    expect(isTruthy('לא')).toBe(false)
  })
})

describe('the record digest', () => {
  it('is over the understood record, not the raw text', () => {
    // A renamed column in the source is a cosmetic change and must not make
    // eighteen hundred bookings look new.
    const first = validateRows(rows({ שם: 'דנה כהן' }), {
      entity: 'guests',
      mappings: [{ column: 'שם', field: 'fullName' }],
    })
    const second = validateRows(rows({ Name: 'דנה כהן' }), {
      entity: 'guests',
      mappings: [{ column: 'Name', field: 'fullName' }],
    })

    expect(first.records[0]?.contentHash).toBe(second.records[0]?.contentHash)
  })

  it('carries the source identifier when one is mapped', () => {
    const result = validateRows(
      rows({
        מזהה: 'HM-1',
        יחידה: 'וילה',
        אורח: 'דנה',
        הגעה: '2026-04-03',
        עזיבה: '2026-04-07',
      }),
      { entity: 'bookings', mappings: BOOKING_MAP },
    )

    expect(result.records[0]?.sourceId).toBe('HM-1')
  })
})

describe('derived values', () => {
  it('builds a latin slug and falls back to the row rather than refusing', () => {
    expect(slugFrom('Villa Gilboa', 4)).toBe('villa-gilboa')
    expect(slugFrom('וילה הגלבוע', 4)).toBe('property-4')
  })

  it('sums a party when there is no total guest count', () => {
    const result = validateRows(
      rows({
        יחידה: 'וילה',
        אורח: 'דנה',
        הגעה: '2026-04-03',
        עזיבה: '2026-04-07',
        מבוגרים: '2',
        ילדים: '3',
      }),
      {
        entity: 'bookings',
        mappings: [
          ...BOOKING_MAP,
          { column: 'מבוגרים', field: 'adults' },
          { column: 'ילדים', field: 'children' },
        ],
      },
    )

    const values = result.records[0]?.values
    expect(values?.entity === 'bookings' && values.booking.guestCount).toBe(5)
  })
})
