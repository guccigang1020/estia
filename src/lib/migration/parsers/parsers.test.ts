import { describe, expect, it } from 'vitest'

import {
  detectFormat,
  guestNameFrom,
  icalDate,
  isBinaryWorkbook,
  marksUnavailable,
  parseDelimitedFile,
  parseIcal,
  parseSource,
  unescapeText,
  unfold,
} from './index'

describe('detecting what a file actually is', () => {
  it('reads a calendar as a calendar whatever it is called', () => {
    expect(detectFormat('BEGIN:VCALENDAR\r\nEND:VCALENDAR', 'download')).toBe(
      'ical',
    )
    expect(
      detectFormat('BEGIN:VCALENDAR\r\nEND:VCALENDAR', 'bookings.csv'),
    ).toBe('ical')
  })

  it('recognises a renamed binary workbook rather than parsing zip noise', () => {
    // A real person renames bookings.xlsx to bookings.csv because a previous
    // product told them to. Reading it as text produces four hundred rows of
    // unactionable rubbish.
    expect(detectFormat('PKrest', 'bookings.csv')).toBe(
      'excel_binary',
    )
    expect(isBinaryWorkbook('PK')).toBe(true)
  })

  it('counts delimiters over several lines, not only the header', () => {
    const tsv = 'Bookings\nא\tב\tג\nד\tה\tו'
    expect(detectFormat(tsv, 'export.txt')).toBe('excel')
    expect(detectFormat(tsv)).toBe('tsv')
    expect(detectFormat('a,b\n1,2', 'x.csv')).toBe('csv')
  })

  it('answers "I do not know" rather than guessing', () => {
    expect(detectFormat('%PDF-1.7 some binary-ish text', 'report.pdf')).toBe(
      'unknown',
    )
    const parsed = parseSource('%PDF-1.7 rubbish', {
      entity: 'bookings',
      fileName: 'report.pdf',
    })
    expect(parsed.rows).toEqual([])
    expect(parsed.issues[0]?.code).toBe('unknown_format')
  })

  it('refuses a binary workbook with the sentence that unblocks the operator', () => {
    const parsed = parseSource('PKbinary', {
      entity: 'bookings',
      fileName: 'bookings.xlsx',
    })
    expect(parsed.issues[0]?.code).toBe('binary_spreadsheet')
    expect(parsed.issues[0]?.message).toContain('CSV')
  })
})

describe('delimited files', () => {
  it('keys cells by the header the source wrote, untranslated', () => {
    const parsed = parseDelimitedFile('שם,טלפון\nדנה,0501234567', {
      entity: 'guests',
    })
    expect(parsed.columns).toEqual(['שם', 'טלפון'])
    expect(parsed.rows[0]?.cells).toEqual({ שם: 'דנה', טלפון: '0501234567' })
  })

  it('numbers rows the way the operator sees them, header included', () => {
    const parsed = parseDelimitedFile('a,b\n1,2\n3,4', { entity: 'guests' })
    expect(parsed.rows.map((row) => row.rowNumber)).toEqual([2, 3])
  })

  it('gives blank and repeated headers stable names instead of refusing', () => {
    const parsed = parseDelimitedFile('שם,,שם\nא,ב,ג', { entity: 'guests' })
    expect(parsed.columns).toEqual(['שם', 'עמודה 2', 'שם (2)'])
  })

  it('reports an over-long row with its number and keeps reading', () => {
    const parsed = parseDelimitedFile('a,b\n1,2,3\n4,5', { entity: 'guests' })
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.issues[0]?.rowNumber).toBe(2)
    expect(parsed.issues[0]?.severity).toBe('warning')
  })

  it('reports an empty file rather than throwing', () => {
    const parsed = parseDelimitedFile('   \n  ', { entity: 'guests' })
    expect(parsed.issues[0]?.code).toBe('empty_file')
  })
})

describe('iCal, the export this market actually has', () => {
  const CALENDAR = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:HMABCD1234@airbnb.com',
    'DTSTART;VALUE=DATE:20260103',
    'DTEND;VALUE=DATE:20260105',
    'SUMMARY:Reserved',
    'DESCRIPTION:Guest Name: Dana Co',
    ' hen\\nPhone: 050-1234567',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:block-1',
    'DTSTART;VALUE=DATE:20260201',
    'DTEND;VALUE=DATE:20260205',
    'SUMMARY:CLOSED - Not available',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  it('takes DTEND as written, because it is already exclusive', () => {
    // Subtracting a day here would turn every same-day changeover into a false
    // conflict and delete one sellable night per turnover.
    const parsed = parseIcal(CALENDAR, {
      entity: 'bookings',
      unitName: 'וילה הגלבוע',
    })
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0]?.cells.DTSTART).toBe('2026-01-03')
    expect(parsed.rows[0]?.cells.DTEND).toBe('2026-01-05')
  })

  it('unfolds a folded description and recovers the guest name', () => {
    const parsed = parseIcal(CALENDAR, { entity: 'bookings' })
    expect(parsed.rows[0]?.cells.GUEST_NAME).toBe('Dana Cohen')
  })

  it('keeps an unavailable event out of the bookings and in the blocks', () => {
    const asBookings = parseIcal(CALENDAR, { entity: 'bookings' })
    const asBlocks = parseIcal(CALENDAR, { entity: 'blocked_dates' })

    expect(asBookings.rows.map((row) => row.cells.UID)).toEqual([
      'HMABCD1234@airbnb.com',
    ])
    expect(asBlocks.rows.map((row) => row.cells.UID)).toEqual(['block-1'])
  })

  it('carries the source identifier through, which is the idempotency key', () => {
    const parsed = parseIcal(CALENDAR, { entity: 'bookings' })
    expect(parsed.rows[0]?.cells.UID).toBe('HMABCD1234@airbnb.com')
  })

  it('refuses an event with no readable dates and names its line', () => {
    const broken = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:x',
      'SUMMARY:Reserved',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')

    const parsed = parseIcal(broken, { entity: 'bookings' })
    expect(parsed.rows).toEqual([])
    expect(parsed.issues[0]?.code).toBe('not_a_date')
    expect(parsed.issues[0]?.rowNumber).toBe(2)
  })

  it('discards the clock from a timed event rather than inventing precision', () => {
    expect(icalDate('20260103T150000Z')).toBe('2026-01-03')
    expect(icalDate('TZID=Asia/Jerusalem:20260103T150000')).toBe('2026-01-03')
    expect(icalDate('not a date')).toBeNull()
    expect(icalDate('20261301')).toBeNull()
  })

  it('unfolds, unescapes and recognises the channel vocabulary', () => {
    expect(unfold('A\r\n B').join('|')).toBe('AB')
    expect(unescapeText('a\\nb\\,c')).toBe('a\nb,c')
    expect(marksUnavailable('CLOSED - Not available')).toBe(true)
    expect(marksUnavailable('לא זמין')).toBe(true)
    expect(marksUnavailable('Reserved')).toBe(false)
    expect(guestNameFrom('Guest: Dana')).toBe('Dana')
    expect(guestNameFrom('Confirmation: HMX')).toBeNull()
  })
})
