import { describe, expect, it } from 'vitest'

import {
  MERGE_SUGGESTION_THRESHOLD,
  POSSIBLE_MATCH_THRESHOLD,
  attachmentFor,
  jaroWinkler,
  normaliseName,
  scoreMatch,
  suggestsMerge,
  worthMentioning,
  type MatchableGuest,
} from './matching'

const guest = (over: Partial<MatchableGuest> = {}): MatchableGuest => ({
  id: 'g-1',
  fullName: 'דנה לוי',
  phoneE164: '+972501234567',
  email: 'dana@example.com',
  ...over,
})

describe('attaching a new lead to a guest (ח40-08)', () => {
  it('attaches on an exact normalised telephone match', () => {
    const result = attachmentFor(
      { phoneE164: '+972501234567', emailNormalized: null },
      [guest({ id: 'g-7' })],
    )
    expect(result).toEqual({ kind: 'attach', guestId: 'g-7' })
  })

  it('never attaches on an email match — it suggests (ח40-06)', () => {
    // A couple booking two stays from one address is the ordinary case, not a
    // duplicate, so the email can only ever raise the question.
    const result = attachmentFor(
      { phoneE164: null, emailNormalized: 'dana@example.com' },
      [guest({ id: 'g-2', phoneE164: null })],
    )
    expect(result).toEqual({ kind: 'suggest', guestIds: ['g-2'] })
  })

  it('never matches on a name', () => {
    const result = attachmentFor({ phoneE164: null, emailNormalized: null }, [
      guest({ id: 'g-3', phoneE164: null, email: null }),
    ])
    expect(result).toEqual({ kind: 'none' })
  })

  it('suggests rather than guesses when two live rows share a number', () => {
    // The unique index makes this impossible among live rows. If it ever
    // happens something has been merged badly, and picking one of the two is
    // the last thing to do.
    const result = attachmentFor(
      { phoneE164: '+972501234567', emailNormalized: null },
      [guest({ id: 'a' }), guest({ id: 'b' })],
    )
    expect(result).toEqual({ kind: 'suggest', guestIds: ['a', 'b'] })
  })

  it('leaves guest_id empty rather than inventing a second guest card', () => {
    expect(
      attachmentFor({ phoneE164: '+972509999999', emailNormalized: null }, [
        guest(),
      ]),
    ).toEqual({ kind: 'none' })
  })
})

describe('the match score (§7.1)', () => {
  it('gives a shared telephone number most of the weight', () => {
    const score = scoreMatch(
      guest({ fullName: 'דנה לוי', email: null }),
      guest({ id: 'g-2', fullName: 'ד. לוי', email: null }),
    )
    expect(score.phone).toBe(1)
    expect(score.score).toBeGreaterThanOrEqual(MERGE_SUGGESTION_THRESHOLD - 0.2)
  })

  /**
   * The single most important assertion in this file.
   *
   * "דוד כהן" and "דוד כהן" with nothing else shared is two people, and the
   * weights have to make that unreachable rather than merely unlikely.
   */
  it('never suggests a merge on an identical name alone', () => {
    const score = scoreMatch(
      { id: 'a', fullName: 'דוד כהן', phoneE164: null, email: null },
      { id: 'b', fullName: 'דוד כהן', phoneE164: null, email: null },
    )
    expect(score.name).toBe(1)
    expect(score.score).toBe(0.12)
    expect(suggestsMerge(score)).toBe(false)
    expect(worthMentioning(score)).toBe(false)
  })

  it('does not reach the threshold on an identical name and document either', () => {
    const score = scoreMatch(
      {
        id: 'a',
        fullName: 'דוד כהן',
        phoneE164: null,
        email: null,
        idDocumentNumber: '123456782',
        idDocumentCountry: 'IL',
      },
      {
        id: 'b',
        fullName: 'דוד כהן',
        phoneE164: null,
        email: null,
        idDocumentNumber: '123456782',
        idDocumentCountry: 'IL',
      },
    )
    expect(score.score).toBe(0.2)
    expect(suggestsMerge(score)).toBe(false)
  })

  it('crosses the threshold on phone and email together, with no documents', () => {
    const score = scoreMatch(guest(), guest({ id: 'g-2' }))
    // 0.60 + 0.20 + 0.12 = 0.92. The threshold is reachable without ever
    // reading a document number, which is why the merge never copies one.
    expect(score.documentsCompared).toBe(false)
    expect(score.score).toBe(0.92)
    expect(suggestsMerge(score)).toBe(true)
  })

  it('says when it reached its answer without comparing documents', () => {
    expect(scoreMatch(guest(), guest({ id: 'g-2' })).documentsCompared).toBe(
      false,
    )
    expect(
      scoreMatch(
        guest({ idDocumentNumber: '1', idDocumentCountry: 'IL' }),
        guest({ id: 'g-2', idDocumentNumber: '1', idDocumentCountry: 'IL' }),
      ).documentsCompared,
    ).toBe(true)
  })

  it('refuses a document match across two countries', () => {
    const score = scoreMatch(
      {
        id: 'a',
        fullName: 'א',
        phoneE164: null,
        email: null,
        idDocumentNumber: '99',
        idDocumentCountry: 'IL',
      },
      {
        id: 'b',
        fullName: 'ב',
        phoneE164: null,
        email: null,
        idDocumentNumber: '99',
        idDocumentCountry: 'FR',
      },
    )
    expect(score.document).toBe(0)
  })

  it('half-scores a telephone whose last seven digits agree', () => {
    const score = scoreMatch(
      { id: 'a', fullName: 'א', phoneE164: '+972501234567', email: null },
      { id: 'b', fullName: 'ב', phoneE164: '+441234567', email: null },
    )
    expect(score.phone).toBe(0.5)
  })

  it('part-scores an email whose local part agrees and domain does not', () => {
    const score = scoreMatch(
      { id: 'a', fullName: 'א', phoneE164: null, email: 'dana@gmail.com' },
      { id: 'b', fullName: 'ב', phoneE164: null, email: 'dana@company.co.il' },
    )
    expect(score.email).toBe(0.4)
  })

  it('puts a same-name, same-email pair in the "might be" band, not the merge band', () => {
    const score = scoreMatch(
      { id: 'a', fullName: 'דנה לוי', phoneE164: null, email: 'd@e.com' },
      { id: 'b', fullName: 'דנה לוי', phoneE164: null, email: 'd@e.com' },
    )
    expect(score.score).toBe(0.32)
    expect(score.score).toBeLessThan(POSSIBLE_MATCH_THRESHOLD)
  })

  it('scores nothing when there is nothing comparable', () => {
    const score = scoreMatch(
      { id: 'a', fullName: '', phoneE164: null, email: null },
      { id: 'b', fullName: '', phoneE164: null, email: null },
    )
    expect(score.score).toBe(0.12)
  })
})

describe('normalising a Hebrew name for comparison', () => {
  it('collapses whitespace and folds Hebrew punctuation onto ASCII', () => {
    expect(normaliseName('  דוד   כהן ')).toBe('דוד כהן')
    expect(normaliseName('ד׳׳ר לוי')).toBe("ד''ר לוי")
    expect(normaliseName('בי״ס')).toBe('בי"ס')
  })

  it('strips niqqud so a pointed spelling matches an unpointed one', () => {
    expect(normaliseName('דָּוִד')).toBe(normaliseName('דוד'))
  })

  it('leaves spelling variants alone rather than guessing at them', () => {
    // Deliberate: a transliteration table is a list of guesses, and every
    // guess in here moves a score toward merging two people.
    expect(normaliseName("ו'")).not.toBe(normaliseName('ואו'))
  })
})

describe('jaro-winkler', () => {
  it('is 1 for identical strings and 0 for nothing in common', () => {
    expect(jaroWinkler('abc', 'abc')).toBe(1)
    expect(jaroWinkler('abc', 'xyz')).toBe(0)
  })

  it('is 1 for two empty strings and 0 when only one is empty', () => {
    expect(jaroWinkler('', '')).toBe(1)
    expect(jaroWinkler('abc', '')).toBe(0)
  })

  it('rewards a shared prefix, which is what the Winkler half is for', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.961, 3)
    expect(jaroWinkler('dwayne', 'duane')).toBeCloseTo(0.84, 2)
  })
})
