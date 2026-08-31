/**
 * The finance domain, in one import.
 *
 * The contracts, the rules and the operations together, so a caller never has
 * to know whether `PaymentStatus` came from the frozen vocabulary, the state
 * machine or a record type. There is one finance vocabulary.
 *
 * What is deliberately **not** re-exported: `PAYMENT_STATUSES`,
 * `COMMISSION_STATUSES` and their siblings. Those belong to
 * `src/lib/contracts/states.ts` and are imported from there by everybody,
 * including this module. Re-exporting them here would create a second import
 * path for a frozen contract, and a second import path is how two modules end
 * up believing they are consuming different vocabularies.
 */

export {
  CURRENCY,
  allocateByWeight,
  allocateEvenly,
  applyPercent,
  assertSumsExactly,
  isWholeAgorot,
  roundAgorot,
  sumAgorot,
  type Currency,
} from './money'

export {
  COLLECTION_CHANNELS,
  PAYMENT_ATTENTIONS,
  PAYMENT_PURPOSES,
  INSTALMENT_CADENCES,
  REFUND_REASONS,
  REFUND_STATUSES,
  INVOICE_KINDS,
  INVOICE_STATUSES,
  EXPENSE_KINDS,
  EXPENSE_FREQUENCIES,
  EXPENSE_SCOPE_KINDS,
  ALLOCATION_METHODS,
  COMMISSION_BASES,
  settledAgorot,
  type AllocatableBooking,
  type AllocationMethod,
  type AllocationResult,
  type AllocationShare,
  type CollectionChannel,
  type Commission,
  type CommissionBasis,
  type CommissionRule,
  type CommissionStatement,
  type CreditNote,
  type Deposit,
  type ExpenseFrequency,
  type ExpenseKind,
  type ExpenseRule,
  type ExpenseScope,
  type ExpenseScopeKind,
  type InstalmentCadence,
  type Invoice,
  type InvoiceKind,
  type InvoiceStatus,
  type Payment,
  type PaymentAmounts,
  type PaymentAttention,
  type PaymentPurpose,
  type PaymentSchedule,
  type PayoutBatch,
  type Refund,
  type RefundReason,
  type RefundStatus,
  type ScheduledInstalment,
  type VariableFormula,
} from './types'

export {
  InMemoryPaymentProvider,
  PROVIDER_EVENT_TYPES,
  type CaptureRequest,
  type FakeBehaviour,
  type HostedPage,
  type HostedPageRequest,
  type PaymentProvider,
  type ProviderEventType,
  type ProviderOutcome,
  type ProviderResult,
  type ProviderTransaction,
  type ProviderWebhookEvent,
  type RefundRequest,
  type VoidRequest,
  type WebhookVerification,
} from './provider'

export {
  PAYMENT_ANOMALIES,
  PAYMENT_SIDE_EFFECTS,
  PAYMENT_STATUS_LABEL,
  PAYMENT_TRANSITIONS,
  TERMINAL_PAYMENT_STATUSES,
  assertPaymentTransition,
  evaluatePaymentTransition,
  findPaymentTransition,
  legalNextPaymentStatuses,
  paymentEventFor,
  paymentResource,
  type PaymentAnomaly,
  type PaymentCondition,
  type PaymentRefusal,
  type PaymentSideEffect,
  type PaymentTransition,
  type PaymentTransitionCheck,
  type PaymentTransitionContext,
} from './payment-state-machine'

export {
  applyProviderResult,
  applyWebhook,
  bookingBalance,
  createPayment,
  deriveStatusFromAmounts,
  movePaymentTo,
  planInstalments,
  resolveUnknownPayment,
  type BookingBalance,
  type InstalmentPlanRequest,
  type MoveOptions,
  type PaymentChange,
  type PaymentDraft,
  type ProviderCallKind,
  type WebhookApplication,
  type WebhookOutcome,
} from './payments'

export {
  DEFAULT_REFUND_POLICY,
  approveRefund,
  assertRefundable,
  maxRefundableAgorot,
  refundLedgerDifference,
  refundNeedsApproval,
  rejectRefund,
  requestRefund,
  settleRefund,
  type RefundApprovalPolicy,
  type RefundRequestInput,
  type RefundSettlement,
} from './refunds'

export {
  authorizeDeposit,
  availableHold,
  createDeposit,
  depositPosition,
  depositResource,
  forfeitDeposit,
  releaseDeposit,
  type DepositChange,
  type DepositDraft,
  type DepositPosition,
} from './deposits'

export {
  archiveInvoice,
  cancelInvoice,
  composeInvoice,
  creditedAgainst,
  exportDocuments,
  formatDocumentNumber,
  issueCreditNote,
  issueInvoice,
  remainingCreditable,
  type InvoiceComposition,
  type InvoiceExportRow,
  type IssueCreditNoteInput,
  type IssueInvoiceInput,
} from './invoices'

export {
  allocateExpense,
  nightsInPeriod,
  periodicAmount,
  variableAmount,
  type AllocationInput,
  type ExpensePeriod,
} from './expenses'

export {
  applicableRules,
  captureFinanceSnapshot,
  detectRuleDrift,
  resnapshot,
  snapshotFingerprint,
  type CaptureSnapshotInput,
  type FinanceSnapshot,
  type OwnerShareRule,
  type ResnapshotInput,
  type RuleDrift,
  type RuleDriftKind,
  type RuleTarget,
  type SnapshottedExpenseRule,
} from './snapshot'

export {
  bookingPnl,
  commissionBasisAgorot,
  commissionFromRule,
  pnlHeadlines,
  propertyPnl,
  revenueBreakdown,
  type BookingPnl,
  type BookingPnlInput,
  type CostComponent,
  type PnlHeadlines,
  type PnlLine,
  type PropertyPnl,
  type PropertyPnlInput,
  type RevenueBreakdown,
} from './pnl'

export {
  COMMISSION_CONDITIONS,
  COMMISSION_STATUS_LABEL,
  COMMISSION_TRANSITIONS,
  DEFAULT_ELIGIBILITY_POLICY,
  TERMINAL_COMMISSION_STATUSES,
  applyBookingRefundToCommission,
  buildPayoutBatch,
  buildStatement,
  commissionResource,
  createCommission,
  evaluateEligibility,
  findCommissionTransition,
  isEligible,
  moveCommission,
  payPayoutBatch,
  payeeKey,
  type BuildPayoutBatchInput,
  type BuildStatementInput,
  type CommissionChange,
  type CommissionConditionCode,
  type CommissionDraft,
  type CommissionTransition,
  type EligibilityContext,
  type EligibilityPolicy,
  type RefundEffect,
  type UnmetCondition,
} from './commissions'

export {
  DIFFERENCE_KINDS,
  describeReconciliation,
  reconcile,
  type DifferenceKind,
  type ReconciliationDifference,
  type ReconciliationInput,
  type ReconciliationReport,
} from './reconciliation'

export {
  InMemoryFinanceRepository,
  type CommissionListQuery,
  type CommissionListRow,
  type CommissionPayee,
  type ExpenseAllocationRow,
  type ExpenseRuleDraft,
  type ExpenseRuleListQuery,
  type ExpenseRuleListRow,
  type FinanceListQuery,
  type FinanceRepository,
  type InvoiceListQuery,
  type InvoiceListRow,
  type InvoicePaymentLinkRow,
  type PaymentListQuery,
  type PaymentListRow,
} from './repository'

export {
  defineFinanceOperations,
  outstandingAgorot,
  type FinanceOperationOptions,
  type FinanceOperations,
} from './operations'
