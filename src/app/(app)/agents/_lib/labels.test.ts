/**
 * The distribution wording, checked for totality against the contracts it
 * words.
 *
 * This is the point of the file it tests, exactly as it is for
 * `finance/_lib/labels.ts`: every record is total over its tuple, so a rung
 * added to `roles.ts` or a status added to `can.ts` without wording here fails
 * the suite rather than shipping `net_commission` into a Hebrew screen.
 *
 * `Record<K, string>` already makes a *missing* key a compile error. What a
 * test adds is the two things the type cannot see: that no value is blank, and
 * that no value was left in English — both of which typecheck perfectly and are
 * what actually reaches a guesthouse owner.
 */

import { describe, expect, it } from 'vitest'

import { MEMBERSHIP_STATUSES } from '@/lib/authz/can'
import {
  CALENDAR_LEVELS,
  GUEST_DATA_LEVELS,
  PRICE_LEVELS,
} from '@/lib/authz/roles'

import {
  AGENCY_MEMBER_ROLES,
  AGENCY_MEMBER_ROLE_LABEL,
  AGENCY_MEMBER_STATUSES,
  AGENCY_MEMBER_STATUS_LABEL,
  AGENCY_STATUSES,
  AGENCY_STATUS_LABEL,
  AGENT_STATUS_LABEL,
  AGREEMENT_STATUSES,
  AGREEMENT_STATUS_LABEL,
  CALENDAR_LEVEL_LABEL,
  GUEST_DATA_LEVEL_LABEL,
  PRICE_LEVEL_LABEL,
  QUOTE_OUTCOMES,
  QUOTE_OUTCOME_LABEL,
  WITHHELD,
  agentStatusTone,
  agentStatusVoided,
  agreementTone,
  cancellationLabel,
  inventoryReachLabel,
  quoteOutcomeTone,
} from './labels'

/** Hebrew letters, which is what a user-facing string in this product has. */
const HEBREW = /[֐-׿]/

function assertTotal<K extends string>(
  keys: readonly K[],
  labels: Record<K, string>,
) {
  for (const key of keys) {
    const label = labels[key]
    expect(label, `no wording for '${key}'`).toBeTruthy()
    expect(label.trim().length, `blank wording for '${key}'`).toBeGreaterThan(0)
    expect(HEBREW.test(label), `'${key}' is not worded in Hebrew`).toBe(true)
  }
  // And nothing extra: a label for a value the contract does not carry is a
  // rung somebody removed and forgot to stop wording.
  expect(Object.keys(labels).sort()).toEqual([...keys].sort())
}

describe('the three ladders', () => {
  it('words every calendar rung', () => {
    assertTotal(CALENDAR_LEVELS, CALENDAR_LEVEL_LABEL)
  })

  it('words every price rung', () => {
    assertTotal(PRICE_LEVELS, PRICE_LEVEL_LABEL)
  })

  it('words every guest-data rung', () => {
    assertTotal(GUEST_DATA_LEVELS, GUEST_DATA_LEVEL_LABEL)
  })

  it('words the guest-data rungs cumulatively, because they are cumulative', () => {
    // `grantsForGuestDataLevel('phone')` grants the name as well, so a label
    // reading only "טלפון" would understate what an owner just handed over.
    expect(GUEST_DATA_LEVEL_LABEL.phone).toContain('שם')
    expect(GUEST_DATA_LEVEL_LABEL.email).toContain('שם')
    expect(GUEST_DATA_LEVEL_LABEL.email).toContain('טלפון')
  })
})

describe('agent status', () => {
  it('words every membership status', () => {
    assertTotal(MEMBERSHIP_STATUSES, AGENT_STATUS_LABEL)
  })

  it('gives the two an owner scans for their own tone', () => {
    expect(agentStatusTone('active')).toBe('brand')
    expect(agentStatusTone('suspended')).toBe('accent')
    expect(agentStatusTone('removed')).toBe('accent')
    expect(agentStatusTone('invited')).toBe('neutral')
    expect(agentStatusTone('pending')).toBe('neutral')
  })

  it('strikes through only a relationship that is over', () => {
    // A suspension is a pause and reads as one; struck-through text says
    // "this is finished", which about a suspended agent is wrong in the
    // direction that gets somebody reinstated by accident.
    expect(agentStatusVoided('removed')).toBe(true)
    expect(agentStatusVoided('suspended')).toBe(false)
    expect(agentStatusVoided('active')).toBe(false)
  })
})

describe('the inventory reach', () => {
  it('says that "everything" includes what is bought later', () => {
    // `inventoryScopeToScope` turns `all_properties` into `all_organization`
    // rather than a snapshot of today's list, so an owner choosing it is
    // granting the future as well and should be told so.
    const label = inventoryReachLabel({ kind: 'all_properties' })
    expect(label).toContain('כל הנכסים')
    expect(label).toContain('בהמשך')
  })

  it('counts, and agrees with itself in the singular', () => {
    expect(
      inventoryReachLabel({ kind: 'properties', propertyIds: ['a'] }),
    ).toBe('נכס אחד')
    expect(
      inventoryReachLabel({ kind: 'properties', propertyIds: ['a', 'b'] }),
    ).toBe('2 נכסים')
    expect(inventoryReachLabel({ kind: 'units', unitIds: ['a'] })).toBe(
      'יחידה אחת',
    )
    expect(
      inventoryReachLabel({ kind: 'units', unitIds: ['a', 'b', 'c'] }),
    ).toBe('3 יחידות')
  })

  it('says nothing at all about an empty list, because the CHECK forbids one', () => {
    // 0019's `inventory_shape` refuses an empty list on `properties` and
    // `units`, so "0 נכסים" is a string this product cannot produce. Asserted
    // so that a future relaxation of the constraint has to face this line.
    expect(inventoryReachLabel({ kind: 'properties', propertyIds: [] })).toBe(
      '0 נכסים',
    )
  })
})

describe('the cancellation policy', () => {
  it('words all four postures, and carries the hours', () => {
    expect(cancellationLabel({ kind: 'never' })).toContain('לא')
    expect(cancellationLabel({ kind: 'until_paid' })).toContain('תשלום')
    expect(cancellationLabel({ kind: 'requires_approval' })).toContain('אישור')
    expect(
      cancellationLabel({ kind: 'hours_before_arrival', hours: 48 }),
    ).toContain('48')
  })
})

describe('the agency vocabularies', () => {
  it('words every agency status, member role, member status and agreement status', () => {
    assertTotal(AGENCY_STATUSES, AGENCY_STATUS_LABEL)
    assertTotal(AGENCY_MEMBER_ROLES, AGENCY_MEMBER_ROLE_LABEL)
    assertTotal(AGENCY_MEMBER_STATUSES, AGENCY_MEMBER_STATUS_LABEL)
    assertTotal(AGREEMENT_STATUSES, AGREEMENT_STATUS_LABEL)
  })

  it('tones an agreement by whether it is live today, not by its status', () => {
    // `isAgreementActive` decides against the date every time, because an
    // agreement whose end date passed last night is over whether or not a job
    // has run to say so. The tone follows the computed answer, which is why it
    // takes a boolean and not a status.
    expect(agreementTone(true)).toBe('brand')
    expect(agreementTone(false)).toBe('neutral')
  })
})

describe('the quote outcomes', () => {
  it('words all four', () => {
    assertTotal(QUOTE_OUTCOMES, QUOTE_OUTCOME_LABEL)
  })

  it('separates "still open" from "won" in tone', () => {
    // An open offer is the one a person still has to do something about, so it
    // leaves the neutral palette; a won one is settled.
    expect(quoteOutcomeTone('open')).toBe('accent')
    expect(quoteOutcomeTone('won')).toBe('brand')
    expect(quoteOutcomeTone('released')).toBe('neutral')
    expect(quoteOutcomeTone('expired')).toBe('neutral')
  })
})

describe('the withheld sentence', () => {
  it('says something, rather than leaving a blank cell', () => {
    // A blank cell reads as "there is nothing here", which is a different and
    // false statement from "you may not see this".
    expect(WITHHELD.trim().length).toBeGreaterThan(0)
    expect(HEBREW.test(WITHHELD)).toBe(true)
  })
})
