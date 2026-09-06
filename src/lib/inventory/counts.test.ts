/**
 * The stocktake, through the real pipeline.
 *
 * Four of these are the module's promises rather than its arithmetic, and
 * they are the ones worth reading first:
 *
 *   · a blind sheet does not contain the expected quantity, checked on the
 *     object the counter actually receives rather than on a component;
 *   · the operation that starts a blind count cannot return the expected
 *     figures, because the port does not hand them to it;
 *   · variance is `expected − counted`, and `expected` is the ledger's own
 *     `onHandClean` re-projected, never a second sum of movements;
 *   · an uncounted line is not a variance of zero, which is the bug that
 *     would report a whole cupboard as missing the first time somebody was
 *     called away half way through.
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
  COUNT_SESSION_TRANSITIONS,
  assertTransition,
  buildCountSheet,
  canAdvance,
  defineCountOperations,
  expectedFromLedger,
  explainVariance,
  reconcile,
  type CountLine,
  type CountPorts,
  type CountSessionRecord,
  type CountSessionStatus,
  type CountVariance,
  type CountVarianceRecord,
  type ExpectedStock,
  type NewCountSession,
} from './counts'
import type { LossClass } from './loss'
import { defaultInventorySettings, startingSettingsFor } from './settings'
import type { ForecastItem, InventoryMode, InventorySettings } from './types'

const ORGANIZATION = 'org-example'
const PROPERTY = 'property-galilee'
const SESSION = '3c1d5f80-8a2b-4a1e-9f6d-2b7c4e9a1d33'
const TOWEL = '1f2e3d4c-5b6a-4798-8899-aabbccddeeff'
const SOAP = '5a4b3c2d-1e0f-4321-8765-99aabbccddee'
const VARIANCE = '7d6c5b4a-3e2f-4110-9988-1122334455aa'
const USER = 'user-michal'
const NOW = new Date('2026-09-06T09:00:00.000Z')
const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

/* ------------------------------------------------------------- the world -- */

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
  reason: string | null = null,
): OperationContext {
  return {
    actor: actor(grants),
    auditActor: AUDIT_ACTOR,
    correlationId: 'req-inventory-count-1',
    now: NOW,
    reason,
  }
}

/** A ledger record, exactly the shape the existing repository produces. */
function forecastItem(overrides: Partial<ForecastItem> = {}): ForecastItem {
  return {
    itemId: TOWEL,
    label: 'מגבת רחצה',
    propertyId: PROPERTY,
    location: 'מחסן קומה ב׳',
    unitOfMeasure: 'יח׳',
    onHandClean: 18,
    byState: { available: 18, laundry: 30, dirty: 12 },
    reservedTotal: 0,
    minQuantity: 10,
    parLevel: 60,
    ...overrides,
  }
}

function line(overrides: Partial<CountLine> = {}): CountLine {
  return {
    id: `line-${overrides.itemId ?? TOWEL}`,
    sessionId: SESSION,
    itemId: TOWEL,
    label: 'מגבת רחצה',
    unitOfMeasure: 'יח׳',
    location: 'מחסן קומה ב׳',
    countedQuantity: null,
    countedAt: null,
    note: null,
    ...overrides,
  }
}

function expectation(overrides: Partial<ExpectedStock> = {}): ExpectedStock {
  return {
    itemId: TOWEL,
    onShelf: 18,
    owned: 60,
    elsewhere: { laundry: 30, dirty: 12 },
    circulating: 42,
    replacementCostAgorot: 1800,
    capturedAt: NOW.toISOString(),
    ...overrides,
  }
}

class RecordingPorts implements CountPorts {
  readonly created: NewCountSession[] = []
  readonly advanced: { to: CountSessionStatus; reason: string | null }[] = []
  readonly counts: { itemId: string; countedQuantity: number }[] = []
  readonly savedVariances: CountVariance[] = []
  readonly classifications: {
    classification: LossClass
    note: string | null
  }[] = []
  readonly movements: { kind: string; quantityDelta: number }[] = []
  stamped = 0

  constructor(
    private readonly settings: InventorySettings,
    private readonly session: CountSessionRecord | null,
    private readonly lines: readonly CountLine[],
    private readonly expected: readonly ExpectedStock[],
    private readonly variance: CountVarianceRecord | null,
    private readonly live: { id: string; status: CountSessionStatus } | null,
    private readonly unexplained: number,
  ) {}

  async loadSettings(organizationId: string) {
    return {
      settings: { ...this.settings, organizationId },
      provisioned: true,
    }
  }

  async loadSession(args: { sessionId: string }) {
    return this.session !== null && this.session.id === args.sessionId
      ? this.session
      : null
  }

  async liveSessionFor() {
    return this.live
  }

  async createSession(draft: NewCountSession) {
    this.created.push(draft)
    return { id: SESSION, lines: draft.itemIds.length }
  }

  async advanceSession(args: {
    to: CountSessionStatus
    reason: string | null
  }) {
    this.advanced.push({ to: args.to, reason: args.reason })
  }

  async snapshotExpected() {
    // The whole point: a number of items, never the quantities.
    return { items: this.expected.length }
  }

  async loadExpected() {
    return this.expected
  }

  async loadLines() {
    return this.lines
  }

  async saveCount(args: { itemId: string; countedQuantity: number }) {
    this.counts.push({
      itemId: args.itemId,
      countedQuantity: args.countedQuantity,
    })
  }

  async saveVariances(args: { variances: readonly CountVariance[] }) {
    this.savedVariances.push(...args.variances)
    return { written: args.variances.length }
  }

  async loadVariance(args: { varianceId: string }) {
    return this.variance !== null && this.variance.id === args.varianceId
      ? this.variance
      : null
  }

  async saveClassification(args: {
    classification: LossClass
    note: string | null
  }) {
    this.classifications.push({
      classification: args.classification,
      note: args.note,
    })
  }

  async recordMovement(args: {
    movement: { kind: string; quantityDelta: number }
  }) {
    this.movements.push({
      kind: args.movement.kind,
      quantityDelta: args.movement.quantityDelta,
    })
    return { id: `movement-${this.movements.length}` }
  }

  async stampLastCounted() {
    this.stamped += 1
    return { items: this.lines.length }
  }

  async unexplainedCount() {
    return this.unexplained
  }
}

function session(
  overrides: Partial<CountSessionRecord> = {},
): CountSessionRecord {
  return {
    id: SESSION,
    organizationId: ORGANIZATION,
    propertyId: PROPERTY,
    label: 'ספירת סוף ספטמבר',
    status: 'open',
    blind: true,
    scheduledFor: '2026-09-06',
    taskId: null,
    countingStartedAt: null,
    reconcilingStartedAt: null,
    closedAt: null,
    note: null,
    version: 1,
    ...overrides,
  }
}

function world(
  options: {
    mode?: InventoryMode
    session?: CountSessionRecord | null
    lines?: readonly CountLine[]
    expected?: readonly ExpectedStock[]
    variance?: CountVarianceRecord | null
    live?: { id: string; status: CountSessionStatus } | null
    unexplained?: number
  } = {},
) {
  const mode = options.mode ?? 'tracked'
  const settings =
    mode === 'off'
      ? defaultInventorySettings(ORGANIZATION)
      : startingSettingsFor(ORGANIZATION, mode)

  const ports = new RecordingPorts(
    settings,
    options.session === undefined ? session() : options.session,
    options.lines ?? [],
    options.expected ?? [],
    options.variance ?? null,
    options.live ?? null,
    options.unexplained ?? 0,
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
    counts: defineCountOperations(ports),
  }
}

/* --------------------------------------------------------- the ledger --- */

describe('expectedFromLedger', () => {
  it('re-projects the forecast record and sums nothing of its own', () => {
    const expected = expectedFromLedger({
      item: forecastItem(),
      replacementCostAgorot: 1800,
      capturedAt: NOW.toISOString(),
    })

    // `onShelf` is `onHandClean`, unchanged. Not recomputed from `byState`,
    // not derived from `quantity`, not summed from movements.
    expect(expected.onShelf).toBe(18)
    expect(expected.owned).toBe(60)
    expect(expected.elsewhere).toEqual({ laundry: 30, dirty: 12 })
    expect(expected.circulating).toBe(42)
  })

  it('carries a consumable as owned-equals-on-shelf, with no circulation', () => {
    const expected = expectedFromLedger({
      item: forecastItem({
        itemId: SOAP,
        label: 'סבון גוף',
        onHandClean: 24,
        byState: { available: 24 },
      }),
      replacementCostAgorot: 450,
      capturedAt: NOW.toISOString(),
    })

    expect(expected.onShelf).toBe(24)
    expect(expected.owned).toBe(24)
    expect(expected.circulating).toBe(0)
    expect(expected.elsewhere).toEqual({})
  })

  it('never counts damaged or lost stock as coming back', () => {
    const expected = expectedFromLedger({
      item: forecastItem({
        byState: { available: 10, damaged: 4, lost: 6, laundry: 5 },
      }),
      replacementCostAgorot: null,
      capturedAt: NOW.toISOString(),
    })

    expect(expected.owned).toBe(25)
    // Only the wash. Damaged and lost units are not an explanation for a
    // shortfall on the shelf — they are already gone from it.
    expect(expected.circulating).toBe(5)
  })
})

/* ---------------------------------------------------------- blind sheet -- */

describe('the blind count sheet', () => {
  const lines = [
    line({ itemId: TOWEL }),
    line({ itemId: SOAP, label: 'סבון גוף', countedQuantity: 22 }),
  ]

  it('does not contain the expected quantity, on any line', () => {
    const sheet = buildCountSheet({
      blind: true,
      session: session(),
      lines,
    })

    expect(sheet.blind).toBe(true)
    for (const one of sheet.lines) {
      expect('expected' in one).toBe(false)
      expect(Object.keys(one)).toEqual([
        'itemId',
        'label',
        'unitOfMeasure',
        'location',
        'counted',
        'note',
      ])
    }

    // The strongest form of the check: the number 18 is in the ledger and
    // must not appear anywhere in what the counter receives.
    expect(JSON.stringify(sheet)).not.toContain('18')
  })

  it('carries what the counter has written so far, and nothing more', () => {
    const sheet = buildCountSheet({ blind: true, session: session(), lines })

    expect(sheet.lines.map((one) => one.counted)).toEqual([null, 22])
  })

  it('shows the expectation only when the business chose an open count', () => {
    const sheet = buildCountSheet({
      blind: false,
      session: session({ blind: false }),
      lines,
      expected: new Map([[TOWEL, expectation()]]),
    })

    expect(sheet.blind).toBe(false)
    if (sheet.blind) throw new Error('narrowing failed')
    expect(sheet.lines[0].expected).toBe(18)
  })

  it('refuses to build an open sheet for a session asked to be blind', () => {
    expect(() =>
      buildCountSheet({
        blind: false,
        session: session({ blind: true }),
        lines,
        expected: new Map([[TOWEL, expectation()]]),
      }),
    ).toThrow(BusinessRuleError)
  })
})

/* -------------------------------------------------------- reconciliation -- */

describe('reconcile', () => {
  it('computes variance as expected minus counted', () => {
    const result = reconcile({
      sessionId: SESSION,
      lines: [line({ countedQuantity: 15 })],
      expected: new Map([[TOWEL, expectation({ onShelf: 18 })]]),
    })

    expect(result.variances).toHaveLength(1)
    expect(result.variances[0].expected).toBe(18)
    expect(result.variances[0].counted).toBe(15)
    expect(result.variances[0].variance).toBe(3)
  })

  it('reports a surplus as a negative variance rather than as nothing', () => {
    const result = reconcile({
      sessionId: SESSION,
      lines: [line({ countedQuantity: 21 })],
      expected: new Map([[TOWEL, expectation({ onShelf: 18 })]]),
    })

    expect(result.variances[0].variance).toBe(-3)
  })

  it('records a match without producing a row of nothing', () => {
    const result = reconcile({
      sessionId: SESSION,
      lines: [line({ countedQuantity: 18 })],
      expected: new Map([[TOWEL, expectation({ onShelf: 18 })]]),
    })

    expect(result.matched).toBe(1)
    expect(result.variances).toHaveLength(0)
    expect(result.lines[0].state).toBe('matched')
  })

  it('treats an uncounted line as uncounted, never as a variance of zero', () => {
    const result = reconcile({
      sessionId: SESSION,
      lines: [line({ countedQuantity: null })],
      expected: new Map([[TOWEL, expectation({ onShelf: 18 })]]),
    })

    // The bug this guards: counting `null` as zero would report all eighteen
    // towels as missing the first time somebody was called away half way.
    expect(result.uncounted).toEqual([TOWEL])
    expect(result.variances).toHaveLength(0)
    expect(result.lines[0].variance).toBeNull()
    expect(result.lines[0].state).toBe('uncounted')
  })

  it('names a line with no snapshot instead of comparing it to zero', () => {
    const result = reconcile({
      sessionId: SESSION,
      lines: [line({ countedQuantity: 4 })],
      expected: new Map(),
    })

    expect(result.unsnapshotted).toEqual([TOWEL])
    expect(result.variances).toHaveLength(0)
    expect(result.lines).toHaveLength(0)
  })

  it('carries the circulation figures into the variance', () => {
    const result = reconcile({
      sessionId: SESSION,
      lines: [line({ countedQuantity: 15 })],
      expected: new Map([[TOWEL, expectation()]]),
    })

    expect(result.variances[0].circulating).toBe(42)
    expect(result.variances[0].replacementCostAgorot).toBe(1800)
  })
})

describe('explainVariance', () => {
  it('says the arithmetic out loud in Hebrew', () => {
    const variance: CountVariance = {
      itemId: TOWEL,
      label: 'מגבת רחצה',
      expected: 18,
      counted: 15,
      variance: 3,
      elsewhere: { laundry: 30 },
      circulating: 30,
      replacementCostAgorot: 1800,
    }

    const sentence = explainVariance(variance)
    expect(sentence).toContain('18')
    expect(sentence).toContain('15')
    expect(sentence).toContain('חסרים 3')
    expect(sentence).toContain('30')
  })
})

/* ----------------------------------------------------------- transitions -- */

describe('session transitions', () => {
  it('walks open → counting → reconciling → closed and nothing else', () => {
    expect(canAdvance('open', 'counting')).toBe(true)
    expect(canAdvance('counting', 'reconciling')).toBe(true)
    expect(canAdvance('reconciling', 'closed')).toBe(true)
    expect(canAdvance('open', 'closed')).toBe(false)
    expect(canAdvance('open', 'reconciling')).toBe(false)
  })

  it('lets any live session be cancelled and none be reopened', () => {
    expect(canAdvance('open', 'cancelled')).toBe(true)
    expect(canAdvance('counting', 'cancelled')).toBe(true)
    expect(canAdvance('reconciling', 'cancelled')).toBe(true)
    expect(COUNT_SESSION_TRANSITIONS.closed).toEqual([])
    expect(COUNT_SESSION_TRANSITIONS.cancelled).toEqual([])
  })

  it('refuses an illegal move in a sentence rather than a code', () => {
    expect(() => assertTransition('closed', 'counting')).toThrow(
      BusinessRuleError,
    )
  })
})

/* ------------------------------------------------------------ operations -- */

describe('inventory.count.session.open', () => {
  function open(built: ReturnType<typeof world>, grants: readonly Grant[]) {
    return built.counts.openSession.run({
      request: {
        input: {
          propertyId: '9e8d7c6b-5a49-4382-9271-abcdefabcdef',
          label: 'ספירת סוף ספטמבר',
          blind: true,
          scheduledFor: '2026-09-06',
          taskId: null,
          note: null,
          itemIds: [TOWEL, SOAP],
        },
      },
      context: context(grants),
      services: built.services,
    })
  }

  it('refuses without inventory.adjust', async () => {
    const built = world()
    await expect(open(built, ['inventory.view'])).rejects.toBeInstanceOf(
      AuthorizationError,
    )
    expect(built.ports.created).toHaveLength(0)
  })

  it('refuses when the stock module is off, as a configuration answer', async () => {
    const built = world({ mode: 'off' })
    await expect(open(built, ['inventory.adjust'])).rejects.toBeInstanceOf(
      BusinessRuleError,
    )
    expect(built.ports.created).toHaveLength(0)
  })

  it('refuses a second live session for the same property', async () => {
    const built = world({ live: { id: 'other', status: 'counting' } })
    await expect(open(built, ['inventory.adjust'])).rejects.toBeInstanceOf(
      BusinessRuleError,
    )
  })

  it('opens a blind session and records the audit sentence', async () => {
    const built = world()
    const outcome = await open(built, ['inventory.adjust'])

    expect(outcome.data.sessionId).toBe(SESSION)
    expect(outcome.data.lines).toBe(2)
    expect(built.ports.created[0].blind).toBe(true)
    expect(built.audit.records).toHaveLength(1)
    expect(built.audit.records[0].summary).toContain('עיוורת')
  })
})

describe('inventory.count.session.start', () => {
  it('snapshots the ledger and returns a count, never the quantities', async () => {
    const built = world({
      expected: [expectation(), expectation({ itemId: SOAP, onShelf: 24 })],
    })

    const outcome = await built.counts.startCounting.run({
      request: { input: { sessionId: SESSION } },
      context: context(['inventory.adjust']),
      services: built.services,
    })

    expect(outcome.data).toEqual({ itemsSnapshotted: 2 })
    // Nothing in the result, at any depth, carries an expected quantity.
    expect(JSON.stringify(outcome.data)).not.toContain('18')
    expect(built.ports.advanced).toEqual([{ to: 'counting', reason: null }])
  })

  it('refuses to start a session that has already been counted', async () => {
    const built = world({ session: session({ status: 'closed' }) })

    await expect(
      built.counts.startCounting.run({
        request: { input: { sessionId: SESSION } },
        context: context(['inventory.adjust']),
        services: built.services,
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })
})

describe('inventory.count.record', () => {
  it('accepts a quantity and nothing that could echo the ledger', async () => {
    const built = world({ session: session({ status: 'counting' }) })

    await built.counts.recordCount.run({
      request: {
        input: {
          sessionId: SESSION,
          itemId: TOWEL,
          countedQuantity: 15,
          note: null,
        },
      },
      context: context(['inventory.adjust']),
      services: built.services,
    })

    expect(built.ports.counts).toEqual([{ itemId: TOWEL, countedQuantity: 15 }])
  })

  it('refuses an input carrying an expected quantity', async () => {
    const built = world({ session: session({ status: 'counting' }) })

    await expect(
      built.counts.recordCount.run({
        request: {
          input: {
            sessionId: SESSION,
            itemId: TOWEL,
            countedQuantity: 15,
            note: null,
            // A screen that tried to send the expectation back is refused by
            // the schema, which names no such field.
            expected: 18,
          },
        },
        context: context(['inventory.adjust']),
        services: built.services,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(built.ports.counts).toHaveLength(0)
  })

  it('refuses a count before the session has started', async () => {
    const built = world({ session: session({ status: 'open' }) })

    await expect(
      built.counts.recordCount.run({
        request: {
          input: {
            sessionId: SESSION,
            itemId: TOWEL,
            countedQuantity: 15,
            note: null,
          },
        },
        context: context(['inventory.adjust']),
        services: built.services,
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })
})

describe('inventory.count.session.reconcile', () => {
  it('writes only the non-zero differences and reports the rest', async () => {
    const built = world({
      session: session({ status: 'counting' }),
      lines: [
        line({ itemId: TOWEL, countedQuantity: 15 }),
        line({ itemId: SOAP, label: 'סבון גוף', countedQuantity: 24 }),
        line({ id: 'line-3', itemId: 'unfinished', countedQuantity: null }),
      ],
      expected: [
        expectation({ itemId: TOWEL, onShelf: 18 }),
        expectation({ itemId: SOAP, onShelf: 24, circulating: 0 }),
        expectation({ itemId: 'unfinished', onShelf: 9 }),
      ],
    })

    const outcome = await built.counts.reconcileSession.run({
      request: { input: { sessionId: SESSION } },
      context: context(['inventory.adjust']),
      services: built.services,
    })

    expect(outcome.data).toEqual({
      variances: 1,
      matched: 1,
      uncounted: 1,
      unsnapshotted: 0,
    })
    expect(built.ports.savedVariances).toHaveLength(1)
    expect(built.ports.savedVariances[0].variance).toBe(3)
  })

  it('raises the closest frozen event, with no money in it', async () => {
    const built = world({
      session: session({ status: 'counting' }),
      lines: [line({ countedQuantity: 15 })],
      expected: [expectation()],
    })

    const outcome = await built.counts.reconcileSession.run({
      request: { input: { sessionId: SESSION } },
      context: context(['inventory.adjust']),
      services: built.services,
    })

    expect(outcome.events).toHaveLength(1)
    expect(outcome.events[0].name).toBe('inventory.discrepancy_detected')
    expect(JSON.stringify(outcome.events[0].payload)).not.toContain('agorot')
  })

  it('raises nothing when everything matched', async () => {
    const built = world({
      session: session({ status: 'counting' }),
      lines: [line({ countedQuantity: 18 })],
      expected: [expectation()],
    })

    const outcome = await built.counts.reconcileSession.run({
      request: { input: { sessionId: SESSION } },
      context: context(['inventory.adjust']),
      services: built.services,
    })

    expect(outcome.events).toHaveLength(0)
  })
})

describe('inventory.count.variance.classify', () => {
  function variance(
    overrides: Partial<CountVarianceRecord> = {},
  ): CountVarianceRecord {
    return {
      id: VARIANCE,
      sessionId: SESSION,
      organizationId: ORGANIZATION,
      propertyId: PROPERTY,
      itemId: TOWEL,
      label: 'מגבת רחצה',
      expected: 18,
      counted: 15,
      variance: 3,
      circulating: 42,
      replacementCostAgorot: 1800,
      classification: null,
      ...overrides,
    }
  }

  function classify(
    built: ReturnType<typeof world>,
    grants: readonly Grant[],
    classification: LossClass,
    note: string | null = 'נבדקו כל הארונות בקומה.',
  ) {
    return built.counts.classifyVariance.run({
      request: { input: { varianceId: VARIANCE, classification, note } },
      context: context(grants),
      services: built.services,
    })
  }

  it('writes no movement for an unexplained variance', async () => {
    const built = world({ variance: variance() })
    const outcome = await classify(built, ['inventory.adjust'], 'unknown')

    expect(outcome.data.movementId).toBeNull()
    expect(built.ports.movements).toHaveLength(0)
    expect(built.ports.classifications[0].classification).toBe('unknown')
  })

  it('refuses an actor who cannot write the ledger, before the table does', async () => {
    const built = world({ variance: variance() })

    // 0011 gates `inventory_movements_insert` on `inventory.edit` while this
    // operation declares `inventory.adjust`. The refusal has to arrive here,
    // as a sentence, rather than as a SQLSTATE at the end of the write.
    await expect(
      classify(built, ['inventory.adjust'], 'damaged'),
    ).rejects.toBeInstanceOf(AuthorizationError)
    expect(built.ports.movements).toHaveLength(0)
  })

  it('writes the movement the classification implies', async () => {
    const built = world({ variance: variance() })
    const outcome = await classify(
      built,
      ['inventory.adjust', 'inventory.edit'],
      'damaged',
    )

    expect(outcome.data.movementId).toBe('movement-1')
    expect(built.ports.movements[0]).toEqual({
      kind: 'adjustment',
      quantityDelta: -3,
    })
  })

  it('refuses laundry as an explanation for an item that never circulates', async () => {
    const built = world({ variance: variance({ circulating: 0 }) })

    await expect(
      classify(built, ['inventory.adjust', 'inventory.edit'], 'in_laundry'),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })
})

describe('inventory.count.session.close', () => {
  it('closes a clean count without demanding a reason', async () => {
    const built = world({
      session: session({ status: 'reconciling' }),
      lines: [line()],
      unexplained: 0,
    })

    const outcome = await built.counts.closeSession.run({
      request: { input: { sessionId: SESSION } },
      context: context(['inventory.adjust']),
      services: built.services,
    })

    expect(outcome.data.unexplained).toBe(0)
    expect(built.ports.stamped).toBe(1)
  })

  it('demands a stated reason when differences remain unexplained', async () => {
    const built = world({
      session: session({ status: 'reconciling' }),
      unexplained: 11,
    })

    await expect(
      built.counts.closeSession.run({
        request: { input: { sessionId: SESSION } },
        context: context(['inventory.adjust']),
        services: built.services,
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
    expect(built.ports.advanced).toHaveLength(0)
  })

  it('closes with unexplained differences once somebody says why', async () => {
    const built = world({
      session: session({ status: 'reconciling' }),
      lines: [line()],
      unexplained: 11,
    })

    const outcome = await built.counts.closeSession.run({
      request: { input: { sessionId: SESSION } },
      context: context(
        ['inventory.adjust'],
        'נבדקו כל המחסנים ורכב הכביסה. ההפרש נשאר פתוח לספירה הבאה.',
      ),
      services: built.services,
    })

    expect(outcome.data.unexplained).toBe(11)
    expect(built.ports.advanced).toEqual([{ to: 'closed', reason: null }])
  })
})

describe('inventory.count.session.cancel', () => {
  it('refuses without a stated reason', async () => {
    const built = world({ session: session({ status: 'counting' }) })

    await expect(
      built.counts.cancelSession.run({
        request: { input: { sessionId: SESSION } },
        context: context(['inventory.adjust'], null),
        services: built.services,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('writes no movement at all', async () => {
    const built = world({ session: session({ status: 'counting' }) })

    await built.counts.cancelSession.run({
      request: { input: { sessionId: SESSION } },
      context: context(['inventory.adjust'], 'המחסן ננעל והספירה הופסקה.'),
      services: built.services,
    })

    expect(built.ports.movements).toHaveLength(0)
    expect(built.ports.advanced[0].to).toBe('cancelled')
  })
})
