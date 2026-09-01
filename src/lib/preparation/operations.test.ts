/**
 * The operations, through the real pipeline.
 *
 * These do not test the arithmetic — the files above do that. They test that
 * the arithmetic is only reachable through `defineOperation`: that a cleaner
 * cannot see a profit statement, that closing an unfinished section takes a
 * different permission and a stated reason from closing a finished one, that
 * every success writes one audit event with a sentence a manager can read, and
 * that a recomputation reads the stored snapshot rather than today's rules.
 *
 * Most of it is negative, because "it works" and "it refuses everybody it
 * should" are different claims and only the second one is worth making.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { InMemoryAuditWriter } from '../audit/pipeline'
import type { AuditActor } from '../audit/events'
import { AuthorizationError, type Actor } from '../authz/can'
import type { Grant } from '../authz/permissions'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'
import { BusinessRuleError, NotFoundError, ValidationError } from '../errors'
import {
  InMemoryEventBus,
  RecordingTransactionRunner,
  type OperationContext,
  type OperationServices,
} from '../service'
import { estimateStaffing } from './complexity'
import {
  createPreparationOperations,
  type PreparationPorts,
} from './operations'
import { computeRequirements, templateSections } from './requirements'
import { captureSnapshot } from './snapshot'
import { buildWorkPlan, recordProgress } from './work-plan'
import type {
  AllocationContext,
  CostFrequency,
  PreparationBooking,
  PreparationCatalogue,
  PreparationSnapshot,
  StockLevel,
  WorkPlan,
} from './types'
import {
  BOOKING_ID,
  ORGANIZATION_ID,
  PROPERTY_ID,
  UNIT_ID,
  exampleBooking,
  exampleCatalogue,
  exampleStock,
} from './testing/example-configuration'

const NOW = new Date('2026-09-01T09:00:00.000Z')
const CORRELATION = 'req-prep-1'
const SUPERVISOR = 'user-michal'
const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

const MONTH: AllocationContext = {
  propertyId: PROPERTY_ID,
  periodDays: 30,
  periodOccupiedNights: 22,
  periodBookings: 8,
  periodGuests: 120,
  periodRevenue: 4_000_000,
  periodUnits: 1,
}

const CONTEXTS: Readonly<Partial<Record<CostFrequency, AllocationContext>>> = {
  monthly: MONTH,
  annual: {
    ...MONTH,
    periodDays: 365,
    periodOccupiedNights: 260,
    periodBookings: 96,
    periodGuests: 1_440,
    periodRevenue: 48_000_000,
  },
}

// ── The world ─────────────────────────────────────────────────────────────

function actor(
  grants: readonly Grant[],
  overrides: Partial<Actor> = {},
): Actor {
  return {
    userId: SUPERVISOR,
    organizationId: ORGANIZATION_ID,
    membershipStatus: 'active',
    grants: new Set(grants),
    scope: { kind: 'all_organization' },
    entitlements: EVERY_ENTITLEMENT,
    ...overrides,
  }
}

const AUDIT_ACTOR: AuditActor = {
  type: 'user',
  userId: SUPERVISOR,
  label: 'מיכל',
}

function context(
  grants: readonly Grant[],
  overrides: Partial<OperationContext> = {},
): OperationContext {
  return {
    actor: actor(grants),
    auditActor: AUDIT_ACTOR,
    correlationId: CORRELATION,
    now: NOW,
    ...overrides,
  }
}

/**
 * A world with a booking, a catalogue and whatever stock the test wants.
 *
 * Every port is a function over in-memory state. Nothing here touches a
 * database, which is the point — the domain is pure and the ports are the
 * whole of its contact with the outside.
 */
function world(
  options: {
    booking?: PreparationBooking
    catalogue?: PreparationCatalogue
    stock?: readonly StockLevel[]
    elsewhere?: readonly StockLevel[]
  } = {},
) {
  const booking = options.booking ?? exampleBooking()
  const catalogue = options.catalogue ?? exampleCatalogue()

  const state: {
    plan: WorkPlan | null
    snapshot: PreparationSnapshot | null
    catalogue: PreparationCatalogue
    saves: number
  } = { plan: null, snapshot: null, catalogue, saves: 0 }

  const ports: PreparationPorts = {
    loadBooking: async (id) => (id === booking.id ? booking : null),
    loadCatalogue: async () => state.catalogue,
    loadSnapshot: async () => state.snapshot,
    loadPlan: async () => state.plan,
    loadStock: async () => options.stock ?? exampleStock(),
    loadTransferrableStock: async () => options.elsewhere ?? [],
    loadAllocationContexts: async () => CONTEXTS,
    savePlan: async (plan) => {
      state.plan = plan
      state.saves += 1
    },
    saveSnapshot: async (_bookingId, snapshot) => {
      state.snapshot = snapshot
    },
    nextPlanId: (bookingId) => `plan-${bookingId}`,
  }

  const audit = new InMemoryAuditWriter()
  const events = new InMemoryEventBus()
  const transactions = new RecordingTransactionRunner()
  const services: OperationServices = { audit, events, transactions }

  return {
    booking,
    state,
    audit,
    events,
    transactions,
    services,
    operations: createPreparationOperations(ports),
  }
}

/** Build a plan the way the operation would, for tests that start with one. */
function seedPlan(w: ReturnType<typeof world>): WorkPlan {
  const snapshot = captureSnapshot({
    catalogue: w.state.catalogue,
    booking: w.booking,
    capturedAt: NOW.toISOString(),
  })
  const { facts, requirements } = computeRequirements(w.booking, snapshot)

  const plan = buildWorkPlan({
    id: `plan-${w.booking.id}`,
    booking: w.booking,
    snapshot,
    requirements,
    staffing: estimateStaffing({
      facts,
      configuration: snapshot.complexity,
      extraItems: w.booking.extras.length,
    }),
    extraSections: templateSections(snapshot, w.booking.eventType),
    version: 1,
    createdAt: NOW.toISOString(),
  })

  w.state.snapshot = snapshot
  w.state.plan = plan
  return plan
}

// ── Building ──────────────────────────────────────────────────────────────

describe('building a plan', () => {
  let w: ReturnType<typeof world>

  beforeEach(() => {
    w = world()
  })

  it('produces the plan, the snapshot and the stock check together', async () => {
    const outcome = await w.operations.buildPlan.run({
      request: { input: { bookingId: BOOKING_ID } },
      context: context(['task.create']),
      services: w.services,
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.data.plan.version).toBe(1)
    expect(outcome.data.plan.snapshotHash).toBe(outcome.data.snapshot.hash)
    expect(outcome.data.inventory.lines.length).toBeGreaterThan(0)
  })

  it('stores the snapshot, so nothing later reads the live catalogue', async () => {
    await w.operations.buildPlan.run({
      request: { input: { bookingId: BOOKING_ID } },
      context: context(['task.create']),
      services: w.services,
    })

    expect(w.state.snapshot).not.toBeNull()
    expect(Object.isFrozen(w.state.snapshot)).toBe(true)
  })

  it('writes one audit event naming the party and the counts', async () => {
    await w.operations.buildPlan.run({
      request: { input: { bookingId: BOOKING_ID } },
      context: context(['task.create']),
      services: w.services,
    })

    expect(w.audit.records).toHaveLength(1)
    const summary = w.audit.records[0].summary

    expect(summary).toContain('25 אורחים')
    expect(summary).toContain('בית הזית')
    expect(summary).not.toBe('booking updated')
  })

  it('raises the frozen event names, not invented ones', async () => {
    await w.operations.buildPlan.run({
      request: { input: { bookingId: BOOKING_ID } },
      context: context(['task.create']),
      services: w.services,
    })

    const names = w.events.published.map((event) => event.name)

    expect(names).toContain('preparation.calculated')
    expect(names).toContain('inventory.shortage_detected')
  })

  it('stays quiet about shortages when there are none', async () => {
    // Stocked from the plan's own requirements. Topping up the three items
    // the fixture happens to name would leave every other item at zero, and
    // the test would pass for the wrong reason — or, as it did, fail.
    const booking = exampleBooking()
    const snapshot = captureSnapshot({
      catalogue: exampleCatalogue(),
      booking,
      capturedAt: NOW.toISOString(),
    })
    const fullyStocked: readonly StockLevel[] = computeRequirements(
      booking,
      snapshot,
    ).requirements.map((requirement) => ({
      itemId: requirement.itemId,
      label: requirement.label,
      location: { kind: 'property' as const, propertyId: PROPERTY_ID },
      onHand: requirement.quantity * 10,
      reserved: 0,
      safetyStock: 0,
    }))

    const stocked = world({ stock: fullyStocked })

    await stocked.operations.buildPlan.run({
      request: { input: { bookingId: BOOKING_ID } },
      context: context(['task.create']),
      services: stocked.services,
    })

    expect(stocked.events.published.map((event) => event.name)).not.toContain(
      'inventory.shortage_detected',
    )
  })

  it('refuses a second plan for the same booking', async () => {
    const run = () =>
      w.operations.buildPlan.run({
        request: { input: { bookingId: BOOKING_ID } },
        context: context(['task.create']),
        services: w.services,
      })

    await run()
    await expect(run()).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('commits the plan, the snapshot and the audit event as one unit', async () => {
    await w.operations.buildPlan.run({
      request: { input: { bookingId: BOOKING_ID } },
      context: context(['task.create']),
      services: w.services,
    })

    expect(w.transactions.commits).toBe(1)
    expect(w.transactions.rollbacks).toBe(0)
  })
})

// ── Authorization ─────────────────────────────────────────────────────────

describe('who may do what', () => {
  it('refuses somebody without the grant, before reading anything', async () => {
    const w = world()
    let loaded = false
    const watching = createPreparationOperations({
      loadBooking: async () => {
        loaded = true
        return w.booking
      },
      loadCatalogue: async () => w.state.catalogue,
      loadSnapshot: async () => null,
      loadPlan: async () => null,
      loadStock: async () => [],
      loadAllocationContexts: async () => CONTEXTS,
      savePlan: async () => {},
      saveSnapshot: async () => {},
      nextPlanId: () => 'plan-x',
    })

    await expect(
      watching.buildPlan.run({
        request: { input: { bookingId: BOOKING_ID } },
        context: context(['task.view']),
        services: w.services,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)

    expect(loaded, 'the booking was read despite the refusal').toBe(false)
  })

  it('refuses a booking belonging to another organization', async () => {
    const w = world({
      booking: exampleBooking({ organizationId: 'other-org' }),
    })

    await expect(
      w.operations.buildPlan.run({
        request: { input: { bookingId: BOOKING_ID } },
        context: context(['task.create']),
        services: w.services,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  it('will not let somebody who can tick a box read the profit', async () => {
    const w = world()
    seedPlan(w)

    await expect(
      w.operations.calculateEventProfit.run({
        request: { input: { bookingId: BOOKING_ID } },
        context: context(['task.complete', 'task.verify']),
        services: w.services,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  it('refuses an input that is not a booking id', async () => {
    const w = world()

    await expect(
      w.operations.buildPlan.run({
        request: { input: { bookingId: 'not-a-uuid' } },
        context: context(['task.create']),
        services: w.services,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

// ── Recomputation ─────────────────────────────────────────────────────────

describe('recomputing a plan', () => {
  it('versions it and reports the delta rather than changing it silently', async () => {
    const w = world()
    const previous = seedPlan(w)

    // The booking grew. Rebuild against the same stored snapshot.
    const grown = world({ booking: exampleBooking({ guests: 30 }) })
    grown.state.snapshot = w.state.snapshot
    grown.state.plan = previous

    const outcome = await grown.operations.recomputePlan.run({
      request: { input: { bookingId: BOOKING_ID }, expectedVersion: 1 },
      context: context(['task.update']),
      services: grown.services,
    })

    expect(outcome.data.plan.version).toBe(2)
    expect(
      outcome.data.delta.added.find(
        (change) => change.itemId === 'floor_mattress',
      )?.delta,
    ).toBe(5)
  })

  it('says what moved, in Hebrew, in the audit log', async () => {
    const w = world()
    const previous = seedPlan(w)

    const grown = world({ booking: exampleBooking({ guests: 30 }) })
    grown.state.snapshot = w.state.snapshot
    grown.state.plan = previous

    await grown.operations.recomputePlan.run({
      request: { input: { bookingId: BOOKING_ID }, expectedVersion: 1 },
      context: context(['task.update']),
      services: grown.services,
    })

    const summary = grown.audit.records[0].summary

    expect(summary).toContain('מגרסה 1 לגרסה 2')
    expect(summary).toContain('+5 מזרן רצפה')
  })

  it('reads the stored snapshot, not the catalogue as it is today', async () => {
    const w = world()
    const previous = seedPlan(w)

    // Somebody doubles the towel rule after the plan was built.
    const base = exampleCatalogue()
    w.state.catalogue = exampleCatalogue({
      rules: base.rules.map((rule) =>
        rule.id === 'towel_bath'
          ? { ...rule, quantity: { basis: 'guests' as const, factor: 2 } }
          : rule,
      ),
    })

    const outcome = await w.operations.recomputePlan.run({
      request: { input: { bookingId: BOOKING_ID }, expectedVersion: 1 },
      context: context(['task.update']),
      services: w.services,
    })

    expect(outcome.data.delta.added).toEqual([])
    expect(outcome.data.delta.removed).toEqual([])
    expect(previous.snapshotHash).toBe(outcome.data.plan.snapshotHash)
  })

  it('refuses a caller editing a version somebody else has moved on from', async () => {
    const w = world()
    seedPlan(w)

    await expect(
      w.operations.recomputePlan.run({
        request: { input: { bookingId: BOOKING_ID }, expectedVersion: 7 },
        context: context(['task.update']),
        services: w.services,
      }),
    ).rejects.toThrow(/version/i)
  })

  it('says there is no plan, rather than blaming a version conflict', async () => {
    // The pipeline checks the expected version straight after the load. A
    // load that succeeded on a booking with no plan would leave the version
    // undefined and the caller would be told somebody else had changed the
    // record — untrue, and unactionable. The plan is this operation's
    // resource, so its absence is a not-found.
    const w = world()

    await expect(
      w.operations.recomputePlan.run({
        request: { input: { bookingId: BOOKING_ID }, expectedVersion: 1 },
        context: context(['task.update']),
        services: w.services,
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('refuses to close a section of a plan that does not exist', async () => {
    const w = world()

    await expect(
      w.operations.completePlanSection.run({
        request: { input: { bookingId: BOOKING_ID, section: 'cleaning' } },
        context: context(['task.complete']),
        services: w.services,
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

// ── Sections ──────────────────────────────────────────────────────────────

describe('closing a section', () => {
  function withCleaningDone() {
    const w = world()
    const plan = seedPlan(w)
    const section = plan.sections.find((entry) => entry.key === 'cleaning')

    w.state.plan = (section?.items ?? []).reduce(
      (current, item) =>
        recordProgress(current, {
          section: 'cleaning',
          itemId: item.itemId,
          completedCount: item.requiredCount,
        }),
      plan,
    )

    return w
  }

  it('accepts a finished section and records it as completed', async () => {
    const w = withCleaningDone()

    const outcome = await w.operations.completePlanSection.run({
      request: { input: { bookingId: BOOKING_ID, section: 'cleaning' } },
      context: context(['task.complete']),
      services: w.services,
    })

    expect(outcome.data.overridden).toBe(false)
    expect(
      outcome.data.plan.sections.find((section) => section.key === 'cleaning')
        ?.status,
    ).toBe('completed')
    expect(w.events.published.map((event) => event.name)).toContain(
      'task.completed',
    )
  })

  it('refuses an unfinished section through the ordinary route', async () => {
    const w = world()
    seedPlan(w)

    await expect(
      w.operations.completePlanSection.run({
        request: { input: { bookingId: BOOKING_ID, section: 'cleaning' } },
        context: context(['task.complete']),
        services: w.services,
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses a section name that is not a section', async () => {
    const w = world()
    seedPlan(w)

    await expect(
      w.operations.completePlanSection.run({
        request: { input: { bookingId: BOOKING_ID, section: 'nonsense' } },
        context: context(['task.complete']),
        services: w.services,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('overriding a section', () => {
  it('needs a different permission from ordinary completion', async () => {
    const w = world()
    seedPlan(w)

    await expect(
      w.operations.overridePlanSection.run({
        request: { input: { bookingId: BOOKING_ID, section: 'cleaning' } },
        context: context(['task.complete'], { reason: 'האורחים הקדימו' }),
        services: w.services,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  it('refuses without a stated reason, even with the permission', async () => {
    const w = world()
    seedPlan(w)

    await expect(
      w.operations.overridePlanSection.run({
        request: { input: { bookingId: BOOKING_ID, section: 'cleaning' } },
        context: context(['task.verify']),
        services: w.services,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('closes the section and records the reason, the person and the shortfall', async () => {
    const w = world()
    seedPlan(w)

    const outcome = await w.operations.overridePlanSection.run({
      request: { input: { bookingId: BOOKING_ID, section: 'cleaning' } },
      context: context(['task.verify'], {
        reason: 'האורחים הקדימו והמצעים בדרך מהמכבסה',
      }),
      services: w.services,
    })

    expect(outcome.data.overridden).toBe(true)
    expect(outcome.data.outstanding).toBeGreaterThan(0)

    const section = outcome.data.plan.sections.find(
      (entry) => entry.key === 'cleaning',
    )
    expect(section?.status).toBe('completed')
    expect(section?.override?.supervisorUserId).toBe(SUPERVISOR)
    expect(section?.override?.reason).toContain('הקדימו')

    const record = w.audit.records[0]
    expect(record.reason).toContain('הקדימו')
    expect(record.summary).toContain('מיכל')
    expect(record.summary).toContain('פריטים חסרים')
    expect(w.events.published.map((event) => event.name)).toContain(
      'task.verified',
    )
  })
})

// ── Costing ───────────────────────────────────────────────────────────────

describe('calculating the event profit', () => {
  it('returns the whole breakdown to somebody entitled to it', async () => {
    const w = world()
    seedPlan(w)

    const outcome = await w.operations.calculateEventProfit.run({
      request: { input: { bookingId: BOOKING_ID } },
      context: context(['report.financial.view']),
      services: w.services,
    })

    expect(outcome.data.revenue.total).toBe(640_000)
    expect(outcome.data.netContribution).toBe(139_886)
    expect(outcome.data.directCosts.lines.length).toBeGreaterThan(0)
  })

  it('puts the money in the audit sentence, formatted for a person', async () => {
    const w = world()
    seedPlan(w)

    await w.operations.calculateEventProfit.run({
      request: { input: { bookingId: BOOKING_ID } },
      context: context(['report.financial.view']),
      services: w.services,
    })

    expect(w.audit.records[0].summary).toContain('₪6,400')
    expect(w.audit.records[0].summary).toContain('תרומה נטו')
  })

  it('refuses before a plan has been built, because there is no snapshot', async () => {
    const w = world()

    await expect(
      w.operations.calculateEventProfit.run({
        request: { input: { bookingId: BOOKING_ID } },
        context: context(['report.financial.view']),
        services: w.services,
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })
})

// ── Idempotency ───────────────────────────────────────────────────────────

describe('a booking that does not exist', () => {
  it('is not found rather than silently building nothing', async () => {
    const w = world()

    await expect(
      w.operations.buildPlan.run({
        request: {
          input: { bookingId: '99999999-9999-4999-8999-999999999999' },
        },
        context: context(['task.create']),
        services: w.services,
      }),
    ).rejects.toThrow(/not found/i)
  })
})

describe('the resource the pipeline authorizes against', () => {
  it('is the booking’s property and unit, so scope is enforceable', async () => {
    const w = world()

    await w.operations.buildPlan.run({
      request: { input: { bookingId: BOOKING_ID } },
      context: {
        ...context(['task.create']),
        actor: actor(['task.create'], {
          scope: { kind: 'units', unitIds: [UNIT_ID] },
        }),
      },
      services: w.services,
    })

    expect(w.state.plan?.unitId).toBe(UNIT_ID)
  })

  it('refuses a unit outside the actor’s scope', async () => {
    const w = world()

    await expect(
      w.operations.buildPlan.run({
        request: { input: { bookingId: BOOKING_ID } },
        context: {
          ...context(['task.create']),
          actor: actor(['task.create'], {
            scope: { kind: 'units', unitIds: ['some-other-unit'] },
          }),
        },
        services: w.services,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })
})

// ── Adjusting, acknowledging and cancelling ───────────────────────────────

describe('overruling a computed quantity', () => {
  it('keeps the calculated figure and records who changed it and why', async () => {
    const w = world()
    seedPlan(w)

    const outcome = await w.operations.adjustPlanItem.run({
      request: {
        input: {
          bookingId: BOOKING_ID,
          section: 'towels',
          itemId: 'bath_towel',
          finalCount: 30,
        },
        expectedVersion: 1,
      },
      context: context(['checklist.manage'], {
        reason: 'ספרתי במחסן ויש שלושים',
      }),
      services: w.services,
    })

    expect(outcome.data.calculated).toBe(25)
    expect(outcome.data.adjustment).toBe(5)
    expect(outcome.data.final).toBe(30)

    const item = w.state.plan?.sections
      .find((section) => section.key === 'towels')
      ?.items.find((entry) => entry.itemId === 'bath_towel')

    // The engine's own figure is still there. Overwriting it would answer
    // "how many" and destroy "why".
    expect(item?.requiredCount).toBe(25)
    expect(item?.adjustment?.reason).toBe('ספרתי במחסן ויש שלושים')
    expect(item?.adjustment?.byUserId).toBe(SUPERVISOR)
  })

  it('says all three numbers in the audit sentence', async () => {
    const w = world()
    seedPlan(w)

    await w.operations.adjustPlanItem.run({
      request: {
        input: {
          bookingId: BOOKING_ID,
          section: 'towels',
          itemId: 'bath_towel',
          finalCount: 30,
        },
        expectedVersion: 1,
      },
      context: context(['checklist.manage'], { reason: 'ספרתי במחסן' }),
      services: w.services,
    })

    const summary = w.audit.records[0].summary
    expect(summary).toContain('25')
    expect(summary).toContain('30')
    expect(summary).toContain('+5')
    expect(summary).toContain('ספרתי במחסן')
  })

  it('advances the revision, so the people working the section are told', async () => {
    const w = world()
    seedPlan(w)

    const outcome = await w.operations.adjustPlanItem.run({
      request: {
        input: {
          bookingId: BOOKING_ID,
          section: 'towels',
          itemId: 'bath_towel',
          finalCount: 30,
        },
        expectedVersion: 1,
      },
      context: context(['checklist.manage'], { reason: 'סיבה' }),
      services: w.services,
    })

    expect(outcome.data.plan.version).toBe(2)
    expect(outcome.events.map((event) => event.name)).toContain(
      'preparation.changed',
    )
  })

  it('refuses without a reason', async () => {
    const w = world()
    seedPlan(w)

    await expect(
      w.operations.adjustPlanItem.run({
        request: {
          input: {
            bookingId: BOOKING_ID,
            section: 'towels',
            itemId: 'bath_towel',
            finalCount: 30,
          },
          expectedVersion: 1,
        },
        context: context(['checklist.manage']),
        services: w.services,
      }),
    ).rejects.toBeTruthy()
  })

  it('is not something the grant to do the work carries', async () => {
    // Ticking an item off is saying what happened. Overruling the engine is
    // saying what the house needs, and that is the policy grant.
    const w = world()
    seedPlan(w)

    await expect(
      w.operations.adjustPlanItem.run({
        request: {
          input: {
            bookingId: BOOKING_ID,
            section: 'towels',
            itemId: 'bath_towel',
            finalCount: 30,
          },
          expectedVersion: 1,
        },
        context: context(['task.complete', 'task.update'], {
          reason: 'סיבה',
        }),
        services: w.services,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })
})

describe('acknowledging a change', () => {
  it('stamps the section with the version the person has seen', async () => {
    const w = world()
    const seeded = seedPlan(w)

    // Somebody is halfway through the towels and the plan has moved on.
    w.state.plan = {
      ...seeded,
      version: 2,
      sections: seeded.sections.map((section) =>
        section.key === 'towels'
          ? { ...section, status: 'in_progress' as const }
          : section,
      ),
    }

    const outcome = await w.operations.acknowledgePlanSection.run({
      request: { input: { bookingId: BOOKING_ID, section: 'towels' } },
      context: context(['task.update']),
      services: w.services,
    })

    const towels = outcome.data.plan.sections.find(
      (section) => section.key === 'towels',
    )

    expect(towels?.acknowledgedVersion).toBe(2)
    // Acknowledging is not a new version of what the house needs.
    expect(outcome.data.plan.version).toBe(2)
  })
})

describe('cancelling the preparation behind a cancelled booking', () => {
  it('stops the outstanding work and keeps what was already done', async () => {
    const w = world()
    const seeded = seedPlan(w)

    // The cleaning is finished; everything else is not.
    w.state.plan = {
      ...seeded,
      sections: seeded.sections.map((section) =>
        section.key === 'cleaning'
          ? { ...section, status: 'completed' as const }
          : section,
      ),
    }

    const outcome = await w.operations.cancelPlan.run({
      request: { input: { bookingId: BOOKING_ID }, expectedVersion: 1 },
      context: context(['task.update'], { reason: 'האורח ביטל' }),
      services: w.services,
    })

    // A house that was cleaned was cleaned. Rewriting that to `cancelled`
    // because the guest pulled out is the product lying about labour.
    expect(outcome.data.keptSections).toContain('cleaning')
    expect(outcome.data.cancelledSections).not.toContain('cleaning')

    const cleaning = outcome.data.plan.sections.find(
      (section) => section.key === 'cleaning',
    )
    expect(cleaning?.status).toBe('completed')

    for (const key of outcome.data.cancelledSections) {
      const section = outcome.data.plan.sections.find(
        (entry) => entry.key === key,
      )
      expect(section?.status).toBe('cancelled')
    }
  })

  it('raises the event the other modules react to, rather than calling them', async () => {
    const w = world()
    seedPlan(w)

    const outcome = await w.operations.cancelPlan.run({
      request: { input: { bookingId: BOOKING_ID }, expectedVersion: 1 },
      context: context(['task.update'], { reason: 'האורח ביטל' }),
      services: w.services,
    })

    const changed = outcome.events.find(
      (event) => event.name === 'preparation.changed',
    )

    expect(changed).toBeTruthy()
    expect(changed?.payload).toMatchObject({ cancelled: true })
  })

  it('keeps the plan and its history rather than deleting the row', async () => {
    const w = world()
    seedPlan(w)

    await w.operations.cancelPlan.run({
      request: { input: { bookingId: BOOKING_ID }, expectedVersion: 1 },
      context: context(['task.update'], { reason: 'האורח ביטל' }),
      services: w.services,
    })

    expect(w.state.plan).not.toBeNull()
    // A new revision, so `work_plan_versions` holds both the plan as worked
    // and the plan as cancelled.
    expect(w.state.plan?.version).toBe(2)
  })

  it('refuses without a reason', async () => {
    const w = world()
    seedPlan(w)

    await expect(
      w.operations.cancelPlan.run({
        request: { input: { bookingId: BOOKING_ID }, expectedVersion: 1 },
        context: context(['task.update']),
        services: w.services,
      }),
    ).rejects.toBeTruthy()
  })
})

describe('a date change', () => {
  it('moves the stay and recomputes against the same frozen rules', async () => {
    const w = world()
    const previous = seedPlan(w)

    // The stay moved a week later. Same booking, same snapshot, new dates.
    const moved = world({
      booking: exampleBooking({
        stay: { checkIn: '2026-09-11', checkOut: '2026-09-13' },
        arrivalAt: '2026-09-11T14:00:00.000Z',
      }),
    })
    moved.state.snapshot = w.state.snapshot
    moved.state.plan = previous

    const outcome = await moved.operations.recomputePlan.run({
      request: { input: { bookingId: BOOKING_ID }, expectedVersion: 1 },
      context: context(['task.update'], { reason: 'ההזמנה נדחתה בשבוע' }),
      services: moved.services,
    })

    expect(outcome.data.plan.version).toBe(2)
    // The rules the plan is measured by did not move with the dates. That is
    // the snapshot doing its job: a plan built in September stays a September
    // plan even when the stay slides.
    expect(outcome.data.plan.snapshotHash).toBe(previous.snapshotHash)
  })
})
