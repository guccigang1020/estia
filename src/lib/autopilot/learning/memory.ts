/**
 * What the business has actually agreed to — and nothing else.
 *
 * ── Memory starts empty and only a person fills it ────────────────────────
 *
 * `patterns.ts` notices things. This file holds the ones somebody said yes to:
 * the preferred cleaner for a property, the laundry provider that actually
 * serves it, the setup that is standard here, the exception an operator has
 * approved. Every entry carries who approved it and when, and there is no way
 * to create one without both — `rememberPreference` refuses, loudly, rather
 * than storing an entry whose author is unknown.
 *
 * The reason is the same one the candidates table carries in its own comment:
 * a preference with no approver is indistinguishable from a preference the
 * software gave itself, and six months later nobody can tell which of the two
 * the business is running on.
 *
 * ── Memory is a default, not a decision ───────────────────────────────────
 *
 * Nothing in the Autopilot decision path reads this. The policy engine reads
 * `autopilot_policies`; the modules read their own configuration. What is here
 * is what a screen offers a person as the pre-filled answer, and what a
 * proposal can say has already been agreed. If a preference here ever
 * disagreed with a module's configuration, the module's configuration is what
 * the business is running — this is a memory of a conversation, not a second
 * source of truth.
 *
 * ── The same boundary, not a second copy of it ────────────────────────────
 *
 * A preference is screened by `boundaries.ts`, through the same
 * `screenPattern` the proposals go through. Writing a second screening pass
 * here would mean two lists of forbidden vocabulary drifting apart, and the
 * one that mattered would be whichever one was not updated.
 */

import { screenPattern, type BoundaryRefusal } from './boundaries'
import {
  toCodeSegment,
  type ObservedPattern,
  type PatternParameter,
  type PatternSubject,
} from './patterns'

/* ----------------------------------------------------------------- kinds -- */

export const PREFERENCE_KINDS = [
  /** Who cleans this property, by default. */
  'preferred_cleaner',
  /** Which provider this property's laundry actually goes to. */
  'preferred_laundry_provider',
  /** The setup that is standard here — quantities, checklist, timing. */
  'standard_setup',
  /** A departure from the normal path that an operator has approved. */
  'approved_exception',
] as const

export type PreferenceKind = (typeof PREFERENCE_KINDS)[number]

/** Hebrew, for the settings screen. */
export const PREFERENCE_KIND_LABELS: Readonly<Record<PreferenceKind, string>> =
  {
    preferred_cleaner: 'מנקה מועדף',
    preferred_laundry_provider: 'מכבסה מועדפת',
    standard_setup: 'מערך הכנה קבוע',
    approved_exception: 'חריגה מאושרת',
  }

/* ---------------------------------------------------------------- shapes -- */

export interface PreferenceDraft {
  organizationId: string
  /** `null` means the whole organization. A property entry overrides it. */
  propertyId: string | null
  kind: PreferenceKind
  subject: PatternSubject
  /** The thing preferred — a user id, a provider id, a quantity. */
  value: PatternParameter
  /** Hebrew, for a person reading the list. */
  label: string
  /** Anything the owning module needs. Flat scalars, as everywhere here. */
  parameters: Readonly<Record<string, PatternParameter>>
  /** The candidate this came from, when it came from one. */
  sourcePatternCode: string | null
  /**
   * The Autopilot action applying this preference would eventually cause.
   *
   * Present so the boundary screen can refuse by consequence rather than by
   * reading the label. `null` when it causes none — which is the usual case,
   * because a preference is a pre-filled answer and not an instruction.
   */
  actionKind: string | null
}

/** Who said yes, and when. Both required; neither is defaulted. */
export interface Approval {
  approvedBy: string
  approvedAt: string
}

export interface OperationalPreference extends PreferenceDraft {
  approvedBy: string
  approvedAt: string
  /** Withdrawing a preference is also a decision, and also names somebody. */
  revokedBy: string | null
  revokedAt: string | null
}

export class UnapprovedPreferenceError extends Error {
  constructor(detail: string) {
    super(
      `An operational preference cannot be remembered without an explicit ` +
        `approval: ${detail}. A preference with no approver is one the ` +
        `software gave itself.`,
    )
    this.name = 'UnapprovedPreferenceError'
  }
}

export type RememberOutcome =
  | { remembered: true; preference: OperationalPreference }
  | { remembered: false; refusal: BoundaryRefusal }

/* ------------------------------------------------------------- screening -- */

/**
 * A preference, shaped as a pattern so the one boundary screen can read it.
 *
 * The counts are `1` because a preference is a single agreed fact rather than
 * an observation — nothing downstream of the screen reads them, and inventing
 * a larger number to look more convincing would be a lie in a probe.
 */
function asProbe(draft: PreferenceDraft, at: string): ObservedPattern {
  const day = at.slice(0, 10)

  return {
    patternCode: `preference.${toCodeSegment(draft.kind)}`,
    subject: draft.subject,
    propertyId: draft.propertyId,
    occurrences: 1,
    opportunities: 1,
    observedFrom: day,
    observedTo: day,
    sample: [],
    observation: draft.label,
    suggestion: {
      module: 'preparation',
      statement: draft.label,
      expectedImpact: '',
      parameters: {
        ...draft.parameters,
        preferenceKind: draft.kind,
        preferenceValue: draft.value,
      },
      actionKind: draft.actionKind,
    },
  }
}

/* ------------------------------------------------------------- operations -- */

function validateApproval(approval: Approval): Approval {
  const approvedBy = approval.approvedBy.trim()
  if (approvedBy.length === 0) {
    throw new UnapprovedPreferenceError('approvedBy was blank')
  }

  const approvedAt = approval.approvedAt.trim()
  if (approvedAt.length === 0 || Number.isNaN(Date.parse(approvedAt))) {
    throw new UnapprovedPreferenceError(
      `approvedAt is not a timestamp: '${approval.approvedAt}'`,
    )
  }

  return { approvedBy, approvedAt: new Date(approvedAt).toISOString() }
}

/**
 * Record a preference somebody has approved.
 *
 * Throws when the approval is missing — that is a programming error and
 * should stop the request. Returns a refusal when the boundary screen says no
 * — that is a data outcome, and the refusal is something a screen shows.
 */
export function rememberPreference(
  draft: PreferenceDraft,
  approval: Approval,
  now: Date,
): RememberOutcome {
  const approved = validateApproval(approval)

  const verdict = screenPattern(asProbe(draft, approved.approvedAt), now)
  if (!verdict.permitted) {
    return { remembered: false, refusal: verdict.refusal }
  }

  return {
    remembered: true,
    preference: {
      ...draft,
      parameters: { ...draft.parameters },
      approvedBy: approved.approvedBy,
      approvedAt: approved.approvedAt,
      revokedBy: null,
      revokedAt: null,
    },
  }
}

/** Withdraw one. Also a decision, so it also names somebody. */
export function revokePreference(
  preference: OperationalPreference,
  revocation: Approval,
): OperationalPreference {
  const revoked = validateApproval(revocation)

  return {
    ...preference,
    revokedBy: revoked.approvedBy,
    revokedAt: revoked.approvedAt,
  }
}

/** The ones still in force. A revoked entry is kept, never deleted. */
export function activePreferences(
  preferences: readonly OperationalPreference[],
): readonly OperationalPreference[] {
  return preferences.filter((one) => one.revokedAt === null)
}

/**
 * What this property prefers, falling back to the organization.
 *
 * A property entry beats an organization entry, and a later approval beats an
 * earlier one. Both rules are stated here rather than left to insertion order,
 * because "whichever row came back first" is not an answer anybody can
 * reproduce.
 */
export function preferenceFor(
  preferences: readonly OperationalPreference[],
  kind: PreferenceKind,
  scope: { organizationId: string; propertyId: string | null },
): OperationalPreference | null {
  const candidates = activePreferences(preferences)
    .filter(
      (one) =>
        one.organizationId === scope.organizationId &&
        one.kind === kind &&
        (one.propertyId === null || one.propertyId === scope.propertyId),
    )
    .sort(
      (a, b) =>
        // Property before organization, then newest approval first.
        Number(b.propertyId !== null) - Number(a.propertyId !== null) ||
        b.approvedAt.localeCompare(a.approvedAt),
    )

  return candidates[0] ?? null
}
