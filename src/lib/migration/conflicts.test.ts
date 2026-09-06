import { describe, expect, it } from 'vitest'

import {
  applicableRows,
  decide,
  detectConflicts,
  findUnit,
  normalizeUnitName,
  skippedRows,
  undecidedRows,
  type ExistingCalendar,
} from './conflicts'
import { bookingRecord } from './fixtures'

const UNIT = {
  id: 'unit-1',
  name: 'וילה הגלבוע',
  propertyId: 'prop-1',
  propertyName: 'הגלבוע',
}

const CALENDAR: ExistingCalendar = {
  units: [UNIT],
  bookings: [],
  blocks: [],
}

describe('an overlap is a decision, never a silent drop', () => {
  it('turns a collision with an existing booking into a conflict', () => {
    const conflicts = detectConflicts(
      [
        bookingRecord(2, {
          guestName: 'דנה כהן',
          unitName: 'וילה הגלבוע',
          checkIn: '2026-10-01',
          checkOut: '2026-10-05',
        }),
      ],
      {
        ...CALENDAR,
        bookings: [
          {
            id: 'b-1',
            reference: 'EST-1001',
            unitId: 'unit-1',
            unitName: 'וילה הגלבוע',
            guestName: 'רון לוי',
            status: 'confirmed',
            checkIn: '2026-10-03',
            checkOut: '2026-10-08',
          },
        ],
      },
    )

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.kind).toBe('booking_overlaps_booking')
    expect(conflicts[0]?.decision).toBe('undecided')
    // Both sides described well enough to choose without leaving the screen.
    expect(conflicts[0]?.left.label).toBe('דנה כהן')
    expect(conflicts[0]?.right.label).toContain('רון לוי')
    expect(conflicts[0]?.right.label).toContain('EST-1001')
  })

  it('does not drop the colliding record from the input', () => {
    const records = [
      bookingRecord(2, {
        guestName: 'א',
        unitName: 'וילה הגלבוע',
        checkIn: '2026-10-01',
        checkOut: '2026-10-05',
      }),
      bookingRecord(3, {
        guestName: 'ב',
        unitName: 'וילה הגלבוע',
        checkIn: '2026-10-02',
        checkOut: '2026-10-06',
      }),
    ]

    const conflicts = detectConflicts(records, CALENDAR)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.kind).toBe('booking_overlaps_import')

    // The record is still there. It is blocked from writing until settled, and
    // it becomes writable the moment somebody says so.
    expect(records).toHaveLength(2)
    expect(applicableRows(records, conflicts).map((r) => r.rowNumber)).toEqual([
      2,
    ])
    const settled = decide(conflicts, conflicts[0]?.id ?? '', 'import_anyway')
    expect(applicableRows(records, settled).map((r) => r.rowNumber)).toEqual([
      2, 3,
    ])
  })

  it('does not treat a same-day changeover as a collision', () => {
    // The whole calendar's worth of sellable turnover nights hangs on this.
    const conflicts = detectConflicts(
      [
        bookingRecord(2, {
          guestName: 'ב',
          unitName: 'וילה הגלבוע',
          checkIn: '2026-10-05',
          checkOut: '2026-10-09',
        }),
      ],
      {
        ...CALENDAR,
        bookings: [
          {
            id: 'b-1',
            reference: 'EST-1',
            unitId: 'unit-1',
            unitName: 'וילה הגלבוע',
            guestName: 'א',
            status: 'confirmed',
            checkIn: '2026-10-01',
            checkOut: '2026-10-05',
          },
        ],
      },
    )

    expect(conflicts).toEqual([])
  })

  it('ignores a cancelled booking, which holds no dates', () => {
    const conflicts = detectConflicts(
      [
        bookingRecord(2, {
          guestName: 'ב',
          unitName: 'וילה הגלבוע',
          checkIn: '2026-10-01',
          checkOut: '2026-10-05',
        }),
      ],
      {
        ...CALENDAR,
        bookings: [
          {
            id: 'b-1',
            reference: 'EST-1',
            unitId: 'unit-1',
            unitName: 'וילה הגלבוע',
            guestName: 'א',
            status: 'cancelled',
            checkIn: '2026-10-01',
            checkOut: '2026-10-05',
          },
        ],
      },
    )

    expect(conflicts).toEqual([])
  })
})

describe('an owner stay and a maintenance block ask different questions', () => {
  it('names the owner stay as its own kind', () => {
    const conflicts = detectConflicts(
      [
        bookingRecord(2, {
          guestName: 'דנה',
          unitName: 'וילה הגלבוע',
          checkIn: '2026-08-01',
          checkOut: '2026-08-05',
        }),
      ],
      {
        ...CALENDAR,
        blocks: [
          {
            id: 'block-1',
            unitId: 'unit-1',
            unitName: 'וילה הגלבוע',
            kind: 'owner_stay',
            label: 'שהות בעלים',
            checkIn: '2026-08-02',
            checkOut: '2026-08-04',
          },
        ],
      },
    )

    expect(conflicts[0]?.kind).toBe('booking_overlaps_owner_stay')
    expect(conflicts[0]?.question).toContain('בעלים')
  })

  it('names the maintenance block separately', () => {
    const conflicts = detectConflicts(
      [
        bookingRecord(2, {
          guestName: 'דנה',
          unitName: 'וילה הגלבוע',
          checkIn: '2026-08-01',
          checkOut: '2026-08-05',
        }),
      ],
      {
        ...CALENDAR,
        blocks: [
          {
            id: 'block-2',
            unitId: 'unit-1',
            unitName: 'וילה הגלבוע',
            kind: 'maintenance',
            label: 'החלפת דוד',
            checkIn: '2026-08-02',
            checkOut: '2026-08-04',
          },
        ],
      },
    )

    expect(conflicts[0]?.kind).toBe('booking_overlaps_maintenance')
    expect(conflicts[0]?.question).toContain('תחזוקה')
  })
})

describe('unit resolution', () => {
  it('raises a conflict rather than guessing when the unit is unknown', () => {
    const conflicts = detectConflicts(
      [
        bookingRecord(2, {
          guestName: 'דנה',
          unitName: 'וילה מסתורית',
          checkIn: '2026-08-01',
          checkOut: '2026-08-05',
        }),
      ],
      CALENDAR,
    )

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.kind).toBe('unit_mismatch')
    // The list of real unit names is on the conflict, so the operator can map
    // it without opening another screen.
    expect(conflicts[0]?.right.detail).toContain('וילה הגלבוע')
  })

  it('refuses to choose between two units sharing a name', () => {
    const units = [
      { id: 'u-1', name: 'יחידה 1', propertyId: 'p-1', propertyName: 'צפון' },
      { id: 'u-2', name: 'יחידה 1', propertyId: 'p-2', propertyName: 'דרום' },
    ]

    expect(findUnit(units, 'יחידה 1', null)).toBeNull()
    expect(findUnit(units, 'יחידה 1', 'דרום')?.id).toBe('u-2')
  })

  it('matches a unit name across quoting and spacing but not across digits', () => {
    expect(normalizeUnitName('וילה  ״הגלבוע״ ')).toBe('וילה הגלבוע')
    expect(normalizeUnitName('יחידה 1')).not.toBe(normalizeUnitName('יחידה 2'))
  })
})

describe('decisions', () => {
  it('keeps an undecided conflict blocking and a settled skip blocking too', () => {
    const conflicts = detectConflicts(
      [
        bookingRecord(2, {
          guestName: 'א',
          unitName: 'וילה לא ידועה',
          checkIn: '2026-08-01',
          checkOut: '2026-08-05',
        }),
      ],
      CALENDAR,
    )

    expect([...undecidedRows(conflicts)]).toEqual([2])
    expect([...skippedRows(conflicts)]).toEqual([])

    const settled = decide(conflicts, conflicts[0]?.id ?? '', 'skip_record')
    expect([...skippedRows(settled)]).toEqual([2])
    expect([...undecidedRows(settled)]).toEqual([])
  })
})
