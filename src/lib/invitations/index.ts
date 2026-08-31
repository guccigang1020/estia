/**
 * The invitation domain, in one import.
 *
 * Both halves now. Creation mints the token, hashes it and writes the row;
 * acceptance hashes the token from the link with the *same* function and
 * redeems it. That shared hash is why `hashInvitationToken` is exported rather
 * than kept private — two implementations of it would mean the acceptance path
 * never finds what the creation path wrote.
 *
 * The asymmetry between them is deliberate. Creation is a `defineOperation`
 * like every other write in the codebase. Acceptance cannot be: the person
 * redeeming a token has no membership in that organization, therefore no role,
 * therefore no actor for the pipeline to authorize. Possession of the token is
 * the authorization, and it is checked in one atomic place — see
 * `acceptance.ts` and migration 0027.
 */

export {
  ACCEPTANCE_REFUSAL_CODES,
  InvitationRefusedError,
  acceptInvitation,
  type AcceptedInvitation,
} from './acceptance'

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
