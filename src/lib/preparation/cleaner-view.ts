/**
 * The plan as the person doing the work receives it.
 *
 * A cleaner needs five things: what, where, how many, when, and how it should
 * be done. They need none of the sixth — what any of it is worth. The charter
 * puts it plainly: minimum necessity, and a cleaner does not receive booking
 * value or financials.
 *
 * ── Why this is a projection and not a filter ─────────────────────────────
 *
 * The safe way to build this would seem to be taking the plan and deleting the
 * financial fields. It is not safe. A field added to `WorkPlan` next month is
 * a field that ships to every cleaner in the product, and nobody reviewing
 * that change will think to come back here. So the cleaner's view is its own
 * type built field by field: something new reaches a cleaner only when
 * somebody writes the line that puts it there.
 *
 * `containsFinancialField` is the belt to that pair of braces — a runtime scan
 * over the produced object, used by the test that proves the promise. It
 * cannot catch a field named `x`, which is exactly why it is the second line
 * of defence and the explicit projection is the first.
 */

import {
  CHANGE_NOTICE,
  adjustmentDelta,
  calculatedCount,
  finalCount,
  itemOutstanding,
  needsAcknowledgement,
} from './adjustment'
import type {
  PlanSectionKey,
  RequirementUnit,
  SectionStatus,
  WorkPlan,
} from './types'

export interface CleanerItemView {
  itemId: string
  /** Hebrew. What to do. */
  label: string
  /**
   * The count to work to, shown as `3 / 15`.
   *
   * The **final** figure — what the rules produced plus any manual change —
   * because that is what the house needs and what the person in it is being
   * asked for. Both halves are beside it, so somebody told the number moved
   * can see by how much and why.
   */
  requiredCount: number
  /** What the rules produced, before anybody intervened. */
  calculatedCount: number
  /** Signed. Zero where nobody has changed it. */
  adjustmentDelta: number
  /** Why it was changed, in the adjuster's words. Null where it was not. */
  adjustmentReason: string | null
  completedCount: number
  /** Still to do, counting the adjustment. */
  outstanding: number
  unit: RequirementUnit
  requiresPhoto: boolean
  photoCount: number
  instructions: string | null
}

export interface CleanerSectionView {
  key: PlanSectionKey
  label: string
  status: SectionStatus
  /** Sections that have to be finished first, so the order is visible. */
  dependsOn: readonly PlanSectionKey[]
  items: readonly CleanerItemView[]
  /** Estimated work here. Minutes, never money. */
  minutes: number
  /** Items not yet finished. The number the person is working down. */
  outstanding: number
  /**
   * The booking moved and this section is already under way.
   *
   * True only where somebody has started: a section nobody has touched has
   * nothing to un-learn. See `needsAcknowledgement`.
   */
  changed: boolean
  /** A supervisor's words when they closed this section unfinished. */
  sectionNote: string | null
}

export interface CleanerPlanView {
  planId: string
  version: number
  propertyLabel: string
  unitLabel: string
  /** The stay's own number, so a person can say which job they mean. */
  bookingReference: string | null
  /** ISO instant. When the guests arrive — the only deadline that matters. */
  arrivalAt: string
  /**
   * When the house has to be ready, where that is earlier than the arrival.
   *
   * Null when nobody has set one, and the arrival stands in its place on
   * screen rather than a blank.
   */
  deadlineAt: string | null
  /** How many people are coming. A count, not a value. */
  guestCount: number
  /** What kind of stay it is, in Hebrew. Null where nobody said. */
  eventTypeLabel: string | null
  /** What the guest asked for, in their words. "שתי מיטות תינוק". */
  specialRequests: string | null
  sections: readonly CleanerSectionView[]
  recommendedStaff: number
  /** Set when any started section is working from an older version. */
  changeNotice: string | null
}

export interface CleanerViewInput {
  plan: WorkPlan
  propertyLabel: string
  unitLabel: string
  arrivalAt: string
  guestCount: number
  /**
   * Optional so that a caller written before these fields existed keeps
   * compiling and keeps producing the view it always did.
   */
  bookingReference?: string | null
  deadlineAt?: string | null
  eventTypeLabel?: string | null
  specialRequests?: string | null
}

export function toCleanerView(input: CleanerViewInput): CleanerPlanView {
  const { plan } = input

  const sections = plan.sections.map((section) => {
    const items = section.items.map((item) => ({
      itemId: item.itemId,
      label: item.label,
      requiredCount: finalCount(item),
      calculatedCount: calculatedCount(item),
      adjustmentDelta: adjustmentDelta(item),
      adjustmentReason: item.adjustment?.reason ?? null,
      completedCount: item.completedCount,
      outstanding: itemOutstanding(item),
      unit: item.unit,
      requiresPhoto: item.requiresPhoto,
      photoCount: item.photoIds.length,
      instructions: item.instructions,
    }))

    return {
      key: section.key,
      label: section.label,
      status: section.status,
      dependsOn: section.dependsOn,
      items,
      minutes: section.minutes,
      outstanding: items.filter((item) => item.outstanding > 0).length,
      changed: needsAcknowledgement(plan, section),
      sectionNote: section.override?.reason ?? null,
    }
  })

  return {
    planId: plan.id,
    version: plan.version,
    propertyLabel: input.propertyLabel,
    unitLabel: input.unitLabel,
    bookingReference: input.bookingReference ?? null,
    arrivalAt: input.arrivalAt,
    deadlineAt: input.deadlineAt ?? null,
    guestCount: input.guestCount,
    eventTypeLabel: input.eventTypeLabel ?? null,
    specialRequests: input.specialRequests ?? null,
    recommendedStaff: plan.recommendedStaff,
    sections,
    changeNotice: sections.some((section) => section.changed)
      ? CHANGE_NOTICE
      : null,
  }
}

/**
 * Field-name fragments that mean money.
 *
 * Deliberately blunt and deliberately over-inclusive: a false positive costs a
 * rename, a false negative costs a cleaner learning what the house earns.
 */
const FINANCIAL_FRAGMENTS = [
  'revenue',
  'cost',
  'price',
  'profit',
  'margin',
  'commission',
  'agorot',
  'payment',
  'paid',
  'deposit',
  'rate',
  'amount',
  'fee',
  'charge',
  'invoice',
  'balance',
  'money',
  'total',
  'pnl',
  'salary',
  'wage',
] as const

/**
 * Every path in an object whose key name means money.
 *
 * Returns paths rather than a boolean so a failing test names the field
 * instead of saying "something leaked".
 */
export function containsFinancialField(
  value: unknown,
  path = '',
): readonly string[] {
  if (value === null || typeof value !== 'object') return []

  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      containsFinancialField(entry, `${path}[${index}]`),
    )
  }

  const found: string[] = []

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const here = path.length > 0 ? `${path}.${key}` : key
    const lowered = key.toLowerCase()

    if (FINANCIAL_FRAGMENTS.some((fragment) => lowered.includes(fragment))) {
      found.push(here)
    }

    found.push(...containsFinancialField(entry, here))
  }

  return found
}
