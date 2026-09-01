/**
 * What changed, said out loud.
 *
 * A booking that grows from twenty-five guests to thirty while a cleaner is
 * already halfway through the bedrooms is the most expensive silent event in
 * this domain. The plan quietly gains five mattresses, five pillows, five
 * sheets and five towels; the person in the house is working from the old
 * numbers and has no way to know. They finish, the section shows complete, and
 * five people arrive to no bed.
 *
 * So recomputation never replaces a plan. It produces a **new version** and a
 * **delta**, the delta names every item that moved and by how much, and the
 * people already assigned to the affected sections are on the notification
 * list before anything else happens.
 *
 * ── Progress survives ─────────────────────────────────────────────────────
 *
 * `carryProgress` is not a convenience. A recomputation that reset the counts
 * would punish the worker for a change somebody else made, and the second time
 * it happened they would stop ticking items off — which removes the only
 * signal the readiness screen has.
 */

import {
  PLAN_SECTIONS,
  type PlanDelta,
  type PlanItem,
  type PlanSectionKey,
  type PlanVersion,
  type RequirementChange,
  type WorkPlan,
} from './types'

interface Totals {
  label: string
  category: RequirementChange['category']
  section: PlanSectionKey
  count: number
  sections: Set<PlanSectionKey>
}

/**
 * Totals per item across the whole plan.
 *
 * Keyed by category and item rather than by section, because moving an item
 * between sections is a reorganisation of the work and not a change to what
 * the house needs. Reporting "−15 mattresses, +15 mattresses" because the
 * section changed would bury the one line that mattered.
 */
function totalsOf(plan: WorkPlan): ReadonlyMap<string, Totals> {
  const totals = new Map<string, Totals>()

  for (const section of plan.sections) {
    for (const item of section.items) {
      const key = `${item.category} ${item.itemId}`
      const existing = totals.get(key)

      if (existing) {
        existing.count += item.requiredCount
        existing.sections.add(section.key)
        continue
      }

      totals.set(key, {
        label: item.label,
        category: item.category,
        section: section.key,
        count: item.requiredCount,
        sections: new Set([section.key]),
      })
    }
  }

  return totals
}

/** Every section key present in either version. */
function sectionKeys(
  previous: WorkPlan,
  next: WorkPlan,
): ReadonlySet<PlanSectionKey> {
  return new Set([
    ...previous.sections.map((section) => section.key),
    ...next.sections.map((section) => section.key),
  ])
}

/**
 * One section's counts, as a comparable fingerprint.
 *
 * A string rather than a total, because a section that swapped five of one
 * item for five of another has changed and its total has not.
 */
function sectionCount(plan: WorkPlan, key: PlanSectionKey): string {
  const section = plan.sections.find((entry) => entry.key === key)
  if (!section) return ''

  return section.items
    .map((item) => `${item.category}:${item.itemId}=${item.requiredCount}`)
    .sort()
    .join('|')
}

export function computeDelta(previous: WorkPlan, next: WorkPlan): PlanDelta {
  const before = totalsOf(previous)
  const after = totalsOf(next)

  const keys = [...new Set([...before.keys(), ...after.keys()])].sort()

  const added: RequirementChange[] = []
  const removed: RequirementChange[] = []
  const affected = new Set<PlanSectionKey>()
  let unchanged = 0

  for (const key of keys) {
    const from = before.get(key)
    const to = after.get(key)
    const fromCount = from?.count ?? 0
    const toCount = to?.count ?? 0

    if (fromCount === toCount) {
      unchanged += 1
      continue
    }

    const meta = to ?? from
    if (!meta) continue

    const change: RequirementChange = {
      itemId: key.slice(key.indexOf(' ') + 1),
      label: meta.label,
      category: meta.category,
      section: meta.section,
      from: fromCount,
      to: toCount,
      delta: toCount - fromCount,
    }

    if (change.delta > 0) added.push(change)
    else removed.push(change)
  }

  // Which sections actually changed is a *per-section* question, not an
  // item-level one. Twenty-five pillows become thirty by adding five floor
  // mattresses; the ten pillows on the five permanent beds are untouched, and
  // telling the person making those beds that pillows changed is the noise
  // that teaches a team to ignore the notification. So the sections are
  // compared on their own counts, even though the reported change stays at
  // item level — which is what the laundry order and the sentence need.
  for (const key of sectionKeys(previous, next)) {
    if (sectionCount(previous, key) !== sectionCount(next, key)) {
      affected.add(key)
    }
  }

  const affectedSections = PLAN_SECTIONS.filter((key) => affected.has(key))

  // Only people already working the affected sections. Telling the whole team
  // about every change is how a team learns to ignore the notification.
  const notifyUserIds = [
    ...new Set(
      previous.sections
        .filter((section) => affected.has(section.key))
        .map((section) => section.assignedToUserId)
        .filter((userId): userId is string => userId !== null),
    ),
  ]

  return {
    fromVersion: previous.version,
    toVersion: next.version,
    added,
    removed,
    unchanged,
    affectedSections,
    notifyUserIds,
  }
}

/**
 * The delta as a sentence a person reads.
 *
 * "+5 מזרנים, +5 כריות, −2 מגבות" — signed, so the direction is visible
 * without reading the words. Used verbatim in the audit summary, which is why
 * it lives beside the calculation rather than in the interface: two renderings
 * of the same change would eventually disagree.
 */
export function describeDelta(delta: PlanDelta): string {
  const parts = [
    ...delta.added.map((change) => `+${change.delta} ${change.label}`),
    ...delta.removed.map(
      (change) => `−${Math.abs(change.delta)} ${change.label}`,
    ),
  ]

  return parts.length === 0 ? 'ללא שינוי בכמויות' : parts.join(', ')
}

/**
 * Carry a worker's progress onto the recomputed plan.
 *
 * Counts are clamped to the new requirement: a section that shrank from
 * fifteen to ten with twelve already done is ten of ten, not twelve of ten.
 * A section previously marked complete drops back to `in_progress` when its
 * requirement grew — it is, in plain fact, no longer complete.
 *
 * ── Three things survive a recomputation, and each for its own reason ─────
 *
 * **Progress**, because resetting it would punish the worker for a change
 * somebody else made. **A manual adjustment**, because a supervisor who said
 * "the fifteenth mattress is not in the building" is still right after the
 * booking grows by one guest, and silently reinstating the engine's figure
 * would undo a decision nobody was told had been undone. **The
 * acknowledgement**, deliberately *not* advanced: it keeps the version it was
 * given, so a plan that has just moved to a newer version raises the notice
 * again for every section already under way. That last one is the mechanism —
 * carrying it forward would make every change silent, which is the failure
 * this whole module was written against.
 */
export function carryProgress(previous: WorkPlan, next: WorkPlan): WorkPlan {
  const done = new Map<
    string,
    {
      completedCount: number
      photoIds: readonly string[]
      adjustment: PlanItem['adjustment']
    }
  >()

  for (const section of previous.sections) {
    for (const item of section.items) {
      done.set(`${section.key} ${item.category} ${item.itemId}`, {
        completedCount: item.completedCount,
        photoIds: item.photoIds,
        adjustment: item.adjustment ?? null,
      })
    }
  }

  const previousSections = new Map(
    previous.sections.map((section) => [section.key, section]),
  )

  return {
    ...next,
    sections: next.sections.map((section) => {
      const before = previousSections.get(section.key)

      const items = section.items.map((item) => {
        const carried = done.get(
          `${section.key} ${item.category} ${item.itemId}`,
        )
        if (!carried) return item
        return {
          ...item,
          completedCount: Math.min(item.requiredCount, carried.completedCount),
          photoIds: carried.photoIds,
          adjustment: carried.adjustment,
        }
      })

      const finished = items.every(
        (item) => item.completedCount >= item.requiredCount,
      )
      const started = items.some((item) => item.completedCount > 0)

      const status =
        before?.status === 'completed' && finished
          ? ('completed' as const)
          : started
            ? ('in_progress' as const)
            : ('new' as const)

      return {
        ...section,
        items,
        status,
        assignedToUserId: before?.assignedToUserId ?? null,
        override: before?.status === 'completed' ? before.override : null,
        // Kept at the version it was given rather than advanced. See above.
        acknowledgedVersion: before?.acknowledgedVersion ?? null,
      }
    }),
  }
}

export interface VersionInput {
  previous: WorkPlan
  /** The freshly built plan, at the previous version number. */
  rebuilt: WorkPlan
  changedByUserId: string
  changedAt: string
  reason?: string | null
}

/**
 * Turn a rebuilt plan into the next version of the old one.
 *
 * The version number is assigned here and nowhere else, so a plan cannot
 * acquire a version without acquiring a delta at the same time. That is the
 * mechanical form of "changes are never silent".
 */
export function versionPlan(input: VersionInput): PlanVersion {
  const carried = carryProgress(input.previous, input.rebuilt)
  const next: WorkPlan = { ...carried, version: input.previous.version + 1 }

  return {
    plan: next,
    delta: computeDelta(input.previous, next),
    supersedesVersion: input.previous.version,
    changedByUserId: input.changedByUserId,
    changedAt: input.changedAt,
    reason: input.reason ?? null,
  }
}
