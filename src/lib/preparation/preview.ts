/**
 * Assembling a plan, and the one function a settings screen may call.
 *
 * ── Why this file exists at all ───────────────────────────────────────────
 *
 * `operations.ts` had a private `assemble` closure: measure the booking, score
 * the complexity, build the sections. Both the first build and every
 * recomputation went through it, precisely so the two could not produce
 * structurally different plans and make the delta report phantom changes.
 *
 * A configuration screen needs the same thing for a third reason. Somebody
 * setting a policy has to see what the policy *does* before they save it, and
 * a preview computed by a second implementation is worse than no preview: it
 * agrees with the engine on the easy cases and disagrees on exactly the ones
 * worth checking. So `assemble` moved here, `operations.ts` calls it, and the
 * preview calls it too. There is one assembly.
 *
 * ── What the preview is honest about ──────────────────────────────────────
 *
 * `previewPlan` takes a catalogue and a *hypothetical* booking and returns a
 * real `WorkPlan`. It freezes a snapshot first, because that is what building
 * a plan does — skipping the freeze would let a preview read a live catalogue
 * in a way no real plan ever can, and the shape it printed would then be
 * unreachable through the product.
 *
 * What it deliberately does not do is write. No plan id is reserved, no
 * snapshot is stored, nothing is audited: `buildPlan` in `operations.ts` is
 * the only path that puts a plan in front of a cleaner, and it still refuses
 * to build a second plan for a booking that has one. A preview that quietly
 * created rows would be a write wearing a read's permission.
 */

import { estimateStaffing } from './complexity'
import { computeRequirements, templateSections } from './requirements'
import { captureSnapshot } from './snapshot'
import { buildWorkPlan } from './work-plan'
import type {
  PreparationBooking,
  PreparationCatalogue,
  PreparationFacts,
  PreparationSnapshot,
  Requirement,
  SleepingAllocation,
  StaffingEstimate,
  WorkPlan,
} from './types'

/** The first revision of a plan. A count, not a business number. */
const FIRST_VERSION = 1

export interface AssembleInput {
  booking: PreparationBooking
  /** The frozen ruleset. Never a live catalogue — see `snapshot.ts`. */
  snapshot: PreparationSnapshot
  planId: string
  version: number
  createdAt: string
}

export interface AssembledPlan {
  plan: WorkPlan
  facts: PreparationFacts
  allocation: SleepingAllocation
  requirements: readonly Requirement[]
  staffing: StaffingEstimate
}

/**
 * The pipeline, in the only order it can run in.
 *
 * Requirements before staffing because the score reads the allocation's extra
 * beds, and sections last because a section is a view over requirements that
 * already exist. `extraSections` is passed so an event template's empty
 * sections still appear — a Shabbat with nothing yet in the event-setup
 * section is a section a person has to see, not one to hide.
 */
export function assemblePlan(input: AssembleInput): AssembledPlan {
  const { booking, snapshot } = input

  const { facts, allocation, requirements } = computeRequirements(
    booking,
    snapshot,
  )

  const staffing = estimateStaffing({
    facts,
    configuration: snapshot.complexity,
    extraItems: booking.extras.length,
  })

  const plan = buildWorkPlan({
    id: input.planId,
    booking,
    snapshot,
    requirements,
    staffing,
    extraSections: templateSections(snapshot, booking.eventType),
    version: input.version,
    createdAt: input.createdAt,
  })

  return { plan, facts, allocation, requirements, staffing }
}

export interface PreviewInput {
  catalogue: PreparationCatalogue
  /** The party being tried out. Real in shape, hypothetical in existence. */
  booking: PreparationBooking
  /** Injected, so a preview of an unchanged policy is byte-identical twice. */
  capturedAt: string
  planId: string
}

export interface PreparationPreview extends AssembledPlan {
  /** What the plan was computed against, hash included. */
  snapshot: PreparationSnapshot
}

/**
 * What this configuration would produce for that party.
 *
 * The snapshot is captured rather than assumed, so the preview inherits the
 * effective dating: a rule that starts next month does not appear in a preview
 * of a stay that arrives tomorrow, which is the same answer the real plan
 * would give and the opposite of what reading the live catalogue would show.
 */
export function previewPlan(input: PreviewInput): PreparationPreview {
  const snapshot = captureSnapshot({
    catalogue: input.catalogue,
    booking: input.booking,
    capturedAt: input.capturedAt,
  })

  return {
    snapshot,
    ...assemblePlan({
      booking: input.booking,
      snapshot,
      planId: input.planId,
      version: FIRST_VERSION,
      createdAt: input.capturedAt,
    }),
  }
}
