/**
 * The invitation domain, in one import.
 *
 * Creation only. Accepting an invitation — hashing the token from the link,
 * finding the row by `token_hash`, checking the expiry and turning it into a
 * membership — is the other half and is not written yet. When it is, it uses
 * `hashInvitationToken` from here: two implementations of that hash means the
 * acceptance path never finds what the creation path wrote.
 */

export {
  CapturingInvitationDelivery,
  type InvitationDelivery,
  type InvitationHandoff,
} from './delivery'

export {
  INVITATION_MAX_TTL_DAYS,
  INVITATION_TTL_DAYS,
  hashInvitationToken,
  invitationExpiry,
  mintInvitationToken,
  type MintedInvitationToken,
} from './token'

export {
  INVITATION_SCOPE_KINDS,
  InvitationAlreadyLiveError,
  InvitationNotReadableError,
  InvitationScopeShapeError,
  InvitationScopeTooWideError,
  RoleNotAssignableError,
  defineInvitationOperations,
  type CreatedInvitation,
  type InvitationCreationOperation,
  type InvitationDraft,
  type InvitationOperations,
  type InvitationScopeKind,
} from './operations'
