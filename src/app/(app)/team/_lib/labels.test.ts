/**
 * The wording, checked for the two things a type cannot check.
 *
 * `Record<MembershipStatus, string>` already fails the build if a sixth status
 * is added to the union and left unworded, so that half is free. What is not
 * free is:
 *
 *   · `EMPLOYMENT_TYPES` is *transcribed* from `public.employment_type` in
 *     `0001_identity.sql`, because nothing in `src/lib` names its members. A
 *     tuple restated by hand needs the same test `properties/_lib/labels.ts`
 *     has beside it — every member worded, or a Latin enum value reaches a
 *     Hebrew-speaking administrator.
 *   · the *meaning* strings. Those are the reason this screen exists: status
 *     is not decoration, and a sentence that merely repeated the word would be
 *     the decoration it is supposed to replace.
 */

import { describe, expect, it } from 'vitest'

import { MEMBERSHIP_STATUSES, RESOURCE_FAMILIES } from '@/lib/authz/can'

import {
  EMPLOYMENT_TYPES,
  EMPLOYMENT_TYPE_LABEL,
  MEMBERSHIP_STATUS_LABEL,
  MEMBERSHIP_STATUS_MEANING,
  SCOPE_KIND_LABEL,
  describeScopeSentence,
  hebrewDate,
  hebrewMoment,
  labelOr,
  membershipStatusTone,
} from './labels'

/** Hebrew letters, so a label left in English fails rather than looks fine. */
const HEBREW = /[֐-׿]/

describe('membership status', () => {
  it('words every status the engine understands', () => {
    for (const status of MEMBERSHIP_STATUSES) {
      expect(MEMBERSHIP_STATUS_LABEL[status]).toMatch(HEBREW)
    }
  })

  it('explains every status, and never by repeating the word', () => {
    for (const status of MEMBERSHIP_STATUSES) {
      const meaning = MEMBERSHIP_STATUS_MEANING[status]

      expect(meaning).toMatch(HEBREW)
      // A sentence, not a synonym. Forty characters is not a style rule — it
      // is the length below which nothing useful about a person's access can
      // be said.
      expect(meaning.length).toBeGreaterThan(40)
      expect(meaning).not.toBe(MEMBERSHIP_STATUS_LABEL[status])
    }
  })

  it('gives the two waiting statuses a tone of their own', () => {
    // An outstanding action is a different thing from an account somebody
    // deliberately closed, and the roster should not draw them alike.
    expect(membershipStatusTone('invited')).toBe('accent')
    expect(membershipStatusTone('pending')).toBe('accent')
    expect(membershipStatusTone('active')).toBe('brand')
    expect(membershipStatusTone('suspended')).toBe('neutral')
    expect(membershipStatusTone('removed')).toBe('neutral')
  })
})

describe('employment type', () => {
  it('words every member of the transcribed tuple', () => {
    for (const type of EMPLOYMENT_TYPES) {
      expect(EMPLOYMENT_TYPE_LABEL[type]).toMatch(HEBREW)
    }
  })

  it('renders a value the migration grew and this file has not been taught', () => {
    // `labelOr` is what stops an unknown enum member rendering as a blank
    // cell. It renders as itself, which is ugly and true.
    expect(labelOr(EMPLOYMENT_TYPE_LABEL, 'seasonal')).toBe('seasonal')
  })
})

describe('scope', () => {
  it('words every variant of the Scope union', () => {
    for (const kind of Object.keys(SCOPE_KIND_LABEL)) {
      expect(SCOPE_KIND_LABEL[kind as keyof typeof SCOPE_KIND_LABEL]).toMatch(
        HEBREW,
      )
    }
    // The union has one variant per member and `RESOURCE_FAMILIES` is the
    // other axis. Asserted here only so a reader of this test knows the two
    // are different lists and neither indexes the other.
    expect(RESOURCE_FAMILIES.length).toBeGreaterThan(0)
  })

  it('names the properties in a scope rather than counting them', () => {
    const sentence = describeScopeSentence(
      { kind: 'properties', propertyIds: ['a', 'b'] },
      ['אחוזת רימונים', 'וילה כחול ים'],
      0,
    )

    expect(sentence).toContain('אחוזת רימונים')
    expect(sentence).toContain('וילה כחול ים')
  })

  it('counts what it could not read, and never prints an id', () => {
    const sentence = describeScopeSentence(
      { kind: 'properties', propertyIds: ['a', 'b', 'c'] },
      ['אחוזת רימונים'],
      2,
    )

    expect(sentence).toContain('אחוזת רימונים')
    expect(sentence).toContain('2')
    // A truncated uuid on a roster tells the reader nothing except that
    // something went wrong.
    expect(sentence).not.toContain('a')
  })

  it('does not describe an unreadable property scope as reaching everything', () => {
    // The dangerous rendering: a `properties` scope that resolved to no names
    // must never read like `all_organization`.
    const sentence = describeScopeSentence(
      { kind: 'properties', propertyIds: ['a'] },
      [],
      1,
    )

    expect(sentence).not.toContain('כל הנכסים')
  })

  it('says what own_records actually excludes', () => {
    const sentence = describeScopeSentence({ kind: 'own_records' }, [], 0)
    expect(sentence).toMatch(HEBREW)
    expect(sentence.length).toBeGreaterThan(40)
  })
})

describe('dates', () => {
  it('reads a timestamp in the property time zone, not in UTC', () => {
    // 22:30 UTC on the 4th is 01:30 on the 5th in Israel. Slicing the ISO
    // string would file a joining date under the wrong day, and a date that
    // disagrees with the audit trail by one is a question somebody has to
    // answer.
    const late = '2026-03-04T22:30:00.000Z'

    expect(hebrewDate(late)).toContain('5')
    expect(hebrewMoment(late)).toContain('5')
  })

  it('leaves an absent timestamp absent', () => {
    expect(hebrewDate(null)).toBeNull()
    expect(hebrewMoment(null)).toBeNull()
  })
})
