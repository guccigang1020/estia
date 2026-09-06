/**
 * What a screen hands a card. One declaration, read from both sides.
 *
 * ── Why these are not the domain types ───────────────────────────────────
 *
 * `Signal`, `Decision` and `PlannedAction` in `src/lib/autopilot/types.ts` are
 * what the engine passes between its own stages. What the screens read is a
 * ROW — an `autopilot_exceptions` or `autopilot_actions` record that has been
 * through the database, carries an id, a state, a `seen_count` and an owner,
 * and may name an action kind the catalogue has since dropped. Rendering the
 * stage types would mean either inventing the missing fields or pretending a
 * stored row is a freshly computed one, and the second is the mistake that
 * makes "why did ESTIA do this" unanswerable: the row's stored `reason` is the
 * one the person was owed, not a sentence recomposed today from a booking that
 * has since been cancelled.
 *
 * So these are the read models. `Evidence` is shared verbatim, because a fact
 * with its source is the same shape wherever it appears.
 *
 * ── Nullable is a claim, and `undefined` is a different claim ────────────
 *
 * A `null` here means the database holds nothing. A field that is *absent* on
 * the object means this reader may not see it — the `redact()` convention the
 * action centre uses, where a withheld guest name is not replaced with
 * "אורח". The two are printed differently and must not collapse into one.
 *
 * No `'use client'`: types only, so either side of the boundary may import it.
 */

import type { Evidence } from '@/lib/autopilot/types'
import type {
  ActionSafetyLevel,
  AutopilotActionOutcome,
  AutopilotConfidence,
  AutopilotDisposition,
  AutopilotDomain,
  AutopilotExceptionState,
  AutopilotRiskState,
  AutopilotRunMode,
  AutopilotSuppressionReason,
} from '@/lib/contracts/states'

/* ---------------------------------------------------------- exceptions -- */

export type ExceptionView = {
  id: string
  code: string
  domain: AutopilotDomain
  risk: AutopilotRiskState
  state: AutopilotExceptionState
  title: string
  detail: string
  /** What it is about — `booking`, `unit`, `laundry_order`. */
  resourceType: string
  resourceId: string | null
  propertyId: string | null
  /** Null when the property row was not readable. The id is never shown instead. */
  propertyName: string | null
  evidence: readonly Evidence[]
  /** The root this is downstream of, by id. Null when this IS the root. */
  causedBy: string | null
  dueAt: string | null
  warnAt: string | null
  criticalAt: string | null
  ownerUserId: string | null
  /** Null when nobody owns it, or when the name was not readable. */
  ownerName: string | null
  firstSeenAt: string
  lastSeenAt: string
  /**
   * How many detection passes have seen this one ongoing problem.
   *
   * Rendered rather than hidden: a shortage seen 72 times over six hours is
   * one exception, and the count is the evidence that deduplication worked.
   */
  seenCount: number
}

/**
 * One incident: a root and everything it caused.
 *
 * A laundry delay causes a shortage causes a preparation risk causes an
 * arrival risk. That is four rows and ONE thing to fix, and a screen that
 * printed four alarms at 06:00 would have the manager chasing the arrival risk
 * — the last link — while the laundry van is still the answer.
 */
export type IncidentView = {
  root: ExceptionView
  consequences: readonly ExceptionView[]
}

/* ------------------------------------------------------------- actions -- */

export type ActionView = {
  id: string
  /** As stored. May name a kind the catalogue has since dropped. */
  kind: string
  /** The catalogue's Hebrew label, or the raw kind when it is not in it. */
  kindLabel: string
  /** Null when the kind is not in the catalogue — a stale row, not a crash. */
  inCatalogue: boolean
  safetyLevel: ActionSafetyLevel
  disposition: AutopilotDisposition
  runMode: AutopilotRunMode
  outcome: AutopilotActionOutcome
  confidence: AutopilotConfidence
  /** Prose, composed when the decision was made. Never re-derived. */
  reason: string
  triggerEvent: string | null
  evidence: readonly Evidence[]
  /** The domain command this called. Null for an action that ends inside Autopilot. */
  command: string | null
  /** Recognised member of the vocabulary, or null when the stored text is not one. */
  suppressedReason: AutopilotSuppressionReason | null
  /** The stored text, always, so an unrecognised reason is still readable. */
  suppressedText: string | null
  errorCode: string | null
  errorDetail: string | null
  attempt: number
  approvedAt: string | null
  approvedByName: string | null
  requestedByName: string | null
  scheduledFor: string | null
  executedAt: string | null
  undoneAt: string | null
  createdAt: string
  propertyId: string | null
  propertyName: string | null
  exceptionId: string | null
}
