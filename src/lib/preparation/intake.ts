/**
 * What the desk wrote down, as things the engine can count.
 *
 * The booking form collects couples, extra beds and cots. Two of those three
 * are *quantities of physical objects somebody has to fetch and set up*, which
 * is exactly what `BookingExtra` is for — "what the guest asked for by name",
 * merging with the rule-derived requirements rather than replacing them. This
 * module is the one place that translation happens, so a cot requested at the
 * desk cannot mean one thing on the plan screen and another in the laundry
 * order.
 *
 * ── Why this is not a second allocator ────────────────────────────────────
 *
 * `SleepingAllocation` answers "how short is this house", and it is an output
 * of `allocateSleeping`. `SleepingShape` answers "what did they ask for", and
 * it is an input a person typed. They are allowed to disagree — a family can
 * want a cot in a house with a spare bedroom — and merging them here would
 * quietly turn a request into a shortfall or a shortfall into a request.
 *
 * So the extras produced here are additive, exactly as `extraDrafts` in
 * `requirements.ts` treats every extra: a booking that asks for one more bed
 * than the allocation found short ends up with the sum, and the breakdown
 * shows which part came from where.
 *
 * ── Where the labels and the minutes come from ────────────────────────────
 *
 * Configuration, never this file. The extra bed is the property's own
 * `extraSleepingBedTypeId` — the type it says it puts on the floor when
 * storage runs out — and its Hebrew label and setup minutes are read off that
 * bed type. A cot is looked up by `COT_BED_TYPE_ID`, which an organization
 * that owns cots declares as an ordinary bed type.
 *
 * When the catalogue names neither, the extra still appears: the guest asked
 * for it and a cleaner has to see it. It appears with a Hebrew fallback label
 * and **no** setup minutes, because inventing a duration would put a number
 * this engine is forbidden to hold onto the critical path. That understates
 * the estimate, which is the honest direction: a plan that says it does not
 * know how long a cot takes is better than one that guesses.
 */

import type {
  BedType,
  BookingExtra,
  PlanSectionKey,
  RequirementCategory,
  RequirementUnit,
  SleepingShape,
} from './types'

/** Nothing requested, and no configured duration. */
const NONE = 0

/**
 * The catalogue keys a cot and a spare bed are declared under.
 *
 * A convention rather than a rule: an organization that owns cots adds a bed
 * type with this id, gets its own Hebrew label and its own setup minutes, and
 * the cots requested at the desk line up with the cots in the linen cupboard.
 * One that does not still sees the request on the plan.
 *
 * `EXTRA_BED_ITEM_ID` is only the fallback. A property that has named its own
 * `extraSleepingBedTypeId` — the type it puts on the floor when storage runs
 * out — is asked for *that*, so a requested spare bed and an allocated one
 * merge into a single line instead of appearing twice under two names.
 */
export const COT_BED_TYPE_ID = 'cot'
export const EXTRA_BED_ITEM_ID = 'extra_bed'

/** A cot and an extra bed are both sleeping, and both are set up out of store. */
const EXTRA_CATEGORY: RequirementCategory = 'sleeping'
const EXTRA_SECTION: PlanSectionKey = 'extra_sleeping'
const EXTRA_UNIT: RequirementUnit = 'piece'

/** Used only where the catalogue names no bed type for the request. */
const FALLBACK_EXTRA_BED_LABEL = 'מיטה נוספת לפי בקשה'
const FALLBACK_COT_LABEL = 'מיטת תינוק לפי בקשה'

export interface SleepingExtrasInput {
  sleeping: SleepingShape
  /**
   * `PropertyConfiguration.extraSleepingBedTypeId`, or `null` where the
   * property has no preparation policy at all yet. The request still produces
   * a line; it just carries the fallback id and no setup minutes.
   */
  extraBedTypeId: string | null
  bedTypes: readonly BedType[]
}

/**
 * The requested beds and cots, as extras.
 *
 * A request of zero produces no line at all rather than a line of zero:
 * `extraDrafts` already filters those, and a plan listing "0 cots" is a plan
 * that teaches people to skim.
 */
export function sleepingExtras(
  input: SleepingExtrasInput,
): readonly BookingExtra[] {
  const index = new Map(input.bedTypes.map((type) => [type.id, type]))
  const extras: BookingExtra[] = []

  const bedTypeId = input.extraBedTypeId ?? EXTRA_BED_ITEM_ID
  if (input.sleeping.extraBedsRequested > NONE) {
    const type = index.get(bedTypeId)
    extras.push({
      itemId: bedTypeId,
      label: type?.label ?? FALLBACK_EXTRA_BED_LABEL,
      quantity: input.sleeping.extraBedsRequested,
      category: EXTRA_CATEGORY,
      section: EXTRA_SECTION,
      unit: EXTRA_UNIT,
      minutesPerUnit: type?.setupMinutes ?? NONE,
    })
  }

  if (input.sleeping.cotsRequested > NONE) {
    const type = index.get(COT_BED_TYPE_ID)
    extras.push({
      itemId: COT_BED_TYPE_ID,
      label: type?.label ?? FALLBACK_COT_LABEL,
      quantity: input.sleeping.cotsRequested,
      category: EXTRA_CATEGORY,
      section: EXTRA_SECTION,
      unit: EXTRA_UNIT,
      minutesPerUnit: type?.setupMinutes ?? NONE,
    })
  }

  return extras
}

/** Nobody asked for anything. The shape a booking with no sleeping row has. */
export const NO_SLEEPING_REQUEST: SleepingShape = {
  couples: NONE,
  extraBedsRequested: NONE,
  cotsRequested: NONE,
}
