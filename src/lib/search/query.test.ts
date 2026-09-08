import { describe, expect, it } from 'vitest'

import { likePattern, parseQuery, SEARCH_KINDS } from './query'

describe('parseQuery — too short to mean anything', () => {
  it('refuses one character rather than matching everything', () => {
    expect(parseQuery('a')).toBeNull()
    expect(parseQuery('  ')).toBeNull()
    expect(parseQuery('')).toBeNull()
  })

  it('trims and collapses before measuring', () => {
    expect(parseQuery('  דנה   לוי  ')?.text).toBe('דנה לוי')
  })
})

describe('parseQuery — an email is only ever a person', () => {
  it('recognises it and searches nothing else', () => {
    const parsed = parseQuery('dana@example.com')

    expect(parsed?.shape).toBe('email')
    expect(parsed?.kinds).toEqual(['guest'])
  })

  it('is never read as a phone, whatever digits it contains', () => {
    const parsed = parseQuery('0501234567@example.com')

    expect(parsed?.shape).toBe('email')
    expect(parsed?.digits).toBeNull()
  })
})

describe('parseQuery — a booking reference', () => {
  it('recognises the shape 0009 generates', () => {
    // `'B' || hex`, which is what `bookings.reference` actually holds.
    const parsed = parseQuery('B3F91A2C')

    expect(parsed?.shape).toBe('reference')
    expect(parsed?.kinds[0]).toBe('booking')
  })

  it('is case-insensitive, because nobody types a reference in caps', () => {
    expect(parseQuery('b3f91a2c')?.shape).toBe('reference')
  })

  it('still looks at properties and units', () => {
    // Decisive enough to lead with, not decisive enough to be alone: a unit
    // genuinely called "B12" exists somewhere, and refusing to look would be
    // the confident-and-wrong failure this module is written to avoid.
    const parsed = parseQuery('B3F91A2C')

    expect(parsed?.kinds).toContain('property')
    expect(parsed?.kinds).toContain('unit')
  })

  it('is anchored, so a reference inside a sentence is not one', () => {
    expect(parseQuery('the booking B3F91A2C is late')?.shape).toBe('text')
  })
})

describe('parseQuery — a phone number', () => {
  it('recognises the way people actually type one', () => {
    for (const typed of [
      '050-123-4567',
      '050 123 4567',
      '+972501234567',
      '(050) 1234567',
      '0501234567',
    ]) {
      const parsed = parseQuery(typed)
      expect(parsed?.shape, typed).toBe('phone')
      expect(parsed?.digits, typed).toContain('501234567')
    }
  })

  it('leads with the guest, because that is who a number identifies', () => {
    expect(parseQuery('0501234567')?.kinds[0]).toBe('guest')
  })

  it('reaches agents and owners too — they are people with numbers', () => {
    const parsed = parseQuery('0501234567')

    expect(parsed?.kinds).toContain('agent')
    expect(parsed?.kinds).toContain('owner')
  })

  it('refuses a fragment too short to be a number', () => {
    // Five digits matches most of a customer list, which is not a search
    // result — it is a list with extra steps.
    const parsed = parseQuery('12345')

    expect(parsed?.shape).toBe('text')
    expect(parsed?.digits).toBeNull()
  })
})

describe('parseQuery — free text searches everything', () => {
  it('keeps every kind in when the shape decides nothing', () => {
    const parsed = parseQuery('דנה לוי')

    expect(parsed?.shape).toBe('text')
    expect(parsed?.kinds).toEqual([...SEARCH_KINDS])
  })

  it('still carries the digits when a name has a number beside it', () => {
    // "דנה 0501234567" is a thing people type into one box.
    const parsed = parseQuery('דנה 0501234567')

    expect(parsed?.shape).toBe('text')
    expect(parsed?.digits).toBe('0501234567')
  })
})

describe('likePattern', () => {
  it('wraps the text so it matches anywhere', () => {
    expect(likePattern('דנה')).toBe('%דנה%')
  })

  it('escapes the wildcards, so a literal percent is a percent', () => {
    // Without this, somebody searching "50%" matches every guest whose name
    // contains "50" — a search that silently widens is worse than one that
    // finds nothing.
    expect(likePattern('50%')).toBe('%50\\%%')
    expect(likePattern('a_b')).toBe('%a\\_b%')
  })

  it('escapes the escape character itself', () => {
    expect(likePattern('a\\b')).toBe('%a\\\\b%')
  })
})
