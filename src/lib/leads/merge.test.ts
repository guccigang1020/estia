import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { KNOWN_MERGE_TOKENS, asMergeFailure } from './errors'
import {
  MERGE_CHOOSEABLE_FIELDS,
  MERGE_NEVER_COPIED_FIELDS,
  MERGE_RULED_FIELDS,
  conflictsBetween,
  problemsWithMerge,
  sanitiseChoices,
  undoAvailability,
  type MergeableGuest,
} from './merge'

const MIGRATION = fileURLToPath(
  new URL(
    '../../../supabase/migrations/0074_leads_and_guest_merges.sql',
    import.meta.url,
  ),
)

const sql = readFileSync(MIGRATION, 'utf8')

const person = (over: Partial<MergeableGuest> = {}): MergeableGuest =>
  ({
    id: 'g-1',
    version: 3,
    full_name: 'דנה לוי',
    first_name: 'דנה',
    last_name: 'לוי',
    email: 'dana@example.com',
    phone: '050-1234567',
    phone_alt: null,
    language: 'he',
    ...over,
  }) as MergeableGuest

describe('what a merge is allowed to touch', () => {
  it('never lets a document number, a date of birth or an address be chosen', () => {
    for (const field of MERGE_NEVER_COPIED_FIELDS) {
      expect(MERGE_CHOOSEABLE_FIELDS).not.toContain(field)
      expect(MERGE_RULED_FIELDS).not.toContain(field)
    }
  })

  /**
   * The assertion with teeth.
   *
   * The list above is a promise; this checks the function that keeps it. If a
   * future edit taught `guest_merge_apply` to read a passport number, this
   * fails — which is the whole reason the allow-list is written as literal
   * column names in the SQL rather than as a loop over `guests`.
   */
  it('and the database function does not name one either', () => {
    const body = sql.slice(
      sql.indexOf('create or replace function public.guest_merge_apply'),
      sql.indexOf('create or replace function public.guest_merge_undo'),
    )
    expect(body.length).toBeGreaterThan(0)

    for (const field of MERGE_NEVER_COPIED_FIELDS) {
      // `v_survivor.<field>` / `v_merged.<field>` is how the function would
      // have to read one. The column names also appear in the file's header
      // prose, which is why this looks at the function body only.
      expect(body).not.toMatch(new RegExp(`v_(survivor|merged)\\.${field}\\b`))
    }
  })

  it('drops a choice for a field the database decides by rule', () => {
    const choices = sanitiseChoices({
      full_name: 'merged',
      // Refusal wins on consent, so offering the choice would be the bug.
      marketing_consent: 'merged',
      is_blocked: 'survivor',
      tags: 'merged',
      nonsense: 'merged',
      email: 'sideways',
    })
    expect(choices).toEqual({ full_name: 'merged' })
  })
})

describe('the fields a person actually has to decide', () => {
  it('lists only what the two rows disagree about', () => {
    const conflicts = conflictsBetween(
      person(),
      person({ id: 'g-2', full_name: 'דנה לוי-כהן', phone: '0501234567' }),
    )
    expect(conflicts.map((conflict) => conflict.field)).toEqual([
      'full_name',
      'phone',
    ])
  })

  it('is empty when the two rows say the same thing', () => {
    expect(conflictsBetween(person(), person({ id: 'g-2' }))).toEqual([])
  })

  it('treats a missing value and a null as the same absence', () => {
    expect(
      conflictsBetween(
        person({ phone_alt: null }),
        person({ id: 'g-2', phone_alt: null }),
      ),
    ).toEqual([])
  })
})

describe('before a merge may run', () => {
  const base = {
    survivorId: 'a',
    mergedId: 'b',
    reason: 'אותו טלפון, הוקלד פעמיים בדלפק',
    typedSurvivorName: 'דנה לוי',
    survivorName: 'דנה לוי',
  }

  it('accepts a complete, confirmed request', () => {
    expect(problemsWithMerge(base)).toEqual([])
  })

  it('refuses a guest merged into itself (ק40-09)', () => {
    const problems = problemsWithMerge({ ...base, mergedId: 'a' })
    expect(problems.map((problem) => problem.field)).toContain('mergedId')
  })

  it('refuses a reason that explains nothing', () => {
    expect(
      problemsWithMerge({ ...base, reason: 'כפילות' }).map((p) => p.field),
    ).toContain('reason')
  })

  /**
   * §5.3 · the confirmation is a name typed, not a button pressed.
   *
   * A dialog with a button is dismissed by muscle memory. A name has to be
   * read off the correct column first, which is the entire mechanism — so a
   * near miss is a refusal and the refusal repeats the name.
   */
  it('refuses when the typed name is the other profile', () => {
    const problems = problemsWithMerge({
      ...base,
      typedSurvivorName: 'דנה כהן',
    })
    expect(problems.map((problem) => problem.field)).toEqual([
      'typedSurvivorName',
    ])
    expect(problems[0].message).toContain('דנה לוי')
  })

  it('forgives only surrounding and repeated whitespace', () => {
    expect(
      problemsWithMerge({ ...base, typedSurvivorName: '  דנה   לוי ' }),
    ).toEqual([])
  })

  it('reports every problem at once rather than one at a time', () => {
    const problems = problemsWithMerge({
      ...base,
      mergedId: 'a',
      reason: '',
      typedSurvivorName: '',
    })
    expect(problems).toHaveLength(3)
  })
})

describe('the thirty day window', () => {
  const record = {
    id: 'm-1',
    survivorGuestId: 'a',
    mergedGuestId: 'b',
    performedAt: '2026-04-01T10:00:00.000Z',
    undoDeadline: '2026-05-01T10:00:00.000Z',
    undoneAt: null,
  }

  it('offers an undo inside the window and counts the days left', () => {
    const state = undoAvailability(record, new Date('2026-04-04T10:00:00.000Z'))
    expect(state).toEqual({ kind: 'available', daysLeft: 27 })
  })

  it('refuses one day past the deadline (ק40-08)', () => {
    expect(
      undoAvailability(record, new Date('2026-05-02T10:00:00.000Z')),
    ).toEqual({ kind: 'expired', closedAt: record.undoDeadline })
  })

  it('says it is already undone rather than offering it again', () => {
    expect(
      undoAvailability(
        { ...record, undoneAt: '2026-04-05T09:00:00.000Z' },
        new Date('2026-04-06T10:00:00.000Z'),
      ),
    ).toEqual({ kind: 'already_undone', at: '2026-04-05T09:00:00.000Z' })
  })

  it('treats an unreadable deadline as closed rather than as open', () => {
    expect(
      undoAvailability({ ...record, undoDeadline: 'not a date' }, new Date()),
    ).toMatchObject({ kind: 'expired' })
  })
})

describe('the refusals the database raises', () => {
  it('turns a token into a Hebrew failure and keeps the diagnostic', () => {
    const failure = asMergeFailure({
      message: 'GUEST_MERGE_STALE: the surviving profile changed',
    })
    expect(failure?.code).toBe('guest_merge.stale')
    expect(failure?.userMessage).toContain('רענן')
    expect(failure?.message).toContain('GUEST_MERGE_STALE')
  })

  it('names both grants when a merge is refused for permission', () => {
    const failure = asMergeFailure({
      message:
        'GUEST_MERGE_FORBIDDEN: merging requires guest.update and guest.delete',
    })
    // "You lack permission" sends somebody to look for the wrong switch.
    expect(failure?.userMessage).toContain('עדכון אורח')
    expect(failure?.userMessage).toContain('מחיקת אורח')
  })

  it('leaves anything that is not one of theirs alone', () => {
    expect(asMergeFailure(new TypeError('x of undefined'))).toBeNull()
    expect(asMergeFailure({ message: 'duplicate key value' })).toBeNull()
    expect(asMergeFailure(null)).toBeNull()
    expect(asMergeFailure('GUEST_MERGE_STALE: as a bare string')).toBeNull()
  })

  it('has a Hebrew sentence for every token the migration actually raises', () => {
    const raised = new Set(
      [...sql.matchAll(/'(GUEST_MERGE[A-Z_]*):/g)].map((match) => match[1]),
    )
    expect(raised.size).toBeGreaterThan(0)

    for (const token of raised) {
      expect(KNOWN_MERGE_TOKENS).toContain(token)
    }
    // And nothing here that the database never says, which would be a sentence
    // nobody ever sees pretending to be coverage.
    for (const token of KNOWN_MERGE_TOKENS) {
      expect([...raised]).toContain(token)
    }
  })
})
