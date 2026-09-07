import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  ALL_STATUS_PAIRS,
  canTransition,
  isOpen,
  nextStatuses,
  problemsWith,
} from './transitions'
import { LEAD_STATUSES, type LeadStatus } from './types'

const MIGRATION = fileURLToPath(
  new URL(
    '../../../supabase/migrations/0074_leads_and_guest_merges.sql',
    import.meta.url,
  ),
)

describe('the lead state machine', () => {
  it('names every ordered pair exactly once', () => {
    expect(ALL_STATUS_PAIRS).toHaveLength(
      LEAD_STATUSES.length * LEAD_STATUSES.length,
    )
  })

  /**
   * The test this file exists for.
   *
   * `tg_lead_is_governed` and `transitions.ts` are two statements of §4.1, and
   * two statements of one rule drift. This reads the pair list out of the
   * migration itself and compares it to `ALLOWED`, so a change to either half
   * fails here rather than in production as a button that does nothing.
   */
  it('agrees with the trigger in the migration, pair for pair', () => {
    const sql = readFileSync(MIGRATION, 'utf8')

    const block = sql.slice(
      sql.indexOf('v_allowed := (old.status, new.status) in ('),
      sql.indexOf('if not v_allowed then'),
    )
    expect(block.length).toBeGreaterThan(0)

    const inSql = new Set(
      [...block.matchAll(/\('(\w+)',\s*'(\w+)'\)/g)].map(
        (match) => `${match[1]}->${match[2]}`,
      ),
    )
    expect(inSql.size).toBeGreaterThan(0)

    const inTypeScript = new Set(
      ALL_STATUS_PAIRS.filter(([from, to]) => canTransition(from, to)).map(
        ([from, to]) => `${from}->${to}`,
      ),
    )

    expect([...inTypeScript].sort()).toEqual([...inSql].sort())
  })

  it('makes booked terminal', () => {
    expect(nextStatuses('booked')).toEqual([])
    for (const status of LEAD_STATUSES) {
      expect(canTransition('booked', status)).toBe(false)
    }
  })

  it('never lets a lead jump straight from new to booked', () => {
    // A walk-in that books on the spot is a booking, not a conversion.
    expect(canTransition('new', 'booked')).toBe(false)
    expect(canTransition('contacted', 'booked')).toBe(false)
  })

  it('lets a closed lead back in only through contacted', () => {
    expect(nextStatuses('lost')).toEqual(['contacted'])
  })

  it('treats everything but booked and lost as open', () => {
    const open = LEAD_STATUSES.filter(isOpen)
    expect(open).toEqual([
      'new',
      'contacted',
      'interested',
      'quote_sent',
      'negotiation',
    ])
  })
})

describe('what a move needs before it happens', () => {
  it('refuses a move that is not in the table, and says both names', () => {
    const problems = problemsWith({ from: 'new', to: 'negotiation' })
    expect(problems).toHaveLength(1)
    expect(problems[0].message).toContain('חדש')
    expect(problems[0].message).toContain('משא ומתן')
  })

  it('says nothing more once the move itself is impossible', () => {
    // A refused move must not also complain about a missing lost reason: the
    // second sentence is about a move that is not going to happen.
    expect(problemsWith({ from: 'booked', to: 'lost' })).toHaveLength(1)
  })

  it('demands a reason on the way to lost', () => {
    const problems = problemsWith({ from: 'contacted', to: 'lost' })
    expect(problems.map((problem) => problem.field)).toEqual(['lostReason'])
  })

  it('demands a note when the reason is other', () => {
    const problems = problemsWith({
      from: 'contacted',
      to: 'lost',
      lostReason: 'other',
    })
    expect(problems.map((problem) => problem.field)).toEqual(['lostNote'])
  })

  it('accepts a closing reason that explains itself', () => {
    expect(
      problemsWith({
        from: 'contacted',
        to: 'lost',
        lostReason: 'dates_unavailable',
      }),
    ).toEqual([])
  })

  it('demands a booking on the way to booked', () => {
    const problems = problemsWith({ from: 'interested', to: 'booked' })
    expect(problems.map((problem) => problem.field)).toEqual(['bookingId'])
  })

  /**
   * The rule that keeps one person out of two figures.
   *
   * `inquiry`, `quote` and `option` are the three statuses
   * `src/lib/revenue/stays.ts` excludes from occupancy, and this imports that
   * decision rather than restating it. A lead pointing at a booking still in
   * one of them has not converted, and counting it would put the same person
   * in the funnel and in the occupancy figures at once.
   */
  it.each(['inquiry', 'quote', 'option'] as const)(
    'refuses to call a lead booked when the booking is still %s',
    (status) => {
      const problems = problemsWith({
        from: 'quote_sent',
        to: 'booked',
        bookingId: 'b-1',
        bookingStatus: status,
      })
      expect(problems).toHaveLength(1)
      expect(problems[0].message).toContain('תפוסה')
    },
  )

  it.each(['awaiting_payment', 'confirmed', 'checked_out'] as const)(
    'accepts a booking that is genuinely a stay (%s)',
    (status) => {
      expect(
        problemsWith({
          from: 'quote_sent',
          to: 'booked',
          bookingId: 'b-1',
          bookingStatus: status,
        }),
      ).toEqual([])
    },
  )

  it('refuses when the linked booking cannot be read at all', () => {
    // Null is not "probably fine". A conversion recorded against a booking
    // nobody could load is a conversion nobody can check.
    const problems = problemsWith({
      from: 'quote_sent',
      to: 'booked',
      bookingId: 'b-1',
      bookingStatus: null,
    })
    expect(problems).toHaveLength(1)
  })

  it('demands a reason to reopen a closed lead', () => {
    const problems = problemsWith({ from: 'lost', to: 'contacted' })
    expect(problems.map((problem) => problem.field)).toEqual(['reason'])

    expect(
      problemsWith({
        from: 'lost',
        to: 'contacted',
        reason: 'התקשר שוב עם תאריכים אחרים',
      }),
    ).toEqual([])
  })

  it('says so plainly when the lead is already there', () => {
    const problems = problemsWith({
      from: 'contacted' as LeadStatus,
      to: 'contacted' as LeadStatus,
    })
    expect(problems).toHaveLength(1)
    expect(problems[0].field).toBe('status')
  })
})
