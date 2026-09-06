/**
 * How each outcome reads on the completion report.
 *
 * ── Six outcomes, and only one of them is a problem ───────────────────────
 *
 * `RECORD_OUTCOMES` is the domain's vocabulary and this file adds nothing to
 * it: no outcome is invented here, none is collapsed into another, and nothing
 * here decides what happened. What it decides is how a person should read what
 * happened, and that is a genuinely separate question — the domain says
 * `needs_manual_update`, and the operator needs to be told, in a sentence, that
 * their file is fine and their data is in ESTIA and one record is stale.
 *
 * ── Why the tones are so restrained ───────────────────────────────────────
 *
 * `Badge` offers three, and only `failed` gets the loud one. A report that
 * colours `skipped_unchanged` as a warning turns the second run of the same
 * file — the normal, correct, idempotent case — into eighteen hundred amber
 * rows, and an operator who sees that concludes the import broke.
 *
 * Pure data and two lookups. No React, so it is testable in the node suite the
 * rest of this repository uses.
 */

import type { BadgeTone } from '@/components/ui/badge'
import { RECORD_OUTCOMES, type RecordOutcome } from '@/lib/migration/types'

/**
 * The one outcome that is somebody's problem.
 *
 * Everything else is a normal result of a correct import, including the two
 * kinds of skip.
 */
export function isFailure(outcome: RecordOutcome): boolean {
  return outcome === 'failed'
}

/** True when the row is now in ESTIA because of this run. */
export function isWrite(outcome: RecordOutcome): boolean {
  return outcome === 'created' || outcome === 'updated'
}

export function outcomeTone(outcome: RecordOutcome): BadgeTone {
  if (isFailure(outcome)) return 'accent'
  if (isWrite(outcome)) return 'brand'
  return 'neutral'
}

/**
 * What the outcome means for the operator, in one sentence.
 *
 * Read beside the label rather than instead of it: `RECORD_OUTCOME_LABEL` says
 * "דולג בהחלטת אדם" and this says whose decision and where to find it.
 */
export const OUTCOME_MEANING: Readonly<Record<RecordOutcome, string>> = {
  created: 'השורה נכתבה ל-ESTIA בפעם הראשונה.',
  updated: 'הרשומה כבר הייתה כאן, והשורה עדכנה אותה.',
  skipped_unchanged:
    'השורה יובאה בעבר ולא השתנתה מאז. הרצה חוזרת של אותו קובץ אינה מכפילה כלום — זו התוצאה שמוכיחה זאת.',
  skipped_by_decision:
    'אדם החליט לא לייבא אותה, במסך ההתנגשויות. אפשר לחזור ולשנות את ההחלטה ולהריץ שוב.',
  needs_manual_update:
    'הרשומה קיימת כאן, השתנתה במערכת המקור, ולגוף שלה אין עדיין פעולת עדכון. שום כפילות לא נוצרה — פתחו את הרשומה ועדכנו ידנית.',
  failed: 'השורה לא נכתבה. הסיבה מופיעה לצידה.',
}

/**
 * The order the outcomes are shown in.
 *
 * Failures first, because they are the only rows anybody has to act on, and
 * the successes last for the same reason the dry run puts its refusals above
 * its totals: a list that opens with 1,800 green rows is a list whose four red
 * ones are never scrolled to.
 */
export const OUTCOME_ORDER: readonly RecordOutcome[] = [
  'failed',
  'needs_manual_update',
  'skipped_by_decision',
  'created',
  'updated',
  'skipped_unchanged',
]

/** Fails loudly if an outcome is ever added to the domain and not to the screen. */
export function unorderedOutcomes(): readonly RecordOutcome[] {
  return RECORD_OUTCOMES.filter((outcome) => !OUTCOME_ORDER.includes(outcome))
}
