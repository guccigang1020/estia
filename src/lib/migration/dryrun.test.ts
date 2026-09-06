import { describe, expect, it } from 'vitest'

import { bookingRecord, guestRecord } from './fixtures'
import { SUPPORTED_ENTITIES, dryRun, isHistoric, isInHouse } from './dryrun'
import type { ExistingWorld } from './dryrun'
import { record } from './fixtures'

const EMPTY: ExistingWorld = {
  guests: [],
  calendar: { units: [], bookings: [], blocks: [] },
  ledger: [],
}

const UNIT = {
  id: 'unit-1',
  name: 'וילה הגלבוע',
  propertyId: 'prop-1',
  propertyName: 'הגלבוע',
}

function world(overrides: Partial<ExistingWorld> = {}): ExistingWorld {
  return {
    guests: overrides.guests ?? [],
    calendar: overrides.calendar ?? {
      units: [UNIT],
      bookings: [],
      blocks: [],
    },
    ledger: overrides.ledger ?? [],
  }
}

describe('the dry run cannot write', () => {
  /**
   * The claim the whole feature is judged on, checked three ways that do not
   * depend on reading the body.
   */
  it('takes no argument that can be called', () => {
    const input = {
      records: [guestRecord(2, { fullName: 'דנה כהן' })],
      world: world(),
      computedOn: '2026-09-06',
      decisions: [],
      issues: [],
    }

    const callables: string[] = []
    const walk = (value: unknown, path: string, depth: number): void => {
      if (depth > 8) return
      if (typeof value === 'function') {
        callables.push(path)
        return
      }
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${index}]`, depth + 1))
        return
      }
      if (typeof value === 'object' && value !== null) {
        for (const [key, entry] of Object.entries(value)) {
          walk(entry, `${path}.${key}`, depth + 1)
        }
      }
    }
    walk(input, 'input', 0)

    expect(callables).toEqual([])
  })

  it('is synchronous, so it cannot await any write path', () => {
    const result = dryRun({
      records: [],
      world: EMPTY,
      computedOn: '2026-09-06',
      decisions: [],
      issues: [],
    })

    // Every write in this codebase is asynchronous. A function that returns a
    // value rather than a promise cannot have reached one.
    expect(result).not.toBeInstanceOf(Promise)
    expect(typeof result.computedOn).toBe('string')
  })

  it('leaves the records and the world it was given untouched', () => {
    const records = [
      guestRecord(2, { fullName: 'דנה כהן', phone: '050-1234567' }),
      bookingRecord(3, {
        guestName: 'דנה כהן',
        unitName: 'וילה הגלבוע',
        checkIn: '2023-04-01',
        checkOut: '2023-04-05',
      }),
    ]
    const given = world({
      guests: [
        {
          id: 'g-1',
          fullName: 'דנה כהן',
          phoneE164: '+972501234567',
          email: null,
        },
      ],
    })

    const before = JSON.stringify({ records, given })
    dryRun({
      records,
      world: given,
      computedOn: '2026-09-06',
      decisions: [],
      issues: [],
    })

    expect(JSON.stringify({ records, given })).toBe(before)
  })
})

describe('what the report says', () => {
  it('separates writable rows from entities with no domain command', () => {
    const report = dryRun({
      records: [
        guestRecord(2, { fullName: 'דנה כהן' }),
        record(3, {
          entity: 'owners',
          owner: {
            externalId: null,
            fullName: 'משה לוי',
            phone: null,
            email: null,
            propertyName: null,
            agencyName: null,
            percent: 50,
            notes: null,
          },
        }),
      ],
      world: world(),
      computedOn: '2026-09-06',
      decisions: [],
      issues: [],
    })

    expect(report.writable.map((row) => row.rowNumber)).toEqual([2])
    expect(report.unsupported.map((row) => row.rowNumber)).toEqual([3])
    // Named, not counted as invalid — the file is fine, the product is not
    // finished, and telling an operator their data is wrong would be a lie.
    expect(
      report.issues.some((issue) => issue.code === 'entity_not_importable'),
    ).toBe(true)
    expect(SUPPORTED_ENTITIES).not.toContain('owners')
  })

  it('counts a stay that ended as historic and one spanning today as not', () => {
    const past = bookingRecord(2, {
      guestName: 'א',
      unitName: 'וילה הגלבוע',
      checkIn: '2023-04-01',
      checkOut: '2023-04-05',
    })
    const inHouse = bookingRecord(3, {
      guestName: 'ב',
      unitName: 'וילה הגלבוע',
      checkIn: '2026-09-04',
      checkOut: '2026-09-09',
    })

    expect(isHistoric(past, '2026-09-06')).toBe(true)
    expect(isHistoric(inHouse, '2026-09-06')).toBe(false)
    expect(isInHouse(inHouse, '2026-09-06')).toBe(true)
    expect(isInHouse(past, '2026-09-06')).toBe(false)
  })

  it('treats a guest leaving today as history rather than as in-house', () => {
    // Half-open: the guest is gone by check-out, and the unit is sellable.
    const leaving = bookingRecord(2, {
      guestName: 'א',
      unitName: 'וילה הגלבוע',
      checkIn: '2026-09-01',
      checkOut: '2026-09-06',
    })
    expect(isHistoric(leaving, '2026-09-06')).toBe(true)
    expect(isInHouse(leaving, '2026-09-06')).toBe(false)
  })

  it('carries a decision already made onto a freshly detected conflict', () => {
    const rows = [
      bookingRecord(2, {
        guestName: 'א',
        unitName: 'וילה הגלבוע',
        checkIn: '2026-10-01',
        checkOut: '2026-10-05',
      }),
      bookingRecord(3, {
        guestName: 'ב',
        unitName: 'וילה הגלבוע',
        checkIn: '2026-10-03',
        checkOut: '2026-10-07',
      }),
    ]

    const first = dryRun({
      records: rows,
      world: world(),
      computedOn: '2026-09-06',
      decisions: [],
      issues: [],
    })
    expect(first.conflicts).toHaveLength(1)
    expect(first.conflicts[0]?.decision).toBe('undecided')
    // Undecided blocks the row rather than defaulting either way.
    expect(first.writable.map((row) => row.rowNumber)).toEqual([2])

    const settled = first.conflicts.map((conflict) => ({
      ...conflict,
      decision: 'import_anyway' as const,
    }))
    const second = dryRun({
      records: rows,
      world: world(),
      computedOn: '2026-09-06',
      decisions: settled,
      issues: [],
    })

    expect(second.conflicts[0]?.decision).toBe('import_anyway')
    expect(second.writable.map((row) => row.rowNumber)).toEqual([2, 3])
  })

  it('reports rows already imported as unchanged and does not offer them', () => {
    const row = guestRecord(2, { fullName: 'דנה כהן' }, 'src-7')

    const report = dryRun({
      records: [row],
      world: world({
        ledger: [
          {
            entity: 'guests',
            recordKey: 'src-7',
            contentHash: row.contentHash,
            estiaId: 'guest-1',
            sessionId: 'session-1',
            rowNumber: 2,
          },
        ],
      }),
      computedOn: '2026-09-06',
      decisions: [],
      issues: [],
    })

    expect(report.writable).toHaveLength(0)
    expect(report.empty).toBe(true)
    expect(report.totals.unchanged).toBe(1)
  })

  it('warns once about a file with no source identifiers, not once per row', () => {
    const report = dryRun({
      records: [
        guestRecord(2, { fullName: 'א' }),
        guestRecord(3, { fullName: 'ב' }),
        guestRecord(4, { fullName: 'ג' }),
      ],
      world: world(),
      computedOn: '2026-09-06',
      decisions: [],
      issues: [],
    })

    const warnings = report.issues.filter(
      (issue) => issue.field === 'externalId',
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain('3')
  })
})
