/**
 * What ESTIA must never learn, enforced rather than asked for.
 *
 * ── Why this is code and not a paragraph in a brief ───────────────────────
 *
 * Every system that learns from behaviour eventually learns something it
 * should not have, and it does so quietly: the rows were there, the count was
 * real, and nobody wrote down that this particular correlation is one the
 * business is not allowed to act on. A comment saying "do not infer sensitive
 * characteristics" is satisfied by a detector nobody read carefully. A
 * function that refuses the pattern is satisfied by a test.
 *
 * There are two mechanisms and both are needed:
 *
 *   1. **Structural.** `PATTERN_SUBJECTS` in `patterns.ts` is a closed list of
 *      operational-preference subjects. There is no member that names a
 *      characteristic of a person, so the *shape* of a pattern cannot express
 *      one — a detector would have to invent a subject, and `screenPattern`
 *      refuses a subject that is not in the list.
 *
 *   2. **Screening.** Free text and parameters are read for the vocabulary of
 *      the four forbidden classes, and the suggested action is read for its
 *      safety level. This catches the case the structure cannot: a
 *      `preparation_quantity` pattern whose wording is "guests from country X
 *      get extra towels".
 *
 * ── The refusal is recorded, not swallowed ────────────────────────────────
 *
 * A dropped pattern returns a `BoundaryRefusal` naming the boundary, the exact
 * text that tripped it, and when. Silently discarding it would make the safest
 * behaviour in the system also the least visible one, and nobody could tell a
 * boundary that is working from a detector that found nothing.
 *
 * ── Which direction to be wrong in ────────────────────────────────────────
 *
 * Text screening for personal characteristics is deliberately broad, and it
 * will occasionally refuse a harmless pattern whose label happens to contain
 * one of these words. That is the correct direction: an over-refusal costs a
 * manager one suggestion they never saw and appears in the refusal list where
 * somebody can query it, and an under-refusal is a business quietly running a
 * rule about people's origins.
 *
 * Destructive and security vocabulary is screened on the PARAMETERS and the
 * action kind only, not on the prose — «תבנית הודעת ביטול» is an ordinary
 * template name, and refusing every pattern that mentions a cancellation would
 * make the message-template detector useless without protecting anything.
 *
 * ── Learning affects operational preference only ──────────────────────────
 *
 * `assertLearningWritable` is the last mechanism: this directory may write to
 * exactly one table. Nothing here can reach `autopilot_policies`,
 * `autopilot_settings`, `autopilot_safety_rules` or any module's
 * configuration, and the guard is called by `repository.ts` on every write so
 * that adding a second table is a change somebody has to make on purpose.
 */

import { ACTION_SAFETY_LEVELS } from '../../contracts/states'
import type { ActionSafetyLevel } from '../../contracts/states'
import { actionSpec } from '../actions'

import { PATTERN_SUBJECTS, type ObservedPattern } from './patterns'

/* ----------------------------------------------------------- boundaries -- */

export const LEARNING_BOUNDARIES = [
  /** Anything about who a guest or a member of staff IS. */
  'personal_characteristic',
  /** Anything that would widen what may be done with money. */
  'financial_permission',
  /** Anything that would step around a control rather than satisfy it. */
  'security_control',
  /** Anything that destroys, cancels or revokes. */
  'destructive',
  /** Anything that would change how much Autopilot is allowed to do. */
  'autonomy_change',
] as const

export type LearningBoundary = (typeof LEARNING_BOUNDARIES)[number]

/** Hebrew, for the screen that lists what was refused and why. */
export const BOUNDARY_LABELS: Readonly<Record<LearningBoundary, string>> = {
  personal_characteristic: 'מאפיין אישי של אורח או עובד',
  financial_permission: 'הרחבת הרשאה כספית',
  security_control: 'עקיפת בקרת אבטחה',
  destructive: 'פעולה הרסנית',
  autonomy_change: 'שינוי רמת האוטונומיה של הטייס האוטומטי',
}

/* ---------------------------------------------------------- vocabularies -- */

/**
 * The words that mean a pattern is about who somebody is.
 *
 * Both languages, because the machine-readable half of a pattern comes from
 * column names in English and the human half is written in Hebrew by a
 * manager. Matched as substrings and case-folded, so `guest_nationality`,
 * `Nationality` and `לאום האורח` all trip it.
 */
const PERSONAL_CHARACTERISTIC_TERMS: readonly string[] = [
  'nationality',
  'citizenship',
  'ethnic',
  'race',
  'religio',
  'gender',
  'sexual_orientation',
  'orientation',
  'disabilit',
  'disabled',
  'health',
  'medical',
  'diagnos',
  'pregnan',
  'marital',
  'family_status',
  'political',
  'union_member',
  'criminal',
  'conviction',
  'birth_date',
  'date_of_birth',
  'age_group',
  'skin_',
  'accent',
  'native_language',
  'לאום',
  'אזרחות',
  'מוצא',
  'עדה',
  'דת ',
  'דתי',
  'דתיים',
  'גזע',
  'מגדר',
  'נטייה מינית',
  'נכות',
  'מוגבלות',
  'בריאות',
  'רפואי',
  'הריון',
  'מצב משפחתי',
  'פוליטי',
  'עבר פלילי',
  'תאריך לידה',
  'קבוצת גיל',
  'מבטא',
  'שפת אם',
]

/**
 * Parameter keys that would move a permission rather than a preference.
 *
 * Deliberately specific. A bare `role` was here first and had to go: the
 * staffing detector's parameters name a job role — a cleaner, a pool
 * attendant — and refusing every pattern that mentions one would have
 * disabled a whole detector while protecting nothing. The terms below name
 * authorization, not work.
 */
const SECURITY_TERMS: readonly string[] = [
  'grant_',
  'grants_',
  'permission',
  'role_code',
  'role_id',
  'membership_role',
  'security_role',
  'rls',
  'bypass',
  'skip_approval',
  'without_approval',
  'auto_approve',
  'approval_required',
  'mfa',
  'two_factor',
  'access_token',
  'api_key',
  'secret',
  'credential',
  'password',
]

/** Parameter keys and values that would change how autonomous Autopilot is. */
const AUTONOMY_TERMS: readonly string[] = [
  'disposition',
  'autopilot_level',
  'autopilotlevel',
  'safety_ceiling',
  'safety_level',
  'run_mode',
  'kill_switch',
  'policy',
  'quiet_hours',
]

/** Parameter keys and values that name a destruction. */
const DESTRUCTIVE_TERMS: readonly string[] = [
  'delete',
  'purge',
  'wipe',
  'drop_',
  'cancel_booking',
  'revoke',
  'refund',
  'chargeback',
  'force_release',
]

/** Parameter keys that would move money or widen what may be spent. */
const FINANCIAL_TERMS: readonly string[] = [
  'grants_permission_amount',
  'credit_limit',
  'spend_limit',
  'discount_authority',
  'waive_deposit',
  'auto_charge',
  'charge_card',
  'payout',
]

/**
 * The most consequential action a learned preference may ever cause.
 *
 * A preference is a default somebody applies. Anything above external
 * communication changes what the business charges, promises, collects or
 * revokes, and those are decisions rather than habits — a person makes them
 * one at a time, and never because a count reached eleven.
 */
export const MAX_LEARNABLE_SAFETY: ActionSafetyLevel = 'external_communication'

function safetyRank(level: ActionSafetyLevel): number {
  return ACTION_SAFETY_LEVELS.indexOf(level)
}

/**
 * Which boundary a too-consequential action trips.
 *
 * Named per kind rather than derived from the safety level, because "this
 * would revoke a door code" and "this would change the price" are different
 * refusals and a manager reading the list deserves to be told which.
 */
const DESTRUCTIVE_ACTION_KINDS: readonly string[] = [
  'booking.cancel',
  'access.revoke_code',
  'payment.refund',
]

/* -------------------------------------------------------------- verdicts -- */

export interface BoundaryRefusal {
  patternCode: string
  propertyId: string | null
  boundary: LearningBoundary
  /**
   * The exact thing that tripped it.
   *
   * `where` names the field — `observation`, `parameters.itemCode`,
   * `suggestion.actionKind` — and `value` is what was there. A refusal nobody
   * can check is a shrug, and a shrug is not a safety control.
   */
  trigger: { where: string; value: string }
  /** Hebrew, one sentence, for the screen. */
  explanation: string
  refusedAt: string
}

export type BoundaryVerdict =
  { permitted: true } | { permitted: false; refusal: BoundaryRefusal }

/* -------------------------------------------------------------- screening -- */

function hit(haystack: string, terms: readonly string[]): string | null {
  const folded = haystack.toLowerCase()
  for (const term of terms) {
    if (folded.includes(term)) return term
  }
  return null
}

/** Every string a pattern carries that a person will read, with its field. */
function readableFields(
  pattern: ObservedPattern,
): readonly { where: string; value: string }[] {
  const fields: { where: string; value: string }[] = [
    { where: 'observation', value: pattern.observation },
    { where: 'suggestion.statement', value: pattern.suggestion.statement },
    {
      where: 'suggestion.expectedImpact',
      value: pattern.suggestion.expectedImpact,
    },
    { where: 'patternCode', value: pattern.patternCode },
  ]

  for (const sample of pattern.sample) {
    fields.push({ where: 'sample.label', value: sample.label })
  }

  for (const [key, value] of Object.entries(pattern.suggestion.parameters)) {
    fields.push({ where: `parameters.${key}`, value: key })
    if (typeof value === 'string') {
      fields.push({ where: `parameters.${key}`, value })
    }
  }

  return fields
}

/** Parameter keys and their string values, which is where a rule hides. */
function parameterFields(
  pattern: ObservedPattern,
): readonly { where: string; value: string }[] {
  return Object.entries(pattern.suggestion.parameters).flatMap(
    ([key, value]) => {
      const entries = [{ where: `parameters.${key}`, value: key }]
      if (typeof value === 'string') {
        entries.push({ where: `parameters.${key}`, value })
      }
      return entries
    },
  )
}

function refuse(
  pattern: ObservedPattern,
  boundary: LearningBoundary,
  trigger: { where: string; value: string },
  explanation: string,
  now: Date,
): BoundaryVerdict {
  return {
    permitted: false,
    refusal: {
      patternCode: pattern.patternCode,
      propertyId: pattern.propertyId,
      boundary,
      trigger,
      explanation,
      refusedAt: now.toISOString(),
    },
  }
}

/**
 * Decide whether one pattern may become a proposal.
 *
 * Checks in order of how badly the business would be harmed by missing one,
 * so the refusal a person sees names the worst thing about the pattern rather
 * than the first alphabetically.
 */
export function screenPattern(
  pattern: ObservedPattern,
  now: Date,
): BoundaryVerdict {
  const subjects: readonly string[] = PATTERN_SUBJECTS
  if (!subjects.includes(pattern.subject)) {
    // The structural mechanism. A subject outside the closed list means a
    // detector invented one, and an invented subject is exactly how a pattern
    // about people would arrive wearing an operational name.
    return refuse(
      pattern,
      'personal_characteristic',
      { where: 'subject', value: String(pattern.subject) },
      'הדפוס עוסק בנושא שאינו מופיע ברשימת נושאי ההעדפה התפעולית, ולכן לא ' +
        'יוצע.',
      now,
    )
  }

  for (const field of readableFields(pattern)) {
    const term = hit(field.value, PERSONAL_CHARACTERISTIC_TERMS)
    if (term !== null) {
      return refuse(
        pattern,
        'personal_characteristic',
        field,
        'הדפוס נשען על מאפיין אישי של אורח או עובד. ESTIA אינה לומדת ' +
          'מאפיינים אישיים, ולכן ההצעה נדחתה לפני שהוצגה.',
        now,
      )
    }
  }

  const parameters = parameterFields(pattern)

  for (const field of parameters) {
    const security = hit(field.value, SECURITY_TERMS)
    if (security !== null) {
      return refuse(
        pattern,
        'security_control',
        field,
        'ההצעה הייתה משנה הרשאה או עוקפת בקרת אבטחה. שינוי כזה נעשה ידנית ' +
          'בלבד, ולא מתוך דפוס שנצפה.',
        now,
      )
    }

    const autonomy = hit(field.value, AUTONOMY_TERMS)
    if (autonomy !== null) {
      return refuse(
        pattern,
        'autonomy_change',
        field,
        'ההצעה הייתה משנה את מידת העצמאות של הטייס האוטומטי. הלמידה נוגעת ' +
          'להעדפה תפעולית בלבד.',
        now,
      )
    }

    const destructive = hit(field.value, DESTRUCTIVE_TERMS)
    if (destructive !== null) {
      return refuse(
        pattern,
        'destructive',
        field,
        'ההצעה הייתה גורמת לפעולה הרסנית — ביטול, מחיקה או שלילת גישה. ' +
          'פעולות כאלה אינן נלמדות.',
        now,
      )
    }

    const financial = hit(field.value, FINANCIAL_TERMS)
    if (financial !== null) {
      return refuse(
        pattern,
        'financial_permission',
        field,
        'ההצעה הייתה מרחיבה הרשאה כספית. הרחבה כזו היא החלטה של אדם, ולא ' +
          'תוצאה של ספירה.',
        now,
      )
    }
  }

  const kind = pattern.suggestion.actionKind
  if (kind !== null) {
    const spec = actionSpec(kind)
    if (spec === null) {
      // An action kind outside the catalogue cannot be screened for safety, so
      // it is refused rather than assumed harmless. A proposal whose
      // consequence nobody can look up is one nobody can approve.
      return refuse(
        pattern,
        'security_control',
        { where: 'suggestion.actionKind', value: kind },
        'ההצעה מפנה לפעולה שאינה מופיעה בקטלוג הפעולות, ולכן לא ניתן לבדוק ' +
          'את רמת הסיכון שלה.',
        now,
      )
    }

    if (safetyRank(spec.safety) > safetyRank(MAX_LEARNABLE_SAFETY)) {
      const boundary: LearningBoundary = DESTRUCTIVE_ACTION_KINDS.includes(kind)
        ? 'destructive'
        : 'financial_permission'

      return refuse(
        pattern,
        boundary,
        { where: 'suggestion.actionKind', value: kind },
        `ההצעה הייתה מובילה לפעולה «${spec.label}», שרמת הסיכון שלה גבוהה ` +
          'מכל מה שמותר ללמוד. פעולות כאלה נשארות בהחלטה אנושית.',
        now,
      )
    }
  }

  return { permitted: true }
}

export interface ScreeningResult {
  permitted: readonly ObservedPattern[]
  refusals: readonly BoundaryRefusal[]
}

/** Screen a batch. Both halves are returned; neither is thrown away. */
export function screenPatterns(
  patterns: readonly ObservedPattern[],
  now: Date,
): ScreeningResult {
  const permitted: ObservedPattern[] = []
  const refusals: BoundaryRefusal[] = []

  for (const pattern of patterns) {
    const verdict = screenPattern(pattern, now)
    if (verdict.permitted) permitted.push(pattern)
    else refusals.push(verdict.refusal)
  }

  return { permitted, refusals }
}

/* --------------------------------------------------------- write barrier -- */

/**
 * The only table this directory may write.
 *
 * Learning proposes and never adopts, so the write surface is one table of
 * proposals. Naming the forbidden tables explicitly in the message rather than
 * only the allowed one, because the failure this guards against is somebody
 * adding a convenient `autopilot_policies` upsert here and the review not
 * noticing that it makes the whole separation decorative.
 */
export const LEARNING_WRITABLE_TABLES: readonly string[] = [
  'autopilot_rule_candidates',
]

export class LearningWriteBarrierError extends Error {
  readonly table: string

  constructor(table: string) {
    super(
      `The learning module may not write to '${table}'. It may write only ` +
        `to ${LEARNING_WRITABLE_TABLES.join(', ')}. Learning proposes; a ` +
        `person with autopilot.rules_manage adopts, and what they adopt is ` +
        `an ordinary row in whichever module owns that rule.`,
    )
    this.name = 'LearningWriteBarrierError'
    this.table = table
  }
}

/** Called by every write in `repository.ts`, before the client is touched. */
export function assertLearningWritable(table: string): void {
  if (!LEARNING_WRITABLE_TABLES.includes(table)) {
    throw new LearningWriteBarrierError(table)
  }
}
