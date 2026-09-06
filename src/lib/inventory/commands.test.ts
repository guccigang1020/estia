/**
 * The two asks, through the real pipeline.
 *
 * These do not test arithmetic; there is none here to test, and that is the
 * point — `forecast.ts` decides what is short and these commands only carry
 * that decision to somebody. What is tested is who may make each ask, what
 * comes out the other end, and that neither of them moves a quantity or spends
 * a shekel.
 *
 * The double-grant tests are the load-bearing ones. Row level security demands
 * `task.create` for a task and `approval.request` for an approval, and the
 * Autopilot catalogue declares `inventory.adjust` and `expense.create`. An
 * actor holding only the declared grant must be refused HERE, in a sentence,
 * rather than by Postgres at the end of the write.
 */

import { describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../audit/pipeline'
import type { AuditActor } from '../audit/events'
import { AuthorizationError, type Actor } from '../authz/can'
import type { Grant } from '../authz/permissions'
import { BusinessRuleError, ValidationError } from '../errors'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'
import {
  InMemoryEventBus,
  RecordingTransactionRunner,
  type OperationContext,
  type OperationServices,
} from '../service'

import {
  defineInventoryCommands,
  type CommandItem,
  type CountTaskDraft,
  type InventoryCommandPorts,
  type ProcurementApprovalDraft,
} from './commands'
import { defaultInventorySettings, startingSettingsFor } from './settings'
import type { InventoryMode, InventorySettings } from './types'

const ORGANIZATION = 'org-example'
const PROPERTY = 'property-galilee'
const ITEM = '1f2e3d4c-5b6a-4798-8899-aabbccddeeff'
const USER = 'user-michal'
const NOW = new Date('2026-09-02T08:00:00.000Z')
const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

/** The forecast line, exactly as `forecast.ts` produced it. Never recomputed. */
const FORECAST = {
  date: '2026-09-08',
  required: 30,
  expectedClean: 25,
  shortage: 5,
}

// ── The world ─────────────────────────────────────────────────────────────

function item(overrides: Partial<CommandItem> = {}): CommandItem {
  return {
    itemId: ITEM,
    organizationId: ORGANIZATION,
    propertyId: PROPERTY,
    label: 'מגבת רחצה',
    unitOfMeasure: 'יח׳',
    unitCostAgorot: 1800,
    ...overrides,
  }
}

function actor(grants: readonly Grant[]): Actor {
  return {
    userId: USER,
    organizationId: ORGANIZATION,
    membershipStatus: 'active',
    grants: new Set(grants),
    scope: { kind: 'all_organization' },
    entitlements: EVERY_ENTITLEMENT,
  }
}

const AUDIT_ACTOR: AuditActor = { type: 'user', userId: USER, label: 'מיכל' }

function context(
  grants: readonly Grant[],
  reason: string | null = 'התחזית מראה חוסר של 5 מגבות ב-8 בספטמבר.',
): OperationContext {
  return {
    actor: actor(grants),
    auditActor: AUDIT_ACTOR,
    correlationId: 'req-inventory-command-1',
    now: NOW,
    reason,
  }
}

class RecordingPorts implements InventoryCommandPorts {
  readonly tasks: CountTaskDraft[] = []
  readonly approvals: ProcurementApprovalDraft[] = []

  constructor(
    private readonly settings: InventorySettings,
    private readonly stocked: CommandItem | null,
  ) {}

  async loadSettings(organizationId: string) {
    return {
      settings: { ...this.settings, organizationId },
      provisioned: true,
    }
  }

  async loadItem(args: { itemId: string }) {
    return this.stocked !== null && this.stocked.itemId === args.itemId
      ? this.stocked
      : null
  }

  async openCountTask(draft: CountTaskDraft) {
    this.tasks.push(draft)
    return { id: `task-${this.tasks.length}` }
  }

  async requestProcurementApproval(draft: ProcurementApprovalDraft) {
    this.approvals.push(draft)
    return { id: `approval-${this.approvals.length}` }
  }
}

function world(
  options: { mode?: InventoryMode; stocked?: CommandItem | null } = {},
) {
  const mode = options.mode ?? 'tracked'
  const settings =
    mode === 'off'
      ? defaultInventorySettings(ORGANIZATION)
      : startingSettingsFor(ORGANIZATION, mode)

  const ports = new RecordingPorts(
    settings,
    options.stocked === undefined ? item() : options.stocked,
  )

  const audit = new InMemoryAuditWriter()
  const events = new InMemoryEventBus()
  const services: OperationServices = {
    audit,
    events,
    transactions: new RecordingTransactionRunner(),
  }

  return {
    ports,
    audit,
    events,
    services,
    commands: defineInventoryCommands(ports),
  }
}

// ── requestCount ──────────────────────────────────────────────────────────

describe('inventory.count.request', () => {
  function ask(
    built: ReturnType<typeof world>,
    grants: readonly Grant[],
    reason: string | null = 'ההפרש בספירה האחרונה לא הוסבר.',
  ) {
    return built.commands.requestCount.run({
      request: { input: { itemId: ITEM, dueAt: '2026-09-04T06:00:00.000Z' } },
      context: context(grants, reason),
      services: built.services,
    })
  }

  it('refuses without inventory.adjust', async () => {
    const built = world()

    await expect(ask(built, ['inventory.view'])).rejects.toBeInstanceOf(
      AuthorizationError,
    )
    expect(built.ports.tasks).toHaveLength(0)
    expect(built.audit.records).toHaveLength(0)
  })

  it('refuses an actor who cannot open a task, before the table does', async () => {
    const built = world()

    // Exactly the grant Autopilot's catalogue declares, and nothing else. The
    // task table would refuse this at row level security; the refusal has to
    // happen here so it arrives as a sentence.
    await expect(ask(built, ['inventory.adjust'])).rejects.toBeInstanceOf(
      AuthorizationError,
    )
    expect(built.ports.tasks).toHaveLength(0)
  })

  it('refuses without a stated reason', async () => {
    const built = world()

    await expect(
      ask(built, ['inventory.adjust', 'task.create'], null),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses when the module is off, and says so as a configuration answer', async () => {
    const built = world({ mode: 'off' })

    await expect(
      ask(built, ['inventory.adjust', 'task.create']),
    ).rejects.toBeInstanceOf(BusinessRuleError)
    expect(built.ports.tasks).toHaveLength(0)
  })

  it('opens an inventory task carrying the reason and the item', async () => {
    const built = world()
    const outcome = await ask(built, ['inventory.adjust', 'task.create'])

    expect(outcome.data.taskId).toBe('task-1')

    const [task] = built.ports.tasks
    expect(task.taskType).toBe('inventory')
    expect(task.propertyId).toBe(PROPERTY)
    expect(task.title).toContain('מגבת רחצה')
    expect(task.description).toContain('ההפרש בספירה האחרונה לא הוסבר.')
    expect(task.dueAt).toBe('2026-09-04T06:00:00.000Z')
    expect(task.metadata).toEqual({ kind: 'stock_count', itemId: ITEM })
  })

  it('does not tell the counter what the ledger believes', async () => {
    const built = world()
    await ask(built, ['inventory.adjust', 'task.create'])

    const [task] = built.ports.tasks
    // A count is worthless if the counter is shown the expected answer first.
    // The comparison happens after the number is written, not before it.
    expect(task.description).not.toMatch(/\d+\s*יח׳/)
    expect(task.description).toContain('אין צורך להשוות')
  })

  it('records one audit event saying nothing moved, and raises task.created', async () => {
    const built = world()
    await ask(built, ['inventory.adjust', 'task.create'])

    const [record] = built.audit.records
    expect(built.audit.records).toHaveLength(1)
    expect(record.summary).toContain('לא בוצע שינוי בכמות')

    const [event] = built.events.published
    expect(event.name).toBe('task.created')
    expect(event.payload).toMatchObject({ kind: 'stock_count', itemId: ITEM })
  })

  it('reports a missing item as not found rather than opening a task', async () => {
    const built = world({ stocked: null })

    await expect(
      ask(built, ['inventory.adjust', 'task.create']),
    ).rejects.toThrow()
    expect(built.ports.tasks).toHaveLength(0)
  })
})

// ── draftProcurement ──────────────────────────────────────────────────────

describe('inventory.procurement.draft', () => {
  function draft(
    built: ReturnType<typeof world>,
    grants: readonly Grant[],
    overrides: { quantity?: number; forecast?: typeof FORECAST | null } = {},
  ) {
    return built.commands.draftProcurement.run({
      request: {
        input: {
          itemId: ITEM,
          quantity: overrides.quantity ?? 12,
          neededBy: '2026-09-07T06:00:00.000Z',
          forecast:
            overrides.forecast === undefined ? FORECAST : overrides.forecast,
        },
      },
      context: context(grants),
      services: built.services,
    })
  }

  it('refuses without expense.create', async () => {
    const built = world()

    await expect(
      draft(built, ['inventory.adjust', 'approval.request']),
    ).rejects.toBeInstanceOf(AuthorizationError)
    expect(built.ports.approvals).toHaveLength(0)
    expect(built.audit.records).toHaveLength(0)
  })

  it('refuses an actor who cannot raise an approval, before the table does', async () => {
    const built = world()

    await expect(draft(built, ['expense.create'])).rejects.toBeInstanceOf(
      AuthorizationError,
    )
    expect(built.ports.approvals).toHaveLength(0)
  })

  it('refuses when procurement is not a capability this business has', async () => {
    const built = world({ mode: 'basic' })

    await expect(
      draft(built, ['expense.create', 'approval.request']),
    ).rejects.toBeInstanceOf(BusinessRuleError)
    expect(built.ports.approvals).toHaveLength(0)
  })

  it('produces a request a second person must still decide on', async () => {
    const built = world()
    const outcome = await draft(built, ['expense.create', 'approval.request'])

    expect(outcome.data.approvalId).toBe('approval-1')

    const [request] = built.ports.approvals
    expect(request.approvalType).toBe('expense')
    expect(request.subjectType).toBe('inventory_item')
    expect(request.subjectId).toBe(ITEM)
    // The reason is NOT NULL on the table and is what the decider reads.
    expect(request.reason).toContain('התחזית')

    // Nothing here names a supplier, a payment or an order. It cannot: the
    // draft is an approval row, and an approval row has no such column.
    expect(Object.keys(request)).not.toContain('providerId')
    expect(Object.keys(request)).not.toContain('supplierId')

    const [event] = built.events.published
    expect(event.name).toBe('approval.requested')
    expect(event.payload).toMatchObject({ approvalType: 'expense' })

    const [record] = built.audit.records
    expect(record.summary).toContain('ממתינה לאישור')
    expect(record.summary).toContain('לא הוזמן דבר ולא נוצר קשר עם ספק')
    expect(record.after).toMatchObject({ status: 'requested' })
  })

  it('sizes the ask from the recorded unit cost', async () => {
    const built = world()
    const outcome = await draft(built, ['expense.create', 'approval.request'], {
      quantity: 12,
    })

    expect(outcome.data.estimatedAgorot).toBe(12 * 1800)
    expect(built.ports.approvals[0].requestedAgorot).toBe(21_600)
  })

  it('leaves the ask unpriced rather than pricing it at zero', async () => {
    const built = world({ stocked: item({ unitCostAgorot: null }) })
    const outcome = await draft(built, ['expense.create', 'approval.request'])

    // Zero would read on the approval screen as "this costs nothing".
    expect(outcome.data.estimatedAgorot).toBeNull()
    expect(built.ports.approvals[0].requestedAgorot).toBeNull()
  })

  it('carries the forecast line into the request verbatim', async () => {
    const built = world()
    await draft(built, ['expense.create', 'approval.request'])

    expect(built.ports.approvals[0].metadata).toMatchObject({
      itemId: ITEM,
      quantity: 12,
      forecast: FORECAST,
    })
  })

  it('accepts a draft raised by hand, with no forecast line behind it', async () => {
    const built = world()
    const outcome = await draft(built, ['expense.create', 'approval.request'], {
      forecast: null,
    })

    expect(outcome.ok).toBe(true)
    expect(built.ports.approvals[0].metadata).toMatchObject({ forecast: null })
  })

  it('refuses a quantity of zero', async () => {
    const built = world()

    await expect(
      draft(built, ['expense.create', 'approval.request'], { quantity: 0 }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses an estimate the approval column cannot hold', async () => {
    const built = world({ stocked: item({ unitCostAgorot: 500_000 }) })

    await expect(
      draft(built, ['expense.create', 'approval.request'], {
        quantity: 100_000,
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
    expect(built.ports.approvals).toHaveLength(0)
  })
})
