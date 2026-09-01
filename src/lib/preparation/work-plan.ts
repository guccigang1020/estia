/**
 * The plan a person standing in the house actually works from.
 *
 * The requirement list is the truth; it is not a usable instruction. Ninety
 * lines in one column is a list that gets skimmed, and the item that gets
 * skipped is always the one nobody thought to count. So the plan is sectioned,
 * every item carries a count the worker ticks off (`0 / 15`, not "linen ✓"),
 * and a section cannot be closed while it is unfinished.
 *
 * ── Dependencies are real, not decorative ─────────────────────────────────
 *
 * Final inspection after cleaning and after the beds are made, towels after
 * the bathrooms are done. These are declared as a graph because a same-day
 * turnover has to be planned against the longest chain through it — the number
 * that decides whether the house can be ready by four o'clock is not the total
 * work, it is the work that cannot be done in parallel.
 *
 * ── Why the override is not a boolean ─────────────────────────────────────
 *
 * A supervisor closing an unfinished section is a legitimate and frequent
 * event: the guest arrived early, the fifteenth pillow is genuinely not in the
 * building, and the alternative to closing the section is a house that is
 * never marked ready. What must not happen is closing it *silently*. The
 * override therefore carries the supervisor, the reason in their own words,
 * and the list of what was outstanding at that moment — the question three
 * weeks later is never "was it overridden" but "what did they say at the
 * time", and only the second one is answerable after the fact.
 */

import { BusinessRuleError } from '../errors'
import { finalCount } from './adjustment'
import { sectionRequirements } from './requirements'
import {
  PLAN_SECTIONS,
  type PlanItem,
  type PlanSection,
  type PlanSectionKey,
  type PreparationBooking,
  type PreparationSnapshot,
  type Requirement,
  type SectionOverride,
  type StaffingEstimate,
  type WorkPlan,
} from './types'

/**
 * What has to be finished before a section may be closed.
 *
 * Declared once, here, and read by the completion rule, the critical path and
 * the readiness percentage alike. Three implementations of "what comes first"
 * is three chances to disagree about whether the towels can go out before the
 * bathroom is cleaned.
 */
export const SECTION_DEPENDENCIES: Readonly<
  Record<PlanSectionKey, readonly PlanSectionKey[]>
> = {
  cleaning: [],
  bedrooms: ['cleaning'],
  extra_sleeping: ['bedrooms'],
  bathrooms: ['cleaning'],
  towels: ['bathrooms'],
  kitchen: ['cleaning'],
  event_setup: ['cleaning'],
  outdoor: [],
  pool: [],
  final_inspection: [
    'cleaning',
    'bedrooms',
    'extra_sleeping',
    'bathrooms',
    'towels',
    'kitchen',
    'event_setup',
    'outdoor',
    'pool',
  ],
}

// ── Building ──────────────────────────────────────────────────────────────

export interface WorkPlanInput {
  id: string
  booking: PreparationBooking
  snapshot: PreparationSnapshot
  requirements: readonly Requirement[]
  staffing: StaffingEstimate
  /** Sections the event template wants shown even when nothing fills them. */
  extraSections?: readonly PlanSectionKey[]
  version: number
  createdAt: string
}

export function buildWorkPlan(input: WorkPlanInput): WorkPlan {
  const { booking, snapshot, requirements, staffing } = input
  const forced = new Set(input.extraSections ?? [])

  const sections: PlanSection[] = []

  for (const key of PLAN_SECTIONS) {
    const entries = sectionRequirements(requirements, key)
    if (entries.length === 0 && !forced.has(key)) continue

    const items: PlanItem[] = entries.map((entry) => ({
      id: `${input.id}:${key}:${entry.requirement.category}:${entry.requirement.itemId}`,
      itemId: entry.requirement.itemId,
      label: entry.requirement.label,
      category: entry.requirement.category,
      unit: entry.requirement.unit,
      requiredCount: entry.count,
      completedCount: 0,
      requiresPhoto: entry.requirement.requiresPhoto,
      photoIds: [],
      instructions: entry.requirement.instructions,
      minutes: entry.minutes,
    }))

    sections.push({
      key,
      label: snapshot.sectionLabels[key],
      items,
      dependsOn: [],
      status: 'new',
      minutes: items.reduce((total, item) => total + item.minutes, 0),
      assignedToUserId: null,
      override: null,
    })
  }

  // Dependencies are narrowed to the sections that exist. A plan with no pool
  // must not leave final inspection waiting for a pool section that will never
  // be created — a dependency on nothing is a permanently blocked plan.
  const present = new Set(sections.map((section) => section.key))
  const withDependencies = sections.map((section) => ({
    ...section,
    dependsOn: SECTION_DEPENDENCIES[section.key].filter((key) =>
      present.has(key),
    ),
  }))

  return {
    id: input.id,
    organizationId: booking.organizationId,
    bookingId: booking.id,
    propertyId: booking.propertyId,
    unitId: booking.unitId,
    version: input.version,
    snapshotHash: snapshot.hash,
    createdAt: input.createdAt,
    sections: withDependencies,
    criticalPathMinutes: criticalPathMinutes(withDependencies),
    recommendedStaff: staffing.recommendedStaff,
    // Captured here rather than read later, for the same reason the snapshot
    // hash is: the person who has to work from these numbers holds
    // `task.view` and cannot read the booking they came from. See `PlanFacts`.
    facts: {
      arrivalAt: booking.arrivalAt,
      eventType: booking.eventType,
      specialRequests: booking.specialRequests ?? null,
      guests: booking.guests,
      adults: booking.adults,
      children: booking.children,
    },
  }
}

// ── The critical path ─────────────────────────────────────────────────────

/**
 * The longest chain of dependent sections, in order.
 *
 * Depth-first with memoisation over a graph that is small and acyclic by
 * construction — the table above has no cycle and is not user-editable, so
 * there is no cycle detection here on purpose rather than by oversight.
 */
export function criticalPath(
  sections: readonly PlanSection[],
): readonly PlanSectionKey[] {
  const byKey = new Map(sections.map((section) => [section.key, section]))
  const memo = new Map<PlanSectionKey, readonly PlanSectionKey[]>()

  const pathTo = (key: PlanSectionKey): readonly PlanSectionKey[] => {
    const cached = memo.get(key)
    if (cached) return cached

    const section = byKey.get(key)
    if (!section) return []

    let best: readonly PlanSectionKey[] = []
    let bestMinutes = -1

    for (const dependency of section.dependsOn) {
      const candidate = pathTo(dependency)
      const minutes = minutesOf(candidate, byKey)
      if (minutes > bestMinutes) {
        best = candidate
        bestMinutes = minutes
      }
    }

    const path = [...best, key]
    memo.set(key, path)
    return path
  }

  let longest: readonly PlanSectionKey[] = []
  let longestMinutes = -1

  for (const section of sections) {
    const path = pathTo(section.key)
    const minutes = minutesOf(path, byKey)
    if (minutes > longestMinutes) {
      longest = path
      longestMinutes = minutes
    }
  }

  return longest
}

export function criticalPathMinutes(sections: readonly PlanSection[]): number {
  const byKey = new Map(sections.map((section) => [section.key, section]))
  return minutesOf(criticalPath(sections), byKey)
}

function minutesOf(
  path: readonly PlanSectionKey[],
  byKey: ReadonlyMap<PlanSectionKey, PlanSection>,
): number {
  return path.reduce((total, key) => total + (byKey.get(key)?.minutes ?? 0), 0)
}

/**
 * Can the house be turned around in the window between one guest and the next?
 *
 * Two ceilings, and the answer is the larger. Adding people shortens the work
 * but never shortens the chain: cleaning still has to finish before the beds
 * are made, however many hands are available.
 */
export interface TurnoverAssessment {
  criticalPathMinutes: number
  totalMinutes: number
  /** With the recommended crew working in parallel where the graph allows. */
  achievableMinutes: number
  availableMinutes: number
  feasible: boolean
  /** Minutes short. Zero when it fits. */
  shortfallMinutes: number
}

export function assessTurnover(
  plan: WorkPlan,
  options: { availableMinutes: number; staff?: number },
): TurnoverAssessment {
  const staff = Math.max(1, options.staff ?? plan.recommendedStaff)
  const totalMinutes = plan.sections.reduce(
    (total, section) => total + section.minutes,
    0,
  )
  const achievableMinutes = Math.max(
    plan.criticalPathMinutes,
    Math.ceil(totalMinutes / staff),
  )

  return {
    criticalPathMinutes: plan.criticalPathMinutes,
    totalMinutes,
    achievableMinutes,
    availableMinutes: options.availableMinutes,
    feasible: achievableMinutes <= options.availableMinutes,
    shortfallMinutes: Math.max(0, achievableMinutes - options.availableMinutes),
  }
}

// ── Progress ──────────────────────────────────────────────────────────────

export interface ProgressInput {
  section: PlanSectionKey
  itemId: string
  completedCount: number
  photoIds?: readonly string[]
}

/**
 * Record work done, returning a new plan.
 *
 * The count is clamped rather than validated: a worker who ticks off sixteen
 * of fifteen pillows has miscounted, and refusing the whole update over it
 * would leave the plan showing less progress than actually happened.
 */
export function recordProgress(plan: WorkPlan, input: ProgressInput): WorkPlan {
  return {
    ...plan,
    sections: plan.sections.map((section) => {
      if (section.key !== input.section) return section

      const items = section.items.map((item) =>
        item.itemId === input.itemId
          ? {
              ...item,
              completedCount: Math.min(
                finalCount(item),
                Math.max(0, input.completedCount),
              ),
              photoIds: input.photoIds
                ? [...item.photoIds, ...input.photoIds]
                : item.photoIds,
            }
          : item,
      )

      return {
        ...section,
        items,
        status: statusFor(items, section.status),
      }
    }),
  }
}

function statusFor(
  items: readonly PlanItem[],
  current: PlanSection['status'],
): PlanSection['status'] {
  if (current === 'completed') return current
  const done = items.reduce((total, item) => total + item.completedCount, 0)
  return done > 0 ? 'in_progress' : 'new'
}

// ── Completion ────────────────────────────────────────────────────────────

export interface OutstandingItem {
  itemId: string
  label: string
  missing: number
  /** The item is counted but its photograph was never taken. */
  missingPhoto: boolean
}

export function outstandingItems(
  section: PlanSection,
): readonly OutstandingItem[] {
  return section.items
    .map((item) => ({
      itemId: item.itemId,
      label: item.label,
      missing: Math.max(0, finalCount(item) - item.completedCount),
      missingPhoto: item.requiresPhoto && item.photoIds.length === 0,
    }))
    .filter((item) => item.missing > 0 || item.missingPhoto)
}

export interface CompleteSectionInput {
  section: PlanSectionKey
  at: string
  /** Supplied only when a supervisor is closing an unfinished section. */
  override?: { supervisorUserId: string; reason: string }
}

export interface CompletionOutcome {
  plan: WorkPlan
  overridden: boolean
  outstanding: readonly OutstandingItem[]
}

export function completeSection(
  plan: WorkPlan,
  input: CompleteSectionInput,
): CompletionOutcome {
  const section = plan.sections.find((entry) => entry.key === input.section)
  if (!section) {
    throw new BusinessRuleError({
      code: 'plan_section_not_found',
      message: `Section ${input.section} is not part of plan ${plan.id}`,
      userMessage: 'המקטע המבוקש אינו חלק מתוכנית ההכנה הזו.',
      publicDetails: { section: input.section },
    })
  }

  const blocking = section.dependsOn.filter(
    (key) =>
      plan.sections.find((entry) => entry.key === key)?.status !== 'completed',
  )

  // Order is not advice. Inspecting a house before it has been cleaned
  // produces a signed-off inspection of a dirty house, which is worse than no
  // inspection: it is a record saying somebody looked.
  if (blocking.length > 0) {
    throw new BusinessRuleError({
      code: 'plan_section_blocked',
      message: `Section ${input.section} depends on incomplete sections: ${blocking.join(', ')}`,
      userMessage:
        'לא ניתן לסמן את המקטע כהושלם לפני שהמקטעים שהוא תלוי בהם הושלמו.',
      publicDetails: { section: input.section, blockedBy: blocking },
    })
  }

  const outstanding = outstandingItems(section)

  if (outstanding.length > 0 && !input.override) {
    throw new BusinessRuleError({
      code: 'plan_section_incomplete',
      message: `Section ${input.section} has ${outstanding.length} outstanding item(s)`,
      userMessage:
        'יש פריטים שטרם הושלמו במקטע. השלם אותם, או בקש ממנהל לאשר סגירה עם נימוק.',
      publicDetails: {
        section: input.section,
        outstanding: outstanding.length,
      },
    })
  }

  if (input.override && input.override.reason.trim().length === 0) {
    throw new BusinessRuleError({
      code: 'plan_override_reason_required',
      message: 'A section override was requested without a stated reason',
      userMessage: 'סגירת מקטע לא שלם מחייבת נימוק כתוב.',
      publicDetails: { section: input.section },
    })
  }

  const override: SectionOverride | null =
    outstanding.length > 0 && input.override
      ? {
          supervisorUserId: input.override.supervisorUserId,
          reason: input.override.reason.trim(),
          at: input.at,
          outstanding: outstanding.map((item) => ({
            itemId: item.itemId,
            missing: item.missing,
          })),
        }
      : null

  return {
    plan: {
      ...plan,
      sections: plan.sections.map((entry) =>
        entry.key === input.section
          ? { ...entry, status: 'completed' as const, override }
          : entry,
      ),
    },
    overridden: override !== null,
    outstanding,
  }
}
