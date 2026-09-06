/**
 * Four looks at the same unit, and the differences between them.
 *
 * ══ THIS FILE PRODUCES DIFFERENCES. IT DOES NOT PRODUCE CONCLUSIONS ════════
 *
 * `compareInspections` returns a list of things that are not the same as they
 * were. It never returns who caused them, whether they are damage, whether
 * they are chargeable, or how much. `InspectionDifference` has no field for
 * any of that and must never gain one — see `liability.ts` for the argument in
 * full and for the one place a conclusion may be recorded, with a person's
 * name on it.
 *
 * The distinction is not pedantry. "The kettle is missing from unit 4" is a
 * fact. "The guest took the kettle" is an accusation, and between the two sit
 * the cleaner who moved it to unit 3, the maintenance visit nobody logged, and
 * the count that was wrong before the guest arrived. A system that emits the
 * second from the first will, eventually, keep somebody's deposit for a kettle
 * that was in the next room.
 *
 * ── The four stages, and why the middle one exists ────────────────────────
 *
 * `pre_stay` and `checkout` are the pair everything hangs on. `stay` is for
 * something recorded while the guest is in the unit — a maintenance visit, a
 * mid-stay clean — and it matters because it breaks the chain: a difference
 * between pre-stay and checkout that a mid-stay record already shows is a
 * difference that predates the checkout, and the comparison says so rather
 * than leaving somebody to notice. `post_stay` is the turnover clean, which is
 * where most damage is actually found.
 *
 * Every stage is optional. A business with no pre-stay record still has a
 * checkout record, and the comparison says "there is nothing to compare
 * against" — which is a true and useful answer, and is the answer that most
 * often decides a dispute in the guest's favour.
 *
 * Pure. No database, no clock.
 */

/* -------------------------------------------------------------- stages --- */

export const INSPECTION_STAGES = [
  'pre_stay',
  'stay',
  'checkout',
  'post_stay',
] as const

export type InspectionStage = (typeof INSPECTION_STAGES)[number]

export const INSPECTION_STAGE_LABEL: Record<InspectionStage, string> = {
  pre_stay: 'לפני הכניסה',
  stay: 'במהלך השהות',
  checkout: 'ביציאה',
  post_stay: 'אחרי היציאה',
}

/**
 * The order the stages happened in.
 *
 * Declared rather than derived from the array above, because the comparison
 * depends on it and an accidental reordering of a display list must not
 * silently reverse what "before" means.
 */
export const STAGE_ORDER: Record<InspectionStage, number> = {
  pre_stay: 0,
  stay: 1,
  checkout: 2,
  post_stay: 3,
}

/* ----------------------------------------------------------- conditions -- */

/**
 * What somebody saw.
 *
 * `not_checked` is the most important value here and is the default. An item
 * nobody looked at is not an intact item, and a checklist that records
 * silence as "fine" is a checklist that manufactures differences at checkout
 * for everything the pre-stay walk skipped.
 */
export const INSPECTION_CONDITIONS = [
  'intact',
  'worn',
  'damaged',
  'missing',
  'not_checked',
] as const

export type InspectionCondition = (typeof INSPECTION_CONDITIONS)[number]

export const INSPECTION_CONDITION_LABEL: Record<InspectionCondition, string> = {
  intact: 'תקין',
  worn: 'בלאי',
  damaged: 'ניזוק',
  missing: 'חסר',
  not_checked: 'לא נבדק',
}

/**
 * How bad each condition is, for ordering only.
 *
 * `not_checked` is deliberately outside the scale — it is not better or worse
 * than anything, it is an absence of information, and giving it a rank would
 * let a comparison treat "we did not look" as "it was fine".
 */
const CONDITION_RANK: Record<InspectionCondition, number | null> = {
  intact: 0,
  worn: 1,
  damaged: 2,
  missing: 3,
  not_checked: null,
}

/* ------------------------------------------------------------- records --- */

/**
 * One thing that was looked at.
 *
 * `key` is stable across stages and is what pairs a pre-stay line with a
 * checkout line — an inventory item id, or a slug for an area of the unit
 * (`kitchen.worktop`). `quantity` is set for countable things and null for
 * everything else; three towels and a worktop are both inspectable and only
 * one of them has a number.
 */
export interface InspectionItem {
  key: string
  label: string
  condition: InspectionCondition
  quantity: number | null
  /** What was photographed. Ids into `incident_evidence`. */
  evidenceIds: readonly string[]
  note: string | null
}

export interface InspectionRecord {
  id: string
  organizationId: string
  propertyId: string
  unitId: string
  /** The stay this belongs to. `null` between stays. */
  bookingId: string | null
  /** Set when the inspection was performed as part of working a case. */
  caseId: string | null
  stage: InspectionStage
  performedByUserId: string | null
  performedAt: Date
  notes: string | null
  items: readonly InspectionItem[]
}

export interface InspectionRecordDraft {
  organizationId: string
  propertyId: string
  unitId: string
  bookingId: string | null
  caseId: string | null
  stage: InspectionStage
  performedByUserId: string | null
  performedAt: Date
  notes: string | null
  items: readonly InspectionItem[]
}

/* --------------------------------------------------------- differences --- */

/**
 * What kind of difference this is.
 *
 * Descriptive, all of them. `condition_worsened` says the later record is
 * worse than the earlier one; it does not say damage, and it does not say
 * whose. `not_comparable` is the one that keeps the whole thing honest — one
 * side was never checked, so there is nothing to compare, and that is reported
 * rather than resolved in either direction.
 */
export const DIFFERENCE_KINDS = [
  'condition_worsened',
  'condition_improved',
  'quantity_short',
  'quantity_over',
  'appeared',
  'disappeared',
  'not_comparable',
] as const

export type DifferenceKind = (typeof DIFFERENCE_KINDS)[number]

export const DIFFERENCE_KIND_LABEL: Record<DifferenceKind, string> = {
  condition_worsened: 'המצב הידרדר',
  condition_improved: 'המצב השתפר',
  quantity_short: 'חסרה כמות',
  quantity_over: 'עודף כמות',
  appeared: 'נוסף פריט שלא נבדק קודם',
  disappeared: 'פריט שנבדק קודם ולא נבדק עכשיו',
  not_comparable: 'אין בסיס להשוואה',
}

/**
 * One difference between two records.
 *
 * Read the fields: two conditions, two quantities, a kind and the evidence
 * from both sides. There is no `liable`, no `chargeable`, no `amount` and no
 * `confidence`, and `inspection.test.ts` asserts that there is not — because
 * the day one appears is the day a comparison starts deciding.
 */
export interface InspectionDifference {
  key: string
  label: string
  kind: DifferenceKind
  before: InspectionCondition | null
  after: InspectionCondition | null
  quantityBefore: number | null
  quantityAfter: number | null
  /** Everything either side photographed, so a person can look at both. */
  evidenceIds: readonly string[]
}

/**
 * Compare two inspection records.
 *
 * Order is taken from the records' own stages, not from the argument order: a
 * caller who passes checkout first still gets a comparison that reads
 * forwards, because "before" and "after" are facts about when somebody looked
 * and not about how a function was called.
 *
 * Every key present in either record produces at most one entry. Keys that
 * match and did not change produce nothing — a difference list that included
 * everything that stayed the same would be a checklist, and a person reading
 * forty unchanged lines does not see the two that changed.
 */
export function compareInspections(
  first: InspectionRecord,
  second: InspectionRecord,
): readonly InspectionDifference[] {
  const [before, after] =
    STAGE_ORDER[first.stage] <= STAGE_ORDER[second.stage]
      ? [first, second]
      : [second, first]

  const beforeItems = new Map(before.items.map((item) => [item.key, item]))
  const afterItems = new Map(after.items.map((item) => [item.key, item]))

  const keys = [
    ...new Set([...beforeItems.keys(), ...afterItems.keys()]),
  ].sort()

  const differences: InspectionDifference[] = []

  for (const key of keys) {
    const left = beforeItems.get(key) ?? null
    const right = afterItems.get(key) ?? null
    const difference = compareItem(key, left, right)
    if (difference !== null) differences.push(difference)
  }

  return differences
}

function compareItem(
  key: string,
  before: InspectionItem | null,
  after: InspectionItem | null,
): InspectionDifference | null {
  const label = after?.label ?? before?.label ?? key
  const evidenceIds = [
    ...(before?.evidenceIds ?? []),
    ...(after?.evidenceIds ?? []),
  ]

  const shell = {
    key,
    label,
    before: before?.condition ?? null,
    after: after?.condition ?? null,
    quantityBefore: before?.quantity ?? null,
    quantityAfter: after?.quantity ?? null,
    evidenceIds,
  }

  // One side never looked at this at all.
  if (before === null && after !== null) {
    return { ...shell, kind: 'appeared' }
  }
  if (before !== null && after === null) {
    return { ...shell, kind: 'disappeared' }
  }
  if (before === null || after === null) return null

  const beforeRank = CONDITION_RANK[before.condition]
  const afterRank = CONDITION_RANK[after.condition]

  // "Not checked" on either side. Nothing about the pair is comparable, and
  // reporting it as unchanged would be the system asserting a fact nobody
  // established.
  if (beforeRank === null || afterRank === null) {
    if (before.condition === after.condition) return null
    return { ...shell, kind: 'not_comparable' }
  }

  if (afterRank > beforeRank) return { ...shell, kind: 'condition_worsened' }
  if (afterRank < beforeRank) return { ...shell, kind: 'condition_improved' }

  // Same condition. Quantities may still differ — three towels became two.
  if (before.quantity !== null && after.quantity !== null) {
    if (after.quantity < before.quantity) {
      return { ...shell, kind: 'quantity_short' }
    }
    if (after.quantity > before.quantity) {
      return { ...shell, kind: 'quantity_over' }
    }
  }

  return null
}

/* ----------------------------------------------------------- the chain --- */

/**
 * The whole sequence for one stay, compared stage by stage.
 *
 * Adjacent pairs rather than pre-stay against checkout, and that is the point
 * of having four stages: a difference that first shows up between `stay` and
 * `checkout` happened during the stay, and one that shows up between
 * `checkout` and `post_stay` was found by the cleaner after the guest left.
 * Comparing only the endpoints would collapse those into one indistinguishable
 * claim, which is the claim a guest disputes.
 */
export interface InspectionChainStep {
  from: InspectionStage
  to: InspectionStage
  fromAt: Date
  toAt: Date
  differences: readonly InspectionDifference[]
}

export function compareChain(
  records: readonly InspectionRecord[],
): readonly InspectionChainStep[] {
  const ordered = [...records].sort(
    (left, right) => STAGE_ORDER[left.stage] - STAGE_ORDER[right.stage],
  )

  const steps: InspectionChainStep[] = []
  for (let index = 1; index < ordered.length; index++) {
    const from = ordered[index - 1]
    const to = ordered[index]
    if (!from || !to) continue
    steps.push({
      from: from.stage,
      to: to.stage,
      fromAt: from.performedAt,
      toAt: to.performedAt,
      differences: compareInspections(from, to),
    })
  }
  return steps
}

/**
 * Is there anything to compare against at all?
 *
 * Asked by the screens before they render a comparison, so that "no pre-stay
 * record exists" is a sentence the reader sees rather than an empty difference
 * list they read as "nothing changed". Those are opposite statements and they
 * look identical.
 */
export function hasBaseline(records: readonly InspectionRecord[]): boolean {
  return records.some((record) => record.stage === 'pre_stay')
}

/**
 * The differences worth a person's attention, ordered.
 *
 * Worsening and shortage first, because those are the ones that cost money.
 * Nothing is filtered out — an improvement and a not-comparable are both
 * facts, and a comparison that hid them would be a comparison that only ever
 * argued in the business's direction.
 */
const KIND_ATTENTION: Record<DifferenceKind, number> = {
  quantity_short: 0,
  condition_worsened: 1,
  disappeared: 2,
  not_comparable: 3,
  appeared: 4,
  quantity_over: 5,
  condition_improved: 6,
}

export function byAttention(
  differences: readonly InspectionDifference[],
): readonly InspectionDifference[] {
  return [...differences].sort(
    (left, right) =>
      KIND_ATTENTION[left.kind] - KIND_ATTENTION[right.kind] ||
      left.label.localeCompare(right.label, 'he'),
  )
}
