/**
 * The owner portal, in one import.
 *
 * `repository.ts` is **deliberately absent**, and it is the only omission. That
 * file reaches `@/lib/persistence`, which reaches the `postgres` driver, which
 * cannot be bundled for a browser: a Client Component importing this barrel
 * would pull the driver through it and every route in the product would 500 on
 * `Can't resolve 'fs'` — with a stack naming a file nobody touched.
 * `scripts/client-bundle.mjs` exists because that happened three times in one
 * day. A screen that needs the adapter imports `@/lib/owners/repository`
 * directly, from a Server Component, where it is safe.
 *
 * What is not re-exported either: `APPROVAL_STATUSES` and `ApprovalType`. Those
 * belong to `src/lib/contracts/states.ts` and are imported from there by
 * everybody including this module. A second import path for a frozen contract
 * is how two modules come to believe they hold different vocabularies.
 */

export {
  FULL_SHARE_BPS,
  OWNER_PAYOUT_DIRECTIONS,
  OWNER_PAYOUT_DIRECTION_LABEL,
  OWNER_PAYOUT_METHODS,
  OWNER_PAYOUT_METHOD_LABEL,
  OWNER_STATEMENT_STATUSES,
  OWNER_STATEMENT_STATUS_LABEL,
  OWNER_STATUSES,
  OWNER_STATUS_LABEL,
  type OwnerPayout,
  type OwnerPayoutDirection,
  type OwnerPayoutMethod,
  type OwnerStatement,
  type OwnerStatementExpense,
  type OwnerStatementLine,
  type OwnerStatementLineKind,
  type OwnerStatementStatus,
  type OwnerStatus,
  type OwnerSummary,
  type PropertyOwner,
  type PropertyOwnership,
} from './types'

export {
  assertWholeOwnership,
  buildOwnerStatement,
  expenseDetail,
  issueOwnerStatement,
  splitOwnerShare,
  type OwnerStatementInput,
} from './statement'

export {
  assertNoGuestIdentity,
  canReadOwnerStatement,
  isExternalOwner,
  ownerBookingView,
  ownerStatementView,
  ownerStatementViews,
  visibleOwnerships,
  type OwnerBookingView,
  type OwnerOccupancySource,
} from './visibility'

export {
  OWNER_APPROVAL_KINDS,
  OWNER_APPROVAL_KIND_LABEL,
  OWNER_APPROVAL_SUBJECT_TYPE,
  OWNER_APPROVAL_TYPE,
  decideOwnerApproval,
  draftOwnerApproval,
  isAwaitingOwner,
  tallyOwnerApprovals,
  type DecideOwnerApprovalInput,
  type OwnerApproval,
  type OwnerApprovalDecision,
  type OwnerApprovalDraft,
  type OwnerApprovalKind,
  type OwnerApprovalTally,
} from './approvals'

export {
  defineOwnerOperations,
  type OwnerFinanceSource,
  type OwnerOperations,
} from './operations'
