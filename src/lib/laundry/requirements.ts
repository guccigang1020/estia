/**
 * The engine.
 *
 * ── What it does, stated as narrowly as it actually is ────────────────────
 *
 * It takes the canonical preparation requirements — the ones
 * `src/lib/preparation` computed against a frozen snapshot of the
 * organization's own rules — and answers two questions preparation has no
 * opinion about:
 *
 *   1. Which of these go to a wash at all? (the item profile)
 *   2. How many, once the item's own spare and the provider's bundle size are
 *      accounted for? (addition and a division that rounds up)
 *
 * That is the whole engine. There is no third question, and in particular
 * there is no "how many towels does a party of twenty-five need" — that was
 * answered upstream, by rules a customer edits, and answering it again here
 * would put two numbers for one fact into one product.
 *
 * ── The line that must never be written here ──────────────────────────────
 *
 *     const towels = booking.guests * TOWELS_PER_GUEST
 *
 * It is one line, it passes every test that exists, and it is wrong from the
 * moment a customer edits the towel rule. `no-hardcoded-numbers.test.ts` scans
 * this directory and fails on any numeric literal that is not structural, and
 * `requirements.test.ts` asserts positively that changing the preparation
 * requirement changes the laundry requirement — because the scan alone cannot
 * tell a copied number from a derived one.
 *
 * ── Why skipped items are reported and not dropped ────────────────────────
 *
 * A manager who expects duvet covers on the list and does not see them is
 * looking at a configuration mistake — no profile row, or `laundry_managed`
 * left false. A shorter list is indistinguishable from a correct one, so every
 * requirement that did not become a laundry requirement comes back in
 * `skipped` with the reason, and the screen shows them under the list.
 */

import type { Requirement } from '../preparation/types'
import { routeFor } from './mode'
import { profileIndex, turnaroundFor } from './settings'
import type {
  ExplanationStep,
  LaundryItemProfile,
  LaundryRequirement,
  LaundryRequirementResult,
  LaundrySettings,
  SkippedRequirement,
} from './types'

export interface LaundryRequirementInput {
  settings: LaundrySettings
  profiles: readonly LaundryItemProfile[]
  /**
   * THE CANONICAL PREPARATION REQUIREMENTS. The only source of quantity in
   * this module. Produced by `computeRequirements` against a frozen snapshot;
   * passed through, never re-derived.
   */
  requirements: readonly Requirement[]
  propertyId: string
  /** ISO instant the linen must be clean by. */
  requiredBy: string
  /** Internal. Which booking caused this. Never reaches a provider. */
  bookingId: string | null
  /** Per provider, when one is known. Falls back to the settings' figure. */
  providerTurnaroundHours?: number | null
}

/**
 * Turn canonical preparation requirements into laundry requirements.
 *
 * Under `off` this returns nothing and reports every requirement as skipped
 * with no profile — which is honest, and which is why the caller must check
 * the mode rather than the emptiness of the list.
 */
export function buildLaundryRequirements(
  input: LaundryRequirementInput,
): LaundryRequirementResult {
  const {
    settings,
    profiles,
    requirements,
    propertyId,
    requiredBy,
    bookingId,
    providerTurnaroundHours = null,
  } = input

  const index = profileIndex(profiles)
  const built: LaundryRequirement[] = []
  const skipped: SkippedRequirement[] = []

  for (const requirement of requirements) {
    const profile = index.get(requirement.itemId)

    const refusal = refuse(requirement, profile, settings)
    if (refusal) {
      skipped.push(refusal)
      continue
    }

    // `refuse` returned nothing, so the profile exists and is usable. The
    // non-null assertion is avoided by re-narrowing rather than by trusting
    // the branch above.
    if (!profile) continue

    built.push(
      toLaundryRequirement({
        requirement,
        profile,
        settings,
        propertyId,
        requiredBy,
        bookingId,
        providerTurnaroundHours,
      }),
    )
  }

  return {
    mode: settings.mode,
    propertyId,
    requiredBy,
    requirements: built,
    skipped,
  }
}

// ── The filter ────────────────────────────────────────────────────────────

/**
 * Why this requirement is not going to a wash, or `null` if it is.
 *
 * Ordered from the most common reason to the rarest, because the order is what
 * a reader sees: an item with no profile at all is the ordinary case (toilet
 * paper, coffee, tables) and should not be reported as though something were
 * wrong with it.
 */
function refuse(
  requirement: Requirement,
  profile: LaundryItemProfile | undefined,
  settings: LaundrySettings,
): SkippedRequirement | null {
  const base = {
    itemId: requirement.itemId,
    label: requirement.label,
    quantity: requirement.quantity,
  }

  if (!profile) {
    return {
      ...base,
      reason: 'no_profile',
      explanation: `${requirement.label} אינו מוגדר כפריט כביסה, ולכן אינו נכלל.`,
    }
  }

  if (!profile.laundryManaged) {
    return {
      ...base,
      reason: 'not_laundry_managed',
      explanation: `${requirement.label} מוגדר כפריט שאינו נשלח לכביסה.`,
    }
  }

  if (!profile.washable) {
    return {
      ...base,
      reason: 'not_washable',
      explanation: `${requirement.label} מוגדר כפריט שאינו כביס, ולכן דורש טיפול אחר.`,
    }
  }

  // Only under a mode that actually sends things out. Under `hybrid` the
  // database already refuses a profile that is routed external and not
  // permitted out, so this catches the mode-level case: an organization on
  // `external` holding an item it will not let leave the premises.
  if (settings.mode === 'external' && !profile.externalLaundryAllowed) {
    return {
      ...base,
      reason: 'external_not_allowed',
      explanation: `${requirement.label} אינו מורשה לצאת מהנכס, והעסק מוגדר לכביסה חיצונית בלבד. יש לטפל בו בנפרד.`,
    }
  }

  return null
}

// ── The arithmetic ────────────────────────────────────────────────────────

interface BuildOne {
  requirement: Requirement
  profile: LaundryItemProfile
  settings: LaundrySettings
  propertyId: string
  requiredBy: string
  bookingId: string | null
  providerTurnaroundHours: number | null
}

function toLaundryRequirement(args: BuildOne): LaundryRequirement {
  const {
    requirement,
    profile,
    settings,
    propertyId,
    requiredBy,
    bookingId,
    providerTurnaroundHours,
  } = args

  // COPIED. Not computed, not re-derived, not adjusted.
  const preparationQuantity = requirement.quantity
  const buffer = profile.minimumBuffer
  const needed = preparationQuantity + buffer

  const bundleSize = Math.max(1, profile.bundleSize)
  const bundles = Math.ceil(needed / bundleSize)
  const quantity = bundles * bundleSize

  return {
    itemId: requirement.itemId,
    label: profile.label,
    unit: profile.unit,
    category: requirement.category,
    route: routeFor(settings.mode, profile.route),
    propertyId,
    requiredBy,
    sourceBookingId: bookingId,
    preparationQuantity,
    buffer,
    bundleSize,
    bundles,
    quantity,
    providerId: profile.defaultProviderId ?? settings.defaultProviderId,
    turnaroundHours: turnaroundFor(
      profile,
      providerTurnaroundHours,
      settings.turnaroundHours,
    ),
    explanation: explain(requirement, profile, {
      needed,
      bundles,
      bundleSize,
      quantity,
    }),
  }
}

/**
 * The chain of arithmetic, in Hebrew, from the preparation rule to the order.
 *
 * The first step reads its numbers out of the canonical requirement's own
 * `sources`, which carry what each rule computed before and after preparation's
 * buffer. That matters: a manager asking why the order says 30 when 25 guests
 * are arriving is usually looking at TWO buffers — preparation's and laundry's
 * — and a chain that shows one of them answers the wrong question.
 */
function explain(
  requirement: Requirement,
  profile: LaundryItemProfile,
  totals: {
    needed: number
    bundles: number
    bundleSize: number
    quantity: number
  },
): readonly ExplanationStep[] {
  const steps: ExplanationStep[] = []

  const base = requirement.sources.reduce((sum, source) => sum + source.base, 0)
  const buffered = requirement.sources.reduce(
    (sum, source) => sum + source.buffered,
    0,
  )

  steps.push({
    kind: 'preparation',
    text: `${base} ${requirement.label} — לפי כללי ההכנה של העסק.`,
    value: base,
  })

  if (buffered !== base) {
    steps.push({
      kind: 'preparation_buffer',
      text: `${buffered} אחרי מרווח ההכנה (${buffered - base} נוספים).`,
      value: buffered,
    })
  }

  if (profile.minimumBuffer > 0) {
    steps.push({
      kind: 'laundry_buffer',
      text: `${totals.needed} אחרי מרווח הכביסה (${profile.minimumBuffer} נוספים לפריטים שחוזרים פגומים).`,
      value: totals.needed,
    })
  }

  if (totals.bundleSize > 1) {
    steps.push({
      kind: 'bundle',
      text: `${totals.quantity} — ${totals.bundles} חבילות של ${totals.bundleSize}, מעוגל כלפי מעלה.`,
      value: totals.quantity,
    })
  }

  return steps
}

// ── Aggregation ───────────────────────────────────────────────────────────

/**
 * Several bookings' laundry requirements at one property, added up per item.
 *
 * Used by the day view and by the order builder: two arrivals on Friday at the
 * same house are one wash. The tightest `requiredBy` wins, because the linen
 * has to be back for the earlier of the two — taking the later one is the
 * mistake that produces an order which is technically on time and practically
 * useless.
 */
export function mergeRequirements(
  requirements: readonly LaundryRequirement[],
): readonly LaundryRequirement[] {
  const byItem = new Map<string, LaundryRequirement>()

  for (const requirement of requirements) {
    const key = `${requirement.propertyId} ${requirement.itemId}`
    const existing = byItem.get(key)

    if (!existing) {
      byItem.set(key, requirement)
      continue
    }

    const preparationQuantity =
      existing.preparationQuantity + requirement.preparationQuantity
    const buffer = existing.buffer + requirement.buffer
    const bundleSize = existing.bundleSize
    const bundles = Math.ceil((preparationQuantity + buffer) / bundleSize)
    const quantity = bundles * bundleSize

    byItem.set(key, {
      ...existing,
      preparationQuantity,
      buffer,
      bundles,
      quantity,
      requiredBy: earlierOf(existing.requiredBy, requirement.requiredBy),
      // A merged line comes from more than one booking, so it names none. The
      // per-booking record survives on the unmerged requirements and on the
      // order lines that were built before merging.
      sourceBookingId:
        existing.sourceBookingId === requirement.sourceBookingId
          ? existing.sourceBookingId
          : null,
      explanation: [
        ...existing.explanation,
        {
          kind: 'aggregate',
          text: `${quantity} בסך הכול — איחוד של יותר מהזמנה אחת באותו נכס.`,
          value: quantity,
        },
      ],
    })
  }

  return [...byItem.values()]
}

function earlierOf(a: string, b: string): string {
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b
}
