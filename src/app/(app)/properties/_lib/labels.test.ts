import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  PROPERTY_STATUSES,
  PROPERTY_STATUS_LABEL,
  PROPERTY_TYPES,
  PROPERTY_TYPE_LABEL,
  UNIT_SELLABILITY_NOTE,
  UNIT_STATUSES,
  UNIT_STATUS_LABEL,
  UNIT_TYPES,
  UNIT_TYPE_LABEL,
  labelOr,
  statusTone,
} from './labels'

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL(
      '../../../../../supabase/migrations/0008_accommodation.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

/** The members of a `create type ... as enum (...)` block in the migration. */
function enumMembers(typeName: string): string[] {
  const match = MIGRATION.match(
    new RegExp(`create type public\\.${typeName} as enum \\(([^)]*)\\)`),
  )
  if (!match) throw new Error(`No enum ${typeName} in 0008_accommodation.sql`)
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1])
}

describe('the tuples match the migration they were read from', () => {
  it.each([
    ['property_type', PROPERTY_TYPES],
    ['property_status', PROPERTY_STATUSES],
    ['unit_type', UNIT_TYPES],
    ['unit_status', UNIT_STATUSES],
  ])('%s', (typeName, declared) => {
    expect([...declared]).toEqual(enumMembers(typeName))
  })
})

describe('every enum member has Hebrew wording', () => {
  it.each([
    ['property type', PROPERTY_TYPES, PROPERTY_TYPE_LABEL],
    ['property status', PROPERTY_STATUSES, PROPERTY_STATUS_LABEL],
    ['unit type', UNIT_TYPES, UNIT_TYPE_LABEL],
    ['unit status', UNIT_STATUSES, UNIT_STATUS_LABEL],
  ])('%s', (_name, members, labels) => {
    for (const member of members) {
      const label = (labels as Record<string, string>)[member]
      expect(label, member).toBeTruthy()
      // Hebrew, not the raw enum value leaking onto a Hebrew screen.
      expect(label, member).toMatch(/[֐-׿]/)
    }
  })

  it('says what every non-sellable unit status means for the calendar', () => {
    for (const status of UNIT_STATUSES) {
      const note = UNIT_SELLABILITY_NOTE[status]
      if (status === 'active') {
        expect(note).toBeNull()
      } else {
        expect(note, status).toMatch(/[֐-׿]/)
      }
    }
  })
})

describe('labelOr', () => {
  it('returns the wording when it knows the value', () => {
    expect(labelOr(PROPERTY_TYPE_LABEL, 'villa')).toBe('וילה')
  })

  it('returns the raw value rather than inventing wording for it', () => {
    expect(labelOr(PROPERTY_TYPE_LABEL, 'glamping')).toBe('glamping')
  })
})

describe('statusTone', () => {
  it('emphasises active and nothing else', () => {
    expect(statusTone('active')).toBe('brand')
    expect(statusTone('archived')).toBe('neutral')
    expect(statusTone('maintenance')).toBe('neutral')
  })
})
