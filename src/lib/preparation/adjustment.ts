/**
 * Changing a computed quantity by hand, without losing the computation.
 *
 * The engine is right about the arithmetic and wrong about the world often
 * enough that a manual change has to be possible: the fifteenth mattress is
 * genuinely not in the building, the family brought their own cot, the
 * supervisor knows this particular guest wants no extra towels. A product that
 * refuses those is a product people work around in a notebook.
 *
 * ── Three values, and never two ───────────────────────────────────────────
 *
 * `calculated` is what the rules produced. `adjustment` is what a person did
 * to it, with their reason and their name. `final` is the sum. The one shape
 * this module exists to refuse is the tempting one — overwriting
 * `requiredCount` with the person's number — because it answers "how many
 * towels" and destroys "why", and "why" is the only question anybody asks
 * afterwards. `explain.ts` renders the arithmetic; it can only do so while the
 * calculated figure is still there to render.
 *
 * ── Acknowledgement ───────────────────────────────────────────────────────
 *
 * The second thing here is not about quantities at all, and lives beside them
 * because it is the same idea: a change somebody has to *see* before the plan
 * pretends to be current. A booking that grows while a cleaner is halfway
 * through the bedrooms produces a new plan version, and the section they are
 * holding keeps saying so until they say they have seen it.
 *
 * A section nobody has started needs no acknowledgement. There is nothing to
 * un-learn, the person will read the current version when they pick it up, and
 * a banner on every untouched section is a banner nobody reads.
 */

import { BusinessRuleError } from '../errors'
import type {
  PlanItem,
  PlanSection,
  PlanSectionKey,
  QuantityAdjustment,
  WorkPlan,
} from './types'

/** No such thing as negative towels, however hard somebody adjusts. */
const FLOOR = 0

/**
 * What the house actually needs: the calculated figure plus the human change.
 *
 * Floored at zero rather than allowed negative. An adjustment that would take
 * a requirement below nothing is a typing mistake, and the safe reading of it
 * is "none of these", not "minus three of these".
 */
export function finalCount(item: PlanItem): number {
  const delta = item.adjustment?.delta ?? FLOOR
  const total = item.requiredCount + delta
  return total < FLOOR ? FLOOR : total
}

/** The calculated figure, named so a caller never reaches for the raw field. */
export function calculatedCount(item: PlanItem): number {
  return item.requiredCount
}

/** How much a person moved it by. Zero when nobody has. */
export function adjustmentDelta(item: PlanItem): number {
  return item.adjustment?.delta ?? FLOOR
}

/** Is this item still short of what it needs, counting the adjustment? */
export function itemOutstanding(item: PlanItem): number {
  const missing = finalCount(item) - item.completedCount
  return missing < FLOOR ? FLOOR : missing
}

export interface AdjustInput {
  section: PlanSectionKey
  itemId: string
  /** The number the person wants the house to end up with. */
  finalCount: number
  reason: string
  byUserId: string
  at: string
}

/**
 * Apply one manual change, and refuse the two ways it can be meaningless.
 *
 * The caller states the **final** figure rather than the delta, because that
 * is what a person standing in a linen cupboard knows: they have counted, and
 * there are this many. The delta is derived here, against the calculated
 * number, which is the only place the two can be guaranteed consistent.
 */
export function adjustItem(plan: WorkPlan, input: AdjustInput): WorkPlan {
  const section = plan.sections.find((entry) => entry.key === input.section)
  const item = section?.items.find((entry) => entry.itemId === input.itemId)

  if (!section || !item) {
    throw new BusinessRuleError({
      code: 'preparation_item_missing',
      message: `Plan ${plan.id} has no item ${input.itemId} in section ${input.section}`,
      userMessage: 'הפריט הזה כבר לא נמצא בתוכנית. רענן את המסך ונסה שוב.',
    })
  }

  if (input.reason.trim().length === FLOOR) {
    throw new BusinessRuleError({
      code: 'preparation_adjustment_needs_reason',
      message: 'A quantity adjustment was submitted with an empty reason',
      userMessage: 'צריך לכתוב למה הכמות משתנה. הסיבה נשמרת יחד עם השינוי.',
    })
  }

  if (input.finalCount < FLOOR) {
    throw new BusinessRuleError({
      code: 'preparation_adjustment_negative',
      message: `A quantity adjustment asked for ${input.finalCount}`,
      userMessage: 'כמות לא יכולה להיות שלילית.',
    })
  }

  const delta = input.finalCount - item.requiredCount

  // Setting the quantity back to what the engine said is not an adjustment
  // with a delta of zero — it is the removal of the adjustment, and the item
  // goes back to reading as a plain computed figure with no human beside it.
  const adjustment: QuantityAdjustment | null =
    delta === FLOOR
      ? null
      : {
          delta,
          reason: input.reason.trim(),
          byUserId: input.byUserId,
          at: input.at,
        }

  return {
    ...plan,
    sections: plan.sections.map((entry) =>
      entry.key === section.key
        ? {
            ...entry,
            items: entry.items.map((candidate) =>
              candidate.itemId === item.itemId
                ? { ...candidate, adjustment }
                : candidate,
            ),
          }
        : entry,
    ),
  }
}

/** Every manual change on a plan, for the audit sentence and the screen. */
export function adjustedItems(
  plan: WorkPlan,
): readonly { section: PlanSectionKey; item: PlanItem }[] {
  return plan.sections.flatMap((section) =>
    section.items
      .filter((item) => (item.adjustment ?? null) !== null)
      .map((item) => ({ section: section.key, item })),
  )
}

// ── Acknowledgement ───────────────────────────────────────────────────────

/**
 * Does the person holding this section still have to be told it moved?
 *
 * True only where work has actually begun. `new` sections are excluded on
 * purpose — see the header — and so is a section acknowledged at or above the
 * plan's current version.
 */
export function needsAcknowledgement(
  plan: WorkPlan,
  section: PlanSection,
): boolean {
  if (section.status === 'new') return false
  const seen = section.acknowledgedVersion ?? FLOOR
  return seen < plan.version
}

/** The sections that have to be acknowledged before the plan reads as current. */
export function unacknowledgedSections(
  plan: WorkPlan,
): readonly PlanSectionKey[] {
  return plan.sections
    .filter((section) => needsAcknowledgement(plan, section))
    .map((section) => section.key)
}

/** What a worker is shown when the booking moved underneath them. */
export const CHANGE_NOTICE = 'ההזמנה השתנתה — ההכנה עודכנה'

/**
 * Record that somebody has seen this version of this section.
 *
 * Stamped with the plan's own version rather than with a boolean, so a second
 * change after the acknowledgement raises the notice again. A flag would be
 * cleared once and never re-armed, which is exactly the silent case this whole
 * mechanism exists to prevent.
 */
export function acknowledgeSection(
  plan: WorkPlan,
  section: PlanSectionKey,
): WorkPlan {
  const present = plan.sections.some((entry) => entry.key === section)

  if (!present) {
    throw new BusinessRuleError({
      code: 'preparation_section_missing',
      message: `Plan ${plan.id} has no section ${section}`,
      userMessage: 'המקטע הזה כבר לא נמצא בתוכנית. רענן את המסך.',
    })
  }

  return {
    ...plan,
    sections: plan.sections.map((entry) =>
      entry.key === section
        ? { ...entry, acknowledgedVersion: plan.version }
        : entry,
    ),
  }
}
