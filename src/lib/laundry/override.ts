/**
 * A person changing a number the engine produced.
 *
 * ── Three values, and none of them may be lost ────────────────────────────
 *
 * `calculated` is what the engine derived from the preparation requirement.
 * `adjustment` is what a person changed it by. `final` is the sum.
 *
 * The obvious implementation stores one number and overwrites it. It is
 * smaller, it is simpler, and it destroys the only evidence there will ever be
 * of what the system thought — which matters because the question asked three
 * weeks later is never "how many did we send". The delivery note answers that.
 * The question is "did we send the wrong number, or did the engine get it
 * wrong", and those two have completely different answers: one is a
 * conversation with a person, the other is a bug in the requirement rules that
 * is quietly wrong for every other booking too.
 *
 * A single overwritten column cannot distinguish them, ever, for any booking,
 * retrospectively. That is why there are three.
 *
 * ── The reason is mandatory, and the database agrees ──────────────────────
 *
 * `adjustment_quantity <> 0` requires `adjustment_reason`, by check constraint
 * in `0029_laundry.sql` and by this function. Two refusals for one rule,
 * because the pattern in this codebase is that a domain rule the database also
 * knows is a rule that survives a background job — and the reason a nullable
 * reason column is worthless is that nobody fills one in.
 *
 * "מרווח לאירוע גדול" is a sentence somebody will still understand in
 * November. A blank is not.
 */

import { BusinessRuleError } from '../errors'
import type { ExplanationStep, OrderLineQuantity } from './types'

/** The starting state: the engine's figure, untouched. */
export function calculatedOnly(calculated: number): OrderLineQuantity {
  return {
    calculated,
    adjustment: 0,
    final: calculated,
    reason: null,
    adjustedByUserId: null,
    adjustedAt: null,
  }
}

export interface AdjustmentInput {
  /** Signed. Negative removes. */
  adjustment: number
  reason: string
  adjustedByUserId: string
  /** ISO instant. */
  at: string
}

/**
 * Apply a human adjustment, keeping the calculated figure intact.
 *
 * Refuses two things, both of which are domain law rather than validation:
 *
 *   · an adjustment with no stated reason
 *   · an adjustment that drives the final quantity below zero
 *
 * The second one is worth a sentence. Removing a line entirely is a deletion —
 * a different act, with a different audit event and a different grant — and an
 * adjustment of -30 against a calculated 25 is somebody typing into the wrong
 * row. Silently clamping it to zero would produce an order line for nothing at
 * all, which is a line a provider still has to read.
 *
 * Note that an adjustment REPLACES the previous adjustment rather than adding
 * to it. Two people each adding five would otherwise produce ten, which is
 * never what the second one meant; they are looking at a screen showing the
 * first person's five and typing what they believe the total should be.
 */
export function applyAdjustment(
  current: OrderLineQuantity,
  input: AdjustmentInput,
): OrderLineQuantity {
  if (input.reason.trim().length === 0) {
    throw new BusinessRuleError({
      code: 'laundry_adjustment_needs_reason',
      message: 'A laundry quantity adjustment requires a stated reason.',
      userMessage:
        'שינוי כמות דורש נימוק קצר. מה שנכתב כאן הוא מה שיוסבר בעוד שלושה שבועות.',
    })
  }

  const final = current.calculated + input.adjustment

  if (final < 0) {
    throw new BusinessRuleError({
      code: 'laundry_adjustment_below_zero',
      message: `An adjustment of ${input.adjustment} against a calculated ${current.calculated} would make the quantity negative.`,
      userMessage: `לא ניתן להוריד ${Math.abs(input.adjustment)} מתוך ${current.calculated}. כדי להסיר את הפריט לגמרי יש למחוק את השורה.`,
    })
  }

  return {
    calculated: current.calculated,
    adjustment: input.adjustment,
    final,
    reason: input.reason.trim(),
    adjustedByUserId: input.adjustedByUserId,
    adjustedAt: input.at,
  }
}

/** Has a person touched this line. */
export function isAdjusted(quantity: OrderLineQuantity): boolean {
  return quantity.adjustment !== 0
}

/**
 * The adjustment as a step in the explanation chain.
 *
 * Appended to the engine's own chain rather than replacing it, so the screen
 * shows the whole story: what the rules said, what the buffers added, and then
 * what a person changed and why. A screen that showed only the final number
 * with a pencil icon beside it would be the black box with an extra click.
 */
export function adjustmentStep(
  quantity: OrderLineQuantity,
): ExplanationStep | null {
  if (!isAdjusted(quantity)) return null

  const direction = quantity.adjustment > 0 ? 'נוספו' : 'הופחתו'
  const size = Math.abs(quantity.adjustment)

  return {
    kind: 'adjustment',
    text: `${quantity.final} אחרי התאמה ידנית — ${direction} ${size}. הנימוק: ${quantity.reason ?? ''}`,
    value: quantity.final,
  }
}

/**
 * The full chain for one line, engine steps then the human one.
 *
 * One function so no screen assembles it differently from another. The order
 * detail, the printable order and the dashboard all show the same story.
 */
export function explainQuantity(
  engineSteps: readonly ExplanationStep[],
  quantity: OrderLineQuantity,
): readonly ExplanationStep[] {
  const human = adjustmentStep(quantity)
  return human === null ? engineSteps : [...engineSteps, human]
}
