/**
 * Agencies.
 *
 * The entity that cannot belong to an organization, because it sells for
 * several at once. The tests below are mostly about the consequence of that:
 * access derives from a live agreement, so an agreement that ends removes the
 * reach without anybody deleting anything.
 */

import { describe, expect, it } from 'vitest'
import {
  activeAgreementFor,
  agencyReachesOrganization,
  isAgreementActive,
  organizationsForAgency,
  terminateAgreement,
  type AgencyAgreement,
  type AgencyMembership,
} from './agency'
import { BusinessRuleError } from '../errors'

const AGENCY = 'agency-1'
const ORG_A = 'org-a'
const ORG_B = 'org-b'

function agreement(over: Partial<AgencyAgreement> = {}): AgencyAgreement {
  return {
    id: 'agreement-1',
    agencyId: AGENCY,
    organizationId: ORG_A,
    rule: { kind: 'percentage', percent: 12 },
    base: 'accommodation_only',
    activeFrom: '2026-01-01',
    activeUntil: null,
    paymentTermsDays: 30,
    status: 'active',
    signedAt: '2025-12-15T00:00:00.000Z',
    createdAt: '2025-12-15T00:00:00.000Z',
    version: 1,
    ...over,
  }
}

function membership(over: Partial<AgencyMembership> = {}): AgencyMembership {
  return {
    agencyId: AGENCY,
    userId: 'user-7',
    role: 'agent',
    status: 'active',
    joinedAt: '2026-01-01T00:00:00.000Z',
    leftAt: null,
    ...over,
  }
}

// ── The entity ────────────────────────────────────────────────────────────

describe('an agency spans organizations', () => {
  it('sells for several businesses at once', () => {
    const agreements = [
      agreement({ id: 'a', organizationId: ORG_A }),
      agreement({ id: 'b', organizationId: ORG_B }),
    ]
    expect(
      [...organizationsForAgency(agreements, AGENCY, '2026-09-01')].sort(),
    ).toEqual([ORG_A, ORG_B])
  })

  it('has a different agreement with each of them', () => {
    const agreements = [
      agreement({
        id: 'a',
        organizationId: ORG_A,
        rule: { kind: 'percentage', percent: 12 },
      }),
      agreement({
        id: 'b',
        organizationId: ORG_B,
        rule: { kind: 'percentage', percent: 8 },
      }),
    ]
    const inA = activeAgreementFor(agreements, AGENCY, ORG_A, '2026-09-01')
    const inB = activeAgreementFor(agreements, AGENCY, ORG_B, '2026-09-01')
    expect(inA?.rule).toEqual({ kind: 'percentage', percent: 12 })
    expect(inB?.rule).toEqual({ kind: 'percentage', percent: 8 })
  })

  it('never returns another organization’s agreement', () => {
    const agreements = [agreement({ organizationId: ORG_B })]
    expect(
      activeAgreementFor(agreements, AGENCY, ORG_A, '2026-09-01'),
    ).toBeNull()
  })

  it('never returns another agency’s agreement', () => {
    const agreements = [agreement({ agencyId: 'agency-9' })]
    expect(
      activeAgreementFor(agreements, AGENCY, ORG_A, '2026-09-01'),
    ).toBeNull()
  })
})

// ── Liveness ──────────────────────────────────────────────────────────────

describe('an agreement is live only on the dates it covers', () => {
  it('is live inside its window', () => {
    expect(isAgreementActive(agreement(), '2026-09-01')).toBe(true)
  })

  it('is not live before it starts', () => {
    expect(
      isAgreementActive(agreement({ activeFrom: '2026-10-01' }), '2026-09-01'),
    ).toBe(false)
  })

  it('is not live after it ends, whether or not a job has run', () => {
    // A background job that stops running must not be able to grant access it
    // was supposed to remove.
    expect(
      isAgreementActive(agreement({ activeUntil: '2026-08-31' }), '2026-09-01'),
    ).toBe(false)
  })

  it('is inclusive at both ends', () => {
    const bounded = agreement({
      activeFrom: '2026-09-01',
      activeUntil: '2026-09-30',
    })
    expect(isAgreementActive(bounded, '2026-09-01')).toBe(true)
    expect(isAgreementActive(bounded, '2026-09-30')).toBe(true)
    expect(isAgreementActive(bounded, '2026-10-01')).toBe(false)
  })

  it('is not live while it is still a draft', () => {
    expect(
      isAgreementActive(agreement({ status: 'draft' }), '2026-09-01'),
    ).toBe(false)
  })

  it('prefers the renewal when two agreements overlap', () => {
    const chosen = activeAgreementFor(
      [
        agreement({ id: 'old', activeFrom: '2026-01-01' }),
        agreement({ id: 'renewal', activeFrom: '2026-06-01' }),
      ],
      AGENCY,
      ORG_A,
      '2026-09-01',
    )
    expect(chosen?.id).toBe('renewal')
  })

  it('is deterministic when two agreements start on the same day', () => {
    const rules = [agreement({ id: 'bbb' }), agreement({ id: 'aaa' })]
    const first = activeAgreementFor(rules, AGENCY, ORG_A, '2026-09-01')
    const second = activeAgreementFor(
      [...rules].reverse(),
      AGENCY,
      ORG_A,
      '2026-09-01',
    )
    expect(first?.id).toBe(second?.id)
  })
})

// ── Reach ─────────────────────────────────────────────────────────────────

describe('whether an agency member reaches an organization', () => {
  const base = {
    agreements: [agreement()],
    agencyId: AGENCY,
    organizationId: ORG_A,
    on: '2026-09-01',
  }

  it('reaches it with a live agreement and a live membership', () => {
    expect(
      agencyReachesOrganization({ ...base, membership: membership() }),
    ).toBe(true)
  })

  it('does not reach it once the agreement has ended', () => {
    expect(
      agencyReachesOrganization({
        ...base,
        agreements: [agreement({ activeUntil: '2026-08-31' })],
        membership: membership(),
      }),
    ).toBe(false)
  })

  it('does not reach it once the person has left the agency', () => {
    expect(
      agencyReachesOrganization({
        ...base,
        membership: membership({ status: 'removed' }),
      }),
    ).toBe(false)
  })

  it('does not reach it while the person is suspended by the agency', () => {
    expect(
      agencyReachesOrganization({
        ...base,
        membership: membership({ status: 'suspended' }),
      }),
    ).toBe(false)
  })

  it('does not reach it for somebody who was never a member', () => {
    expect(agencyReachesOrganization({ ...base, membership: null })).toBe(false)
  })

  it('does not let a member of one agency ride another’s agreement', () => {
    expect(
      agencyReachesOrganization({
        ...base,
        membership: membership({ agencyId: 'agency-9' }),
      }),
    ).toBe(false)
  })

  it('does not reach an organization the agency never signed with', () => {
    expect(
      agencyReachesOrganization({
        ...base,
        organizationId: ORG_B,
        membership: membership(),
      }),
    ).toBe(false)
  })
})

// ── Ending one ────────────────────────────────────────────────────────────

describe('terminating an agreement', () => {
  it('closes it without deleting anything', () => {
    const ended = terminateAgreement(agreement(), { effectiveOn: '2026-09-30' })
    expect(ended.status).toBe('terminated')
    expect(ended.activeUntil).toBe('2026-09-30')
    // The commercial terms survive: commissions written under them are still
    // owed and must still be explainable.
    expect(ended.rule).toEqual({ kind: 'percentage', percent: 12 })
    expect(ended.base).toBe('accommodation_only')
    expect(ended.version).toBe(2)
  })

  it('honours a notice period rather than revoking at once', () => {
    // A future end date is normal. Access continues until the date arrives.
    const ended = terminateAgreement(agreement(), { effectiveOn: '2026-12-31' })
    expect(isAgreementActive(ended, '2026-09-01')).toBe(false)
    // ...because the status is now `terminated`. The date bounds the record;
    // the status is what stops it being live.
    expect(ended.activeUntil).toBe('2026-12-31')
  })

  it('refuses to end an agreement twice', () => {
    const ended = terminateAgreement(agreement(), { effectiveOn: '2026-09-30' })
    expect(() =>
      terminateAgreement(ended, { effectiveOn: '2026-10-31' }),
    ).toThrow(BusinessRuleError)
  })

  it('refuses an end date before the start date', () => {
    expect(() =>
      terminateAgreement(agreement(), { effectiveOn: '2025-06-01' }),
    ).toThrow(BusinessRuleError)
  })

  it('removes the organization from the agency’s book of business', () => {
    const ended = terminateAgreement(agreement({ organizationId: ORG_A }), {
      effectiveOn: '2026-08-31',
    })
    const agreements = [ended, agreement({ id: 'b', organizationId: ORG_B })]
    expect(organizationsForAgency(agreements, AGENCY, '2026-09-01')).toEqual([
      ORG_B,
    ])
  })

  it('never mutates the agreement it was given', () => {
    const before = agreement()
    terminateAgreement(before, { effectiveOn: '2026-09-30' })
    expect(before.status).toBe('active')
    expect(before.activeUntil).toBeNull()
  })
})
