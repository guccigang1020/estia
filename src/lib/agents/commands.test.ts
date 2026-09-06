/**
 * The two agent-network commands, through the real service pipeline.
 *
 * What these tests are actually for: neither command can send anything, so the
 * only thing worth proving is that each one REFUSES the messages that would
 * have been wrong, and that neither ever claims to have delivered.
 *
 *   · a reminder to an agent who was suspended last week;
 *   · a reminder about a hold that belongs to a different agent;
 *   · a reminder about a hold that expired two hours ago;
 *   · an "empty night" opportunity for nights that are sold.
 */

import { describe, expect, it } from 'vitest'

import type { AuditRecord, AuditWriter } from '../audit/pipeline'
import { AuthorizationError, type Actor } from '../authz/can'
import { PERMISSIONS, type Grant } from '../authz/permissions'
import type {
  AvailabilitySource,
  AvailabilityWindow,
  OccupyingBooking,
  UnitAvailabilityRules,
} from '../booking/availability'
import type { Hold } from '../booking/types'
import { BusinessRuleError, NotFoundError } from '../errors'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'
import {
  InMemoryEventBus,
  InMemoryIdempotencyStore,
  RecordingTransactionRunner,
  type OperationContext,
} from '../service'
import { AGENT_PRESETS } from './access'
import { defineAgentCommands } from './commands'
import type { AgentHoldLedgerEntry } from './holds'
import type { AgentRepository } from './repository'
import type { AgentOrganizationSettings } from './types'

const ORG = 'org-a'
const AGENT = 'agent-1'
const OWNER = 'owner-1'
const UNIT = 'unit-1'
const PROPERTY = 'property-1'
const HOLD = 'hold-7'

/** 12:00 Israel time on 1 September. The seeded hold expires at 12:25. */
const NOW = new Date('2026-09-01T09:00:00.000Z')
const EXPIRES_AT = '2026-09-01T09:25:00.000Z'

const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

/* ------------------------------------------------------------- the world -- */

function settingsFor(
  overrides: Partial<AgentOrganizationSettings> = {},
): AgentOrganizationSettings {
  return {
    organizationId: ORG,
    agentUserId: AGENT,
    membershipId: 'mem-1',
    status: 'active',
    access: AGENT_PRESETS.sales,
    inventory: { kind: 'all_properties' },
    discountCap: { maxPercent: 0, maxAgorot: null },
    holdLimits: {
      maxConcurrent: 3,
      maxPerDay: 10,
      maxExtensions: 1,
      defaultMinutes: 30,
      maxMinutes: 120,
    },
    reputationScore: 0,
    agencyId: null,
    internalNote: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    version: 1,
    ...overrides,
  }
}

function ledgerEntry(
  overrides: Partial<AgentHoldLedgerEntry> = {},
): AgentHoldLedgerEntry {
  return {
    holdId: HOLD,
    organizationId: ORG,
    agentUserId: AGENT,
    createdAt: NOW.toISOString(),
    extensionCount: 0,
    ...overrides,
  }
}

/** Only the four reads these two commands make are implemented honestly. */
function makeRepo(seed: {
  settings?: AgentOrganizationSettings | null
  ledger?: readonly AgentHoldLedgerEntry[]
}): AgentRepository {
  const unused = (name: string) => async () => {
    throw new Error(`${name} is not reachable from these commands`)
  }

  return {
    findUserByPhone: unused('findUserByPhone'),
    findMembership: unused('findMembership'),
    findPendingInvitation: unused('findPendingInvitation'),
    async loadSettings() {
      return seed.settings ?? null
    },
    saveSettings: unused('saveSettings'),
    insertInvitation: unused('insertInvitation'),
    attachExistingUser: unused('attachExistingUser'),
    async loadHoldLedger() {
      return seed.ledger ?? []
    },
    insertLedgerEntry: unused('insertLedgerEntry'),
    saveLedgerEntry: unused('saveLedgerEntry'),
    loadCommission: unused('loadCommission'),
    loadCommissionRules: unused('loadCommissionRules'),
    saveCommission: unused('saveCommission'),
    loadApproval: unused('loadApproval'),
    insertApproval: unused('insertApproval'),
    saveApproval: unused('saveApproval'),
  }
}

/** A calendar that is free unless a test puts something in it. */
class MemoryAvailability implements AvailabilitySource {
  bookings: OccupyingBooking[] = []
  holds: Hold[] = []
  rules: UnitAvailabilityRules | null = {
    unitId: UNIT,
    minimumNights: 1,
    blockedDates: [],
  }

  async loadBookings(
    _window: AvailabilityWindow,
  ): Promise<readonly OccupyingBooking[]> {
    return this.bookings
  }

  async loadHolds(_window: AvailabilityWindow): Promise<readonly Hold[]> {
    return this.holds
  }

  async loadRules(): Promise<UnitAvailabilityRules | null> {
    return this.rules
  }
}

class MemoryAudit implements AuditWriter {
  readonly records: AuditRecord[] = []
  async write(record: AuditRecord): Promise<void> {
    this.records.push(record)
  }
}

function actorWith(grants: readonly Grant[]): Actor {
  return {
    userId: OWNER,
    organizationId: ORG,
    membershipStatus: 'active',
    grants: new Set<Grant>(grants),
    scope: { kind: 'all_organization' },
    entitlements: EVERY_ENTITLEMENT,
  }
}

function contextFor(
  actor: Actor = actorWith(PERMISSIONS),
  now: Date = NOW,
): OperationContext {
  return {
    actor,
    auditActor: { type: 'user', userId: OWNER, label: 'דנה, הבעלים' },
    correlationId: 'req-agent-commands',
    now,
  }
}

function wiring() {
  return {
    audit: new MemoryAudit(),
    events: new InMemoryEventBus(),
    idempotency: new InMemoryIdempotencyStore(),
    transactions: new RecordingTransactionRunner(),
  }
}

function rejection<E>(promise: Promise<unknown>): Promise<E> {
  return promise.then(
    () => {
      throw new Error('expected the command to be refused, but it succeeded')
    },
    (error: unknown) => error as E,
  )
}

function reminderInput(overrides: Record<string, unknown> = {}) {
  return {
    agentUserId: AGENT,
    kind: 'hold_expiring',
    holdId: HOLD,
    expiresAt: EXPIRES_AT,
    unitLabel: 'וילה הכרמל',
    ...overrides,
  }
}

function opportunityInput(overrides: Record<string, unknown> = {}) {
  return {
    unitId: UNIT,
    unitLabel: 'וילה הכרמל',
    propertyId: PROPERTY,
    checkIn: '2026-10-01',
    checkOut: '2026-10-04',
    note: null,
    ...overrides,
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */

describe('agent.reminder.prepare', () => {
  it('prepares the sentence and never claims it was delivered', async () => {
    const commands = defineAgentCommands({
      repo: makeRepo({ settings: settingsFor(), ledger: [ledgerEntry()] }),
      availability: new MemoryAvailability(),
    })
    const services = wiring()

    const outcome = await commands.sendReminder.run({
      request: { input: reminderInput() },
      context: contextFor(),
      services,
    })

    expect(outcome.data.delivered).toBe(false)
    expect(outcome.data.channel).toBeNull()
    expect(outcome.data.handoff).toBe('manual')
    expect(outcome.data.minutesLeft).toBe(25)
    expect(outcome.data.message).toContain('וילה הכרמל')

    expect(services.audit.records).toHaveLength(1)
    expect(services.audit.records[0].summary).toContain('טרם נשלחה')
    // The frozen catalogue has no name for this, and none is invented.
    expect(services.events.published).toEqual([])
  })

  it('refuses to remind a suspended agent, and says what their state is', async () => {
    const commands = defineAgentCommands({
      repo: makeRepo({
        settings: settingsFor({ status: 'suspended' }),
        ledger: [ledgerEntry()],
      }),
      availability: new MemoryAvailability(),
    })

    const error = await rejection<BusinessRuleError>(
      commands.sendReminder.run({
        request: { input: reminderInput() },
        context: contextFor(),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('agent_reminder.agent_not_active')
    expect(error.userMessage).toContain('מושהה')
  })

  /**
   * The leak this closes: a planner that computed the wrong hold id would
   * otherwise tell one agent that a rival's deal is about to expire.
   */
  it("refuses a hold that is not in that agent's own ledger", async () => {
    const commands = defineAgentCommands({
      repo: makeRepo({
        settings: settingsFor(),
        ledger: [ledgerEntry({ holdId: 'hold-somebody-else' })],
      }),
      availability: new MemoryAvailability(),
    })

    const error = await rejection<BusinessRuleError>(
      commands.sendReminder.run({
        request: { input: reminderInput() },
        context: contextFor(),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('agent_reminder.hold_not_theirs')
    expect(error.userMessage).toContain(HOLD)
  })

  it('refuses to remind about a hold that has already expired', async () => {
    const commands = defineAgentCommands({
      repo: makeRepo({ settings: settingsFor(), ledger: [ledgerEntry()] }),
      availability: new MemoryAvailability(),
    })

    const error = await rejection<BusinessRuleError>(
      commands.sendReminder.run({
        request: { input: reminderInput() },
        context: contextFor(
          actorWith(PERMISSIONS),
          new Date('2026-09-01T11:00:00.000Z'),
        ),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('agent_reminder.hold_already_expired')
  })

  it('reports an agent this organization does not have as not found', async () => {
    const commands = defineAgentCommands({
      repo: makeRepo({ settings: null }),
      availability: new MemoryAvailability(),
    })

    await expect(
      rejection<NotFoundError>(
        commands.sendReminder.run({
          request: { input: reminderInput() },
          context: contextFor(),
          services: wiring(),
        }),
      ),
    ).resolves.toBeInstanceOf(NotFoundError)
  })

  it('refuses without agent.manage, before reading anything', async () => {
    const commands = defineAgentCommands({
      repo: makeRepo({ settings: settingsFor(), ledger: [ledgerEntry()] }),
      availability: new MemoryAvailability(),
    })

    const error = await rejection<AuthorizationError>(
      commands.sendReminder.run({
        request: { input: reminderInput() },
        context: contextFor(actorWith(['agent.view'])),
        services: wiring(),
      }),
    )

    expect(error).toBeInstanceOf(AuthorizationError)
  })
})

/* ══════════════════════════════════════════════════════════════════════════ */

describe('agent.opportunity.prepare', () => {
  it('prepares a notice with no price on it and does not publish it', async () => {
    const commands = defineAgentCommands({
      repo: makeRepo({}),
      availability: new MemoryAvailability(),
    })
    const services = wiring()

    const outcome = await commands.publishOpportunity.run({
      request: { input: opportunityInput() },
      context: contextFor(),
      services,
    })

    expect(outcome.data.published).toBe(false)
    expect(outcome.data.priced).toBe(false)
    expect(outcome.data.nights).toBe(3)
    expect(outcome.data.notice).toContain('וילה הכרמל')
    // Pricing is `price.suggest`, a different action with a different grant.
    expect(outcome.data.notice).not.toMatch(/₪/)

    expect(services.audit.records[0].summary).toContain('טרם פורסמה')
    expect(services.events.published).toEqual([])
  })

  it('refuses nights that are not empty, without naming who has them', async () => {
    const availability = new MemoryAvailability()
    availability.bookings = [
      {
        id: 'bk-1',
        reference: '8892',
        status: 'confirmed',
        checkIn: '2026-10-02',
        checkOut: '2026-10-05',
      },
    ]

    const commands = defineAgentCommands({
      repo: makeRepo({}),
      availability,
    })

    const error = await rejection<BusinessRuleError>(
      commands.publishOpportunity.run({
        request: { input: opportunityInput() },
        context: contextFor(),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('agent_opportunity.not_free')
    // A notice one keystroke away from the whole network must not carry
    // somebody else's booking reference.
    expect(error.userMessage).not.toContain('8892')
    expect(error.userMessage).not.toContain('bk-1')
  })

  it('refuses a hold on the same nights, and does not say a rival holds them', async () => {
    const availability = new MemoryAvailability()
    availability.holds = [
      {
        id: 'hold-rival',
        organizationId: ORG,
        unitId: UNIT,
        checkIn: '2026-10-01',
        checkOut: '2026-10-03',
        reason: 'agent_quote',
        heldByUserId: 'agent-2',
        expiresAt: '2026-12-01T00:00:00.000Z',
        releasedAt: null,
        convertedToBookingId: null,
      },
    ]

    const commands = defineAgentCommands({ repo: makeRepo({}), availability })

    const error = await rejection<BusinessRuleError>(
      commands.publishOpportunity.run({
        request: { input: opportunityInput() },
        context: contextFor(),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('agent_opportunity.not_free')
    expect(error.userMessage).not.toContain('hold-rival')
    expect(error.userMessage).not.toContain('agent-2')
  })

  it('refuses dates that have already gone', async () => {
    const commands = defineAgentCommands({
      repo: makeRepo({}),
      availability: new MemoryAvailability(),
    })

    const error = await rejection<BusinessRuleError>(
      commands.publishOpportunity.run({
        request: {
          input: opportunityInput({
            checkIn: '2026-08-01',
            checkOut: '2026-08-04',
          }),
        },
        context: contextFor(),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('agent_opportunity.dates_past')
  })

  it('refuses without agent.manage, before touching the calendar', async () => {
    const availability = new MemoryAvailability()
    const commands = defineAgentCommands({ repo: makeRepo({}), availability })

    const error = await rejection<AuthorizationError>(
      commands.publishOpportunity.run({
        request: { input: opportunityInput() },
        context: contextFor(actorWith(['agent.view'])),
        services: wiring(),
      }),
    )

    expect(error).toBeInstanceOf(AuthorizationError)
  })
})
