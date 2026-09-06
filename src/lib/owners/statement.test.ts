/**
 * The statement's arithmetic, and the one property that matters most: it does
 * not disagree with finance.
 *
 * Every fixture here runs through the real `propertyPnl`, so a test that passes
 * is a test about the two modules agreeing rather than about a hand-written
 * number matching itself.
 */

import { describe, expect, it } from 'vitest'

import { sumAgorot } from '../finance/money'
import {
  buildOwnerStatement,
  expenseDetail,
  issueOwnerStatement,
  splitOwnerShare,
} from './statement'
import {
  ORG,
  OWNER_A,
  OWNER_B,
  PROPERTY,
  ownershipFor,
  payoutFor,
  pnlFor,
} from './testing'
import { FULL_SHARE_BPS } from './types'

const PERIOD = { periodStart: '2026-03-01', periodEnd: '2026-03-31' }

function statementFor(
  over: Partial<Parameters<typeof buildOwnerStatement>[0]> = {},
) {
  const pnl = over.pnl ?? pnlFor()
  return buildOwnerStatement({
    id: 'statement-1',
    organizationId: ORG,
    ownerId: OWNER_A,
    propertyId: PROPERTY,
    ...PERIOD,
    pnl,
    ownerships: [ownershipFor()],
    ...over,
  })
}

describe('buildOwnerStatement', () => {
  it('reconciles to the finance module rather than recomputing revenue', () => {
    const pnl = pnlFor()
    const statement = statementFor({ pnl })

    // Not "close to". The same numbers, because they are the same numbers.
    expect(statement.grossRevenueAgorot).toBe(pnl.grossRevenueAgorot)
    expect(statement.propertyOwnerShareAgorot).toBe(pnl.ownerShareAgorot)
    expect(statement.salesCommissionAgorot).toBe(pnl.agentCommissionAgorot)
    expect(statement.managementFeeAgorot).toBe(pnl.netProfitAgorot)
    expect(statement.feesAgorot).toBe(
      pnl.grossRevenueAgorot - pnl.netRevenueAgorot,
    )
    expect(statement.expensesAgorot).toBe(
      pnl.variableCostAgorot +
        pnl.allocatedFixedCostAgorot +
        pnl.unallocatedFixedCostAgorot,
    )
  })

  it('has totals that are the sum of its lines, in both sections', () => {
    const statement = statementFor()

    const chain = statement.resultLines
      .filter((line) => line.kind !== 'result')
      .map((line) => line.amountAgorot)
    expect(sumAgorot(chain)).toBe(statement.propertyOwnerShareAgorot)

    const balance = statement.balanceLines
      .filter((line) => line.kind !== 'result')
      .map((line) => line.amountAgorot)
    expect(sumAgorot(balance)).toBe(statement.closingBalanceAgorot)

    // The result lines are restatements of the running total and are excluded
    // from the sums above. They must still hold the totals they restate.
    const result = statement.resultLines.find(
      (line) => line.key === 'property_owner_share',
    )
    expect(result?.amountAgorot).toBe(statement.propertyOwnerShareAgorot)
    const closing = statement.balanceLines.find(
      (line) => line.key === 'closing_balance',
    )
    expect(closing?.amountAgorot).toBe(statement.closingBalanceAgorot)
  })

  it('named expenses add to the expenses total', () => {
    const pnl = pnlFor({ unallocatedFixedCostAgorot: 12_345 })
    const statement = statementFor({ pnl })

    expect(
      sumAgorot(statement.expenses.map((expense) => expense.amountAgorot)),
    ).toBe(statement.expensesAgorot)

    // The period cost that reached no booking is carried visibly rather than
    // pushed onto an arbitrary stay.
    expect(
      statement.expenses.find((expense) => expense.ruleId === 'unallocated')
        ?.amountAgorot,
    ).toBe(12_345)
  })

  it('aggregates a rule across the period instead of listing it per booking', () => {
    const detail = expenseDetail(pnlFor({ bookings: 3 }))
    const cleaning = detail.filter(
      (expense) => expense.ruleId === 'rule-cleaning',
    )

    expect(cleaning).toHaveLength(1)
    expect(cleaning[0].amountAgorot).toBe(3 * 18_000)
  })

  it('runs the account forward from the previous closing balance', () => {
    const statement = statementFor({
      openingBalanceAgorot: 120_000,
      payouts: [
        payoutFor({ id: 'p1', amountAgorot: 80_000, direction: 'to_owner' }),
        payoutFor({ id: 'p2', amountAgorot: 30_000, direction: 'from_owner' }),
      ],
    })

    expect(statement.openingBalanceAgorot).toBe(120_000)
    expect(statement.payoutsAgorot).toBe(80_000)
    expect(statement.paymentsAgorot).toBe(30_000)
    expect(statement.closingBalanceAgorot).toBe(
      120_000 + statement.ownerShareAgorot + 30_000 - 80_000,
    )
  })

  it('ignores another owner’s movements on the same property', () => {
    const statement = statementFor({
      ownerships: [
        ownershipFor({ shareBps: 5_000 }),
        ownershipFor({ ownerId: OWNER_B, shareBps: 5_000 }),
      ],
      payouts: [
        payoutFor({ id: 'p1', ownerId: OWNER_B, amountAgorot: 99_000 }),
      ],
    })

    expect(statement.payoutsAgorot).toBe(0)
  })

  it('refuses to build for somebody who holds no share of the property', () => {
    expect(() =>
      statementFor({ ownerId: OWNER_B, ownerships: [ownershipFor()] }),
    ).toThrow(/no share|not linked|owner_not_linked/i)
  })

  it('refuses shares that do not add to a whole property', () => {
    expect(() =>
      statementFor({ ownerships: [ownershipFor({ shareBps: 6_000 })] }),
    ).toThrow(/Ownership shares total 6000 bps/)
  })

  it('carries no guest identity — there is no field one could occupy', () => {
    const statement = statementFor()
    const serialised = JSON.stringify(statement)

    for (const forbidden of ['guest', 'agent', 'phone', 'email', '@']) {
      expect(serialised.toLowerCase()).not.toContain(forbidden)
    }

    // And the shape itself: the only booking-derived fact is a count.
    expect(Object.keys(statement)).not.toContain('bookings')
    expect(statement.bookingCount).toBeGreaterThan(0)
  })
})

describe('splitOwnerShare', () => {
  it('gives three equal owners parts that add to the whole exactly', () => {
    const ownerships = [
      ownershipFor({ ownerId: 'owner-1', shareBps: 3_334 }),
      ownershipFor({ ownerId: 'owner-2', shareBps: 3_333 }),
      ownershipFor({ ownerId: 'owner-3', shareBps: 3_333 }),
    ]

    const split = splitOwnerShare(1_000, ownerships)
    expect(sumAgorot([...split.values()])).toBe(1_000)
    // Largest remainder, not three times floor(333.4).
    expect([...split.values()].sort()).toEqual([333, 333, 334])
  })

  it('splits a negative period the same way, so nobody wins the coin flip', () => {
    const ownerships = [
      ownershipFor({ ownerId: 'owner-1', shareBps: 5_000 }),
      ownershipFor({ ownerId: 'owner-2', shareBps: 5_000 }),
    ]

    const split = splitOwnerShare(-1_001, ownerships)
    expect(sumAgorot([...split.values()])).toBe(-1_001)
  })

  it('is stable: the same input produces the same split every time', () => {
    const ownerships = [
      ownershipFor({ ownerId: 'owner-1', shareBps: 3_334 }),
      ownershipFor({ ownerId: 'owner-2', shareBps: 3_333 }),
      ownershipFor({ ownerId: 'owner-3', shareBps: 3_333 }),
    ]

    const first = splitOwnerShare(1_000, ownerships)
    const second = splitOwnerShare(1_000, ownerships)
    expect([...second.entries()]).toEqual([...first.entries()])
  })

  it('co-owners’ statements add to the property’s whole owner share', () => {
    const pnl = pnlFor({ bookings: 3 })
    const ownerships = [
      ownershipFor({ ownerId: OWNER_A, shareBps: 6_667 }),
      ownershipFor({ ownerId: OWNER_B, shareBps: 3_333 }),
    ]

    const a = statementFor({ pnl, ownerships })
    const b = statementFor({ pnl, ownerships, ownerId: OWNER_B })

    expect(a.ownerShareAgorot + b.ownerShareAgorot).toBe(pnl.ownerShareAgorot)
    expect(a.shareBps).toBe(6_667)
    expect(b.shareBps).toBe(3_333)
  })
})

describe('issueOwnerStatement', () => {
  it('freezes the draft and stamps who issued it and when', () => {
    const issued = issueOwnerStatement(
      statementFor(),
      'user-finance_manager',
      new Date('2026-04-02T08:00:00.000Z'),
    )

    expect(issued.status).toBe('issued')
    expect(issued.issuedAt).toBe('2026-04-02T08:00:00.000Z')
    expect(issued.issuedBy).toBe('user-finance_manager')
  })

  it('refuses to edit a statement that was already issued', () => {
    const issued = issueOwnerStatement(
      statementFor(),
      'user-finance_manager',
      new Date('2026-04-02T08:00:00.000Z'),
    )

    expect(() => issueOwnerStatement(issued, 'user-other', new Date())).toThrow(
      /already issued|כבר הופק/,
    )
  })

  it('keeps every figure the draft carried', () => {
    const draft = statementFor()
    const issued = issueOwnerStatement(draft, 'user-x', new Date())

    expect(issued.ownerShareAgorot).toBe(draft.ownerShareAgorot)
    expect(issued.closingBalanceAgorot).toBe(draft.closingBalanceAgorot)
    expect(issued.resultLines).toEqual(draft.resultLines)
  })
})

describe('a whole property', () => {
  it('a single owner receives the property’s entire owner share', () => {
    const pnl = pnlFor()
    const statement = statementFor({ pnl })

    expect(statement.shareBps).toBe(FULL_SHARE_BPS)
    expect(statement.ownerShareAgorot).toBe(pnl.ownerShareAgorot)
  })
})
