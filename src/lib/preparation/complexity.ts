/**
 * How hard is this booking, and therefore how many people and how long.
 *
 * A guest house manager already does this arithmetic in their head every
 * Thursday: twenty-five people, four bedrooms, three bathrooms, a pool and a
 * Shabbat — that is two people for most of a day, not one for an afternoon.
 * The value of writing it down is not that the machine is cleverer; it is that
 * the same booking gets the same answer whoever is on the desk, and that the
 * labour figure in the profit statement is the same figure the roster was
 * built from.
 *
 * Every weight is configuration. A business whose properties are studio flats
 * and one running estates have completely different curves, and the engine has
 * no opinion about which is right.
 */

import type { Agorot } from '../booking/types'
import type {
  ComplexityConfiguration,
  PreparationFacts,
  StaffingEstimate,
} from './types'

/** Unit conversion, not a business number. */
const MINUTES_PER_HOUR = 60

export interface StaffingInput {
  facts: PreparationFacts
  configuration: ComplexityConfiguration
  /** Distinct extras the guest asked for by name. */
  extraItems: number
}

/**
 * The score, the crew and the clock.
 *
 * `estimatedMinutes` is wall-clock duration for the recommended crew;
 * `staffMinutes` is what the business pays for. Keeping both is what stops the
 * two most common mistakes in this calculation — costing one person's day for
 * a three-person job, and telling a manager a three-person job takes three
 * times as long as it does.
 */
export function estimateStaffing(input: StaffingInput): StaffingEstimate {
  const { facts, configuration, extraItems } = input

  const contributions = [
    { key: 'guests', points: facts.guests * configuration.perGuest },
    { key: 'bedrooms', points: facts.bedrooms * configuration.perBedroom },
    { key: 'bathrooms', points: facts.bathrooms * configuration.perBathroom },
    { key: 'extra_beds', points: facts.extraBeds * configuration.perExtraBed },
    {
      key: `event:${facts.eventType}`,
      points: configuration.perEventType[facts.eventType] ?? 0,
    },
    ...Object.entries(facts.flags)
      .filter(([, on]) => on)
      .map(([flag]) => ({
        key: `flag:${flag}`,
        points: configuration.perFlag[flag] ?? 0,
      })),
    { key: 'extras', points: extraItems * configuration.perExtraItem },
  ].filter((contribution) => contribution.points !== 0)

  const score = contributions.reduce(
    (total, contribution) => total + contribution.points,
    0,
  )

  const perStaff =
    configuration.scorePerStaff > 0 ? configuration.scorePerStaff : score

  const recommendedStaff = Math.max(
    configuration.minimumStaff,
    perStaff > 0 ? Math.ceil(score / perStaff) : configuration.minimumStaff,
  )

  const estimatedMinutes = Math.max(
    configuration.minimumMinutes,
    Math.ceil(score * configuration.minutesPerPoint),
  )

  const staffMinutes = recommendedStaff * estimatedMinutes

  return {
    score,
    contributions,
    recommendedStaff,
    estimatedMinutes,
    staffMinutes,
    labourCost: labourCostOf(staffMinutes, configuration.hourlyRate),
  }
}

/**
 * What that crew costs.
 *
 * Rounded once, here, to whole agorot. Every money figure in this module
 * follows the same rule — see `costing.ts` — so a total is always the plain
 * sum of numbers that were already integers.
 */
export function labourCostOf(staffMinutes: number, hourlyRate: Agorot): Agorot {
  return Math.round((staffMinutes * hourlyRate) / MINUTES_PER_HOUR)
}
