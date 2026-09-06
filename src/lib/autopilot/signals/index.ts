/**
 * Detection: the expected state, the real state, and the gap between them.
 *
 * The first of Autopilot's four stages. It produces `Signal[]` and `Readiness`
 * and it decides NOTHING else — not what to do, not who is told, not whether
 * the organization has Autopilot switched on at all. Those are `decide`,
 * `policy` and `execute`, in that order, and the separation is what makes any
 * of it testable without a database.
 *
 * ── What a caller assembles ───────────────────────────────────────────────
 *
 *     1. fetch the facts (somewhere else — nothing here does I/O)
 *     2. run the detectors for the modules this organization has
 *     3. sweep the bookings for what should have happened and has not
 *     4. compute readiness, then the arrival risk on top of it
 *     5. `linkCauses` the whole set, so four signals become one incident
 *
 * Step 5 is not optional. Without it a laundry delay, the shortage it caused,
 * the preparation risk that followed and the arrival risk at the end are four
 * unrelated alarms at 06:00 on a Friday, and the manager reads none of them.
 */

export {
  arrivalRiskSignals,
  assessArrivalRisk,
  worst,
  type ArrivalBlocker,
  type ArrivalRiskAssessment,
  type ArrivalRiskInput,
  type ArrivalRiskThresholds,
  type PreparationProgress,
} from './arrival-risk'

export {
  gradeDeadline,
  gradeExpectation,
  gradeInstant,
  gradeRelativeExpectation,
  localTime,
  minutesBetween,
  zonedInstant,
  type Deadline,
  type DeadlineVerdict,
  type Expectation,
  type ExpectationVerdict,
} from './deadlines'

export * from './detectors'

export {
  evidenceFrom,
  fact,
  type BookingFacts,
  type Decided,
  type DetectorContext,
  type PropertyFacts,
} from './facts'

export {
  CAUSE_SOURCES,
  linkCauses,
  signalKey,
  type SignalKeyParts,
} from './keys'

export {
  ALL_MODULES,
  MODULE_LABEL,
  NO_MODULES,
  SIGNAL_MODULES,
  canProjectStock,
  canReserveStock,
  isModuleEnabled,
  laundryHasProvider,
  laundryWords,
  type EnabledModules,
  type SignalModule,
} from './modules'

export {
  NEVER_FORGET_CHECKS,
  NEVER_FORGET_LABEL,
  sweep,
  sweepBooking,
  type NeverForgetCheck,
  type NeverForgetInput,
  type NeverForgetPolicy,
  type NeverForgetSchedule,
} from './never-forget'

export {
  READINESS_REQUIREMENTS,
  REQUIREMENT_LABEL,
  blockingRequirements,
  bookingReadiness,
  outstandingRequirements,
  propertyReadiness,
  type ReadinessInput,
  type ReadinessRequirementKey,
} from './readiness'
