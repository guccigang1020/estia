/**
 * Autopilot's execution layer, in one import.
 *
 * A planned action that policy has already ruled on comes in; a recorded
 * outcome goes out. The work itself happens through the same `defineOperation`
 * command a person's click calls — Autopilot writes no business table — and
 * everything is recorded, including everything that did not happen.
 *
 *     dispatchAction   →  the executor. Simulation, suggestion, approval
 *                         request or execution, in that order of refusal.
 *     approveAction    →  a person pressed the button; same path, both actors
 *                         on the audit record.
 *     retryAction      →  the failure queue. Bounded, and never money.
 *     undoAction       →  reversal where reversal is real, and an explicit
 *                         refusal where it is not.
 *     simulateAction   →  what would have happened, with the same reason and
 *                         evidence a live run would have carried.
 *
 * Read `dispatch.ts` before changing any of it. The order of its refusals and
 * the point at which the idempotency claim is taken are both load-bearing, and
 * both are argued there rather than assumed.
 */

export {
  DEFAULT_DISPATCH_RETRY,
  InMemoryAutopilotLedger,
  dispatchAction,
  executePreparedAction,
  failureOf,
  idempotencyLedger,
  type ApprovalStamp,
  type AutopilotLedger,
  type DispatchOutcome,
  type ExecutionDeps,
  type ExecutionReport,
  type RetryPolicy,
} from './dispatch'

export {
  COMMAND_BINDINGS,
  EXPECTED_VERSION_KEY,
  RESOURCE_ID_KEY,
  boundCommands,
  catalogueCommands,
  createCommandRegistry,
  operationHandler,
  unavailableCommands,
  type CommandBinding,
  type CommandHandler,
  type CommandInvocation,
  type CommandRegistry,
  type CommandResolution,
  type CommandResult,
  type DomainCommand,
  type OperationBinding,
} from './registry'

export {
  AutopilotActionInvalidError,
  InMemoryAutopilotActionRepository,
  SupabaseAutopilotActionRepository,
  actionFromRow,
  applyPatch,
  assertActionConsistent,
  evidenceFromJson,
  plannedFromRow,
  rowFromDraft,
  type AutopilotActionDraft,
  type AutopilotActionPatch,
  type AutopilotActionRepository,
  type AutopilotActionRow,
} from './repository'

export {
  approveAction,
  awaitsApproval,
  type ApprovalRefusal,
  type ApprovalResult,
  type ApproveActionInput,
} from './approval'

export {
  AUTO_RETRY_CEILING,
  DEFAULT_RETRY_LIMIT,
  actionLabel,
  decideRetry,
  retryAction,
  retryRefusalLabel,
  runRetryQueue,
  type RetryDecision,
  type RetryRefusal,
  type RetryResult,
} from './retry'

export {
  REVERSALS,
  planUndo,
  undoAction,
  type UndoActor,
  type UndoPlan,
  type UndoRefusal,
  type UndoResult,
} from './undo'

export {
  simulateAction,
  simulationResult,
  type SimulatedAction,
} from './simulate'
