/**
 * The agent network, in one import.
 *
 * An agent is a member of the organization with a narrow role and a narrow
 * reach — not a second identity system. Everything here sits above that: the
 * telephone number that identifies them, the ladders that bound them, the
 * calendar they are allowed to see, and the money they are owed.
 */

export {
  AGENT_AMENDMENTS,
  AGENT_AMENDMENT_LABEL,
  AGENT_BASELINE_GRANTS,
  AGENT_LADDER_CONTROLLED_GRANTS,
  AGENT_PRESETS,
  AGENT_PRESET_LABEL,
  AGENT_PRESET_NAMES,
  AGENT_PRESET_ROLE,
  AGENT_PRESET_ROLE_CODES,
  AGENT_CANCELLATION_KINDS,
  agentRoleAssignment,
  asAgentPresetRole,
  canBook,
  canHold,
  canSeeAvailability,
  grantsForAgentAccess,
  parseAgentAccess,
  type AgentAccess,
  type AgentAccessAvailability,
  type AgentAccessBooking,
  type AgentAccessHolding,
  type AgentAccessNone,
  type AgentAccessPricing,
  type AgentAmendment,
  type AgentCancellationPolicy,
  type AgentPresetName,
  type VisiblePriceLevel,
} from './access'

export {
  ISRAEL_COUNTRY_CODE,
  PHONE_REJECTION_MESSAGE,
  formatIsraeliPhone,
  isSamePhone,
  normalizePhone,
  toE164,
  type PhoneNormalization,
  type PhoneRejection,
} from './phone'

export {
  DEFAULT_INVITATION_DAYS,
  DEFAULT_PHONE_CHANGE_MINUTES,
  acceptInvitation,
  applyPhoneChange,
  buildInvitation,
  describeInvitationPlan,
  isInvitationOpen,
  markPhoneChangeVerified,
  planAgentInvitation,
  requestPhoneChange,
  type AddAgentInput,
  type AgentDirectory,
  type AgentInvitationPlan,
  type ExistingMembership,
  type ExistingUser,
  type PhoneChangeRequest,
  type PhoneChangeStatus,
} from './identity'

export {
  AGENT_BLOCKER_MESSAGE,
  agentAvailabilityCalendar,
  agentCanSell,
  describeAgentRefusal,
  type AgentAvailabilityDay,
  type AgentAvailabilityRequest,
  type AgentBlockerReason,
  type AgentDayState,
  type AgentSellability,
} from './availability-view'

export {
  DEFAULT_AGENT_HOLD_LIMITS,
  HOLD_DURATION_PRESETS,
  REPUTATION_MINIMUM_SAMPLE,
  REPUTATION_TIERS,
  assertAgentExtensionAllowed,
  assertAgentHoldWithinLimits,
  effectiveHoldLimits,
  holdsStartedOn,
  planAgentHold,
  recordExtension,
  reputationScore,
  reputationTierFor,
  type AgentHoldAllowance,
  type AgentHoldLedgerEntry,
  type AgentHoldLimits,
  type AgentHoldPerformance,
  type AgentReputationTier,
  type PlanAgentHoldInput,
  type ReputationTier,
} from './holds'

export {
  DEFAULT_DISCOUNT_APPROVAL_MINUTES,
  NO_DISCOUNT_ALLOWED,
  decideDiscountApproval,
  discountDecision,
  evaluateAgentDiscount,
  expireDiscountApproval,
  isDiscountApprovalOpen,
  withdrawDiscountApproval,
  type AgentDiscountCap,
  type DiscountApproval,
  type DiscountApprovalView,
  type DiscountDecision,
  type EvaluateDiscountInput,
} from './discounts'

export {
  ALL_COMMISSION_STATUSES,
  ANY_SCOPE,
  COMMISSION_BASES,
  COMMISSION_BASE_LABEL,
  COMMISSION_CONDITIONS,
  COMMISSION_CONDITION_LABEL,
  COMMISSION_RULE_KINDS,
  COMMISSION_STATUS_LABEL,
  COMMISSION_TRANSITIONS,
  NO_FACTS,
  advanceCommission,
  applyPayoutBatch,
  assertCommissionTransition,
  buildAgentStatement,
  buildPayoutBatch,
  calculateCommission,
  canTransitionCommission,
  commissionBaseAmount,
  createCommission,
  isCommissionEligible,
  scopeMatches,
  scopeSpecificity,
  selectCommissionRule,
  sweepEligible,
  unmetConditions,
  type AgentStatement,
  type AgentStatementLine,
  type Commission,
  type CommissionBase,
  type CommissionCalculation,
  type CommissionCondition,
  type CommissionContext,
  type CommissionEligibility,
  type CommissionFacts,
  type CommissionRule,
  type CommissionRuleRecord,
  type CommissionScope,
  type CommissionTier,
  type CommissionTierMode,
  type CreateCommissionInput,
  type PayoutBatch,
} from './commission'

export {
  activeAgreementFor,
  agencyReachesOrganization,
  isAgreementActive,
  organizationsForAgency,
  terminateAgreement,
  type Agency,
  type AgencyAgreement,
  type AgencyMembership,
} from './agency'

export {
  PRESERVED_ON_REMOVAL,
  agentAccessBlockedReason,
  agentActorRoleAssignments,
  agentScopeNarrowing,
  canChangeAgentStatus,
  changeAgentStatus,
  reinstateAgent,
  removeAgent,
  suspendAgent,
  type AgentStatusChange,
  type ChangeAgentStatusInput,
} from './lifecycle'

export {
  INVITATION_CHANNELS,
  assertAgentReach,
  inventoryResource,
  inventoryScopeToScope,
  type AgentInventoryScope,
  type AgentInventoryTarget,
  type AgentInvitation,
  type AgentOrganizationSettings,
  type AgentProfile,
  type InvitationChannel,
} from './types'

export type {
  AgentHoldStore,
  AgentRepository,
  AgentSettingsStore,
  ApprovalStore,
  CommissionStore,
} from './repository'

export { defineAgentOperations, type AgentOperations } from './operations'
