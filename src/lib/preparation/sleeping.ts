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
 * ── Capacity is not positions, and both are constraints ───────────────────
 *
 * A "Jewish bed" sleeps two and is physically two single mattresses. A double
 * bed also sleeps two and is one mattress. That is the same capacity and a
 * different answer, and which one is right turns on a fact only the desk
 * knows: whether the two people are a couple.
 *
 * So the allocation satisfies two targets rather than one. **Capacity** must
 * cover everybody who needs a bed. **Positions** must cover everybody who
 * needs their own mattress — the party minus the couples, because a couple
 * shares one and two colleagues do not. Allocating on capacity alone, which is
 * what this file did until `couples` reached it, puts four colleagues into two
 * double beds and is wrong in the only way that matters: nobody finds out
 * until they arrive.
 *
 * The linen follows from the beds and not from the heads, so this is also the
 * difference between three double sheets and six single ones.
 *
 * ── An infant is a head and not a bed ─────────────────────────────────────
 *
 * `guests` counts everybody, because that is what the stay was priced and its
 * capacity checked against. `sleepingGuests` is who actually needs laying
 * down. Feeding the first where the second belongs makes up a bed nobody
 * sleeps in, dresses it, and sends its linen to the laundry — every time a
 * family travels with a baby.
 */

import type {
  BedAllocationLine,
  BedType,
  PropertyBedStock,
  PropertyConfiguration,
  SleepingAllocation,
} from './types'

export interface SleepingAllocationInput {
  /** Every head, infants included. */
  guests: number
  /**
   * Those who need somewhere to sleep. Defaults to `guests`.
   *
   * Optional because a caller written before infants were counted separately
   * passes only the head count, and for such a caller the two are the same by
   * construction — `legacyParty` puts the whole party in `adults`.
   */
  sleepingGuests?: number
  /**
   * Pairs sharing one mattress.
   *
   * **Absent and zero are different answers, and the difference is the whole
   * design of this field.** Zero is the desk saying nobody shares, and it is
   * honoured: six colleagues get six mattresses, not three double beds.
   * Absent is nobody having been asked, and it applies no position constraint
   * at all — which is exactly what this allocator did before couples existed.
   *
   * Defaulting absent to zero would have been the obvious choice and is the
   * wrong one. It would silently re-plan every booking already in the
   * product: a family of ten in a house of five double beds would stop being
   * five made-up beds and become five beds plus five floor mattresses, and the
   * linen order would double overnight on no new information. A fact nobody
   * recorded must not be read as a fact somebody denied.
   */
  couples?: number
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

  const sleeping = Math.max(0, input.sleepingGuests ?? guests)

  // Only the sign is guarded here, and deliberately only the sign.
  //
  // "No more couples than half the party" is the other rule worth enforcing,
  // and it is enforced twice already, closer to the person who could break it:
  // `partyIssues` refuses it on the form with a sentence naming the field, and
  // `bookings_couples_within_adults` refuses it in the schema. Repeating it
  // here would need the literal two, and this engine is not allowed to hold a
  // business number — `no-hardcoded-numbers.test.ts` reads this file and says
  // so. An impossible count that somehow arrived would drive `positionTarget`
  // to zero, which is the same unconstrained allocation this file performed
  // before couples existed: degraded, not wrong.
  const couples =
    input.couples === undefined ? null : Math.max(0, input.couples)

  // The property's own ceiling wins over the party's size. A house licensed
  // for fewer people does not become licensed for more because somebody typed
  // a larger number into a booking.
  const ceiling = configuration.maximumSleepingPlaces
  const target = ceiling === null ? sleeping : Math.min(sleeping, ceiling)
  // One mattress each, except the couples, who share. Null couples means the
  // question was never asked, and an unasked question constrains nothing — see
  // `SleepingAllocationInput.couples`.
  const positionTarget = couples === null ? 0 : Math.max(0, target - couples)

  const lines: BedAllocationLine[] = []
  let placed = 0
  let positions = 0

  const takeFrom = (
    candidates: readonly Candidate[],
    source: 'permanent' | 'storage',
  ): void => {
    for (const candidate of candidates) {
      if (placed >= target && positions >= positionTarget) return
      if (candidate.available <= 0) continue
      if (candidate.type.capacity <= 0) continue

      // However many it takes to close whichever gap is still open. A double
      // bed closes two of the capacity gap and one of the position gap, so
      // four colleagues need four positions and get four mattresses even
      // though two beds would have "fitted" them.
      const byCapacity = Math.ceil(
        Math.max(0, target - placed) / candidate.type.capacity,
      )
      const byPositions =
        candidate.type.positions > 0
          ? Math.ceil(
              Math.max(0, positionTarget - positions) /
                candidate.type.positions,
            )
          : 0

      const count = Math.min(
        Math.max(byCapacity, byPositions),
        candidate.available,
      )
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
      positions += count * candidate.type.positions
    }
  }

  takeFrom(candidatesFor(configuration, index, 'permanent'), 'permanent')
  takeFrom(candidatesFor(configuration, index, 'storage'), 'storage')

  // Whatever is still short becomes extras that have to be produced — the
  // floor mattresses. The type is named in the configuration rather than
  // chosen by the engine: "the smallest bed with capacity one" is a heuristic
  // that eventually picks a crib for an adult.
  if (placed < target || positions < positionTarget) {
    const extraType = index.get(configuration.extraSleepingBedTypeId)
    if (extraType && extraType.usableAsExtra && extraType.capacity > 0) {
      const byCapacity = Math.ceil(
        Math.max(0, target - placed) / extraType.capacity,
      )
      const byPositions =
        extraType.positions > 0
          ? Math.ceil(
              Math.max(0, positionTarget - positions) / extraType.positions,
            )
          : 0

      const count = Math.max(byCapacity, byPositions)
      const capacity = count * extraType.capacity
      lines.push({
        bedTypeId: extraType.id,
        label: extraType.label,
        source: 'added',
        count,
        capacity,
      })
      placed += capacity
      positions += count * extraType.positions
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
    // Measured against the people who needed laying down, and deliberately
    // NOT against `target`: the target is already clamped by the property's
    // licence, so measuring against it would report a full house every time
    // the licence was the thing that ran out — which is the one case the field
    // exists to surface. Infants are excluded because a baby with no bed is
    // not an unplaced guest; they are in a cot, which is an item on the plan.
    unplacedGuests: Math.max(0, sleeping - placed),
    positions,
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
