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

import type { PlanSectionKey, SectionStatus, WorkPlan } from './types'

export interface CleanerItemView {
  itemId: string
  /** Hebrew. What to do. */
  label: string
  /** The count, shown as `3 / 15`. */
  requiredCount: number
  completedCount: number
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
}

export interface CleanerPlanView {
  planId: string
  version: number
  propertyLabel: string
  unitLabel: string
  /** ISO instant. When the guests arrive — the only deadline that matters. */
  arrivalAt: string
  /** How many people are coming. A count, not a value. */
  guestCount: number
  sections: readonly CleanerSectionView[]
  recommendedStaff: number
}

export interface CleanerViewInput {
  plan: WorkPlan
  propertyLabel: string
  unitLabel: string
  arrivalAt: string
  guestCount: number
}

export function toCleanerView(input: CleanerViewInput): CleanerPlanView {
  const { plan } = input

  return {
    planId: plan.id,
    version: plan.version,
    propertyLabel: input.propertyLabel,
    unitLabel: input.unitLabel,
    arrivalAt: input.arrivalAt,
    guestCount: input.guestCount,
    recommendedStaff: plan.recommendedStaff,
    sections: plan.sections.map((section) => ({
      key: section.key,
      label: section.label,
      status: section.status,
      dependsOn: section.dependsOn,
      items: section.items.map((item) => ({
        itemId: item.itemId,
        label: item.label,
        requiredCount: item.requiredCount,
        completedCount: item.completedCount,
        requiresPhoto: item.requiresPhoto,
        photoCount: item.photoIds.length,
        instructions: item.instructions,
      })),
    })),
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
