/**
 * Autopilot learning, in one import.
 *
 *     patterns   →   boundaries   →   propose   →   a person
 *     what the      what must not     the argument    who accepts
 *     business      be learned,       they can        or does not
 *     keeps doing   dropped and       check
 *     by hand       recorded
 *
 * Nothing in this directory changes what Autopilot does. It produces
 * candidates; a person with `autopilot.rules_manage` adopts them or does not,
 * and what they create is an ordinary row in whichever module owns that rule.
 * The database enforces it — `adopted` requires a named person and a timestamp
 * — and so do `propose.ts`, whose draft type cannot express adoption, and
 * `boundaries.ts`, whose write barrier allows exactly one table.
 *
 * `feedback.ts` and `memory.ts` hang off the same spine: feedback changes how
 * OFTEN a suggestion is raised and never what a rule says, and memory holds
 * only what somebody explicitly approved, with their name on it.
 *
 * `value.ts` is the report at the end — six counts and one estimate, typed so
 * the estimate cannot be shown as a measurement.
 *
 * Its output feeds the Intelligence Centre in `src/lib/insights/**` and
 * duplicates none of it: insights explain figures the metric dictionary
 * already computes, and this explains behaviour nobody computed at all.
 */

export {
  BOUNDARY_LABELS,
  LEARNING_BOUNDARIES,
  LEARNING_WRITABLE_TABLES,
  LearningWriteBarrierError,
  MAX_LEARNABLE_SAFETY,
  assertLearningWritable,
  screenPattern,
  screenPatterns,
  type BoundaryRefusal,
  type BoundaryVerdict,
  type LearningBoundary,
  type ScreeningResult,
} from './boundaries'

export {
  DAMPING_EXEMPT_DOMAINS,
  DAMPING_LADDER,
  FEEDBACK_VERDICTS,
  QUIET_AT_DISMISSALS,
  VERDICT_LABELS,
  VERDICT_WEIGHT,
  countDismissals,
  dampingFor,
  shouldRaise,
  type Damping,
  type DampingTarget,
  type FeedbackRecord,
  type FeedbackVerdict,
} from './feedback'

export {
  PREFERENCE_KIND_LABELS,
  PREFERENCE_KINDS,
  UnapprovedPreferenceError,
  activePreferences,
  preferenceFor,
  rememberPreference,
  revokePreference,
  type Approval,
  type OperationalPreference,
  type PreferenceDraft,
  type PreferenceKind,
  type RememberOutcome,
} from './memory'

export {
  DETECTORS,
  DEVIATION_MARGIN,
  PATTERN_MODULES,
  PATTERN_SUBJECTS,
  SAMPLE_SIZE,
  detectCleanerPreferences,
  detectLaundryProviderChoices,
  detectMessageTemplateChoices,
  detectPatterns,
  detectPaymentExceptions,
  detectPreparationAdjustments,
  detectPropertyDeviations,
  detectQuantityOverrides,
  detectStaffingAdditions,
  emptyHistory,
  formatRate,
  isPatternCode,
  occurrenceRate,
  toCodeSegment,
  type CleanerAssignmentRecord,
  type HistoryWindow,
  type LaundryChoiceRecord,
  type MessageTemplateChoiceRecord,
  type ObservedPattern,
  type OperationalHistory,
  type PatternModule,
  type PatternParameter,
  type PatternSample,
  type PatternSubject,
  type PatternSuggestion,
  type PaymentExceptionRecord,
  type PreparationAdjustmentRecord,
  type QuantityOverrideRecord,
  type StaffingAdditionRecord,
} from './patterns'

export {
  DEFAULT_THRESHOLDS,
  MissingDeciderError,
  SUBJECT_DOMAIN,
  WITHHOLDING_REASONS,
  describePeriod,
  draftFromPattern,
  prepareDecision,
  proposeFromPatterns,
  windowDays,
  type CandidateDecision,
  type DraftState,
  type PreparedDecision,
  type ProposalBody,
  type ProposalInput,
  type ProposalResult,
  type ProposalThresholds,
  type RuleCandidate,
  type RuleCandidateDraft,
  type WithheldPattern,
  type WithholdingReason,
} from './propose'

export {
  InMemoryLearningRepository,
  SupabaseLearningRepository,
  UNRECORDED_STREAMS,
  candidateFromRow,
  type LearningRepository,
} from './repository'

export {
  MINUTES_PER_ACTION,
  REMINDER_KINDS,
  TimeSavedEstimate,
  buildValueReport,
  formatMinutes,
  type AutomationValueReport,
  type EstimateLine,
  type EstimateMethod,
  type ValueInputs,
} from './value'
