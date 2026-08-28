/**
 * Adding an agent, and the three ways it can go.
 *
 * The only field an owner must fill in is the telephone number. Everything else
 * — name, agency, email, an internal note — is optional at this point, because
 * an owner adds an agent *during the phone call with them*, and a form asking
 * for eight fields is a form that gets closed.
 *
 * From that one field, three branches:
 *
 *   | the number…                          | what happens                     |
 *   | ------------------------------------ | -------------------------------- |
 *   | is unknown                           | a pending invitation, by SMS     |
 *   | belongs to an existing ESTIA user    | **a new membership.** Never a    |
 *   |                                      | second user                      |
 *   | is already an agent here             | nothing; they are not added twice|
 *
 * ── The middle branch is the one that matters ─────────────────────────────
 *
 * This is where an identity model is tested, and where a careless one fails
 * quietly. Creating a fresh user because "this is an agent, not an employee"
 * produces two identities for one person — and the repair, months later, is a
 * user merge carrying bookings, permissions, commissions and audit history.
 * `User → Membership → Organization` was chosen for exactly this case: the
 * person already exists, so what is created is the *relationship*.
 *
 * ── Changing the number ───────────────────────────────────────────────────
 *
 * The phone is the identity key and the login code follows it. Swapping it
 * without proving the new number is account takeover in one click, so a change
 * is a two-step request: raise it, verify the new number, then apply it. The
 * profile is not touched in between.
 */

import type { MembershipStatus } from '../authz/can'
import { BusinessRuleError, ValidationError } from '../errors'
import type { AgentAccess } from './access'
import {
  PHONE_REJECTION_MESSAGE,
  formatIsraeliPhone,
  normalizePhone,
} from './phone'
import type {
  AgentInventoryScope,
  AgentInvitation,
  AgentProfile,
  InvitationChannel,
} from './types'

// ── Where the directory answers come from ─────────────────────────────────

export interface ExistingUser {
  userId: string
  displayName: string | null
}

export interface ExistingMembership {
  membershipId: string
  userId: string
  status: MembershipStatus
}

/**
 * The three lookups adding an agent needs.
 *
 * Injected rather than queried, for the same reason `ActorSource` is: the
 * decision below is the interesting part and it should be exercised across
 * every combination of "known number, known member, pending invitation" in a
 * millisecond, with no database anywhere.
 */
export interface AgentDirectory {
  /**
   * The global user holding this number, or `null`.
   *
   * Global on purpose. The question is "does this person exist in ESTIA", not
   * "does this person exist in my organization" — asking the narrow question is
   * precisely how the duplicate user gets created.
   */
  findUserByPhone(phoneE164: string): Promise<ExistingUser | null>

  /** Their membership in *this* organization, whatever its status, or `null`. */
  findMembership(
    organizationId: string,
    userId: string,
  ): Promise<ExistingMembership | null>

  /** An outstanding invitation to this number in this organization. */
  findPendingInvitation(
    organizationId: string,
    phoneE164: string,
  ): Promise<AgentInvitation | null>
}

// ── The plan ──────────────────────────────────────────────────────────────

/**
 * What adding this number should do. A decision, not an action.
 *
 * Returned rather than performed so the operation layer can write it inside its
 * transaction, next to its audit event — and so this whole decision is testable
 * without one.
 */
export type AgentInvitationPlan =
  /** Nobody in ESTIA holds this number. Invite them. */
  | {
      branch: 'invite_new_user'
      phoneE164: string
      displayName: string | null
      channel: InvitationChannel
    }
  /**
   * The number belongs to somebody who already has an ESTIA identity —
   * possibly an employee here, possibly an agent for a competitor. A membership
   * is created for them. **No second user.**
   */
  | {
      branch: 'attach_existing_user'
      phoneE164: string
      userId: string
      displayName: string | null
    }
  /**
   * They were an agent here and were suspended or removed. Their history,
   * commissions and attribution are still theirs; access is restored rather
   * than rebuilt, so nothing is orphaned.
   */
  | {
      branch: 'reactivate_membership'
      phoneE164: string
      userId: string
      membershipId: string
      previousStatus: MembershipStatus
    }
  /** Already active here. Not added again. */
  | {
      branch: 'already_an_agent'
      phoneE164: string
      userId: string
      membershipId: string
    }
  /** An invitation to this number is already outstanding. Not sent twice. */
  | {
      branch: 'invitation_already_pending'
      phoneE164: string
      invitationId: string
    }

export interface AddAgentInput {
  organizationId: string
  /** As typed. Normalised here, on write, and never stored in another shape. */
  phone: string
  displayName?: string | null
  channel?: InvitationChannel
}

/**
 * Decide which branch this number takes.
 *
 * The order of the lookups is the order of the questions: is this an ESTIA
 * person at all, and if so are they already connected to this business. An
 * invitation is only considered when there is no user, because an invitation to
 * somebody who has since signed up is stale by definition.
 */
export async function planAgentInvitation(
  directory: AgentDirectory,
  input: AddAgentInput,
): Promise<AgentInvitationPlan> {
  const phoneE164 = requirePhone(input.phone)

  const existing = await directory.findUserByPhone(phoneE164)

  if (existing === null) {
    const pending = await directory.findPendingInvitation(
      input.organizationId,
      phoneE164,
    )
    if (pending !== null) {
      return {
        branch: 'invitation_already_pending',
        phoneE164,
        invitationId: pending.id,
      }
    }
    return {
      branch: 'invite_new_user',
      phoneE164,
      displayName: input.displayName ?? null,
      channel: input.channel ?? 'sms',
    }
  }

  const membership = await directory.findMembership(
    input.organizationId,
    existing.userId,
  )

  if (membership === null) {
    return {
      branch: 'attach_existing_user',
      phoneE164,
      userId: existing.userId,
      displayName: input.displayName ?? existing.displayName,
    }
  }

  if (membership.status === 'active') {
    return {
      branch: 'already_an_agent',
      phoneE164,
      userId: existing.userId,
      membershipId: membership.membershipId,
    }
  }

  return {
    branch: 'reactivate_membership',
    phoneE164,
    userId: existing.userId,
    membershipId: membership.membershipId,
    previousStatus: membership.status,
  }
}

/** The Hebrew sentence for each branch, for the confirmation and the audit. */
export function describeInvitationPlan(plan: AgentInvitationPlan): string {
  const phone = formatIsraeliPhone(plan.phoneE164)
  switch (plan.branch) {
    case 'invite_new_user':
      return `נשלחה הזמנה ל-${phone}.`
    case 'attach_existing_user':
      return (
        `המספר ${phone} כבר רשום ב-ESTIA` +
        `${plan.displayName ? ` (${plan.displayName})` : ''}. ` +
        'נוצרה עבורו חברות סוכן בעסק הזה — לא נוצר משתמש חדש.'
      )
    case 'reactivate_membership':
      return `${phone} היה סוכן בעסק והוחזר לפעילות. ההזמנות והעמלות שלו נשמרו.`
    case 'already_an_agent':
      return `${phone} כבר סוכן פעיל בעסק הזה ולא נוסף שוב.`
    case 'invitation_already_pending':
      return `כבר קיימת הזמנה פתוחה ל-${phone}.`
  }
}

// ── Building the invitation ───────────────────────────────────────────────

/**
 * How long an invitation stands.
 *
 * The specification does not state a number, so this is a default rather than a
 * product rule. It is short on purpose: an invitation is sent during a phone
 * call, and one that is still live a month later is a live credential nobody
 * remembers issuing.
 */
export const DEFAULT_INVITATION_DAYS = 14

export function buildInvitation(input: {
  id: string
  organizationId: string
  phoneE164: string
  displayName: string | null
  email: string | null
  invitedByUserId: string
  access: AgentAccess
  inventory: AgentInventoryScope
  now: Date
  validForDays?: number
}): AgentInvitation {
  const days = input.validForDays ?? DEFAULT_INVITATION_DAYS
  return {
    id: input.id,
    organizationId: input.organizationId,
    phoneE164: input.phoneE164,
    displayName: input.displayName,
    email: input.email,
    invitedByUserId: input.invitedByUserId,
    access: input.access,
    inventory: input.inventory,
    status: 'pending',
    createdAt: input.now.toISOString(),
    expiresAt: new Date(
      input.now.getTime() + days * 24 * 60 * 60_000,
    ).toISOString(),
    acceptedAt: null,
  }
}

/** Live against the clock, never trusted from the stored status. */
export function isInvitationOpen(
  invitation: AgentInvitation,
  now: Date,
): boolean {
  if (invitation.status !== 'pending') return false
  const expires = Date.parse(invitation.expiresAt)
  if (Number.isNaN(expires)) return false
  return expires > now.getTime()
}

export function acceptInvitation(
  invitation: AgentInvitation,
  now: Date,
): AgentInvitation {
  if (!isInvitationOpen(invitation, now)) {
    throw new BusinessRuleError({
      code: 'agent_invitation.not_open',
      message: `Invitation ${invitation.id} is ${invitation.status}`,
      userMessage: 'ההזמנה אינה פעילה יותר. בקש מבעל העסק לשלוח הזמנה חדשה.',
      publicDetails: { status: invitation.status },
    })
  }
  return { ...invitation, status: 'accepted', acceptedAt: now.toISOString() }
}

// ── Changing the number ───────────────────────────────────────────────────

export type PhoneChangeStatus = 'pending' | 'verified' | 'applied' | 'cancelled'

export interface PhoneChangeRequest {
  id: string
  userId: string
  currentPhoneE164: string
  newPhoneE164: string
  status: PhoneChangeStatus
  requestedAt: string
  expiresAt: string
  verifiedAt: string | null
  appliedAt: string | null
}

export const DEFAULT_PHONE_CHANGE_MINUTES = 15

export interface RequestPhoneChangeInput {
  id: string
  profile: AgentProfile
  /** As typed. Normalised here. */
  newPhone: string
  /**
   * The user already holding the new number, if anybody does.
   *
   * Passed in rather than looked up so this stays pure. It closes the recycled
   * number case §15 leaves open: an Israeli mobile released and reissued to
   * somebody else must not be able to absorb the previous holder's identity.
   */
  existingOwnerUserId: string | null
  now: Date
  validForMinutes?: number
}

export function requestPhoneChange(
  input: RequestPhoneChangeInput,
): PhoneChangeRequest {
  const newPhoneE164 = requirePhone(input.newPhone, 'newPhone')

  if (newPhoneE164 === input.profile.phoneE164) {
    throw new BusinessRuleError({
      code: 'phone.unchanged',
      message: 'The new number is the same as the current one',
      userMessage: 'המספר החדש זהה למספר הנוכחי.',
    })
  }

  if (
    input.existingOwnerUserId !== null &&
    input.existingOwnerUserId !== input.profile.userId
  ) {
    throw new BusinessRuleError({
      code: 'phone.belongs_to_another_user',
      message: `Phone ${newPhoneE164} already belongs to another user`,
      userMessage:
        'המספר הזה כבר משויך למשתמש אחר ב-ESTIA. פנה לתמיכה כדי להסדיר את השיוך.',
    })
  }

  const minutes = input.validForMinutes ?? DEFAULT_PHONE_CHANGE_MINUTES
  return {
    id: input.id,
    userId: input.profile.userId,
    currentPhoneE164: input.profile.phoneE164,
    newPhoneE164,
    status: 'pending',
    requestedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + minutes * 60_000).toISOString(),
    verifiedAt: null,
    appliedAt: null,
  }
}

/** The one-time code sent to the *new* number came back correct. */
export function markPhoneChangeVerified(
  request: PhoneChangeRequest,
  now: Date,
): PhoneChangeRequest {
  if (request.status !== 'pending') {
    throw new BusinessRuleError({
      code: 'phone_change.not_pending',
      message: `Phone change ${request.id} is ${request.status}`,
      userMessage: 'בקשת שינוי המספר אינה ממתינה לאימות.',
    })
  }
  const expires = Date.parse(request.expiresAt)
  if (Number.isNaN(expires) || expires <= now.getTime()) {
    throw new BusinessRuleError({
      code: 'phone_change.expired',
      message: `Phone change ${request.id} expired at ${request.expiresAt}`,
      userMessage: 'תוקף קוד האימות פג. בקש קוד חדש.',
    })
  }
  return { ...request, status: 'verified', verifiedAt: now.toISOString() }
}

/**
 * Move the identity key.
 *
 * Refuses anything but a verified request, and that refusal is the entire
 * security property: the profile's number is what the login code is sent to, so
 * a path that could set it without proof is a path that hands over the account.
 */
export function applyPhoneChange(
  profile: AgentProfile,
  request: PhoneChangeRequest,
  now: Date,
): { profile: AgentProfile; request: PhoneChangeRequest } {
  if (request.userId !== profile.userId) {
    throw new BusinessRuleError({
      code: 'phone_change.wrong_user',
      message: `Phone change ${request.id} belongs to ${request.userId}`,
      userMessage: 'בקשת שינוי המספר אינה שייכת למשתמש הזה.',
    })
  }
  if (request.status !== 'verified') {
    throw new BusinessRuleError({
      code: 'phone_change.not_verified',
      message: `Phone change ${request.id} is ${request.status}, not verified`,
      userMessage:
        'לא ניתן להחליף מספר בלי לאמת אותו. הזן את הקוד שנשלח למספר החדש.',
      publicDetails: { status: request.status },
    })
  }

  const stamp = now.toISOString()
  return {
    profile: {
      ...profile,
      phoneE164: request.newPhoneE164,
      // The new number was proved, so it is verified as of the change. Carrying
      // the old timestamp forward would claim proof that was never given for
      // this number.
      phoneVerifiedAt: request.verifiedAt ?? stamp,
    },
    request: { ...request, status: 'applied', appliedAt: stamp },
  }
}

// ── Shared ────────────────────────────────────────────────────────────────

/**
 * Normalise, or refuse with the reason next to the field.
 *
 * A `ValidationError` rather than a business rule: this is a badly filled form,
 * it names one field, and the interface puts the sentence under that input.
 */
function requirePhone(raw: string, field = 'phone'): string {
  const result = normalizePhone(raw)
  if (result.ok) return result.e164

  throw new ValidationError([
    {
      field,
      code: `phone_${result.reason}`,
      message: PHONE_REJECTION_MESSAGE[result.reason],
      label: 'טלפון',
    },
  ])
}
