/**
 * EXECUTION CONTEXT — SERVER ONLY. One stay's preparation, assembled to render.
 *
 * The board at `/preparation` answers "what is happening this week". This
 * answers "what does this house need for this booking, and why" — which is the
 * screen the whole engine was written for and the one it never had.
 *
 * ── The cleaner's projection is the base, not a variant ───────────────────
 *
 * Everything on the page is built from `toCleanerView`, which is an explicit
 * field-by-field projection with no guest name and no money in it — see
 * `cleaner-view.ts` for why it is a projection rather than a filter. A manager
 * gets *more* panels beside it, gated by `can()`; nobody gets a different
 * rendering of the same plan. So the promise "a cleaner sees no guest name and
 * no price" is kept by the shape of the data rather than by the markup, and a
 * field added to `WorkPlan` next month does not ship to every cleaner in the
 * product because somebody forgot this file existed.
 *
 * ── Why the arithmetic is recomputed and that is not a contradiction ──────
 *
 * `explanationIndex` runs `computeRequirements(booking, snapshot)` again to
 * get the derivation. That is not "recomputing the plan": it is the same pure
 * function over the *stored* snapshot, so it produces the numbers already on
 * the stored plan or the plan is stale and the difference is worth seeing. The
 * snapshot is the guarantee — a plan built in March explains itself with
 * March's rules for ever, because the rules are in the row beside it.
 *
 * ── What a cleaner cannot read today, said plainly ────────────────────────
 *
 * `bookings_select` requires `booking.view`, which the cleaner preset does not
 * carry. So `loadBooking` returns `null` for them under row level security,
 * and with it go the arrival instant, the event type and the special request.
 * The plan itself still renders — `work_plans_select` is a `task` grant — so
 * the sections, the items and the counts are all there, and the page says
 * which facts are missing rather than showing a blank where a deadline goes.
 * Closing that is a policy change on `bookings`, which belongs to `authz`, and
 * it is named in this work's report rather than worked around here.
 */

import { can, type Actor } from '@/lib/authz/can'
import { EVENT_TYPE_LABEL } from '@/lib/booking/party'
import type { SupabasePreparationPorts } from '@/lib/persistence'
import {
  computeRequirements,
  explanationIndex,
  toCleanerView,
  unacknowledgedSections,
  type CleanerPlanView,
  type PlanSectionKey,
  type PreparationBooking,
  type PreparationSnapshot,
  type WorkPlan,
} from '@/lib/preparation'

/** The sentences behind one item, in the section it is shown in. */
export type ItemExplanation = {
  /** `sectionKey:itemId`. The key the component looks the item up by. */
  key: string
  sentences: readonly string[]
}

export type PlanScreen = {
  bookingId: string
  /** Null until somebody builds one. An ordinary state, not a failure. */
  view: CleanerPlanView | null
  /** The stored revision, for the optimistic lock on every write. */
  version: number | null
  /**
   * False when this reader may not read the booking row — a cleaner under row
   * level security. The plan still renders; the stay's facts do not.
   */
  bookingReadable: boolean
  /** True when a plan exists but its frozen ruleset does not. Should not happen. */
  snapshotMissing: boolean
  explanations: readonly ItemExplanation[]
  /** Sections already under way that have not seen the current version. */
  needsAcknowledgement: readonly PlanSectionKey[]
  grants: PlanGrants
}

/**
 * What this person may do here, decided before anything is rendered.
 *
 * Asked up front rather than discovered on submit: a button that leads to a
 * refusal is worse than no button, and every one of these is checked again by
 * the operation's own pipeline and again by row level security.
 */
export type PlanGrants = {
  build: boolean
  recompute: boolean
  adjust: boolean
  complete: boolean
  cancel: boolean
  acknowledge: boolean
}

export function planGrants(
  actor: Actor,
  propertyId: string | null,
  unitId: string | null,
): PlanGrants {
  const resource = {
    organizationId: actor.organizationId,
    family: 'operations' as const,
    ...(propertyId !== null ? { propertyId } : {}),
    ...(unitId !== null ? { unitId } : {}),
  }

  return {
    build: can(actor, 'task.create', resource),
    recompute: can(actor, 'task.update', resource),
    // Overruling the engine is deciding what the house needs, which is the
    // policy grant and not the doing-the-work one. See `adjustPlanItem`.
    adjust: can(actor, 'checklist.manage', resource),
    complete: can(actor, 'task.complete', resource),
    cancel: can(actor, 'task.update', resource),
    acknowledge: can(actor, 'task.update', resource),
  }
}

export type LoadPlanArgs = {
  ports: SupabasePreparationPorts
  actor: Actor
  bookingId: string
}

/**
 * Everything the screen needs, in one pass.
 *
 * The three reads are issued together because they are independent rows and a
 * screen that waits for them in sequence waits three times for no reason. What
 * is *not* parallelised is the explanation: it needs both the booking and the
 * snapshot, and asking for it before either has arrived would be asking a pure
 * function to run on undefined.
 */
export async function loadPlanScreen(args: LoadPlanArgs): Promise<PlanScreen> {
  const { ports, actor, bookingId } = args

  const [booking, plan, context] = await Promise.all([
    ports.loadBooking(bookingId),
    ports.loadPlan(bookingId),
    ports.loadPlanContext(bookingId),
  ])

  const snapshot = plan === null ? null : await ports.loadSnapshot(bookingId)

  const grants = planGrants(
    actor,
    booking?.propertyId ?? plan?.propertyId ?? null,
    booking?.unitId ?? plan?.unitId ?? null,
  )

  if (plan === null) {
    return {
      bookingId,
      view: null,
      version: null,
      bookingReadable: booking !== null,
      snapshotMissing: false,
      explanations: [],
      needsAcknowledgement: [],
      grants,
    }
  }

  const view = toCleanerView({
    plan,
    propertyLabel: context.propertyName ?? '',
    unitLabel: context.unitName ?? '',
    bookingReference: context.reference,
    // The arrival is the deadline. A business that later sets a distinct
    // ready-by time has `deadlineAt` waiting for it; until then the two are
    // the same instant and the screen says so rather than showing a blank.
    arrivalAt: booking?.arrivalAt ?? plan.createdAt,
    deadlineAt: booking?.arrivalAt ?? null,
    guestCount: booking?.guests ?? UNKNOWN_GUESTS,
    eventTypeLabel: booking ? EVENT_TYPE_LABEL[booking.eventType] : null,
    specialRequests: booking?.specialRequests ?? null,
  })

  return {
    bookingId,
    view,
    version: plan.version,
    bookingReadable: booking !== null,
    snapshotMissing: snapshot === null,
    explanations:
      booking === null || snapshot === null
        ? []
        : explanationsFor(booking, snapshot, plan),
    needsAcknowledgement: unacknowledgedSections(plan),
    grants,
  }
}

/**
 * Every item's arithmetic, keyed by the section it is worked in.
 *
 * The sources are filtered to the section rather than shown whole, because
 * the same twenty-five sheets are one line to the laundry and two jobs to the
 * cleaner — fifteen in the extra-sleeping section and ten in the bedrooms —
 * and showing both totals under both headings is how a person double-counts.
 */
function explanationsFor(
  booking: PreparationBooking,
  snapshot: PreparationSnapshot,
  plan: WorkPlan,
): readonly ItemExplanation[] {
  const { facts, requirements } = computeRequirements(booking, snapshot)
  const index = explanationIndex(requirements, facts, snapshot)

  const out: ItemExplanation[] = []

  for (const section of plan.sections) {
    for (const item of section.items) {
      const explanation = index.get(`${item.category} ${item.itemId}`)
      if (!explanation) continue

      const sentences = explanation.sources
        .filter((source) => source.section === section.key)
        .map((source) => source.sentence)

      if (sentences.length > 0) {
        out.push({ key: `${section.key}:${item.itemId}`, sentences })
      }
    }
  }

  return out
}

/**
 * The party, where the booking row is unreadable.
 *
 * Deliberately zero rather than a number inferred from the bed count: a plan
 * records what the guests need, not how many of them there are, and inferring
 * it would be this screen inventing a fact. The component renders nothing
 * rather than "0 אורחים".
 */
const UNKNOWN_GUESTS = 0
