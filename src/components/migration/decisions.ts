/**
 * What a person is offered when they settle a conflict.
 *
 * ── This file chooses which options to show, never what one means ─────────
 *
 * The meaning of every decision belongs to `src/lib/migration/conflicts.ts`:
 * `skippedRows` is what makes `skip_record` and `keep_existing` block a row,
 * and `undecidedRows` is what keeps an unsettled row out of the import. None of
 * that is reproduced here and none of it may be. What is here is which members
 * of `CONFLICT_DECISIONS` are worth putting in front of somebody for a given
 * kind of collision, and the Hebrew that says what each one will do.
 *
 * ── `undecided` is never offered, and `merge` almost never is ─────────────
 *
 * `undecided` is the state every conflict starts in, not a choice — an option
 * reading "leave it undecided" would let somebody clear a screen of decisions
 * without making any, and the row would then silently not be imported.
 *
 * `merge` is offered only for `guest_merge_candidate`, because it is the only
 * collision where welding two records together is even coherent. Merging a
 * booking into another booking is not a thing this product can do, and offering
 * it would produce a button that fails.
 *
 * ── Nothing is preselected ────────────────────────────────────────────────
 *
 * `defaultDecision` does not exist in this file, deliberately. A conflict with
 * a sensible-looking default is a conflict nobody reads, and the whole reason
 * `Conflict.decision` starts at `undecided` is that three years of bookings
 * contain real double-entries that only the operator can settle.
 *
 * Pure data. No React.
 */

import {
  CONFLICT_DECISIONS,
  type ConflictDecision,
  type ConflictKind,
} from '@/lib/migration/types'

export type DecisionOption = {
  decision: Exclude<ConflictDecision, 'undecided'>
  label: string
  /** What pressing it will actually do, in one line. */
  consequence: string
}

const IMPORT_ANYWAY: DecisionOption = {
  decision: 'import_anyway',
  label: 'ייבא בכל זאת',
  consequence: 'השורה תיכתב, וגם הרשומה הקיימת תישאר. שתיהן יופיעו ביומן.',
}

const KEEP_EXISTING: DecisionOption = {
  decision: 'keep_existing',
  label: 'השאר את מה שקיים ב-ESTIA',
  consequence: 'השורה מהקובץ לא תיכתב. שום דבר קיים לא ישתנה.',
}

const SKIP_RECORD: DecisionOption = {
  decision: 'skip_record',
  label: 'דלג על השורה',
  consequence:
    'השורה לא תיכתב, ותופיע בדוח הסיום כ״דולג בהחלטת אדם״ עם מספר השורה שלה.',
}

const MERGE: DecisionOption = {
  decision: 'merge',
  label: 'זה אותו אדם — אחד אותם',
  consequence:
    'ההיסטוריה מהקובץ תיתלה על כרטיס האורח הקיים במקום ליצור כרטיס שני.',
}

/**
 * The options for one kind of collision.
 *
 * `unit_mismatch` is the odd one: the file names a unit ESTIA does not have, so
 * there is nothing existing to keep. Offering "השאר את הקיים" there would be
 * offering to keep nothing.
 */
export function optionsFor(kind: ConflictKind): readonly DecisionOption[] {
  switch (kind) {
    case 'guest_merge_candidate':
      return [MERGE, IMPORT_ANYWAY, SKIP_RECORD]
    case 'unit_mismatch':
      return [SKIP_RECORD, IMPORT_ANYWAY]
    case 'booking_overlaps_booking':
    case 'booking_overlaps_import':
    case 'booking_overlaps_owner_stay':
    case 'booking_overlaps_maintenance':
      return [IMPORT_ANYWAY, KEEP_EXISTING, SKIP_RECORD]
  }
}

/** Hebrew for a decision already taken, so a settled card still reads. */
export const DECISION_LABEL: Readonly<Record<ConflictDecision, string>> = {
  undecided: 'ממתין להחלטה',
  keep_existing: 'הקיים נשמר',
  import_anyway: 'ייובא בכל זאת',
  skip_record: 'דולג',
  merge: 'אוחד',
}

/** Every decision except the one that is a starting state, for a checker. */
export const OFFERABLE_DECISIONS: readonly ConflictDecision[] =
  CONFLICT_DECISIONS.filter((decision) => decision !== 'undecided')
