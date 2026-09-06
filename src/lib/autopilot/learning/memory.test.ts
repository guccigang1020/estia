/**
 * What may be remembered, and who has to have said so.
 *
 * A preference with no approver is indistinguishable from a preference the
 * software gave itself, and six months later nobody can tell which of the two
 * the business is running on. So the approval is not optional, not defaulted,
 * and not something a caller can supply as an empty string.
 */

import { describe, expect, it } from 'vitest'

import {
  UnapprovedPreferenceError,
  activePreferences,
  preferenceFor,
  rememberPreference,
  revokePreference,
  type OperationalPreference,
  type PreferenceDraft,
} from './memory'

const NOW = new Date('2026-09-01T09:00:00.000Z')

const APPROVAL = {
  approvedBy: 'user-dana',
  approvedAt: '2026-09-01T09:00:00Z',
}

function draft(overrides: Partial<PreferenceDraft> = {}): PreferenceDraft {
  return {
    organizationId: 'org-a',
    propertyId: 'property-a',
    kind: 'preferred_laundry_provider',
    subject: 'laundry_provider',
    value: 'provider-b',
    label: 'מכבסת הגליל',
    parameters: { providerId: 'provider-b' },
    sourcePatternCode: 'laundry_provider.provider_b',
    actionKind: null,
    ...overrides,
  }
}

function remembered(
  overrides: Partial<PreferenceDraft> = {},
): OperationalPreference {
  const outcome = rememberPreference(draft(overrides), APPROVAL, NOW)
  if (!outcome.remembered) throw new Error('expected it to be remembered')
  return outcome.preference
}

describe('approval', () => {
  it('records who approved it and when', () => {
    const preference = remembered()

    expect(preference.approvedBy).toBe('user-dana')
    expect(preference.approvedAt).toBe(NOW.toISOString())
    expect(preference.revokedAt).toBeNull()
  })

  it('refuses a blank approver', () => {
    expect(() =>
      rememberPreference(draft(), { ...APPROVAL, approvedBy: '  ' }, NOW),
    ).toThrow(UnapprovedPreferenceError)
  })

  it('refuses an approval time that is not a time', () => {
    expect(() =>
      rememberPreference(draft(), { ...APPROVAL, approvedAt: 'recently' }, NOW),
    ).toThrow(UnapprovedPreferenceError)
  })

  it('names somebody on withdrawal too', () => {
    const revoked = revokePreference(remembered(), {
      approvedBy: 'user-yossi',
      approvedAt: '2026-10-01T09:00:00Z',
    })

    expect(revoked.revokedBy).toBe('user-yossi')
    expect(activePreferences([revoked])).toHaveLength(0)
  })

  it('refuses a withdrawal with no name', () => {
    expect(() =>
      revokePreference(remembered(), {
        approvedBy: '',
        approvedAt: '2026-10-01',
      }),
    ).toThrow(UnapprovedPreferenceError)
  })
})

describe('the same boundary as a proposal', () => {
  it('refuses a preference about who somebody is', () => {
    const outcome = rememberPreference(
      draft({ label: 'מנקה לפי דת האורח', kind: 'preferred_cleaner' }),
      APPROVAL,
      NOW,
    )

    expect(outcome.remembered).toBe(false)
    if (outcome.remembered) throw new Error('unreachable')
    expect(outcome.refusal.boundary).toBe('personal_characteristic')
  })

  it('refuses a preference that would cause a money action', () => {
    const outcome = rememberPreference(
      draft({ kind: 'approved_exception', actionKind: 'payment.refund' }),
      APPROVAL,
      NOW,
    )

    expect(outcome.remembered).toBe(false)
    if (outcome.remembered) throw new Error('unreachable')
    expect(outcome.refusal.boundary).toBe('destructive')
  })

  it('refuses an approval and does not throw, because it is a data outcome', () => {
    // A missing approver is a programming error and stops the request. A
    // boundary refusal is something a screen shows.
    expect(() =>
      rememberPreference(draft({ label: 'לפי לאום' }), APPROVAL, NOW),
    ).not.toThrow()
  })
})

describe('looking a preference up', () => {
  it('lets a property entry beat an organization entry', () => {
    const org = remembered({ propertyId: null, value: 'provider-a' })
    const property = remembered({ propertyId: 'property-a' })

    const found = preferenceFor([org, property], 'preferred_laundry_provider', {
      organizationId: 'org-a',
      propertyId: 'property-a',
    })

    expect(found?.value).toBe('provider-b')
  })

  it('falls back to the organization for a property with no entry', () => {
    const org = remembered({ propertyId: null, value: 'provider-a' })

    const found = preferenceFor([org], 'preferred_laundry_provider', {
      organizationId: 'org-a',
      propertyId: 'property-z',
    })

    expect(found?.value).toBe('provider-a')
  })

  it('ignores a revoked entry', () => {
    const revoked = revokePreference(remembered(), {
      approvedBy: 'user-yossi',
      approvedAt: '2026-10-01T09:00:00Z',
    })

    expect(
      preferenceFor([revoked], 'preferred_laundry_provider', {
        organizationId: 'org-a',
        propertyId: 'property-a',
      }),
    ).toBeNull()
  })

  it('never crosses an organization boundary', () => {
    expect(
      preferenceFor([remembered()], 'preferred_laundry_provider', {
        organizationId: 'org-b',
        propertyId: 'property-a',
      }),
    ).toBeNull()
  })
})
