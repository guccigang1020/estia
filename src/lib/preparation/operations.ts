/**
 * The five things a person can actually do to a preparation plan.
 *
 * Every one of them goes through `defineOperation`, which means none of them
 * can reach a write without having passed authorization twice, validation,
 * optimistic locking and the audit event. That is not a style choice — the
 * pipeline is built so the sequence cannot be reordered or skipped, and a
 * module that wrote plans directly would be a module that had quietly opted
 * out of all of it.
 *
 * ── Data access is injected ───────────────────────────────────────────────
 *
 * `PreparationPorts` is the whole surface this module has on the outside
 * world. Nothing in this directory imports a database client, and the domain
 * functions the operations call are pure: given the same booking and the same
 * snapshot they return the same plan, on any machine, in any order. That is
 * what makes the twelve hundred lines above testable without a Supabase
 * project, and it is why the tests run in CI with no secrets.
 *
 * ── The audit sentences ───────────────────────────────────────────────────
 *
 * Hebrew, and specific. "תוכנית ההכנה עודכנה" is the sentence the charter
 * forbids; "מיכל עדכנה את תוכנית ההכנה מגרסה 1 לגרסה 2: +5 מזרנים, +5 כריות"
 * is the one a manager can act on three weeks later. The delta renderer lives
 * in `delta.ts` beside the calculation, so the sentence and the numbers cannot
 * drift apart.
 */

import { BusinessRuleError, NotFoundError } from '../errors'
import { acknowledgeSection, adjustItem } from './adjustment'
import {
  defineOperation,
  s,
  type Operation,
  type TransactionHandle,
} from '../service'
import type { Resource } from '../authz/can'
import type { DomainEventName } from '../contracts/events'
import { formatAgorot } from '../plans/plan'
import { estimateStaffing } from './complexity'
import { computeEventPnL, type FixedAllocationInput } from './costing'
import { describeDelta, versionPlan } from './delta'
import { checkInventory } from './inventory'
import { assemblePlan } from './preview'
import { computeRequirements } from './requirements'
import { captureSnapshot } from './snapshot'
import { completeSection, outstandingItems } from './work-plan'
import {
  PLAN_SECTIONS,
  type EventPnL,
  type InventoryCheck,
  type PlanDelta,
  type PlanSectionKey,
  type PreparationBooking,
  type PreparationCatalogue,
  type PreparationSnapshot,
  type StockLevel,
  type WorkPlan,
} from './types'

// ── Ports ─────────────────────────────────────────────────────────────────

/**
 * Everything this module needs from the database, and nothing more.
 *
 * Note what is absent: there is no `loadCatalogue(bookingId)`. The catalogue
 * is reachable only for a *new* plan, and every other path takes the stored
 * snapshot. The port list is where the no-historical-drift rule is enforced
 * structurally rather than remembered.
 */
export interface PreparationPorts {
  loadBooking(bookingId: string): Promise<PreparationBooking | null>
  loadCatalogue(
    organizationId: string,
    propertyId: string,
  ): Promise<PreparationCatalogue | null>
  loadSnapshot(bookingId: string): Promise<PreparationSnapshot | null>
  loadPlan(bookingId: string): Promise<WorkPlan | null>
  loadStock(propertyId: string): Promise<readonly StockLevel[]>
  loadTransferrableStock?(
    organizationId: string,
    excludingPropertyId: string,
  ): Promise<readonly StockLevel[]>
  loadAllocationContexts(
    propertyId: string,
    on: string,
  ): Promise<FixedAllocationInput['contexts']>
  savePlan(plan: WorkPlan, tx: TransactionHandle): Promise<void>
  saveSnapshot(
    bookingId: string,
    snapshot: PreparationSnapshot,
    tx: TransactionHandle,
  ): Promise<void>
  /** Ids for freshly built plans, injected so a plan id is deterministic in tests. */
  nextPlanId(bookingId: string): string
}

interface BookingEntity {
  booking: PreparationBooking
  plan: WorkPlan | null
  snapshot: PreparationSnapshot | null
}

/**
 * An event draft, narrowed to the frozen catalogue.
 *
 * The service pipeline's own draft type accepts any `something.something`
 * string, which is right for a generic pipeline and wrong here: an event name
 * this module invents is an event nothing subscribes to, and the failure is
 * silent. Naming `DomainEventName` from `src/lib/contracts/events.ts` turns a
 * typo — or a well-meant `preparation.plan.built` — into a compile error.
 */
interface PreparationEventDraft {
  name: DomainEventName
  propertyId?: string | null
  payload: unknown
}

function resourceFor(booking: PreparationBooking): Resource {
  return {
    organizationId: booking.organizationId,
    propertyId: booking.propertyId,
    unitId: booking.unitId,
  }
}

const FIRST_VERSION = 1

// ── Results ───────────────────────────────────────────────────────────────

export interface BuildPlanResult {
  plan: WorkPlan
  snapshot: PreparationSnapshot
  inventory: InventoryCheck
}

export interface RecomputeResult {
  plan: WorkPlan
  delta: PlanDelta
  inventory: InventoryCheck
}

export interface SectionResult {
  plan: WorkPlan
  section: PlanSectionKey
  overridden: boolean
  outstanding: number
}

export interface AdjustItemInput {
  bookingId: string
  section: PlanSectionKey
  itemId: string
  /** What the person says the house actually needs. */
  finalCount: number
}

/** The three numbers, kept apart. Never collapsed into the one that is final. */
export interface AdjustmentResult {
  plan: WorkPlan
  section: PlanSectionKey
  itemId: string
  label: string
  /** What the rules produced, and what stays on the item. */
  calculated: number
  /** Signed. What the person moved it by. */
  adjustment: number
  /** Their sum, and what the cleaner works to. */
  final: number
}

export interface CancellationResult {
  plan: WorkPlan
  /** Work that was still outstanding and has been stopped. */
  cancelledSections: readonly PlanSectionKey[]
  /** Work that was already done and is kept as history. */
  keptSections: readonly PlanSectionKey[]
}

// ── The operations ────────────────────────────────────────────────────────

export interface PreparationOperations {
  buildPlan: Operation<{ bookingId: string }, BookingEntity, BuildPlanResult>
  recomputePlan: Operation<
    { bookingId: string },
    BookingEntity,
    RecomputeResult
  >
  completePlanSection: Operation<
    { bookingId: string; section: PlanSectionKey },
    BookingEntity,
    SectionResult
  >
  overridePlanSection: Operation<
    { bookingId: string; section: PlanSectionKey },
    BookingEntity,
    SectionResult
  >
  adjustPlanItem: Operation<AdjustItemInput, BookingEntity, AdjustmentResult>
  acknowledgePlanSection: Operation<
    { bookingId: string; section: PlanSectionKey },
    BookingEntity,
    SectionResult
  >
  cancelPlan: Operation<
    { bookingId: string },
    BookingEntity,
    CancellationResult
  >
  calculateEventProfit: Operation<
    { bookingId: string },
    BookingEntity,
    EventPnL
  >
}

export function createPreparationOperations(
  ports: PreparationPorts,
): PreparationOperations {
  const loadBookingEntity = async (bookingId: string) => {
    const booking = await ports.loadBooking(bookingId)
    if (!booking) return null

    const [plan, snapshot] = await Promise.all([
      ports.loadPlan(bookingId),
      ports.loadSnapshot(bookingId),
    ])

    return {
      resource: resourceFor(booking),
      entity: { booking, plan, snapshot },
      version: plan?.version,
    }
  }

  /**
   * The same load, but the *plan* is the resource.
   *
   * Used by every operation that edits an existing plan. Returning `null` when
   * there is no plan is not a convenience: the pipeline checks the expected
   * version immediately after the load and before the business rule, so an
   * operation that loaded a booking-with-no-plan and left the version
   * undefined would refuse the caller with "somebody else changed this
   * record" — which is both untrue and unactionable. Failing the load says
   * what is actually wrong: there is no plan here yet.
   */
  const loadPlanEntity = async (bookingId: string) => {
    const loaded = await loadBookingEntity(bookingId)
    if (!loaded || !loaded.entity.plan) return null
    return loaded
  }

  const inventoryFor = async (
    booking: PreparationBooking,
    requirements: Parameters<typeof checkInventory>[0]['requirements'],
  ): Promise<InventoryCheck> => {
    const [stock, elsewhere] = await Promise.all([
      ports.loadStock(booking.propertyId),
      ports.loadTransferrableStock?.(
        booking.organizationId,
        booking.propertyId,
      ) ?? Promise.resolve([]),
    ])

    return checkInventory({
      requirements,
      stock,
      elsewhere,
      destination: { kind: 'property', propertyId: booking.propertyId },
      neededBy: booking.stay.checkIn,
    })
  }

  /**
   * Build the plan from the snapshot, whichever snapshot that is.
   *
   * Used by both the first build and every recomputation — and, through
   * `previewPlan`, by the configuration screen — so none of the three can
   * produce a structurally different plan and make the delta report phantom
   * changes. The assembly itself lives in `preview.ts`; this closure only
   * spells the arguments out.
   */
  const assemble = (
    booking: PreparationBooking,
    snapshot: PreparationSnapshot,
    planId: string,
    version: number,
    createdAt: string,
  ) => assemblePlan({ booking, snapshot, planId, version, createdAt })

  const buildPlan = defineOperation<
    { bookingId: string },
    BookingEntity,
    BuildPlanResult
  >({
    name: 'preparation.plan.build',
    permission: 'task.create',
    resourceType: 'preparation_plan',
    input: s.object({ bookingId: s.uuid({ label: 'הזמנה' }) }),
    loadResource: ({ input }) => loadBookingEntity(input.bookingId),

    // A second plan would leave two versions of the truth on the board and a
    // cleaner working whichever one they opened first.
    rule: ({ entity }) => {
      if (entity.plan) {
        throw new BusinessRuleError({
          code: 'preparation_plan_exists',
          message: `Booking ${entity.booking.id} already has a preparation plan`,
          userMessage:
            'כבר קיימת תוכנית הכנה להזמנה הזו. עדכן אותה במקום ליצור חדשה.',
        })
      }
    },

    execute: async ({ entity, now, tx }) => {
      const catalogue = await ports.loadCatalogue(
        entity.booking.organizationId,
        entity.booking.propertyId,
      )
      if (!catalogue) {
        throw new NotFoundError(
          'preparation_catalogue',
          entity.booking.propertyId,
        )
      }

      // The snapshot is taken here and never again. Everything downstream —
      // this plan, its recomputations, its profit statement — reads it.
      const snapshot = captureSnapshot({
        catalogue,
        booking: entity.booking,
        capturedAt: now.toISOString(),
      })

      const { plan, requirements } = assemble(
        entity.booking,
        snapshot,
        ports.nextPlanId(entity.booking.id),
        FIRST_VERSION,
        now.toISOString(),
      )

      const inventory = await inventoryFor(entity.booking, requirements)

      await ports.saveSnapshot(entity.booking.id, snapshot, tx)
      await ports.savePlan(plan, tx)

      return { plan, snapshot, inventory }
    },

    audit: ({ result, entity }) => ({
      resourceId: result.plan.id,
      propertyId: entity.booking.propertyId,
      summary: `נבנתה תוכנית הכנה ל-${entity.booking.guests} אורחים ב${result.snapshot.propertyConfiguration.label}: ${countedSections(result.plan)}. ${shortageSentence(result.inventory)}`,
      after: {
        version: result.plan.version,
        snapshotHash: result.plan.snapshotHash,
        criticalPathMinutes: result.plan.criticalPathMinutes,
      },
    }),

    events: ({ result, entity }): readonly PreparationEventDraft[] =>
      shortageEvents(result.inventory, entity).concat([
        {
          name: 'preparation.calculated',
          propertyId: entity.booking.propertyId,
          payload: {
            planId: result.plan.id,
            bookingId: result.plan.bookingId,
            version: result.plan.version,
            snapshotHash: result.plan.snapshotHash,
          },
        },
      ]),
  })

  const recomputePlan = defineOperation<
    { bookingId: string },
    BookingEntity,
    RecomputeResult
  >({
    name: 'preparation.plan.recompute',
    permission: 'task.update',
    resourceType: 'preparation_plan',
    requiresVersion: true,
    input: s.object({ bookingId: s.uuid({ label: 'הזמנה' }) }),
    loadResource: ({ input }) => loadPlanEntity(input.bookingId),

    rule: ({ entity }) => {
      if (!entity.plan || !entity.snapshot) {
        throw new BusinessRuleError({
          code: 'preparation_plan_missing',
          message: `Booking ${entity.booking.id} has no plan to recompute`,
          userMessage: 'אין תוכנית הכנה להזמנה הזו. יש לבנות אותה תחילה.',
        })
      }
    },

    execute: async ({ entity, context, now, tx }) => {
      const previous = entity.plan as WorkPlan
      const snapshot = entity.snapshot as PreparationSnapshot

      // The stored snapshot, deliberately. Recomputing against today's
      // catalogue is the historical-drift bug wearing a helpful face.
      const { plan: rebuilt, requirements } = assemble(
        entity.booking,
        snapshot,
        previous.id,
        previous.version,
        now.toISOString(),
      )

      const versioned = versionPlan({
        previous,
        rebuilt,
        changedByUserId: context.actor.userId,
        changedAt: now.toISOString(),
        reason: context.reason ?? null,
      })

      const inventory = await inventoryFor(entity.booking, requirements)

      await ports.savePlan(versioned.plan, tx)

      return { plan: versioned.plan, delta: versioned.delta, inventory }
    },

    audit: ({ result, entity }) => ({
      resourceId: result.plan.id,
      propertyId: entity.booking.propertyId,
      summary: `תוכנית ההכנה עודכנה מגרסה ${result.delta.fromVersion} לגרסה ${result.delta.toVersion}: ${describeDelta(result.delta)}`,
      before: { version: result.delta.fromVersion },
      after: { version: result.delta.toVersion },
    }),

    events: ({ result, entity }): readonly PreparationEventDraft[] =>
      shortageEvents(result.inventory, entity).concat([
        {
          name: 'preparation.changed',
          propertyId: entity.booking.propertyId,
          payload: {
            planId: result.plan.id,
            delta: result.delta,
            notifyUserIds: result.delta.notifyUserIds,
          },
        },
      ]),
  })

  const sectionInput = s.object({
    bookingId: s.uuid({ label: 'הזמנה' }),
    section: s.enumOf(PLAN_SECTIONS, { label: 'מקטע' }),
  })

  const completePlanSection = defineOperation<
    { bookingId: string; section: PlanSectionKey },
    BookingEntity,
    SectionResult
  >({
    name: 'preparation.section.complete',
    permission: 'task.complete',
    resourceType: 'preparation_plan',
    input: sectionInput,
    loadResource: ({ input }) => loadPlanEntity(input.bookingId),

    rule: ({ entity }) => assertPlan(entity),

    execute: async ({ entity, input, now, tx }) => {
      const outcome = completeSection(entity.plan as WorkPlan, {
        section: input.section,
        at: now.toISOString(),
      })
      await ports.savePlan(outcome.plan, tx)

      return {
        plan: outcome.plan,
        section: input.section,
        overridden: false,
        outstanding: 0,
      }
    },

    audit: ({ result, entity }) => ({
      resourceId: result.plan.id,
      propertyId: entity.booking.propertyId,
      summary: `המקטע "${sectionLabel(result.plan, result.section)}" סומן כהושלם במלואו`,
      after: { section: result.section, status: 'completed' },
    }),

    events: ({ result, entity }): readonly PreparationEventDraft[] => [
      {
        name: 'task.completed',
        propertyId: entity.booking.propertyId,
        payload: {
          planId: result.plan.id,
          section: result.section,
          overridden: false,
        },
      },
    ],
  })

  /**
   * Closing a section that is not finished.
   *
   * A separate operation from completing one, with a separate permission and a
   * mandatory reason. Making it a flag on the ordinary completion would mean
   * anyone who can tick a box can also decide the box did not need ticking.
   */
  const overridePlanSection = defineOperation<
    { bookingId: string; section: PlanSectionKey },
    BookingEntity,
    SectionResult
  >({
    name: 'preparation.section.override',
    permission: 'task.verify',
    resourceType: 'preparation_plan',
    requiresReason: true,
    input: sectionInput,
    loadResource: ({ input }) => loadPlanEntity(input.bookingId),

    rule: ({ entity }) => assertPlan(entity),

    execute: async ({ entity, input, context, now, tx }) => {
      const outcome = completeSection(entity.plan as WorkPlan, {
        section: input.section,
        at: now.toISOString(),
        override: {
          supervisorUserId: context.actor.userId,
          reason: context.reason ?? '',
        },
      })
      await ports.savePlan(outcome.plan, tx)

      return {
        plan: outcome.plan,
        section: input.section,
        overridden: outcome.overridden,
        outstanding: outcome.outstanding.reduce(
          (total, item) => total + item.missing,
          0,
        ),
      }
    },

    audit: ({ result, entity, context }) => ({
      resourceId: result.plan.id,
      propertyId: entity.booking.propertyId,
      reason: context.reason ?? null,
      summary: `${context.auditActor.label} אישרה סגירת המקטע "${sectionLabel(result.plan, result.section)}" עם ${result.outstanding} פריטים חסרים`,
      after: { section: result.section, outstanding: result.outstanding },
    }),

    // `task.verified` is the frozen name for a supervisor signing work off.
    // An override is exactly that, with the outstanding count attached so a
    // subscriber can tell a clean sign-off from an accepted shortfall.
    events: ({ result, entity }): readonly PreparationEventDraft[] => [
      {
        name: 'task.verified',
        propertyId: entity.booking.propertyId,
        payload: {
          planId: result.plan.id,
          section: result.section,
          outstanding: result.outstanding,
          overridden: result.overridden,
        },
      },
    ],
  })

  /**
   * Changing a computed quantity by hand.
   *
   * `checklist.manage` and not `task.update`, deliberately. Ticking an item
   * off is saying what happened; overruling the engine is saying what the
   * house needs, and the person who decides the second is the person who
   * writes the policy. A reason is mandatory, and the calculated figure is
   * kept beside the change rather than replaced — see `adjustment.ts`.
   *
   * The revision advances, which is the point rather than bookkeeping: an
   * adjustment changes what a worker is being asked for, so every started
   * section goes back to needing an acknowledgement exactly as a recomputation
   * does. `work_plan_versions` then holds both figures, so "who changed the
   * towel count and what did they say" is answerable three weeks later.
   */
  const adjustPlanItem = defineOperation<
    AdjustItemInput,
    BookingEntity,
    AdjustmentResult
  >({
    name: 'preparation.item.adjust',
    permission: 'checklist.manage',
    resourceType: 'preparation_plan',
    requiresVersion: true,
    requiresReason: true,
    input: s.object({
      bookingId: s.uuid({ label: 'הזמנה' }),
      section: s.enumOf(PLAN_SECTIONS, { label: 'מקטע' }),
      itemId: s.string({ label: 'פריט', min: 1 }),
      finalCount: s.number({ label: 'כמות', min: 0, integer: true }),
    }),
    loadResource: ({ input }) => loadPlanEntity(input.bookingId),

    rule: ({ entity }) => assertPlan(entity),

    execute: async ({ entity, input, context, now, tx }) => {
      const previous = entity.plan as WorkPlan

      const adjusted = adjustItem(previous, {
        section: input.section,
        itemId: input.itemId,
        finalCount: input.finalCount,
        // The pipeline has already refused a missing reason — `requiresReason`
        // — so this fallback is unreachable and is here for the type rather
        // than as a second policy.
        reason: context.reason ?? '',
        byUserId: context.actor.userId,
        at: now.toISOString(),
      })

      const plan: WorkPlan = { ...adjusted, version: previous.version + 1 }
      await ports.savePlan(plan, tx)

      const item = plan.sections
        .find((section) => section.key === input.section)
        ?.items.find((candidate) => candidate.itemId === input.itemId)

      return {
        plan,
        section: input.section,
        itemId: input.itemId,
        label: item?.label ?? input.itemId,
        calculated: item?.requiredCount ?? input.finalCount,
        adjustment: item?.adjustment?.delta ?? 0,
        final: input.finalCount,
      }
    },

    audit: ({ result, entity, context }) => ({
      resourceId: result.plan.id,
      propertyId: entity.booking.propertyId,
      reason: context.reason ?? null,
      summary: `${context.auditActor.label} שינתה את "${result.label}" מ-${result.calculated} שחושבו ל-${result.final} בפועל (${signed(result.adjustment)}): ${context.reason ?? ''}`,
      before: { calculated: result.calculated },
      after: { final: result.final, adjustment: result.adjustment },
    }),

    events: ({ result, entity }): readonly PreparationEventDraft[] => [
      {
        name: 'preparation.changed',
        propertyId: entity.booking.propertyId,
        payload: {
          planId: result.plan.id,
          bookingId: entity.booking.id,
          version: result.plan.version,
          adjustment: {
            section: result.section,
            itemId: result.itemId,
            calculated: result.calculated,
            adjustment: result.adjustment,
            final: result.final,
          },
          notifyUserIds: assigneesOf(result.plan, result.section),
        },
      },
    ],
  })

  /**
   * "I have seen that the booking changed."
   *
   * Deliberately the weakest permission of the five: the person who has to
   * acknowledge a change is the person already doing the work, and a product
   * that made them find a supervisor to dismiss a banner is a product where
   * the banner gets ignored instead.
   *
   * The revision does **not** advance. Acknowledging is not a new version of
   * what the house needs — `tg_work_plans_record_version` writes
   * `on conflict (plan_id, version) do nothing`, so re-saving at the same
   * revision records nothing and is safe to repeat.
   */
  const acknowledgePlanSection = defineOperation<
    { bookingId: string; section: PlanSectionKey },
    BookingEntity,
    SectionResult
  >({
    name: 'preparation.section.acknowledge',
    permission: 'task.update',
    resourceType: 'preparation_plan',
    input: sectionInput,
    loadResource: ({ input }) => loadPlanEntity(input.bookingId),

    rule: ({ entity }) => assertPlan(entity),

    execute: async ({ entity, input, tx }) => {
      const plan = acknowledgeSection(entity.plan as WorkPlan, input.section)
      await ports.savePlan(plan, tx)

      return {
        plan,
        section: input.section,
        overridden: false,
        outstanding: outstandingOf(plan, input.section),
      }
    },

    audit: ({ result, entity, context }) => ({
      resourceId: result.plan.id,
      propertyId: entity.booking.propertyId,
      summary: `${context.auditActor.label} אישרה שראתה את השינוי במקטע "${sectionLabel(result.plan, result.section)}" בגרסה ${result.plan.version}`,
      after: {
        section: result.section,
        acknowledgedVersion: result.plan.version,
      },
    }),
  })

  /**
   * The stay is off. Stop the work that is left and keep the work that was done.
   *
   * ── What this deliberately does not do ────────────────────────────────────
   *
   * It does not touch `public.tasks`, and it does not call the laundry, the
   * stock or the payment module. Those are other people's tables and other
   * people's rules — whether a linen order already sent to a provider can be
   * recalled is not a question this file is entitled to answer. What it does
   * is raise `preparation.changed` with the cancellation on it, which is the
   * seam those modules subscribe to.
   *
   * ── History is preserved rather than deleted ──────────────────────────────
   *
   * Completed sections stay completed. A house that was cleaned was cleaned,
   * the hours were worked and somebody is owed for them, and rewriting that to
   * `cancelled` because the guest pulled out on the Thursday is the product
   * lying about labour that happened. Only work still outstanding is stopped.
   */
  const cancelPlan = defineOperation<
    { bookingId: string },
    BookingEntity,
    CancellationResult
  >({
    name: 'preparation.plan.cancel',
    permission: 'task.update',
    resourceType: 'preparation_plan',
    requiresVersion: true,
    requiresReason: true,
    input: s.object({ bookingId: s.uuid({ label: 'הזמנה' }) }),
    loadResource: ({ input }) => loadPlanEntity(input.bookingId),

    rule: ({ entity }) => assertPlan(entity),

    execute: async ({ entity, tx }) => {
      const previous = entity.plan as WorkPlan
      const stopped: PlanSectionKey[] = []
      const kept: PlanSectionKey[] = []

      const sections = previous.sections.map((section) => {
        if (section.status === 'completed' || section.status === 'cancelled') {
          if (section.status === 'completed') kept.push(section.key)
          return section
        }
        stopped.push(section.key)
        return { ...section, status: 'cancelled' as const }
      })

      const plan: WorkPlan = {
        ...previous,
        sections,
        version: previous.version + 1,
      }
      await ports.savePlan(plan, tx)

      return { plan, cancelledSections: stopped, keptSections: kept }
    },

    audit: ({ result, entity, context }) => ({
      resourceId: result.plan.id,
      propertyId: entity.booking.propertyId,
      reason: context.reason ?? null,
      summary: `ההזמנה בוטלה, ולכן ${result.cancelledSections.length} מקטעי הכנה נסגרו כמבוטלים ו-${result.keptSections.length} מקטעים שכבר הושלמו נשמרו כהיסטוריה: ${context.reason ?? ''}`,
      before: { version: result.plan.version - 1 },
      after: {
        version: result.plan.version,
        cancelled: result.cancelledSections,
      },
    }),

    events: ({ result, entity }): readonly PreparationEventDraft[] => [
      {
        name: 'preparation.changed',
        propertyId: entity.booking.propertyId,
        payload: {
          planId: result.plan.id,
          bookingId: entity.booking.id,
          version: result.plan.version,
          cancelled: true,
          cancelledSections: result.cancelledSections,
          keptSections: result.keptSections,
          notifyUserIds: assignedUsers(result.plan),
        },
      },
    ],
  })

  /**
   * The profit statement.
   *
   * Guarded by `report.financial.view` and nothing weaker. The same plan a
   * cleaner is working from produces this, and the two views of it must never
   * be reachable through the same permission.
   */
  const calculateEventProfit = defineOperation<
    { bookingId: string },
    BookingEntity,
    EventPnL
  >({
    name: 'preparation.costing.calculate',
    permission: 'report.financial.view',
    resourceType: 'event_pnl',
    input: s.object({ bookingId: s.uuid({ label: 'הזמנה' }) }),
    loadResource: ({ input }) => loadBookingEntity(input.bookingId),

    rule: ({ entity }) => {
      if (!entity.snapshot) {
        throw new BusinessRuleError({
          code: 'preparation_snapshot_missing',
          message: `Booking ${entity.booking.id} has no rule snapshot`,
          userMessage:
            'לא ניתן לחשב רווחיות לפני שנבנתה תוכנית הכנה להזמנה הזו.',
        })
      }
    },

    execute: async ({ entity }) => {
      const snapshot = entity.snapshot as PreparationSnapshot
      const { facts, requirements } = computeRequirements(
        entity.booking,
        snapshot,
      )

      const staffing = estimateStaffing({
        facts,
        configuration: snapshot.complexity,
        extraItems: entity.booking.extras.length,
      })

      const contexts = await ports.loadAllocationContexts(
        entity.booking.propertyId,
        entity.booking.stay.checkIn,
      )

      return computeEventPnL({
        booking: entity.booking,
        snapshot,
        facts,
        requirements,
        staffing,
        contexts,
      })
    },

    audit: ({ result, entity }) => ({
      resourceId: entity.booking.id,
      propertyId: entity.booking.propertyId,
      summary: `חושבה רווחיות לאירוע: הכנסה ${formatAgorot(result.revenue.total)}, עלויות ישירות ${formatAgorot(result.directCosts.total)}, הוצאות קבועות ${formatAgorot(result.allocatedFixedCosts.total)}, תרומה נטו ${formatAgorot(result.netContribution)}`,
    }),
  })

  return {
    buildPlan,
    recomputePlan,
    completePlanSection,
    overridePlanSection,
    adjustPlanItem,
    acknowledgePlanSection,
    cancelPlan,
    calculateEventProfit,
  }
}

// ── Sentence fragments ────────────────────────────────────────────────────

/** How much of one section is still outstanding. Zero when it has gone. */
function outstandingOf(plan: WorkPlan, key: PlanSectionKey): number {
  const section = plan.sections.find((entry) => entry.key === key)
  return section ? outstandingItems(section).length : 0
}

/** `+5` / `−2`. Signed, so the direction is readable without the words. */
function signed(delta: number): string {
  return delta >= 0 ? `+${delta}` : `−${Math.abs(delta)}`
}

/** Everybody holding one section, for the notification list. */
function assigneesOf(
  plan: WorkPlan,
  section: PlanSectionKey,
): readonly string[] {
  const userId = plan.sections.find(
    (entry) => entry.key === section,
  )?.assignedToUserId
  return userId ? [userId] : []
}

/** Everybody holding any section of a plan. */
function assignedUsers(plan: WorkPlan): readonly string[] {
  return [
    ...new Set(
      plan.sections
        .map((section) => section.assignedToUserId)
        .filter((userId): userId is string => userId !== null),
    ),
  ]
}

function assertPlan(entity: BookingEntity): void {
  if (entity.plan) return
  throw new BusinessRuleError({
    code: 'preparation_plan_missing',
    message: `Booking ${entity.booking.id} has no preparation plan`,
    userMessage: 'אין תוכנית הכנה להזמנה הזו.',
  })
}

function sectionLabel(plan: WorkPlan, key: PlanSectionKey): string {
  return plan.sections.find((section) => section.key === key)?.label ?? key
}

/** "מיטות 5, מזרנים 15, מגבות 28" — the plan's shape in one line. */
function countedSections(plan: WorkPlan): string {
  return plan.sections
    .map(
      (section) =>
        `${section.label} ${section.items.reduce((total, item) => total + item.requiredCount, 0)}`,
    )
    .join(', ')
}

function shortageSentence(inventory: InventoryCheck): string {
  if (inventory.procurement.length === 0) return 'המלאי מספיק.'
  return `חסרים ${inventory.procurement.length} פריטים במלאי.`
}

/**
 * One shortage event, or none.
 *
 * `inventory.shortage_detected` is on the product's alert list, which means
 * emitting it reaches a person rather than only a log. So it is raised only
 * when something must actually be bought or moved — a safety-stock warning is
 * information, and waking somebody for information is how they learn to
 * ignore the alert that mattered.
 */
function shortageEvents(
  inventory: InventoryCheck,
  entity: BookingEntity,
): PreparationEventDraft[] {
  if (inventory.procurement.length === 0) return []

  return [
    {
      name: 'inventory.shortage_detected',
      propertyId: entity.booking.propertyId,
      payload: {
        bookingId: entity.booking.id,
        items: inventory.procurement.map((task) => ({
          itemId: task.itemId,
          quantity: task.quantity,
          neededBy: task.neededBy,
        })),
      },
    },
  ]
}
