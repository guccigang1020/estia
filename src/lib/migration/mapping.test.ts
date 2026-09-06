import { describe, expect, it } from 'vitest'

import {
  applySavedMapping,
  fieldForHeader,
  fieldsFor,
  findSavedMapping,
  headerSignature,
  mappedValues,
  normalizeHeader,
  suggestMappings,
  toSavedMapping,
} from './mapping'
import type { SavedMapping } from './types'

describe('recognising a header', () => {
  it('matches Hebrew and English names for the same field', () => {
    expect(fieldForHeader('תאריך הגעה', 'bookings')).toBe('checkIn')
    expect(fieldForHeader('Check-In', 'bookings')).toBe('checkIn')
    expect(fieldForHeader('CHECK_IN', 'bookings')).toBe('checkIn')
  })

  it('survives the geresh and an invisible RTL mark', () => {
    // A right-to-left interface round-trips a header through an RTL run and the
    // mark that comes back matches nothing — the failure `agents/phone.ts`
    // documents for telephone numbers, arriving at a column name.
    expect(normalizeHeader('‏מק״ט‎')).toBe('מקט')
    expect(fieldForHeader('‏טלפון ', 'guests')).toBe('phone')
  })

  it('refuses rather than guessing at an unknown header', () => {
    expect(fieldForHeader('משהו אחר', 'guests')).toBeNull()
  })

  it('will not map a field that does not belong to the sheet', () => {
    // `Check-in` on a guest sheet is somebody else's column.
    expect(fieldForHeader('תאריך הגעה', 'guests')).toBeNull()
    expect(fieldsFor('guests')).not.toContain('checkIn')
  })
})

describe('suggesting a whole mapping', () => {
  it('proposes for what it recognises and leaves the rest empty', () => {
    const suggested = suggestMappings(
      ['שם מלא', 'טלפון', 'מספר לקוח פנימי'],
      'guests',
    )

    expect(suggested).toEqual([
      { column: 'שם מלא', field: 'fullName' },
      { column: 'טלפון', field: 'phone' },
      { column: 'מספר לקוח פנימי', field: null },
    ])
  })

  it('never feeds one field from two columns', () => {
    const suggested = suggestMappings(['Phone', 'Mobile'], 'guests')
    expect(suggested[0]?.field).toBe('phone')
    expect(suggested[1]?.field).toBeNull()
  })

  it('lists every column, including the ones it ignored', () => {
    const suggested = suggestMappings(['a', 'b', 'c'], 'guests')
    expect(suggested).toHaveLength(3)
  })
})

describe('a saved mapping', () => {
  const columns = ['Guest', 'Check-in', 'Check-out', 'Unit']

  const saved: SavedMapping = toSavedMapping({
    id: 'm-1',
    organizationId: 'org-1',
    name: 'ייצוא מ-PMS',
    entity: 'bookings',
    sourceFormat: 'csv',
    columns,
    mappings: suggestMappings(columns, 'bookings'),
  })

  it('is found again for the next export of the same shape', () => {
    expect(findSavedMapping([saved], columns, 'bookings')?.id).toBe('m-1')
  })

  it('is not applied to a different sheet with the same header', () => {
    // A guest sheet and a booking sheet out of one product share `Name`,
    // `Phone`, `Email`; the wrong mapping would import stays with no dates.
    expect(findSavedMapping([saved], columns, 'guests')).toBeNull()
  })

  it('distinguishes the same names in a different order', () => {
    const reordered = ['Check-in', 'Guest', 'Check-out', 'Unit']
    expect(findSavedMapping([saved], reordered, 'bookings')).toBeNull()
    expect(headerSignature(columns, 'bookings')).not.toBe(
      headerSignature(reordered, 'bookings'),
    )
  })

  it('shows a column the export has gained as unmapped rather than dropping it', () => {
    const grown = [...columns, 'Channel']
    const laid = applySavedMapping(saved, grown)

    expect(laid).toHaveLength(5)
    expect(laid[4]).toEqual({ column: 'Channel', field: null })
  })
})

describe('reading a row through a mapping', () => {
  it('keys by ESTIA field and drops what is unmapped or blank', () => {
    const values = mappedValues(
      { 'שם מלא': ' דנה כהן ', טלפון: '', פנימי: 'x' },
      [
        { column: 'שם מלא', field: 'fullName' },
        { column: 'טלפון', field: 'phone' },
        { column: 'פנימי', field: null },
      ],
    )

    expect(values).toEqual({ fullName: 'דנה כהן' })
  })
})
