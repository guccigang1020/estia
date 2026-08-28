/**
 * Phone normalisation.
 *
 * The identity key. These tests are written as a list of the shapes a real
 * number arrives in — from a contacts app, from a WhatsApp export, typed by an
 * owner mid-call — because the failure this prevents is not an exception. It is
 * four agents for one person, discovered when one of them asks why they were
 * paid a quarter of what they sold.
 */

import { describe, expect, it } from 'vitest'
import {
  PHONE_REJECTION_MESSAGE,
  formatIsraeliPhone,
  isSamePhone,
  normalizePhone,
  toE164,
  type PhoneRejection,
} from './phone'

const CANONICAL = '+972501234567'

describe('every shape of one Israeli mobile number', () => {
  /**
   * All of these are the same person. If any one of them normalised
   * differently, that person would become two agents with two ledgers.
   */
  const sameNumber: readonly [string, string][] = [
    ['plain national', '0501234567'],
    ['national, hyphenated', '050-1234567'],
    ['national, hyphenated after two', '05-01234567'],
    ['national, spaced', '050 123 4567'],
    ['national, spaced and hyphenated', '050 123-4567'],
    ['national, in brackets', '(050) 123-4567'],
    ['national, dotted', '050.123.4567'],
    ['national, slashed', '050/1234567'],
    ['international, plus', '+972501234567'],
    ['international, plus and hyphens', '+972-50-1234567'],
    ['international, plus and spaces', '+972 50 123 4567'],
    ['international, no plus', '972501234567'],
    ['international, exit code', '00972501234567'],
    ['international, exit code and hyphens', '00972-50-1234567'],
    ['national significant only, no trunk zero', '501234567'],
    ['leading and trailing whitespace', '  050-1234567  '],
    ['non-breaking space', '050 1234567'],
    ['en dash instead of hyphen', '050–1234567'],
  ]

  it.each(sameNumber)('%s — %s', (_label, input) => {
    const result = normalizePhone(input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.e164).toBe(CANONICAL)
      expect(result.national).toBe('501234567')
    }
  })

  it('normalises every shape to one value, so one person is one agent', () => {
    const normalized = new Set(sameNumber.map(([, input]) => toE164(input)))
    expect(normalized).toEqual(new Set([CANONICAL]))
  })
})

describe('the country code and the trunk zero together', () => {
  /**
   * The case a contacts app actually produces. Read literally it is a
   * ten-digit national number, one digit too long, and would be refused as a
   * typo — from a string that is perfectly correct.
   */
  it.each([
    '+972 (0)50-1234567',
    '+9720501234567',
    '00972 0 50 123 4567',
    '972-0-50-1234567',
  ])('drops the trunk zero after the country code: %s', (input) => {
    expect(toE164(input)).toBe(CANONICAL)
  })
})

describe('bidirectional control characters', () => {
  /**
   * A Hebrew, right-to-left interface round-trips a number through an RTL run
   * and gets an invisible mark back. A key that silently fails to match is
   * worse than one that is refused, because nothing reports it.
   */
  const marks = [
    ['left-to-right mark', '‎'],
    ['right-to-left mark', '‏'],
    ['right-to-left embedding', '‫'],
    ['pop directional formatting', '‬'],
    ['first strong isolate', '⁨'],
    ['pop directional isolate', '⁩'],
  ] as const

  it.each(marks)('strips the %s', (_label, mark) => {
    expect(toE164(`${mark}050-1234567${mark}`)).toBe(CANONICAL)
  })

  it('strips a mark sitting in the middle of the digits', () => {
    expect(toE164('050‏123‎4567')).toBe(CANONICAL)
  })
})

describe('the wrong ones', () => {
  const rejected: readonly [string, string, PhoneRejection][] = [
    ['empty string', '', 'empty'],
    ['only whitespace', '   ', 'empty'],
    ['only separators', '--()--', 'empty'],
    ['only a plus', '+', 'empty'],
    ['letters', 'abcdefghij', 'not_a_number'],
    ['a word', 'לא מספר', 'not_a_number'],
    ['digits with a letter', '05012345a7', 'not_a_number'],
    ['an email', 'agent@example.com', 'not_a_number'],
    ['Tel Aviv landline', '03-1234567', 'not_mobile'],
    ['Jerusalem landline', '02-6543210', 'not_mobile'],
    ['Haifa landline', '04-8123456', 'not_mobile'],
    ['southern landline', '08-9876543', 'not_mobile'],
    ['Sharon landline', '09-7654321', 'not_mobile'],
    ['VoIP range', '072-1234567', 'not_mobile'],
    ['premium range', '1-700-123-456', 'not_mobile'],
    ['international landline with country code', '+97231234567', 'not_mobile'],
    ['one digit short', '050-123456', 'too_short'],
    ['several digits short', '0501234', 'too_short'],
    ['country code only', '+972', 'too_short'],
    ['one digit too many', '050-12345678', 'too_long'],
    ['far too many digits', '0501234567890', 'too_long'],
    ['a British mobile', '+447700900123', 'not_israeli'],
    ['a United States number', '+14155550123', 'not_israeli'],
    ['exit code, foreign country', '00447700900123', 'not_israeli'],
  ]

  it.each(rejected)('refuses %s (%s) as "%s"', (_label, input, reason) => {
    const result = normalizePhone(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe(reason)
  })

  it('refuses null and undefined without throwing', () => {
    expect(normalizePhone(null)).toEqual({ ok: false, reason: 'empty' })
    expect(normalizePhone(undefined)).toEqual({ ok: false, reason: 'empty' })
  })

  it('gives every refusal a Hebrew sentence a person can act on', () => {
    for (const [, , reason] of rejected) {
      expect(PHONE_REJECTION_MESSAGE[reason].length).toBeGreaterThan(0)
    }
  })

  it('tells a landline apart from a wrong length', () => {
    // Both are nine typed digits. Reporting the landline as "too short" would
    // send the owner to add a digit rather than to ask for a mobile.
    expect(normalizePhone('03-1234567')).toEqual({
      ok: false,
      reason: 'not_mobile',
    })
    expect(normalizePhone('050-123456')).toEqual({
      ok: false,
      reason: 'too_short',
    })
  })
})

describe('every assigned Israeli mobile prefix is accepted', () => {
  // 050–059. Operator allocations change; the shape does not, and refusing a
  // real prefix means refusing a real agent.
  it.each([
    '050',
    '051',
    '052',
    '053',
    '054',
    '055',
    '056',
    '057',
    '058',
    '059',
  ])('accepts the %s range', (prefix) => {
    const result = normalizePhone(`${prefix}-1234567`)
    expect(result.ok).toBe(true)
  })
})

describe('comparison', () => {
  it('treats two formats of one number as the same person', () => {
    expect(isSamePhone('050-1234567', '+972501234567')).toBe(true)
    expect(isSamePhone('972501234567', '05-01234567')).toBe(true)
  })

  it('treats different numbers as different people', () => {
    expect(isSamePhone('050-1234567', '050-7654321')).toBe(false)
  })

  it('never says two unparseable values are the same person', () => {
    // The dangerous default. Two nonsense inputs comparing equal would merge
    // two strangers into one identity.
    expect(isSamePhone('nonsense', 'nonsense')).toBe(false)
    expect(isSamePhone(null, null)).toBe(false)
    expect(isSamePhone('', '')).toBe(false)
  })
})

describe('display', () => {
  it('formats the stored key the way an owner wrote it', () => {
    expect(formatIsraeliPhone(CANONICAL)).toBe('050-123-4567')
  })

  it('returns an unparseable value unchanged rather than throwing', () => {
    expect(formatIsraeliPhone('not a number')).toBe('not a number')
  })

  it('round-trips: formatted output normalises back to the same key', () => {
    expect(toE164(formatIsraeliPhone(CANONICAL))).toBe(CANONICAL)
  })
})
