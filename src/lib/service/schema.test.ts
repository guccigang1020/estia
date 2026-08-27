/**
 * The schema validator.
 *
 * The rule these tests exist to hold is the one about collecting: a form must
 * surface every problem at once. Everything else here is about refusing input
 * that looks fine — an extra key, a number that is a string, a price with a
 * fraction of an agora.
 */

import { describe, expect, it } from 'vitest'
import { s, type Schema } from './schema'

function issues<T>(schema: Schema<T>, value: unknown) {
  const result = schema.validate(value, '')
  if (result.ok) throw new Error('expected the schema to refuse this value')
  return result.issues
}

function value<T>(schema: Schema<T>, input: unknown): T {
  const result = schema.validate(input, '')
  if (!result.ok) {
    throw new Error(
      `expected the schema to accept, got: ${JSON.stringify(result.issues)}`,
    )
  }
  return result.value
}

// ── Collecting ────────────────────────────────────────────────────────────

describe('collecting every problem', () => {
  const guest = s.object({
    name: s.string({ min: 2, label: 'שם האורח' }),
    email: s.string({
      pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
      patternMessage: 'כתובת דוא"ל אינה תקינה.',
      label: 'דוא"ל',
    }),
    nights: s.number({ min: 1, integer: true, label: 'לילות' }),
    total: s.agorot({ label: 'סכום' }),
  })

  it('reports all four failures, not the first one', () => {
    const found = issues(guest, {
      name: 'א',
      email: 'not-an-email',
      nights: 0,
      total: -50,
    })

    expect(found.map((i) => i.field).sort()).toEqual([
      'email',
      'name',
      'nights',
      'total',
    ])
  })

  it('reports every missing required field at once', () => {
    const found = issues(guest, {})
    expect(found).toHaveLength(4)
    expect(found.every((i) => i.code === 'required')).toBe(true)
  })

  it('gives each field its own Hebrew message and label', () => {
    const found = issues(guest, {
      name: 'א',
      email: 'x@y.z',
      nights: 1,
      total: 0,
    })
    expect(found).toEqual([
      {
        field: 'name',
        code: 'too_short',
        message: 'יש להזין לפחות 2 תווים.',
        label: 'שם האורח',
      },
    ])
  })

  it('collects from nested objects with dotted paths', () => {
    const booking = s.object({
      guest: s.object({
        name: s.string({ min: 2 }),
        email: s.string({ min: 5 }),
      }),
      unitId: s.uuid(),
    })

    const found = issues(booking, {
      guest: { name: '', email: 'a' },
      unitId: 'not-a-uuid',
    })

    expect(found.map((i) => i.field)).toEqual([
      'guest.name',
      'guest.email',
      'unitId',
    ])
  })

  it('collects from arrays with indexed paths', () => {
    const schema = s.object({
      nights: s.arrayOf(s.object({ date: s.isoDateTime() })),
    })
    const found = issues(schema, {
      nights: [{ date: '2026-01-01' }, { date: 'nonsense' }, {}],
    })

    expect(found.map((i) => i.field)).toEqual([
      'nights[1].date',
      'nights[2].date',
    ])
  })
})

// ── Unknown keys ──────────────────────────────────────────────────────────

describe('unknown keys', () => {
  const schema = s.object({ note: s.string() })

  it('refuses a key the shape does not name', () => {
    // A payload carrying `role: "owner"` at an endpoint that never mentions
    // roles is either a bug or an attempt. Ignoring it is how mass assignment
    // happens.
    const found = issues(schema, { note: 'ok', role: 'organization_owner' })
    expect(found).toEqual([
      { field: 'role', code: 'unknown_field', message: 'שדה לא מוכר.' },
    ])
  })

  it('reports the unknown key alongside the real failures', () => {
    const found = issues(schema, { role: 'owner' })
    expect(found.map((i) => i.code).sort()).toEqual([
      'required',
      'unknown_field',
    ])
  })

  it('accepts extras only when the operation asked for it', () => {
    const lenient = s.object({ note: s.string() }, { allowUnknown: true })
    expect(value(lenient, { note: 'ok', extra: 1 })).toEqual({ note: 'ok' })
  })

  it('refuses any key at all for an operation that takes no input', () => {
    expect(value(s.nothing, {})).toEqual({})
    expect(value(s.nothing, undefined)).toEqual({})
    expect(issues(s.nothing, { anything: 1 })[0].code).toBe('unknown_field')
  })
})

// ── Types ─────────────────────────────────────────────────────────────────

describe('primitives', () => {
  it('refuses a number that arrived as a string', () => {
    expect(issues(s.number(), '5')[0].code).toBe('type')
  })

  it('refuses NaN and Infinity', () => {
    expect(issues(s.number(), Number.NaN)[0].code).toBe('type')
    expect(issues(s.number(), Number.POSITIVE_INFINITY)[0].code).toBe('type')
  })

  it('refuses a fractional agora and a negative price', () => {
    expect(issues(s.agorot(), 520.5)[0].code).toBe('not_integer')
    expect(issues(s.agorot(), -1)[0].code).toBe('too_small')
    expect(value(s.agorot(), 520000)).toBe(520000)
  })

  it('trims a string and keeps the trimmed value', () => {
    expect(value(s.string(), '  רוני לוי  ')).toBe('רוני לוי')
    expect(issues(s.string({ min: 1 }), '   ')[0].code).toBe('too_short')
  })

  it('refuses anything that is not a boolean, including 0 and 1', () => {
    expect(issues(s.boolean(), 1)[0].code).toBe('type')
    expect(issues(s.boolean(), 'true')[0].code).toBe('type')
    expect(value(s.boolean(), false)).toBe(false)
  })

  it('refuses a malformed uuid', () => {
    expect(issues(s.uuid(), 'bk-1')[0].code).toBe('invalid_id')
    expect(value(s.uuid(), '9f1a2b3c-4d5e-4f60-8a91-0b1c2d3e4f50')).toBeTruthy()
  })

  it('parses an ISO instant and refuses a Date object', () => {
    // Accepting a Date would let an unvalidated object through on the strength
    // of its prototype.
    expect(value(s.isoDateTime(), '2026-03-14T09:30:00Z')).toBeInstanceOf(Date)
    expect(issues(s.isoDateTime(), new Date())[0].code).toBe('type')
    expect(issues(s.isoDateTime(), '14/03/2026')[0].code).toBe('invalid_date')
  })

  it('refuses a value outside an enum', () => {
    const status = s.enumOf(['confirmed', 'cancelled'])
    expect(value(status, 'cancelled')).toBe('cancelled')
    expect(issues(status, 'checked_in')[0].code).toBe('not_allowed')
  })
})

describe('combinators', () => {
  it('distinguishes absent from explicitly null', () => {
    // "The guest gave no phone number" and "the caller did not mention the
    // phone number" are different statements; only the first clears a value.
    const schema = s.object({
      note: s.optional(s.string()),
      phone: s.nullable(s.string()),
    })

    expect(value(schema, { phone: null })).toEqual({ phone: null })
    expect(issues(schema, { note: null, phone: null })[0].field).toBe('note')
  })

  it('applies array bounds', () => {
    const schema = s.arrayOf(s.string(), { min: 1, max: 2 })
    expect(issues(schema, [])[0].code).toBe('too_few')
    expect(issues(schema, ['a', 'b', 'c'])[0].code).toBe('too_many')
    expect(issues(schema, 'not-a-list')[0].code).toBe('type')
  })

  it('runs a refinement only after the shape is known to be valid', () => {
    const stay = s.refine(
      s.object({ from: s.isoDateTime(), to: s.isoDateTime() }),
      (v) => v.to.getTime() > v.from.getTime(),
      {
        code: 'checkout_before_checkin',
        message: 'תאריך היציאה חייב להיות אחרי תאריך הכניסה.',
        field: 'to',
      },
    )

    expect(
      value(stay, { from: '2026-03-14T14:00:00Z', to: '2026-03-16T10:00:00Z' }),
    ).toBeTruthy()

    const found = issues(stay, {
      from: '2026-03-16T14:00:00Z',
      to: '2026-03-14T10:00:00Z',
    })
    expect(found).toEqual([
      {
        field: 'to',
        code: 'checkout_before_checkin',
        message: 'תאריך היציאה חייב להיות אחרי תאריך הכניסה.',
      },
    ])

    // The predicate never sees a half-parsed value.
    expect(issues(stay, { from: 'nonsense', to: 'nonsense' })).toHaveLength(2)
  })
})

describe('paths', () => {
  it('names the root "input" when there is no field to blame', () => {
    expect(issues(s.string(), undefined)[0].field).toBe('input')
  })
})
