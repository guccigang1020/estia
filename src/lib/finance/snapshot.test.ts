import { describe, expect, it } from 'vitest'

import { sumLines } from '../booking/pricing'
import { BusinessRuleError } from '../errors'
import {
  applicableRules,
  captureFinanceSnapshot,
  snapshotFingerprint,
} from './snapshot'
import {
  AT,
  BOOKING,
  ORG,
  PROPERTY,
  UNIT,
  fixedRule,
  snapshotFor,
} from './testing'
import type { ExpenseRule } from './types'

const TARGET = {
  on: '2026-03-10',
  propertyId: PROPERTY,
  unitId: UNIT,
  bookingId: BOOKING,
}

describe('which rules apply', () => {
  it('reaches every booking from an organization rule', () => {
    const rule = fixedRule({ scope: { kind: 'organization' } })
    expect(applicableRules([rule], TARGET)).toEqual([rule])
  })

  it('confines a property rule to its own property', () => {
    const mine = fixedRule({
      scope: { kind: 'property', propertyId: PROPERTY },
    })
    const theirs = fixedRule({
      id: 'other',
      scope: { kind: 'property', propertyId: 'another-property' },
    })
    expect(applicableRules([mine, theirs], TARGET)).toEqual([mine])
  })

  it('confines a unit rule to its own unit', () => {
    const mine = fixedRule({ scope: { kind: 'unit', unitId: UNIT } })
    const theirs = fixedRule({
      id: 'other',
      scope: { kind: 'unit', unitId: 'another-unit' },
    })
    expect(applicableRules([mine, theirs], TARGET)).toEqual([mine])
  })

  it('confines a booking rule to its own booking', () => {
    const mine = fixedRule({ scope: { kind: 'booking', bookingId: BOOKING } })
    const theirs = fixedRule({
      id: 'other',
      scope: { kind: 'booking', bookingId: 'another-booking' },
    })
    expect(applicableRules([mine, theirs], TARGET)).toEqual([mine])
  })

  it('denies by default for a scope it does not recognise', () => {
    // A cost that allocated itself everywhere on an unrecognised scope would
    // reach every owner statement in the business.
    const odd = {
      ...fixedRule(),
      scope: { kind: 'galaxy' },
    } as unknown as ExpenseRule
    expect(applicableRules([odd], TARGET)).toEqual([])
  })

  it('treats effectivity as half-open, like a stay', () => {
    const replaced = fixedRule({
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-03-10',
    })
    const replacement = fixedRule({
      id: 'rule-new',
      effectiveFrom: '2026-03-10',
      effectiveTo: null,
    })

    // The tenth belongs to the replacement, and to it alone. A closed range
    // would apply both, or neither.
    expect(applicableRules([replaced, replacement], TARGET)).toEqual([
      replacement,
    ])
  })

  it('ignores a rule that did not exist yet', () => {
    expect(
      applicableRules([fixedRule({ effectiveFrom: '2026-04-01' })], TARGET),
    ).toEqual([])
  })
})

describe('capturing', () => {
  it('takes the total from the lines rather than from the caller', () => {
    // A total handed in beside its own lines is a total that can disagree
    // with them.
    const snapshot = snapshotFor()
    expect(snapshot.totalAgorot).toBe(sumLines(snapshot.lines))
  })

  it('copies the rule whole, with the version it had', () => {
    const snapshot = snapshotFor({
      expenseRules: [fixedRule({ version: 4, amountAgorot: 123_456 })],
    })

    expect(snapshot.expenseRules[0]).toMatchObject({
      ruleId: 'rule-cleaning',
      ruleVersion: 4,
      amountAgorot: 123_456,
      allocation: 'per_occupied_night',
    })
  })

  it('keeps only the rules that were in force for this booking', () => {
    const snapshot = snapshotFor({
      expenseRules: [
        fixedRule({ id: 'in-force' }),
        fixedRule({ id: 'expired', effectiveTo: '2026-01-01' }),
        fixedRule({
          id: 'elsewhere',
          scope: { kind: 'property', propertyId: 'another' },
        }),
      ],
    })

    expect(snapshot.expenseRules.map((rule) => rule.ruleId)).toEqual([
      'in-force',
    ])
  })

  it('is a copy, not a reference — editing the source cannot reach it', () => {
    const live = fixedRule({ amountAgorot: 300_000 })
    const snapshot = snapshotFor({ expenseRules: [live] })

    live.amountAgorot = 999_999
    live.version = 99

    expect(snapshot.expenseRules[0].amountAgorot).toBe(300_000)
    expect(snapshot.expenseRules[0].ruleVersion).toBe(1)
  })

  it('starts at revision one, superseding nothing', () => {
    const snapshot = snapshotFor()
    expect(snapshot.revision).toBe(1)
    expect(snapshot.supersedesCapturedAt).toBeNull()
  })

  it('demands a reason', () => {
    expect(() =>
      captureFinanceSnapshot({
        bookingId: BOOKING,
        organizationId: ORG,
        propertyId: PROPERTY,
        unitId: UNIT,
        capturedAt: AT('2026-02-01T00:00:00.000Z'),
        capturedByUserId: null,
        reason: '   ',
        range: { checkIn: '2026-03-10', checkOut: '2026-03-13' },
        nights: 3,
        guests: 2,
        lines: [],
        stayTotalAgorot: 0,
        depositAgorot: 0,
        taxAgorot: 0,
        taxRatePercent: 0,
        currency: 'ILS',
        commissionRule: null,
        ownerShareRule: null,
        expenseRules: [],
      }),
    ).toThrow(BusinessRuleError)
  })
})

describe('fingerprinting', () => {
  it('is stable for the same basis', () => {
    expect(snapshotFingerprint(snapshotFor())).toBe(
      snapshotFingerprint(snapshotFor()),
    )
  })

  it('changes when the basis changes', () => {
    expect(snapshotFingerprint(snapshotFor())).not.toBe(
      snapshotFingerprint(snapshotFor({ baseNightlyAgorot: 100_001 })),
    )
    expect(snapshotFingerprint(snapshotFor())).not.toBe(
      snapshotFingerprint(
        snapshotFor({ expenseRules: [fixedRule({ version: 2 })] }),
      ),
    )
  })

  it('does not change when only the moment of capture does', () => {
    // Two captures of the same basis are the same basis. The fingerprint
    // answers "did anything that decides money change", not "when".
    expect(
      snapshotFingerprint(
        snapshotFor({ capturedAt: AT('2026-02-01T00:00:00.000Z') }),
      ),
    ).toBe(
      snapshotFingerprint(
        snapshotFor({ capturedAt: AT('2026-07-01T00:00:00.000Z') }),
      ),
    )
  })
})
