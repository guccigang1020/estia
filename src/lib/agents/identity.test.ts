/**
 * Adding an agent, and changing their number.
 *
 * The middle branch is the one that matters. Creating a fresh user because
 * "this is an agent, not an employee" produces two identities for one person,
 * and the repair months later is a user merge carrying bookings, permissions,
 * commissions and audit history.
 */

import { describe, expect, it } from 'vitest'
import {
  acceptInvitation,
  applyPhoneChange,
  buildInvitation,
  describeInvitationPlan,
  isInvitationOpen,
  markPhoneChangeVerified,
  planAgentInvitation,
  requestPhoneChange,
  type AgentDirectory,
  type ExistingMembership,
  type ExistingUser,
} from './identity'
import { AGENT_PRESETS } from './access'
import type { AgentInvitation, AgentProfile } from './types'
import { BusinessRuleError, ValidationError } from '../errors'

const NOW = new Date('2026-09-01T10:00:00.000Z')
const ORG = 'org-a'

interface DirectoryState {
  user?: ExistingUser | null
  membership?: ExistingMembership | null
  invitation?: AgentInvitation | null
}

/** Records what it was asked, so the tests can assert on the questions too. */
function makeDirectory(state: DirectoryState = {}) {
  const asked: string[] = []
  const directory: AgentDirectory = {
    async findUserByPhone(phone) {
      asked.push(`findUserByPhone:${phone}`)
      return state.user ?? null
    },
    async findMembership(organizationId, userId) {
      asked.push(`findMembership:${organizationId}:${userId}`)
      return state.membership ?? null
    },
    async findPendingInvitation(organizationId, phone) {
      asked.push(`findPendingInvitation:${organizationId}:${phone}`)
      return state.invitation ?? null
    },
  }
  return { directory, asked }
}

// ── The three branches ────────────────────────────────────────────────────

describe('the number is unknown', () => {
  it('creates a pending invitation', async () => {
    const { directory } = makeDirectory()
    const plan = await planAgentInvitation(directory, {
      organizationId: ORG,
      phone: '050-1234567',
    })
    expect(plan.branch).toBe('invite_new_user')
    expect(plan.phoneE164).toBe('+972501234567')
  })

  it('defaults to SMS, because the identity is a phone', async () => {
    const { directory } = makeDirectory()
    const plan = await planAgentInvitation(directory, {
      organizationId: ORG,
      phone: '050-1234567',
    })
    if (plan.branch !== 'invite_new_user') throw new Error('wrong branch')
    expect(plan.channel).toBe('sms')
  })

  it('does not send a second invitation to the same number', async () => {
    const { directory } = makeDirectory({
      invitation: invitation({ id: 'invite-existing' }),
    })
    const plan = await planAgentInvitation(directory, {
      organizationId: ORG,
      phone: '+972-50-123-4567',
    })
    expect(plan.branch).toBe('invitation_already_pending')
  })
})

describe('the number belongs to an existing ESTIA user', () => {
  const known: ExistingUser = { userId: 'user-7', displayName: 'דוד לוי' }

  it('creates a membership and never a second user', async () => {
    // The test the whole identity model exists for.
    const { directory } = makeDirectory({ user: known })
    const plan = await planAgentInvitation(directory, {
      organizationId: ORG,
      phone: '0501234567',
    })

    expect(plan.branch).toBe('attach_existing_user')
    if (plan.branch !== 'attach_existing_user') throw new Error('wrong branch')
    expect(plan.userId).toBe('user-7')
    // Emphatically not `invite_new_user`, which is what would create one.
    expect(plan.branch).not.toBe('invite_new_user')
  })

  it('recognises the person however the number was typed', async () => {
    // Four formats, one person, one membership. Without normalisation on write
    // these are four agents with four ledgers.
    const typed = [
      '050-1234567',
      '0501234567',
      '+972-50-1234567',
      '972501234567',
    ]
    for (const phone of typed) {
      const { directory } = makeDirectory({ user: known })
      const plan = await planAgentInvitation(directory, {
        organizationId: ORG,
        phone,
      })
      expect(plan.branch, phone).toBe('attach_existing_user')
      expect(plan.phoneE164, phone).toBe('+972501234567')
    }
  })

  it('looks the person up globally, not inside the organization', async () => {
    // Asking the narrow question is precisely how the duplicate gets created:
    // somebody who sells for a competitor is not in this organization yet.
    const { directory, asked } = makeDirectory({ user: known })
    await planAgentInvitation(directory, {
      organizationId: ORG,
      phone: '0501234567',
    })
    expect(asked[0]).toBe('findUserByPhone:+972501234567')
  })

  it('says so, so the owner knows who they just added', async () => {
    const { directory } = makeDirectory({ user: known })
    const plan = await planAgentInvitation(directory, {
      organizationId: ORG,
      phone: '0501234567',
    })
    const sentence = describeInvitationPlan(plan)
    expect(sentence).toContain('דוד לוי')
    expect(sentence).toContain('לא נוצר משתמש חדש')
  })

  it('does not consider a stale invitation once the person exists', async () => {
    const { directory, asked } = makeDirectory({
      user: known,
      invitation: invitation(),
    })
    const plan = await planAgentInvitation(directory, {
      organizationId: ORG,
      phone: '0501234567',
    })
    expect(plan.branch).toBe('attach_existing_user')
    expect(asked.some((q) => q.startsWith('findPendingInvitation'))).toBe(false)
  })
})

describe('the number is already an agent here', () => {
  const known: ExistingUser = { userId: 'user-7', displayName: 'דוד לוי' }

  it('does not add them again', async () => {
    const { directory } = makeDirectory({
      user: known,
      membership: {
        membershipId: 'membership-1',
        userId: 'user-7',
        status: 'active',
      },
    })
    const plan = await planAgentInvitation(directory, {
      organizationId: ORG,
      phone: '0501234567',
    })
    expect(plan.branch).toBe('already_an_agent')
  })

  it('restores a removed agent rather than building a second membership', async () => {
    // Their commissions and attribution are attached to that membership. A new
    // one would orphan both.
    const { directory } = makeDirectory({
      user: known,
      membership: {
        membershipId: 'membership-1',
        userId: 'user-7',
        status: 'removed',
      },
    })
    const plan = await planAgentInvitation(directory, {
      organizationId: ORG,
      phone: '0501234567',
    })
    expect(plan.branch).toBe('reactivate_membership')
    if (plan.branch !== 'reactivate_membership') throw new Error('wrong branch')
    expect(plan.membershipId).toBe('membership-1')
    expect(plan.previousStatus).toBe('removed')
    expect(describeInvitationPlan(plan)).toContain('נשמרו')
  })

  it('restores a suspended agent the same way', async () => {
    const { directory } = makeDirectory({
      user: known,
      membership: {
        membershipId: 'membership-1',
        userId: 'user-7',
        status: 'suspended',
      },
    })
    const plan = await planAgentInvitation(directory, {
      organizationId: ORG,
      phone: '0501234567',
    })
    expect(plan.branch).toBe('reactivate_membership')
  })
})

describe('the number is not usable', () => {
  it('refuses a landline with the field named', async () => {
    const { directory } = makeDirectory()
    await expect(
      planAgentInvitation(directory, {
        organizationId: ORG,
        phone: '03-1234567',
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('names the field and gives a Hebrew sentence', async () => {
    const { directory } = makeDirectory()
    try {
      await planAgentInvitation(directory, {
        organizationId: ORG,
        phone: '03-1234567',
      })
      expect.unreachable('should have refused')
    } catch (error) {
      const validation = error as ValidationError
      expect(validation.issues[0].field).toBe('phone')
      expect(validation.issues[0].code).toBe('phone_not_mobile')
      expect(validation.issues[0].message).toContain('נייד')
    }
  })

  it('never reaches the directory with an unusable number', async () => {
    const { directory, asked } = makeDirectory()
    await expect(
      planAgentInvitation(directory, {
        organizationId: ORG,
        phone: 'nonsense',
      }),
    ).rejects.toThrow(ValidationError)
    expect(asked).toEqual([])
  })
})

// ── The invitation ────────────────────────────────────────────────────────

function invitation(over: Partial<AgentInvitation> = {}): AgentInvitation {
  return {
    ...buildInvitation({
      id: 'invite-1',
      organizationId: ORG,
      phoneE164: '+972501234567',
      displayName: null,
      email: null,
      invitedByUserId: 'owner-1',
      access: AGENT_PRESETS.sales,
      inventory: { kind: 'all_properties' },
      now: NOW,
    }),
    ...over,
  }
}

describe('the invitation itself', () => {
  it('carries the ladders the agent will start with', () => {
    expect(invitation().access).toEqual(AGENT_PRESETS.sales)
  })

  it('expires, so a live credential does not outlive the phone call', () => {
    const open = invitation()
    expect(isInvitationOpen(open, NOW)).toBe(true)

    const later = new Date(NOW.getTime() + 15 * 24 * 60 * 60_000)
    expect(isInvitationOpen(open, later)).toBe(false)
  })

  it('is accepted once', () => {
    const accepted = acceptInvitation(invitation(), NOW)
    expect(accepted.status).toBe('accepted')
    expect(accepted.acceptedAt).toBe(NOW.toISOString())
    expect(() => acceptInvitation(accepted, NOW)).toThrow(BusinessRuleError)
  })

  it('cannot be accepted after it lapses', () => {
    const later = new Date(NOW.getTime() + 15 * 24 * 60 * 60_000)
    expect(() => acceptInvitation(invitation(), later)).toThrow(
      BusinessRuleError,
    )
  })

  it('cannot be accepted once revoked', () => {
    expect(() =>
      acceptInvitation(invitation({ status: 'revoked' }), NOW),
    ).toThrow(BusinessRuleError)
  })
})

// ── Changing the number ───────────────────────────────────────────────────

const PROFILE: AgentProfile = {
  userId: 'user-7',
  phoneE164: '+972501234567',
  phoneVerifiedAt: '2026-01-01T00:00:00.000Z',
  displayName: 'דוד לוי',
  email: null,
}

describe('changing the identity key', () => {
  function request(
    over: Partial<Parameters<typeof requestPhoneChange>[0]> = {},
  ) {
    return requestPhoneChange({
      id: 'change-1',
      profile: PROFILE,
      newPhone: '052-7654321',
      existingOwnerUserId: null,
      now: NOW,
      ...over,
    })
  }

  it('normalises the new number too', () => {
    expect(request().newPhoneE164).toBe('+972527654321')
  })

  it('starts unverified', () => {
    const change = request()
    expect(change.status).toBe('pending')
    expect(change.verifiedAt).toBeNull()
  })

  it('refuses a number that is not a mobile', () => {
    expect(() => request({ newPhone: '03-1234567' })).toThrow(ValidationError)
  })

  it('refuses a change to the number already held', () => {
    expect(() => request({ newPhone: '050-123-4567' })).toThrow(
      BusinessRuleError,
    )
  })

  it('refuses a number belonging to somebody else', () => {
    // The recycled-number case. An Israeli mobile released and reissued must
    // not absorb the previous holder's identity.
    expect(() => request({ existingOwnerUserId: 'user-99' })).toThrow(
      BusinessRuleError,
    )
  })

  it('allows a change to a number the same person already holds', () => {
    expect(() => request({ existingOwnerUserId: PROFILE.userId })).not.toThrow()
  })

  it('will not move the key without verification', () => {
    // The whole security property. The login code follows the number, so a path
    // that could set it without proof hands over the account.
    expect(() => applyPhoneChange(PROFILE, request(), NOW)).toThrow(
      BusinessRuleError,
    )
  })

  it('moves the key once the new number is proved', () => {
    const verified = markPhoneChangeVerified(request(), NOW)
    const { profile, request: applied } = applyPhoneChange(
      PROFILE,
      verified,
      NOW,
    )

    expect(profile.phoneE164).toBe('+972527654321')
    expect(profile.phoneVerifiedAt).toBe(NOW.toISOString())
    expect(applied.status).toBe('applied')
  })

  it('does not carry the old verification forward to the new number', () => {
    // The old timestamp would claim proof that was never given for this number.
    const verified = markPhoneChangeVerified(request(), NOW)
    const { profile } = applyPhoneChange(PROFILE, verified, NOW)
    expect(profile.phoneVerifiedAt).not.toBe(PROFILE.phoneVerifiedAt)
  })

  it('refuses a verification code that arrived too late', () => {
    const later = new Date(NOW.getTime() + 16 * 60_000)
    expect(() => markPhoneChangeVerified(request(), later)).toThrow(
      BusinessRuleError,
    )
  })

  it('refuses to verify the same request twice', () => {
    const verified = markPhoneChangeVerified(request(), NOW)
    expect(() => markPhoneChangeVerified(verified, NOW)).toThrow(
      BusinessRuleError,
    )
  })

  it('refuses to apply another person’s request', () => {
    const verified = markPhoneChangeVerified(request(), NOW)
    const someoneElse: AgentProfile = { ...PROFILE, userId: 'user-99' }
    expect(() => applyPhoneChange(someoneElse, verified, NOW)).toThrow(
      BusinessRuleError,
    )
  })

  it('never mutates the profile it was given', () => {
    const verified = markPhoneChangeVerified(request(), NOW)
    applyPhoneChange(PROFILE, verified, NOW)
    expect(PROFILE.phoneE164).toBe('+972501234567')
  })
})
