/**
 * Laying the party out across the beds that exist.
 *
 * This runs before every other rule, because two of the bases rules are
 * written against — `sleeping_places` and `extra_beds` — do not exist until it
 * has run. Pillows are counted per sleeping place, and the number of sleeping
 * places is the answer to this question, not an input to it.
 *
 * ── The order beds are used, and why it is fixed ──────────────────────────
 *
 * Permanent beds first, then whatever is folded away in storage, then extras
 * brought in. Within each source, the largest bed first. That ordering is not
 * an optimisation — it is the order that costs the business least: a bed
 * already made up costs nothing, a bed in storage costs setup time, and a
 * mattress that has to be found costs a purchase or a transfer.
 *
 * It is also deterministic, which matters more than it sounds. Two
 * recomputations of an unchanged booking must produce a byte-identical
 * allocation, or the delta engine will report five mattresses added and five
 * removed every time somebody opens the screen.
 *
 * ── Capacity is not positions ─────────────────────────────────────────────
 *
 * A "Jewish bed" sleeps two and is physically two single mattresses. It
 * therefore contributes two sleeping places and takes two single sheets, not
 * one double. The bed type carries both numbers; this file only ever adds up
 * capacity, and `requirements.ts` only ever reads the linen list. Neither
 * guesses one from the other.
 */

import type {
  BedAllocationLine,
  BedType,
  PropertyBedStock,
  PropertyConfiguration,
  SleepingAllocation,
} from './types'

export interface SleepingAllocationInput {
  guests: number
  configuration: PropertyConfiguration
  bedTypes: readonly BedType[]
}

interface Candidate {
  stock: PropertyBedStock
  type: BedType
  available: number
}

export function bedTypeIndex(
  bedTypes: readonly BedType[],
): ReadonlyMap<string, BedType> {
  return new Map(bedTypes.map((type) => [type.id, type]))
}

/**
 * Total capacity of the beds that are already made up.
 *
 * Reported separately from the allocation because it answers a different
 * question — "how many can this house take without extra work" — which is
 * what a rule branching on `permanent_capacity` is asking.
 */
export function permanentCapacityOf(
  configuration: PropertyConfiguration,
  bedTypes: readonly BedType[],
): number {
  const index = bedTypeIndex(bedTypes)
  return configuration.beds.reduce((total, stock) => {
    const type = index.get(stock.bedTypeId)
    if (!type) return total
    return total + stock.permanent * type.capacity
  }, 0)
}

export function allocateSleeping(
  input: SleepingAllocationInput,
): SleepingAllocation {
  const { guests, configuration, bedTypes } = input
  const index = bedTypeIndex(bedTypes)
  const permanentCapacity = permanentCapacityOf(configuration, bedTypes)

  // The property's own ceiling wins over the party's size. A house licensed
  // for fewer people does not become licensed for more because somebody typed
  // a larger number into a booking.
  const ceiling = configuration.maximumSleepingPlaces
  const target = ceiling === null ? guests : Math.min(guests, ceiling)

  const lines: BedAllocationLine[] = []
  let placed = 0

  const takeFrom = (
    candidates: readonly Candidate[],
    source: 'permanent' | 'storage',
  ): void => {
    for (const candidate of candidates) {
      if (placed >= target) return
      if (candidate.available <= 0) continue
      if (candidate.type.capacity <= 0) continue

      const missing = target - placed
      const wanted = Math.ceil(missing / candidate.type.capacity)
      const count = Math.min(wanted, candidate.available)
      if (count <= 0) continue

      const capacity = count * candidate.type.capacity
      lines.push({
        bedTypeId: candidate.type.id,
        label: candidate.type.label,
        source,
        count,
        capacity,
      })
      placed += capacity
    }
  }

  takeFrom(candidatesFor(configuration, index, 'permanent'), 'permanent')
  takeFrom(candidatesFor(configuration, index, 'storage'), 'storage')

  // Whatever is still short becomes extras that have to be produced — the
  // floor mattresses. The type is named in the configuration rather than
  // chosen by the engine: "the smallest bed with capacity one" is a heuristic
  // that eventually picks a crib for an adult.
  if (placed < target) {
    const extraType = index.get(configuration.extraSleepingBedTypeId)
    if (extraType && extraType.usableAsExtra && extraType.capacity > 0) {
      const count = Math.ceil((target - placed) / extraType.capacity)
      const capacity = count * extraType.capacity
      lines.push({
        bedTypeId: extraType.id,
        label: extraType.label,
        source: 'added',
        count,
        capacity,
      })
      placed += capacity
    }
  }

  const extraBeds = lines
    .filter((line) => line.source !== 'permanent')
    .reduce((total, line) => total + line.count, 0)

  return {
    guests,
    permanentCapacity,
    lines,
    sleepingPlaces: placed,
    extraBeds,
    unplacedGuests: Math.max(0, guests - placed),
  }
}

/**
 * The usable beds of one source, largest first.
 *
 * Storage and extras are filtered by `usableAsExtra`; permanent beds are not,
 * because a crib already made up in a bedroom is a real sleeping place for the
 * infant it was put there for. The tie-break on id is what makes the result
 * stable across two properties with identically sized beds.
 */
function candidatesFor(
  configuration: PropertyConfiguration,
  index: ReadonlyMap<string, BedType>,
  source: 'permanent' | 'storage',
): readonly Candidate[] {
  const candidates: Candidate[] = []

  for (const stock of configuration.beds) {
    const type = index.get(stock.bedTypeId)
    if (!type) continue
    if (source === 'storage' && !type.usableAsExtra) continue

    const available = source === 'permanent' ? stock.permanent : stock.storage
    if (available <= 0) continue

    candidates.push({ stock, type, available })
  }

  return candidates.sort((a, b) => {
    if (a.type.capacity !== b.type.capacity) {
      return b.type.capacity - a.type.capacity
    }
    return a.type.id < b.type.id ? -1 : a.type.id > b.type.id ? 1 : 0
  })
}
