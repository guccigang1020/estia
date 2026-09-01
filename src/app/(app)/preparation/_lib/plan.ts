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
 * ── What a cleaner reads, and what they still cannot ──────────────────────
 *
 * `bookings_select` requires `booking.view` and the cleaner preset does not
 * carry it, so this file never asks for the booking on their behalf. It does
 * not need to: `0036_work_plan_facts.sql` put the arrival instant, the event
 * type, the party and the guest's own request onto `work_plans`, whose select
 * policy asks for `task.view` — the grant they hold. The alternative was to
 * widen `booking.view`, which would have handed housekeeping the guest, the
 * total and the source in order to let them read one sentence about a cot.
 *
 * What is still behind `booking.view` is the *arithmetic*: recovering how a
 * quantity was derived needs the extras and the stay, which the plan does not
 * store. A cleaner gets every number and no algebra, which is the right way
 * round.
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
   * Whether this plan carries the stay's own facts — the arrival, the party,
   * the request. False only for a plan stored before `0036_work_plan_facts`,
   * which cannot be back-filled without the booking read the column exists to
   * remove. The screen says so rather than rendering a blank deadline.
   */
  factsAvailable: boolean
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
 * Everything the screen needs, and for a cleaner not one row more.
 *
 * ── The booking is read only by somebody entitled to read bookings ────────
 *
 * `can(actor, 'booking.view')` decides whether `loadBooking` is called at all.
 * Leaving the call in and letting row level security return nothing would look
 * equivalent and is not: it issues a query on the caller's behalf that they
 * have no business issuing, it costs a round trip on the screen a cleaner
 * opens most often, and the day `bookings_select` raises instead of returning
 * empty, their morning disappears behind an error about a table they never
 * asked for. The permission decides here, in the open.
 *
 * The facts they need instead come off the plan — see `PlanFacts` and
 * `0036_work_plan_facts.sql`. `work_plans_select` asks for `task.view`, which
 * is exactly what they hold.
 *
 * ── What the booking is still needed for ──────────────────────────────────
 *
 * The arithmetic, and only that. `explanationIndex` runs
 * `computeRequirements(booking, snapshot)` to recover each quantity's
 * derivation, which needs the extras and the stay the plan does not store. A
 * cleaner is given the counts and not the algebra; a manager arguing with a
 * number gets both. That is a real difference in what the two see and it is
 * the right way round — the derivation is a management question, and every
 * fact a person needs in order to do the work is on the plan.
 */
export async function loadPlanScreen(args: LoadPlanArgs): Promise<PlanScreen> {
  const { ports, actor, bookingId } = args

  const mayReadBooking = can(actor, 'booking.view', {
    organizationId: actor.organizationId,
  })

  const [plan, booking] = await Promise.all([
    ports.loadPlan(bookingId),
    mayReadBooking ? ports.loadBooking(bookingId) : Promise.resolve(null),
  ])

  const grants = planGrants(
    actor,
    plan?.propertyId ?? booking?.propertyId ?? null,
    plan?.unitId ?? booking?.unitId ?? null,
  )

  if (plan === null) {
    return {
      bookingId,
      view: null,
      version: null,
      factsAvailable: false,
      snapshotMissing: false,
      explanations: [],
      needsAcknowledgement: [],
      grants,
    }
  }

  const [names, reference, snapshot] = await Promise.all([
    ports.loadPlaceNames(plan.propertyId, plan.unitId),
    mayReadBooking
      ? ports.loadBookingReference(bookingId)
      : Promise.resolve(null),
    ports.loadSnapshot(bookingId),
  ])

  // The plan's own frozen facts first, always. The booking is the fallback for
  // a plan stored before 0036, and it is only ever present for a reader who
  // was entitled to it anyway.
  const facts = plan.facts
  const arrivalAt = facts?.arrivalAt ?? booking?.arrivalAt ?? null
  const eventType = facts?.eventType ?? booking?.eventType ?? null

  const view = toCleanerView({
    plan,
    propertyLabel: names.propertyName ?? '',
    unitLabel: names.unitName ?? '',
    bookingReference: reference,
    // The arrival is the deadline. A business that later sets a distinct
    // ready-by time has `deadlineAt` waiting for it; until then the two are
    // the same instant and the screen says so rather than showing a blank.
    arrivalAt: arrivalAt ?? plan.createdAt,
    deadlineAt: arrivalAt,
    guestCount: facts?.guests ?? booking?.guests ?? UNKNOWN_GUESTS,
    eventTypeLabel: eventType === null ? null : EVENT_TYPE_LABEL[eventType],
    specialRequests: facts?.specialRequests ?? booking?.specialRequests ?? null,
  })

  return {
    bookingId,
    view,
    version: plan.version,
    factsAvailable: arrivalAt !== null,
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
