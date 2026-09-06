import { describe, expect, it } from 'vitest'

import { dryRun } from './dryrun'
import { bookingRecord, guestRecord } from './fixtures'
import {
  drillDown,
  entityRows,
  failureGroups,
  summarise,
  summariseDryRun,
  suppressionSentence,
  traceRow,
} from './report'
import type { CompletionReport } from './types'

const REPORT: CompletionReport = {
  sessionId: 'session-1',
  startedAt: '2026-09-06T09:00:00.000Z',
  finishedAt: '2026-09-06T09:04:00.000Z',
  interrupted: false,
  results: [
    {
      rowNumber: 2,
      entity: 'bookings',
      outcome: 'created',
      createdId: 'b-1',
      message: null,
    },
    {
      rowNumber: 3,
      entity: 'bookings',
      outcome: 'failed',
      createdId: null,
      message: 'היחידה אינה קיימת',
    },
    {
      rowNumber: 4,
      entity: 'bookings',
      outcome: 'failed',
      createdId: null,
      message: 'היחידה אינה קיימת',
    },
    {
      rowNumber: 5,
      entity: 'bookings',
      outcome: 'failed',
      createdId: null,
      message: 'התאריכים תפוסים',
    },
  ],
  byEntity: [],
  issues: [
    {
      rowNumber: 3,
      entity: 'bookings',
      severity: 'error',
      code: 'unit_not_found',
      field: 'unitName',
      column: 'יחידה',
      value: 'וילה X',
      message: 'לא נמצאה יחידה',
    },
  ],
  conflicts: [],
  suppressedEvents: [
    { name: 'booking.created', rowNumber: 2, reason: 'ייבוא' },
    { name: 'guest.created', rowNumber: 2, reason: 'ייבוא' },
  ],
}

describe('a count is not a report', () => {
  it('lists the rows behind every number', () => {
    expect(drillDown(REPORT, 'failed').rowNumbers).toEqual([3, 4, 5])
    expect(drillDown(REPORT, 'created', 'bookings').rowNumbers).toEqual([2])
  })

  it('answers "what happened to row 3" with everything about row 3', () => {
    const trace = traceRow(REPORT, 3)
    expect(trace.result?.outcome).toBe('failed')
    expect(trace.issues[0]?.value).toBe('וילה X')
  })

  it('groups failures by cause, largest first', () => {
    // Forty failures with one cause is a two-minute fix; forty with forty
    // causes is a bad file. A single count describes both.
    const groups = failureGroups(REPORT)
    expect(groups[0]?.message).toBe('היחידה אינה קיימת')
    expect(groups[0]?.rowNumbers).toEqual([3, 4])
    expect(groups[1]?.rowNumbers).toEqual([5])
  })
})

describe('the sentences', () => {
  it('summarises in words rather than four numbers in four boxes', () => {
    expect(summarise(REPORT)).toContain('1 רשומות נוצרו')
    expect(summarise(REPORT)).toContain('3 נכשלו')
  })

  it('says an interrupted run can be continued', () => {
    expect(summarise({ ...REPORT, interrupted: true })).toContain('להמשיך')
  })

  it('states the promise about the guests with its evidence under it', () => {
    const sentence = suppressionSentence(REPORT)
    expect(sentence).toContain('2 אירועים')
    expect(sentence).toContain('booking.created')
    expect(sentence).toContain('guest.created')
  })

  it('says plainly when nothing was suppressed', () => {
    expect(suppressionSentence({ ...REPORT, suppressedEvents: [] })).toContain(
      'לא הפעיל',
    )
  })
})

describe('the dry run headline', () => {
  it('leads with what will not happen', () => {
    const report = dryRun({
      records: [
        guestRecord(2, { fullName: 'דנה' }),
        bookingRecord(3, {
          guestName: 'דנה',
          unitName: 'וילה שלא קיימת',
          checkIn: '2023-01-01',
          checkOut: '2023-01-04',
        }),
      ],
      world: {
        guests: [],
        calendar: { units: [], bookings: [], blocks: [] },
        ledger: [],
      },
      computedOn: '2026-09-06',
      decisions: [],
      issues: [],
    })

    const headline = summariseDryRun(report)
    expect(headline).toContain('ממתינות להחלטה')
    expect(headline).toContain('רשומות ייכתבו')
    expect(entityRows(report)[0]?.label).toBe('אורחים')
  })

  it('names the historic stays so nobody wonders about the messages', () => {
    const report = dryRun({
      records: [
        bookingRecord(2, {
          guestName: 'דנה',
          unitName: 'וילה',
          checkIn: '2023-01-01',
          checkOut: '2023-01-04',
        }),
      ],
      world: {
        guests: [],
        calendar: {
          units: [
            {
              id: 'u-1',
              name: 'וילה',
              propertyId: null,
              propertyName: null,
            },
          ],
          bookings: [],
          blocks: [],
        },
        ledger: [],
      },
      computedOn: '2026-09-06',
      decisions: [],
      issues: [],
    })

    expect(summariseDryRun(report)).toContain('לא ישלחו הודעה')
  })
})
