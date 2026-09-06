import { describe, expect, it } from 'vitest'

import {
  findDuplicateGuests,
  groupDuplicatesInFile,
  identityOf,
  isSharedMailbox,
  normalizeEmail,
  type ExistingGuest,
} from './dedupe'
import { guestRecord } from './fixtures'

const DANA: ExistingGuest = {
  id: 'guest-1',
  fullName: 'דנה כהן',
  phoneE164: '+972501234567',
  email: 'dana@example.com',
}

describe('a name is never identity', () => {
  /**
   * The test that matters most in this file. Israel has a few dozen extremely
   * common surnames and a three-year import contains eleven unrelated families
   * called כהן. Merging on a name welds their stay histories together.
   */
  it('does not merge two guests who share a surname', () => {
    const candidates = findDuplicateGuests(
      [guestRecord(2, { fullName: 'יוסי כהן' })],
      [{ id: 'g-1', fullName: 'דנה כהן', phoneE164: null, email: null }],
    )

    expect(candidates).toEqual([])
  })

  it('does not merge two guests who share a full name', () => {
    const candidates = findDuplicateGuests(
      [guestRecord(2, { fullName: 'דוד כהן' })],
      [{ id: 'g-1', fullName: 'דוד כהן', phoneE164: null, email: null }],
    )

    expect(candidates).toEqual([])
  })

  it('does not merge on a shared name plus a shared city', () => {
    const candidates = findDuplicateGuests(
      [guestRecord(2, { fullName: 'דוד כהן', city: 'חיפה' })],
      [{ id: 'g-1', fullName: 'דוד כהן', phoneE164: null, email: null }],
    )

    expect(candidates).toEqual([])
  })
})

describe('a normalised telephone number is identity', () => {
  it('offers a merge for the same number written differently', () => {
    const candidates = findDuplicateGuests(
      [guestRecord(2, { fullName: 'דנה כ.', phone: '050-123-4567' })],
      [DANA],
    )

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.matchedOn).toBe('phone')
    expect(candidates[0]?.matchedValue).toBe('+972501234567')
    expect(candidates[0]?.existingId).toBe('guest-1')
    // Both sides are named, because a person cannot decide from a row number.
    expect(candidates[0]?.existingLabel).toBe('דנה כהן')
    expect(candidates[0]?.incomingLabel).toBe('דנה כ.')
  })

  it('offers a merge across the international and domestic forms', () => {
    const candidates = findDuplicateGuests(
      [guestRecord(2, { fullName: 'דנה', phone: '+972 (0)50 1234567' })],
      [DANA],
    )

    expect(candidates).toHaveLength(1)
  })

  it('offers nothing for a number that is not a mobile', () => {
    const candidates = findDuplicateGuests(
      [guestRecord(2, { fullName: 'דנה', phone: '03-1234567' })],
      [DANA],
    )

    expect(candidates).toEqual([])
  })
})

describe('email is the weaker key and is treated as one', () => {
  it('offers nothing on email unless the source verified it', () => {
    const records = [
      guestRecord(2, { fullName: 'דנה', email: 'dana@example.com' }),
    ]

    expect(findDuplicateGuests(records, [DANA])).toEqual([])
    expect(
      findDuplicateGuests(records, [DANA], { emailIsVerified: true }),
    ).toHaveLength(1)
  })

  it('never matches on a shared mailbox even when verified', () => {
    const shared: ExistingGuest = {
      id: 'g-2',
      fullName: 'משפחת לוי',
      phoneE164: null,
      email: 'info@villa.co.il',
    }

    const candidates = findDuplicateGuests(
      [guestRecord(2, { fullName: 'רון', email: 'info@villa.co.il' })],
      [shared],
      { emailIsVerified: true },
    )

    expect(candidates).toEqual([])
  })

  it('knows a mailbox from a person whose name starts the same way', () => {
    expect(isSharedMailbox('info@x.co.il')).toBe(true)
    expect(isSharedMailbox('info+air@x.co.il')).toBe(true)
    expect(isSharedMailbox('information@x.co.il')).toBe(false)
    expect(isSharedMailbox('info.cohen@x.co.il')).toBe(false)
  })

  it('normalises case and refuses a non-address', () => {
    expect(normalizeEmail('  Dana@Example.COM ')).toBe('dana@example.com')
    expect(normalizeEmail('not-an-address')).toBeNull()
    expect(normalizeEmail(null)).toBeNull()
  })
})

describe('duplicates inside one file', () => {
  it('collapses repeated stays by the same person onto the first row', () => {
    const collapse = groupDuplicatesInFile([
      guestRecord(2, { fullName: 'דנה כהן', phone: '0501234567' }),
      guestRecord(3, { fullName: 'דנה כהן', phone: '050-123-4567' }),
      guestRecord(4, { fullName: 'רון לוי', phone: '0529999999' }),
    ])

    expect(collapse.get(3)).toBe(2)
    expect(collapse.has(4)).toBe(false)
  })

  it('does not collapse two people who only share a name', () => {
    const collapse = groupDuplicatesInFile([
      guestRecord(2, { fullName: 'דוד כהן' }),
      guestRecord(3, { fullName: 'דוד כהן' }),
    ])

    expect(collapse.size).toBe(0)
  })
})

describe('identityOf', () => {
  it('reports no key rather than an empty one when there is no evidence', () => {
    expect(identityOf({ phone: null, email: null })).toEqual({
      phoneE164: null,
      email: null,
    })
  })
})
