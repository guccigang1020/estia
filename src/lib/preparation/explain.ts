/**
 * Why the house needs that many, in a sentence a person can argue with.
 *
 * "twenty-eight bath towels" is an instruction. "twenty-eight bath towels =
 * twenty-five guests × one per guest, plus a ten percent margin" is a claim,
 * and a claim can be checked, disputed and corrected. The difference is the
 * whole reason anybody trusts a computed plan: a manager who cannot see the
 * arithmetic has to either accept every number or ignore every number, and
 * both are worse than the notebook the engine replaced.
 *
 * ── The engine already knew this; it was not saying it ────────────────────
 *
 * Nothing here computes a quantity. `Requirement.sources` has carried the
 * derivation since the day requirements existed — the rule's id, whether it
 * came from a rule, a bed or the guest's own request, what it computed before
 * the buffer and after it. This module is the renderer, and it lives beside
 * the calculation for the reason `describeDelta` does: two renderings of one
 * number eventually disagree, and the one on the screen is the one people
 * believe.
 *
 * ── The rule is looked up rather than stored on the source ────────────────
 *
 * `RequirementSource` names a rule id and not its expression, so the basis and
 * the multiplier are read back out of the snapshot the plan was frozen
 * against. That is deliberate: it is the *frozen* rule that produced the
 * number, and rendering today's version of the same rule would print an
 * explanation the figure beside it does not match. A rule id with nothing
 * behind it in the snapshot renders the plain total instead of inventing an
 * expression — see `UNEXPLAINED`.
 */

import { applicableRules } from './requirements'
import {
  type FactBasis,
  type PlanSectionKey,
  type PreparationFacts,
  type PreparationRule,
  type PreparationSnapshot,
  type QuantityExpression,
  type Requirement,
  type RequirementBuffer,
  type RequirementSource,
  type RequirementUnit,
} from './types'

const NONE = 0
const IDENTITY = 1

/**
 * What each basis is called, in the plural, as it appears in the sentence.
 *
 * A total record over the frozen list, so adding a basis without naming it in
 * Hebrew fails the build rather than printing `permanent_capacity` to somebody
 * running a guesthouse.
 */
export const FACT_BASIS_LABEL: Record<FactBasis, string> = {
  guests: 'אורחים',
  adults: 'מבוגרים',
  children: 'ילדים',
  nights: 'לילות',
  bedrooms: 'חדרי שינה',
  bathrooms: 'חדרי רחצה',
  permanent_capacity: 'מקומות לינה קבועים',
  sleeping_places: 'מקומות לינה',
  extra_beds: 'מיטות נוספות',
  booking: 'הזמנה',
}

/** The same list in the singular, as "per one of these". */
export const FACT_BASIS_PER: Record<FactBasis, string> = {
  guests: 'לאורח',
  adults: 'למבוגר',
  children: 'לילד',
  nights: 'ללילה',
  bedrooms: 'לחדר שינה',
  bathrooms: 'לחדר רחצה',
  permanent_capacity: 'למקום לינה קבוע',
  sleeping_places: 'למקום לינה',
  extra_beds: 'למיטה נוספת',
  booking: 'להזמנה',
}

/** What is said when the snapshot no longer holds the rule that produced a line. */
const UNEXPLAINED = 'מתוך חוקי הנכס'

/** Where a line came from, when it did not come from a rule. */
const FROM_BEDS = 'מפריסת המיטות ביחידה'
const FROM_GUEST = 'לפי בקשת האורח'

export interface ExplainedSource {
  ruleId: string
  origin: RequirementSource['origin']
  section: PlanSectionKey
  /** Before the buffer. */
  base: number
  /** After it. This is the number that reaches the plan. */
  buffered: number
  /** The arithmetic, in Hebrew. Never empty. */
  sentence: string
}

export interface Explanation {
  itemId: string
  label: string
  unit: RequirementUnit
  /** The item's total across every section. */
  calculated: number
  sources: readonly ExplainedSource[]
}

/**
 * The multiplication, spelled out.
 *
 * `25 מגבות = 25 אורחים × 1 לאורח` in the ordinary case, with the divisor and
 * the flat addition appended only when they are doing something. A sentence
 * that always printed `÷ 1` would train people to stop reading it.
 */
function arithmetic(
  quantity: QuantityExpression,
  facts: PreparationFacts,
  label: string,
  base: number,
): string {
  const basisValue = factOf(quantity.basis, facts)
  const factor = quantity.factor ?? IDENTITY
  const divisor = quantity.divisor ?? IDENTITY
  const plus = quantity.plus ?? NONE

  const parts = [
    `${basisValue} ${FACT_BASIS_LABEL[quantity.basis]}`,
    `× ${factor} ${FACT_BASIS_PER[quantity.basis]}`,
  ]

  if (divisor !== IDENTITY) parts.push(`÷ ${divisor}`)
  if (plus !== NONE) parts.push(plus > NONE ? `+ ${plus}` : `− ${-plus}`)

  return `${base} ${label} = ${parts.join(' ')}`
}

/**
 * The basis, read off the measured facts.
 *
 * A local copy of the lookup rather than an import of `factValue`, because
 * that one is typed against the engine's evaluation path and this one is a
 * renderer; the day the two need to differ, the renderer must not be able to
 * change what an engine computes.
 */
function factOf(basis: FactBasis, facts: PreparationFacts): number {
  switch (basis) {
    case 'guests':
      return facts.guests
    case 'adults':
      return facts.adults
    case 'children':
      return facts.children
    case 'nights':
      return facts.nights
    case 'bedrooms':
      return facts.bedrooms
    case 'bathrooms':
      return facts.bathrooms
    case 'permanent_capacity':
      return facts.permanentCapacity
    case 'sleeping_places':
      return facts.sleepingPlaces
    case 'extra_beds':
      return facts.extraBeds
    default:
      return facts.booking
  }
}

/** The margin, appended only where one was applied and actually moved it. */
function margin(
  buffer: RequirementBuffer | null,
  base: number,
  buffered: number,
  label: string,
): string {
  if (buffer === null || buffered === base) return ''

  const stated =
    buffer.kind === 'percent'
      ? `${buffer.percent}%`
      : `${buffer.amount} ${label}`

  return `, ועוד מרווח של ${stated} → ${buffered} ${label}`
}

/**
 * One requirement, with every contribution rendered.
 *
 * The rules are resolved from the snapshot against the booking's own event
 * type, which is what `computeRequirements` did when the numbers were
 * produced. Passing today's catalogue instead would explain a plan with rules
 * that were never applied to it.
 */
export function explainRequirement(
  requirement: Requirement,
  facts: PreparationFacts,
  snapshot: PreparationSnapshot,
): Explanation {
  const rules = ruleIndex(snapshot, facts)

  return {
    itemId: requirement.itemId,
    label: requirement.label,
    unit: requirement.unit,
    calculated: requirement.quantity,
    sources: requirement.sources.map((source) => ({
      ruleId: source.ruleId,
      origin: source.origin,
      section: source.section,
      base: source.base,
      buffered: source.buffered,
      sentence: sentenceFor(source, requirement, facts, rules),
    })),
  }
}

function sentenceFor(
  source: RequirementSource,
  requirement: Requirement,
  facts: PreparationFacts,
  rules: ReadonlyMap<string, PreparationRule>,
): string {
  const label = requirement.label

  if (source.origin === 'bed') {
    return `${source.buffered} ${label} — ${FROM_BEDS}`
  }

  if (source.origin === 'extra') {
    return `${source.buffered} ${label} — ${FROM_GUEST}`
  }

  const rule = rules.get(source.ruleId)
  if (!rule) return `${source.buffered} ${label} — ${UNEXPLAINED}`

  return (
    arithmetic(rule.quantity, facts, label, source.base) +
    margin(rule.buffer, source.base, source.buffered, label)
  )
}

function ruleIndex(
  snapshot: PreparationSnapshot,
  facts: PreparationFacts,
): ReadonlyMap<string, PreparationRule> {
  const index = new Map<string, PreparationRule>()
  for (const rule of applicableRules(snapshot, facts.eventType)) {
    index.set(rule.id, rule)
  }
  return index
}

/**
 * Every requirement on one booking, keyed the way the plan keys its items.
 *
 * `category itemId`, which is the same compound key `merge` uses — an
 * organization that calls a cleaning consumable and a kitchen consumable by
 * one catalogue id means two different things by it, and an explanation keyed
 * on the id alone would attach the wrong arithmetic to one of them.
 */
export function explanationIndex(
  requirements: readonly Requirement[],
  facts: PreparationFacts,
  snapshot: PreparationSnapshot,
): ReadonlyMap<string, Explanation> {
  const index = new Map<string, Explanation>()

  for (const requirement of requirements) {
    index.set(
      `${requirement.category} ${requirement.itemId}`,
      explainRequirement(requirement, facts, snapshot),
    )
  }

  return index
}
