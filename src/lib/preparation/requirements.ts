/**
 * From a booking to a countable list of things.
 *
 * The pipeline, in the only order it can run in:
 *
 *     allocate beds → measure the facts → derive bed linen
 *                   → evaluate the rules → add the guest's extras
 *                   → merge by item → sort
 *
 * Beds come first because `sleeping_places` and `extra_beds` are outputs of
 * the allocation and inputs to the rules. Merging comes last because two rules
 * may name the same item — a Shabbat template asking for one urn and a
 * threshold rule asking for a second — and the house needs two urns, not two
 * lines each saying one.
 *
 * ── Nothing here knows a number ───────────────────────────────────────────
 *
 * The famous worked example — 25 guests, 5 double-width beds, 25 sleeping
 * places, 25 linen sets, 25 pillows, 15 mattresses, 28 towels after a ten
 * percent buffer — is produced entirely by the arithmetic below over records
 * the organization wrote. Change the property to four beds and every figure
 * moves. There is no branch anywhere in this directory that mentions any of
 * them, and `no-hardcoded-numbers.test.ts` proves it by scanning the source.
 */

import { nightsBetween } from '../booking/types'
import { applyBuffer, evaluateCondition, resolveQuantity } from './rules'
import { allocateSleeping, bedTypeIndex, permanentCapacityOf } from './sleeping'
import {
  REQUIREMENT_CATEGORIES,
  type PlanSectionKey,
  type PreparationBooking,
  type PreparationFacts,
  type PreparationRule,
  type PreparationSnapshot,
  type Requirement,
  type RequirementCategory,
  type RequirementSource,
  type SleepingAllocation,
} from './types'

/** A booking is one booking. The basis that makes "per event" plain arithmetic. */
const ONE_BOOKING = 1

const CATEGORY_ORDER = new Map<RequirementCategory, number>(
  REQUIREMENT_CATEGORIES.map((category, position) => [category, position]),
)

/**
 * Where a bed's work happens.
 *
 * A bed already made up in a bedroom is bedroom work; anything unfolded or
 * laid on the floor is its own section, because it is a different job done at
 * a different time, usually by a different person.
 */
const SECTION_FOR_PERMANENT: PlanSectionKey = 'bedrooms'
const SECTION_FOR_EXTRA: PlanSectionKey = 'extra_sleeping'

// ── Facts ─────────────────────────────────────────────────────────────────

/**
 * Measure the booking against the property.
 *
 * Taken once and passed by value to every rule. A rule that could re-measure
 * mid-evaluation would be able to see a half-built allocation.
 */
export function measureFacts(
  booking: PreparationBooking,
  snapshot: PreparationSnapshot,
  allocation: SleepingAllocation,
): PreparationFacts {
  const configuration = snapshot.propertyConfiguration
  const nights = nightsBetween(booking.stay)

  return {
    guests: booking.guests,
    adults: booking.adults,
    children: booking.children,
    nights: Number.isNaN(nights) ? 0 : nights,
    bedrooms: configuration.bedrooms,
    bathrooms: configuration.bathrooms,
    permanentCapacity: allocation.permanentCapacity,
    sleepingPlaces: allocation.sleepingPlaces,
    extraBeds: allocation.extraBeds,
    booking: ONE_BOOKING,
    eventType: booking.eventType,
    flags: configuration.flags,
  }
}

// ── The rules that apply to this booking ──────────────────────────────────

/**
 * The base rules plus the event template's, in one list.
 *
 * A template is not a separate mechanism — it is a bag of ordinary rules that
 * only ships with one event type. That is why "a Shabbat needs a second urn
 * above thirty guests" needs no code: it is one more conditional rule inside
 * the Shabbat template, and it merges with the first urn like any other pair.
 */
export function applicableRules(
  snapshot: PreparationSnapshot,
  eventType: PreparationBooking['eventType'],
): readonly PreparationRule[] {
  const templateRules = snapshot.eventTemplates
    .filter((template) => template.eventType === eventType)
    .flatMap((template) => template.rules)

  return [...snapshot.rules, ...templateRules]
}

/** Sections an event type wants shown even when nothing filled them. */
export function templateSections(
  snapshot: PreparationSnapshot,
  eventType: PreparationBooking['eventType'],
): readonly PlanSectionKey[] {
  return snapshot.eventTemplates
    .filter((template) => template.eventType === eventType)
    .flatMap((template) => template.sections)
}

// ── The computation ───────────────────────────────────────────────────────

interface Draft {
  category: RequirementCategory
  itemId: string
  label: string
  unit: Requirement['unit']
  section: PlanSectionKey
  requiresPhoto: boolean
  instructions: string | null
  quantity: number
  minutes: number
  source: RequirementSource
}

/**
 * Who among the party actually needs laying down.
 *
 * Every head except the infants, because a baby sleeps in a cot that somebody
 * has to fetch and not in a bed that somebody has to make. Handing the whole
 * head count to `allocateSleeping` buys a bed nobody lies in, dresses it with
 * two sheets and a pillow, and sends that linen to the laundry — every time a
 * family travels with a baby.
 *
 * Read from `infants` rather than derived as `guests - adults - children`.
 * The derivation looks equivalent and is not: nothing enforces that invariant,
 * so a caller that grew a party by moving `guests` alone would have had the
 * new arrivals silently reclassified as babies and left without beds. An
 * unrecorded infant count means the question was not asked, and an unasked
 * question changes nothing.
 */
export function sleepingGuestsOf(booking: PreparationBooking): number {
  const infants = Math.max(0, booking.infants ?? 0)
  return Math.max(0, booking.guests - infants)
}

export function computeRequirements(
  booking: PreparationBooking,
  snapshot: PreparationSnapshot,
): {
  facts: PreparationFacts
  allocation: SleepingAllocation
  requirements: readonly Requirement[]
} {
  const configuration = snapshot.propertyConfiguration

  const allocation = allocateSleeping({
    guests: booking.guests,
    sleepingGuests: sleepingGuestsOf(booking),
    couples: booking.sleeping?.couples,
    configuration,
    bedTypes: snapshot.bedTypes,
  })

  const facts = measureFacts(booking, snapshot, allocation)

  const drafts = [
    ...bedDrafts(allocation, snapshot),
    ...ruleDrafts(applicableRules(snapshot, booking.eventType), facts),
    ...extraDrafts(booking),
  ]

  return { facts, allocation, requirements: merge(drafts) }
}

/**
 * The beds themselves, and the linen they consume.
 *
 * Both come from the same allocation line so they cannot disagree: five beds
 * of a type that takes two single sheets each is five beds and ten sheets,
 * derived in one place from one number.
 */
function bedDrafts(
  allocation: SleepingAllocation,
  snapshot: PreparationSnapshot,
): readonly Draft[] {
  const index = bedTypeIndex(snapshot.bedTypes)
  const drafts: Draft[] = []

  for (const line of allocation.lines) {
    const type = index.get(line.bedTypeId)
    if (!type) continue

    const section =
      line.source === 'permanent' ? SECTION_FOR_PERMANENT : SECTION_FOR_EXTRA
    const ruleId = `bed:${line.bedTypeId}:${line.source}`
    const minutes = line.count * type.setupMinutes

    drafts.push({
      category: 'sleeping',
      itemId: line.bedTypeId,
      label: type.label,
      unit: 'piece',
      section,
      requiresPhoto: false,
      instructions: null,
      quantity: line.count,
      minutes,
      source: {
        ruleId,
        origin: 'bed',
        section,
        base: line.count,
        buffered: line.count,
        minutes,
      },
    })

    for (const linen of type.linen) {
      const quantity = line.count * linen.quantity
      if (quantity <= 0) continue

      drafts.push({
        category: 'linen',
        itemId: linen.itemId,
        label: linen.label,
        unit: linen.unit,
        section,
        requiresPhoto: false,
        instructions: null,
        quantity,
        minutes: 0,
        source: {
          ruleId: `${ruleId}:${linen.itemId}`,
          origin: 'bed',
          section,
          base: quantity,
          buffered: quantity,
          minutes: 0,
        },
      })
    }
  }

  return drafts
}

function ruleDrafts(
  rules: readonly PreparationRule[],
  facts: PreparationFacts,
): readonly Draft[] {
  const drafts: Draft[] = []

  for (const rule of rules) {
    if (!evaluateCondition(rule.condition, facts)) continue

    const base = resolveQuantity(rule.quantity, facts)
    const buffered = applyBuffer(base, rule.buffer)
    if (buffered <= 0) continue

    const minutes = buffered * rule.minutesPerUnit

    drafts.push({
      category: rule.category,
      itemId: rule.itemId,
      label: rule.label,
      unit: rule.unit,
      section: rule.section,
      requiresPhoto: rule.requiresPhoto,
      instructions: rule.instructions,
      quantity: buffered,
      minutes,
      source: {
        ruleId: rule.id,
        origin: 'rule',
        section: rule.section,
        base,
        buffered,
        minutes,
      },
    })
  }

  return drafts
}

/**
 * What the guest asked for by name.
 *
 * Extras are requirements like any other and merge with them: a booking that
 * orders one more highchair than the rules produce ends up with the sum, and
 * the breakdown shows which part came from where.
 */
function extraDrafts(booking: PreparationBooking): readonly Draft[] {
  return booking.extras
    .filter((extra) => extra.quantity > 0)
    .map((extra) => ({
      category: extra.category,
      itemId: extra.itemId,
      label: extra.label,
      unit: extra.unit,
      section: extra.section,
      requiresPhoto: false,
      instructions: null,
      quantity: extra.quantity,
      minutes: extra.quantity * extra.minutesPerUnit,
      source: {
        ruleId: `extra:${extra.itemId}`,
        origin: 'extra' as const,
        section: extra.section,
        base: extra.quantity,
        buffered: extra.quantity,
        minutes: extra.quantity * extra.minutesPerUnit,
      },
    }))
}

/**
 * One line per item, with every contribution kept.
 *
 * Merging on category *and* item, not item alone: an organization that uses
 * the same catalogue key for a cleaning consumable and a kitchen consumable
 * means two different things by it, and adding them together would produce a
 * number that is wrong in both sections.
 */
function merge(drafts: readonly Draft[]): readonly Requirement[] {
  const merged = new Map<string, Requirement>()

  for (const draft of drafts) {
    const key = `${draft.category} ${draft.itemId}`
    const existing = merged.get(key)

    if (!existing) {
      merged.set(key, {
        category: draft.category,
        itemId: draft.itemId,
        label: draft.label,
        unit: draft.unit,
        quantity: draft.quantity,
        section: draft.section,
        requiresPhoto: draft.requiresPhoto,
        instructions: draft.instructions,
        minutes: draft.minutes,
        sources: [draft.source],
      })
      continue
    }

    merged.set(key, {
      ...existing,
      quantity: existing.quantity + draft.quantity,
      minutes: existing.minutes + draft.minutes,
      // Any rule that wants proof wins: a photo requirement is a control, and
      // a control that a second rule can switch off is not a control.
      requiresPhoto: existing.requiresPhoto || draft.requiresPhoto,
      instructions: existing.instructions ?? draft.instructions,
      sources: [...existing.sources, draft.source],
    })
  }

  return [...merged.values()].sort(compareRequirements)
}

/** Category order, then item, so two runs produce the same list. */
function compareRequirements(a: Requirement, b: Requirement): number {
  const left = CATEGORY_ORDER.get(a.category) ?? 0
  const right = CATEGORY_ORDER.get(b.category) ?? 0
  if (left !== right) return left - right
  return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0
}

// ── Lookups the rest of the module needs ──────────────────────────────────

export function requirementQuantity(
  requirements: readonly Requirement[],
  itemId: string,
): number {
  return requirements
    .filter((requirement) => requirement.itemId === itemId)
    .reduce((total, requirement) => total + requirement.quantity, 0)
}

export function categoryQuantity(
  requirements: readonly Requirement[],
  category: RequirementCategory,
): number {
  return requirements
    .filter((requirement) => requirement.category === category)
    .reduce((total, requirement) => total + requirement.quantity, 0)
}

/** What one section is responsible for, taken from the sources. */
export function sectionRequirements(
  requirements: readonly Requirement[],
  section: PlanSectionKey,
): readonly { requirement: Requirement; count: number; minutes: number }[] {
  const out: { requirement: Requirement; count: number; minutes: number }[] = []

  for (const requirement of requirements) {
    const relevant = requirement.sources.filter(
      (source) => source.section === section,
    )
    if (relevant.length === 0) continue

    out.push({
      requirement,
      count: relevant.reduce((total, source) => total + source.buffered, 0),
      minutes: relevant.reduce((total, source) => total + source.minutes, 0),
    })
  }

  return out
}

export { permanentCapacityOf }
