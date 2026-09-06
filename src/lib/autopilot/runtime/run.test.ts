/**
 * The pass, end to end, with no database anywhere.
 *
 * The four stages were already exercisable without Supabase and the point of
 * injecting everything into `runAutopilotPass` was to keep that true once they
 * had a caller. So this drives detection, triage, the safety engine and the
 * executor over in-memory doubles, and the claim it exists to make is the one
 * that would be catastrophic to get wrong:
 *
 *   a pass in SIMULATION performs no command.
 *
 * Asserted by handing the registry a handler that records every invocation and
 * then proving it was never invoked — rather than by reading the row's outcome,
 * which is what a bug in the executor would also produce.
 */

import { describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../../audit/pipeline'
import type { Actor } from '../../authz/can'
import { PERMISSIONS, type Grant } from '../../authz/permissions'
import { ENTITLEMENTS } from '../../plans/entitlements'
import {
  InMemoryAutopilotActionRepository,
  InMemoryAutopilotLedger,
  createCommandRegistry,
  type CommandInvocation,
  type ExecutionDeps,
} from '../execute'
import { InMemoryAutopilotPolicyRepository } from '../policy/repository'
import {
  ALL_MODULES,
  type CleaningFacts,
  type EnabledModules,
} from '../signals'

import type { AutopilotFactPorts, FactScope, StatedModules } from './ports'
import { runAutopilotPass } from './run'

const ORG = '11111111-1111-4111-8111-111111111111'
const PROPERTY = '22222222-2222-4222-8222-222222222222'
const TASK = '33333333-3333-4333-8333-333333333333'
const OWNER = '44444444-4444-4444-8444-444444444444'

const NOW = new Date('2026-09-06T09:00:00.000Z')

const STATED: StatedModules = {
  cleaning: true,
  inspection: false,
  maintenance: true,
  access: false,
}

function actor(): Actor {
  return {
    userId: OWNER,
    organizationId: ORG,
    membershipStatus: 'active',
    grants: new Set<Grant>(PERMISSIONS),
    scope: { kind: 'all_organization' },
    entitlements: new Set(ENTITLEMENTS),
  }
}

/**
 * One cleaning job nobody is on.
 *
 * The smallest fact set that produces a signal with a proposal whose first rung
 * is a bound command: `cleaning.unassigned` is a `staff` signal, and the head of
 * the staff ladder is `task.assign`, which runs `tasks.assignTask`.
 */
function unassignedCleaning(): CleaningFacts {
  return {
    taskId: TASK,
    bookingId: null,
    propertyId: PROPERTY,
    label: 'וילה ים',
    status: 'new',
    assigneeId: null,
    acceptedAt: null,
    startedAt: null,
    completedAt: null,
    verifiedAt: null,
    inspectionRequired: false,
    dueAt: '2026-09-06T11:00:00.000Z',
    blockedReason: null,
  }
}

class MemoryFacts implements AutopilotFactPorts {
  readonly scopes: FactScope[] = []

  constructor(private readonly cleaning: readonly CleaningFacts[]) {}

  async timeZone(): Promise<string> {
    return 'Asia/Jerusalem'
  }

  async quietWindow() {
    return {
      enabled: false,
      start: '22:00',
      end: '07:00',
      timezone: 'Asia/Jerusalem',
    }
  }

  async modules(): Promise<EnabledModules> {
    return ALL_MODULES
  }

  async loadCleaning(scope: FactScope): Promise<readonly CleaningFacts[]> {
    this.scopes.push(scope)
    return this.cleaning
  }

  async loadMaintenance() {
    return []
  }

  async loadLaundry() {
    return []
  }

  async loadPreparation() {
    return []
  }

  async loadContracts() {
    return []
  }

  // Null, not empty: nothing can supply these, and an empty array would be a
  // confident claim about a world nobody looked at.
  async loadPayments() {
    return null
  }

  async loadShortages() {
    return null
  }

  async loadAccess() {
    return null
  }

  async loadEmptyNights() {
    return null
  }
}

function policiesFor(options: {
  runMode: 'simulation' | 'live'
}): InMemoryAutopilotPolicyRepository {
  const repository = new InMemoryAutopilotPolicyRepository()

  repository.settings.set(ORG, {
    organizationId: ORG,
    level: 'autopilot',
    runMode: options.runMode,
    enabled: true,
    pausedUntil: null,
    pausedReason: null,
    lookaheadHours: 72,
  })

  repository.policies.push({
    id: 'policy-1',
    organizationId: ORG,
    propertyId: null,
    actionKind: 'task.assign',
    disposition: 'auto',
  })

  return repository
}

function executionFor(): {
  deps: ExecutionDeps
  invocations: CommandInvocation[]
  repository: InMemoryAutopilotActionRepository
} {
  const invocations: CommandInvocation[] = []
  const repository = new InMemoryAutopilotActionRepository()

  return {
    invocations,
    repository,
    deps: {
      repository,
      registry: createCommandRegistry({
        async 'tasks.assignTask'(invocation) {
          invocations.push(invocation)
          return { assigned: true }
        },
      }),
      ledger: new InMemoryAutopilotLedger(),
      audit: new InMemoryAuditWriter(),
      now: () => NOW,
      correlationId: 'pass-1',
    },
  }
}

async function pass(runMode: 'simulation' | 'live') {
  const facts = new MemoryFacts([unassignedCleaning()])
  const execution = executionFor()

  const report = await runAutopilotPass({
    organizationId: ORG,
    propertyId: null,
    actor: actor(),
    facts,
    policies: policiesFor({ runMode }),
    execution: execution.deps,
    trigger: 'sweep:2026-09-06T09',
    modules: STATED,
    pageSize: 50,
    now: NOW,
  })

  return { report, facts, ...execution }
}

describe('a pass in simulation', () => {
  it('performs no command', async () => {
    const { report, invocations } = await pass('simulation')

    expect(report.executed).toHaveLength(1)
    expect(report.executed[0]?.outcome.status).toBe('simulated')
    // The load-bearing assertion. The row saying `simulated` is what a bug in
    // the executor would also produce; the handler never having been called is
    // what the customer is actually promised.
    expect(invocations).toHaveLength(0)
  })

  it('still records the action, with the reason a live run would have had', async () => {
    const { repository } = await pass('simulation')

    expect(repository.rows).toHaveLength(1)
    expect(repository.rows[0]?.runMode).toBe('simulation')
    expect(repository.rows[0]?.reason.length).toBeGreaterThan(0)
  })
})

describe('a pass in live mode', () => {
  it('runs the command the action names', async () => {
    const { report, invocations } = await pass('live')

    expect(report.executed[0]?.outcome.status).toBe('executed')
    expect(invocations).toHaveLength(1)
    // The action's own idempotency key travels into the domain pipeline, so a
    // second delivery replays rather than assigning twice.
    expect(invocations[0]?.idempotencyKey).toContain('autopilot:')
  })
})

describe('what the pass reports about itself', () => {
  it('names the detectors it could not run rather than reporting no findings', async () => {
    const { report } = await pass('simulation')

    expect([...report.unsourced].sort()).toEqual([
      'access',
      'inventory',
      'opportunity',
      'payment',
    ])
  })

  it('reads the horizon off the organization row rather than choosing one', async () => {
    const { facts } = await pass('simulation')

    const scope = facts.scopes[0]
    expect(scope?.from).toEqual(NOW)
    // 72 hours, which is what the settings row says and what nothing in the
    // runtime is allowed to decide for a business.
    expect(scope?.to.getTime()).toBe(NOW.getTime() + 72 * 3_600_000)
  })

  it('returns the refusal sentence when the safety engine says no', async () => {
    const policies = policiesFor({ runMode: 'live' })
    policies.settings.set(ORG, {
      organizationId: ORG,
      level: 'autopilot',
      runMode: 'live',
      enabled: false,
      pausedUntil: null,
      pausedReason: null,
      lookaheadHours: 72,
    })

    const execution = executionFor()
    const report = await runAutopilotPass({
      organizationId: ORG,
      propertyId: null,
      actor: actor(),
      facts: new MemoryFacts([unassignedCleaning()]),
      policies,
      execution: execution.deps,
      trigger: 'sweep:2026-09-06T09',
      modules: STATED,
      pageSize: 50,
      now: NOW,
    })

    expect(report.executed).toHaveLength(0)
    expect(report.refused[0]?.reason).toBe('kill_switch')
    expect(report.refused[0]?.explanation.length).toBeGreaterThan(0)
    // Nothing was planned, so nothing was recorded — and no command ran.
    expect(execution.repository.rows).toHaveLength(0)
    expect(execution.invocations).toHaveLength(0)
  })
})
