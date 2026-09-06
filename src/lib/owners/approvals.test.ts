/**
 * Owner approvals — the transitions, and the three refusals that make the
 * mechanism worth having.
 *
 * The tests are about the domain rules only. That the `approvals` table holds
 * the self-approval rule by CHECK is the schema's business and is asserted in
 * `supabase/tests`; what is asserted here is that a person is told why in
 * Hebrew before the constraint ever has to fire.
 */

import { describe, expect, it } from 'vitest'

import {
  OWNER_APPROVAL_SUBJECT_TYPE,
  OWNER_APPROVAL_TYPE,
  decideOwnerApproval,
  draftOwnerApproval,
  isAwaitingOwner,
  tallyOwnerApprovals,
  type OwnerApproval,
} from './approvals'
import { ORG, OWNER_A, PROPERTY } from './testing'

const NOW = new Date('2026-03-15T10:00:00.000Z')
const LATER = new Date('2026-03-16T10:00:00.000Z')

function draft(over: Partial<Parameters<typeof draftOwnerApproval>[0]> = {}) {
  return draftOwnerApproval(
    {
      id: 'approval-1',
      organizationId: ORG,
      propertyId: PROPERTY,
      ownerId: OWNER_A,
      kind: 'maintenance_expense',
      reason: 'הדוד התפוצץ ועלות ההחלפה 4,200 ש״ח',
      requestedAgorot: 420_000,
      limitAgorot: 150_000,
      requestedBy: 'user-property_manager',
      ...over,
    },
    NOW,
  )
}

describe('it consumes the existing approvals concept', () => {
  it('writes owner requests as the type the enum already has', () => {
    expect(OWNER_APPROVAL_TYPE).toBe('owner_request')
    expect(OWNER_APPROVAL_SUBJECT_TYPE).toBe('property_owner')
  })

  it('uses the shared status vocabulary rather than inventing one', () => {
    expect(draft().status).toBe('requested')
    expect(
      decideOwnerApproval(draft(), {
        decision: 'approved',
        decidedBy: 'user-finance_manager',
        now: LATER,
      }).status,
    ).toBe('approved')
  })
})

describe('drafting', () => {
  it('carries the ask and the ceiling it exceeds', () => {
    const approval = draft()
    expect(approval.requestedAgorot).toBe(420_000)
    expect(approval.limitAgorot).toBe(150_000)
    expect(approval.requestedAt).toBe(NOW.toISOString())
  })

  it('refuses a blank reason — an unexplained ask gets waved through', () => {
    expect(() => draft({ reason: '   ' })).toThrow(/blank reason/)
  })

  it('trims the reason rather than storing whitespace', () => {
    expect(draft({ reason: '  צנרת  ' }).reason).toBe('צנרת')
  })
})

describe('deciding', () => {
  it('records who decided and when', () => {
    const decided = decideOwnerApproval(draft(), {
      decision: 'rejected',
      decidedBy: 'user-finance_manager',
      note: 'נדחה, נטפל בעונה הנמוכה',
      now: LATER,
    })

    expect(decided.status).toBe('rejected')
    expect(decided.decidedBy).toBe('user-finance_manager')
    expect(decided.decidedAt).toBe(LATER.toISOString())
    expect(decided.decisionNote).toBe('נדחה, נטפל בעונה הנמוכה')
    expect(decided.version).toBe(2)
  })

  it('refuses the requester deciding their own request', () => {
    expect(() =>
      decideOwnerApproval(draft(), {
        decision: 'approved',
        decidedBy: 'user-property_manager',
        now: LATER,
      }),
    ).toThrow(/decide their own request/)
  })

  it('refuses a second decision on a settled request', () => {
    const decided = decideOwnerApproval(draft(), {
      decision: 'approved',
      decidedBy: 'user-finance_manager',
      now: LATER,
    })

    expect(() =>
      decideOwnerApproval(decided, {
        decision: 'rejected',
        decidedBy: 'user-other',
        now: LATER,
      }),
    ).toThrow(/cannot be decided again/)
  })

  it('refuses a request whose window has closed', () => {
    const lapsing = draft({ expiresAt: new Date('2026-03-15T12:00:00.000Z') })

    expect(() =>
      decideOwnerApproval(lapsing, {
        decision: 'approved',
        decidedBy: 'user-finance_manager',
        now: LATER,
      }),
    ).toThrow(/expired/)
  })

  it('empties a whitespace-only note rather than storing one', () => {
    const decided = decideOwnerApproval(draft(), {
      decision: 'approved',
      decidedBy: 'user-finance_manager',
      note: '   ',
      now: LATER,
    })
    expect(decided.decisionNote).toBeNull()
  })
})

describe('liveness is decided against the clock', () => {
  it('a lapsed request is not shown as actionable, whatever its status says', () => {
    const lapsing = draft({ expiresAt: new Date('2026-03-15T12:00:00.000Z') })

    expect(isAwaitingOwner(lapsing, NOW)).toBe(true)
    // Same row, no sweeper has run, and it is no longer something to act on.
    expect(isAwaitingOwner(lapsing, LATER)).toBe(false)
  })

  it('a request with no expiry waits indefinitely', () => {
    expect(isAwaitingOwner(draft(), LATER)).toBe(true)
  })
})

describe('the dashboard tally', () => {
  it('counts what is waiting and what it is worth', () => {
    const settled: OwnerApproval = decideOwnerApproval(
      draft({ id: 'approval-2' }),
      { decision: 'approved', decidedBy: 'user-finance_manager', now: LATER },
    )

    const tally = tallyOwnerApprovals(
      [
        draft(),
        draft({ id: 'approval-3', requestedAgorot: 80_000 }),
        settled,
        draft({
          id: 'approval-4',
          expiresAt: new Date('2026-03-15T12:00:00.000Z'),
        }),
      ],
      LATER,
    )

    expect(tally.waiting).toBe(2)
    expect(tally.waitingAgorot).toBe(500_000)
    expect(tally.approved).toBe(1)
    expect(tally.rejected).toBe(0)
  })
})
