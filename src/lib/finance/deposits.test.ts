import { describe, expect, it } from 'vitest'

import { AuthorizationError } from '../authz/can'
import { BusinessRuleError } from '../errors'
import {
  authorizeDeposit,
  availableHold,
  createDeposit,
  depositPosition,
  forfeitDeposit,
  releaseDeposit,
} from './deposits'
import {
  AT,
  BOOKING,
  ORG,
  PROPERTY,
  cleanerActor,
  financeActor,
} from './testing'
import type { Deposit } from './types'

const NOW = AT('2026-03-14T09:00:00.000Z')
const actor = financeActor()

function fresh(requiredAgorot = 100_000): Deposit {
  return createDeposit(
    {
      id: 'dep-1',
      organizationId: ORG,
      propertyId: PROPERTY,
      bookingId: BOOKING,
      requiredAgorot,
    },
    NOW,
  )
}

function held(amount = 100_000): Deposit {
  return authorizeDeposit(actor, fresh(), amount, { now: NOW }).deposit
}

describe('creating a deposit', () => {
  it('starts holding nothing', () => {
    const deposit = fresh()
    expect(deposit.status).toBe('pending')
    expect(deposit.heldAgorot).toBe(0)
    expect(availableHold(deposit)).toBe(0)
  })

  it('accepts a zero deposit as a real record', () => {
    // "No deposit required" is an answer. An absent record leaves the
    // question open on every screen that asks it.
    const none = fresh(0)
    expect(none.requiredAgorot).toBe(0)
    expect(depositPosition(none).settled).toBe(true)
  })

  it('refuses a negative or fractional requirement', () => {
    expect(() =>
      createDeposit(
        {
          id: 'd',
          organizationId: ORG,
          propertyId: PROPERTY,
          bookingId: BOOKING,
          requiredAgorot: -1,
        },
        NOW,
      ),
    ).toThrow(BusinessRuleError)
  })
})

describe('authorising', () => {
  it('records what the provider reserved, not what was asked for', () => {
    // Providers reduce an authorisation for their own reasons. Recording our
    // request as their answer is how a business believes it holds money it
    // does not.
    const change = authorizeDeposit(actor, fresh(100_000), 80_000, { now: NOW })

    expect(change.deposit.status).toBe('authorized')
    expect(change.deposit.heldAgorot).toBe(80_000)
    expect(change.deposit.requiredAgorot).toBe(100_000)
    expect(change.event).toBe('deposit.authorized')
    expect(change.deposit.authorizedAt).toEqual(NOW)
  })

  it('refuses a second hold on top of a live one', () => {
    expect(() => authorizeDeposit(actor, held(), 50_000, { now: NOW })).toThrow(
      BusinessRuleError,
    )
  })

  it('refuses a cleaner', () => {
    expect(() =>
      authorizeDeposit(cleanerActor(), fresh(), 10_000, { now: NOW }),
    ).toThrow(AuthorizationError)
  })
})

describe('forfeiting', () => {
  it('takes the whole hold and lands on paid', () => {
    const change = forfeitDeposit(actor, held(), 100_000, {
      now: NOW,
      reason: 'שבירת שולחן זכוכית',
    })

    expect(change.deposit.status).toBe('paid')
    expect(change.deposit.forfeitedAgorot).toBe(100_000)
    expect(change.deposit.releasedAgorot).toBe(0)
    expect(availableHold(change.deposit)).toBe(0)
    expect(change.event).toBe('deposit.captured')
  })

  it('releases the untouched remainder in the same movement', () => {
    // A business that deducts ₪300 of a ₪1,000 hold must not keep reserving
    // the other ₪700 against the guest's credit limit for another month.
    const change = forfeitDeposit(actor, held(), 30_000, {
      now: NOW,
      reason: 'ניקיון חריג',
    })

    expect(change.deposit.status).toBe('partially_paid')
    expect(change.deposit.forfeitedAgorot).toBe(30_000)
    expect(change.deposit.releasedAgorot).toBe(70_000)
    expect(availableHold(change.deposit)).toBe(0)
    expect(depositPosition(change.deposit).settled).toBe(true)
    expect(change.summary).toContain('₪700')
  })

  it('requires a stated reason', () => {
    expect(() =>
      forfeitDeposit(actor, held(), 30_000, { now: NOW, reason: '  ' }),
    ).toThrow(BusinessRuleError)
  })

  it('puts the reason on the record, not only in the log', () => {
    const change = forfeitDeposit(actor, held(), 30_000, {
      now: NOW,
      reason: 'נזק למקרר',
    })
    expect(change.deposit.forfeitReason).toBe('נזק למקרר')
  })

  it('refuses more than is held', () => {
    try {
      forfeitDeposit(actor, held(50_000), 60_000, {
        now: NOW,
        reason: 'נזק',
      })
      expect.unreachable('expected the forfeit to be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessRuleError)
      expect((error as BusinessRuleError).publicDetails).toMatchObject({
        requested: 60_000,
        held: 50_000,
      })
    }
  })

  it('refuses a zero or fractional deduction', () => {
    expect(() =>
      forfeitDeposit(actor, held(), 0, { now: NOW, reason: 'נזק' }),
    ).toThrow(BusinessRuleError)
    expect(() =>
      forfeitDeposit(actor, held(), 10.5, { now: NOW, reason: 'נזק' }),
    ).toThrow(BusinessRuleError)
  })

  it('refuses a cleaner', () => {
    expect(() =>
      forfeitDeposit(cleanerActor(), held(), 1_000, {
        now: NOW,
        reason: 'נזק',
      }),
    ).toThrow(AuthorizationError)
  })
})

describe('releasing', () => {
  it('gives the whole hold back and lands on cancelled', () => {
    const change = releaseDeposit(actor, held(), { now: NOW })

    expect(change.deposit.status).toBe('cancelled')
    expect(change.deposit.releasedAgorot).toBe(100_000)
    expect(change.deposit.forfeitedAgorot).toBe(0)
    expect(change.deposit.releasedByUserId).toBe(actor.userId)
    expect(change.event).toBe('deposit.released')
    expect(availableHold(change.deposit)).toBe(0)
  })

  it('refuses once something has been deducted', () => {
    // The instrument for money already taken is a refund, not a release, and
    // the two are different documents to a guest.
    const deducted = forfeitDeposit(actor, held(), 30_000, {
      now: NOW,
      reason: 'נזק',
    }).deposit

    expect(() => releaseDeposit(actor, deducted, { now: NOW })).toThrow(
      BusinessRuleError,
    )
  })

  it('refuses when nothing is held', () => {
    expect(() => releaseDeposit(actor, fresh(), { now: NOW })).toThrow(
      BusinessRuleError,
    )
  })

  it('refuses a cleaner', () => {
    expect(() => releaseDeposit(cleanerActor(), held(), { now: NOW })).toThrow(
      AuthorizationError,
    )
  })
})

describe('the invariant', () => {
  it('never lets more leave the deposit than entered it', () => {
    for (const hold of [1, 999, 100_000, 7_777_777]) {
      const deductions = [...new Set([1, Math.floor(hold / 3), hold])].filter(
        (amount) => amount > 0,
      )
      for (const deduction of deductions) {
        const after = forfeitDeposit(actor, held(hold), deduction, {
          now: NOW,
          reason: 'בדיקה',
        }).deposit

        expect(after.releasedAgorot + after.forfeitedAgorot).toBe(
          after.heldAgorot,
        )
        expect(availableHold(after)).toBe(0)
      }
    }
  })

  it('reports the position as four separate facts', () => {
    const after = forfeitDeposit(actor, held(), 40_000, {
      now: NOW,
      reason: 'נזק',
    }).deposit

    expect(depositPosition(after)).toEqual({
      requiredAgorot: 100_000,
      outstandingHoldAgorot: 0,
      releasedAgorot: 60_000,
      forfeitedAgorot: 40_000,
      settled: true,
    })
  })
})
