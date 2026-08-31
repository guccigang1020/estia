/**
 * The automation engine, held to the six qualities it claims.
 *
 * Each of the following has at least one test that fails if the quality is
 * removed, rather than a test that merely exercises the happy path:
 *
 *   · **idempotency** — one logical event, delivered three times, performs the
 *     work once.
 *   · **no duplicate execution** — two rules on one event do not deduplicate
 *     each other, and two actions inside one rule do not either. The narrow
 *     failure of a too-coarse key, not the broad one.
 *   · **retry** — a transient failure is retried up to the cap; a permanent
 *     failure is not retried at all.
 *   · **audit** — exactly one record per executed action, carrying
 *     `actorType: 'system'`, the rule's name, and the grant that authorised it.
 *   · **capability awareness** — a package without `automation` runs nothing,
 *     and an action whose feature is missing is refused as a plan refusal.
 *   · **permission-safe actions** — an actor without the grant does not perform
 *     the action, and the engine says which grant was missing.
 *
 * The performer, the ledger, the audit writer, the clock and the sleep are all
 * injected, so none of this waits on wall-clock time and none of it touches a
 * database.
 */

import { describe, expect, it } from 'vitest'

import { InMemoryAuditWriter, FailingAuditWriter } from '../audit/pipeline'
import type { Actor } from '../authz/can'
import type { Grant } from '../authz/permissions'
import type { DomainEvent, DomainEventName } from '../contracts/events'
import { AppError } from '../errors/app-error'
import type { Entitlement } from '../plans/entitlements'

import {
  InMemoryAutomationLedger,
  executedActions,
  executionKey,
  needsAttention,
  runAutomations,
  type ActionResult,
  type AutomationPerformer,
  type AutomationRun,
  type PerformInput,
  type RuleResult,
} from './engine'
import type { AutomationFacts, AutomationRule } from './types'

const ORG = 'org-estia'
const OTHER_ORG = 'org-somebody-else'

/* ------------------------------------------------------------- fixtures --- */

/**
 * The default package carries every feature the action catalogue's grants are
 * gated on — `operations` for `task.create`, `approvals` for
 * `approval.request` — so a test about retries is not silently a test about
 * entitlements. The plan tests below pass their own list.
 */
function actor(
  grants: readonly Grant[],
  entitlements: readonly Entitlement[] = [
    'core',
    'automation',
    'operations',
    'approvals',
  ],
): Actor {
  return {
    userId: 'user-1',
    organizationId: ORG,
    membershipStatus: 'active',
    grants: new Set<Grant>(grants),
    scope: { kind: 'all_organization' },
    entitlements: new Set<Entitlement>(entitlements),
  }
}

function event(
  name: DomainEventName,
  overrides: Partial<DomainEvent> = {},
): DomainEvent {
  return {
    name,
    organizationId: ORG,
    resourceType: 'booking',
    resourceId: 'booking-9',
    propertyId: 'property-1',
    actorUserId: null,
    occurredAt: '2026-03-01T09:00:00.000Z',
    correlationId: 'corr-1',
    idempotencyKey: 'delivery-abc',
    payload: {},
    ...overrides,
  }
}

function rule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule-1',
    name: 'הזמנה אושרה',
    description: 'בדיקה',
    when: 'booking.confirmed',
    conditions: [],
    actions: [{ kind: 'notify_team', note: 'הצוות עודכן' }],
    enabled: true,
    ...overrides,
  }
}

/** Records what it was asked to do; fails on demand. */
class RecordingPerformer implements AutomationPerformer {
  readonly calls: PerformInput[] = []

  constructor(
    private readonly failWith: (attempt: number) => unknown | null = () => null,
  ) {}

  async perform(input: PerformInput): Promise<void> {
    this.calls.push(input)
    const failure = this.failWith(input.attempt)
    if (failure) throw failure
  }
}

const NO_SLEEP = async () => {}

async function run(options: {
  rules: readonly AutomationRule[]
  actor: Actor
  performer: AutomationPerformer
  ledger?: InMemoryAutomationLedger
  audit?: InMemoryAuditWriter | FailingAuditWriter
  facts?: AutomationFacts
  event?: DomainEvent
  maxAttempts?: number
}): Promise<AutomationRun> {
  return runAutomations({
    event: options.event ?? event('booking.confirmed'),
    facts: options.facts ?? {},
    rules: options.rules,
    actor: options.actor,
    performer: options.performer,
    ledger: options.ledger ?? new InMemoryAutomationLedger(),
    audit: options.audit ?? new InMemoryAuditWriter(),
    requestId: 'request-1',
    now: new Date('2026-03-01T09:00:01.000Z'),
    retry: { maxAttempts: options.maxAttempts ?? 3, backoffMs: 10 },
    sleep: NO_SLEEP,
  })
}

function ranActions(run: AutomationRun): readonly ActionResult[] {
  if (run.outcome.status !== 'evaluated') return []
  return run.outcome.rules.flatMap((entry: RuleResult) =>
    entry.outcome.status === 'ran' ? entry.outcome.actions : [],
  )
}

const FULL_GRANTS: readonly Grant[] = [
  'message.send',
  'task.create',
  'approval.request',
  'payment.request_link',
  'invoice.issue',
  'hold.create',
]

/* -------------------------------------------------------------- the run --- */

describe('trigger matching', () => {
  it('runs the rule whose WHEN is the event that arrived', async () => {
    const performer = new RecordingPerformer()
    const result = await run({
      rules: [rule()],
      actor: actor(FULL_GRANTS),
      performer,
    })

    expect(performer.calls).toHaveLength(1)
    expect(ranActions(result)[0].outcome.status).toBe('executed')
  })

  it('skips a rule listening to a different event', async () => {
    const performer = new RecordingPerformer()
    const result = await run({
      rules: [rule({ when: 'booking.cancelled' })],
      actor: actor(FULL_GRANTS),
      performer,
    })

    expect(performer.calls).toHaveLength(0)
    expect(
      result.outcome.status === 'evaluated' &&
        result.outcome.rules[0].outcome.status,
    ).toBe('skipped_trigger')
  })

  it('skips a disabled rule whose trigger did match', async () => {
    const performer = new RecordingPerformer()
    const result = await run({
      rules: [rule({ enabled: false })],
      actor: actor(FULL_GRANTS),
      performer,
    })

    expect(performer.calls).toHaveLength(0)
    expect(
      result.outcome.status === 'evaluated' &&
        result.outcome.rules[0].outcome.status,
    ).toBe('skipped_disabled')
  })

  it('refuses an event name that is not in the frozen catalogue', async () => {
    const performer = new RecordingPerformer()
    // The type says this cannot happen. An event arriving as JSON from a queue
    // has no type, which is exactly why the runtime check exists.
    const forged = {
      ...event('booking.confirmed'),
      name: 'booking.almost_confirmed' as DomainEventName,
    }

    const result = await run({
      rules: [rule()],
      actor: actor(FULL_GRANTS),
      performer,
      event: forged,
    })

    expect(result.outcome.status).toBe('refused_unknown_event')
    expect(performer.calls).toHaveLength(0)
  })
})

describe('tenant isolation', () => {
  it('refuses the entire run when the event belongs to another organization', async () => {
    const performer = new RecordingPerformer()
    const audit = new InMemoryAuditWriter()

    const result = await run({
      rules: [rule()],
      actor: actor(FULL_GRANTS),
      performer,
      audit,
      event: event('booking.confirmed', { organizationId: OTHER_ORG }),
    })

    expect(result.outcome).toEqual({
      status: 'refused_cross_organization',
      eventOrganizationId: OTHER_ORG,
    })
    expect(performer.calls).toHaveLength(0)
    expect(audit.records).toHaveLength(0)
  })
})

describe('conditions', () => {
  it('runs when the IF clause holds', async () => {
    const performer = new RecordingPerformer()
    await run({
      rules: [
        rule({ conditions: [{ kind: 'at_least', field: 'nights', value: 2 }] }),
      ],
      actor: actor(FULL_GRANTS),
      performer,
      facts: { nights: 3 },
    })

    expect(performer.calls).toHaveLength(1)
  })

  it('does not run when a fact the IF clause names is absent, and says which', async () => {
    const performer = new RecordingPerformer()
    const result = await run({
      rules: [
        rule({ conditions: [{ kind: 'at_least', field: 'nights', value: 2 }] }),
      ],
      actor: actor(FULL_GRANTS),
      performer,
      facts: {},
    })

    expect(performer.calls).toHaveLength(0)
    const outcome =
      result.outcome.status === 'evaluated'
        ? result.outcome.rules[0].outcome
        : null
    expect(outcome?.status).toBe('skipped_conditions')
    if (outcome?.status === 'skipped_conditions') {
      expect(outcome.failures[0].reason).toBe('missing_fact')
      expect(outcome.failures[0].field).toBe('nights')
    }
  })
})

/* ---------------------------------------------------------- idempotency --- */

describe('idempotency', () => {
  it('performs the work once when the same event is delivered three times', async () => {
    const ledger = new InMemoryAutomationLedger()
    const performer = new RecordingPerformer()
    const audit = new InMemoryAuditWriter()
    const rules = [rule()]
    const who = actor(FULL_GRANTS)

    const first = await run({ rules, actor: who, performer, ledger, audit })
    const second = await run({ rules, actor: who, performer, ledger, audit })
    const third = await run({ rules, actor: who, performer, ledger, audit })

    expect(performer.calls).toHaveLength(1)
    expect(audit.records).toHaveLength(1)
    expect(ranActions(first)[0].outcome.status).toBe('executed')
    expect(ranActions(second)[0].outcome.status).toBe('skipped_duplicate')
    expect(ranActions(third)[0].outcome.status).toBe('skipped_duplicate')
  })

  it('treats a different delivery of a different event as new work', async () => {
    const ledger = new InMemoryAutomationLedger()
    const performer = new RecordingPerformer()
    const rules = [rule()]
    const who = actor(FULL_GRANTS)

    await run({ rules, actor: who, performer, ledger })
    await run({
      rules,
      actor: who,
      performer,
      ledger,
      event: event('booking.confirmed', { idempotencyKey: 'delivery-def' }),
    })

    expect(performer.calls).toHaveLength(2)
  })

  it('scopes the ledger by organization, so one tenant cannot suppress another', async () => {
    const ledger = new InMemoryAutomationLedger()
    const performer = new RecordingPerformer()
    const rules = [rule()]

    await run({ rules, actor: actor(FULL_GRANTS), performer, ledger })

    const otherTenant: Actor = {
      ...actor(FULL_GRANTS),
      organizationId: OTHER_ORG,
    }
    await run({
      rules,
      actor: otherTenant,
      performer,
      ledger,
      event: event('booking.confirmed', { organizationId: OTHER_ORG }),
    })

    expect(performer.calls).toHaveLength(2)
  })
})

describe('no duplicate execution, and no false duplicates', () => {
  it('runs both actions of one rule — the key carries the position', async () => {
    const performer = new RecordingPerformer()
    await run({
      rules: [
        rule({
          actions: [
            { kind: 'notify_team', note: 'הצוות עודכן' },
            { kind: 'create_task', note: 'נפתחה משימה' },
          ],
        }),
      ],
      actor: actor(FULL_GRANTS),
      performer,
    })

    expect(performer.calls.map((call) => call.action.kind)).toEqual([
      'notify_team',
      'create_task',
    ])
  })

  it('runs two rules on one event — the key carries the rule id', async () => {
    const performer = new RecordingPerformer()
    await run({
      rules: [rule({ id: 'rule-a' }), rule({ id: 'rule-b' })],
      actor: actor(FULL_GRANTS),
      performer,
    })

    expect(performer.calls).toHaveLength(2)
  })

  it('builds a key from the delivery, the rule, the position and the kind', () => {
    const key = executionKey(event('booking.confirmed'), rule(), 2, {
      kind: 'create_task',
      note: 'x',
    })
    expect(key).toBe('delivery-abc::rule-1::2::create_task')
  })
})

/* ---------------------------------------------------------------- retry --- */

describe('retry', () => {
  it('retries a transient failure and succeeds on a later attempt', async () => {
    const performer = new RecordingPerformer((attempt) =>
      attempt < 3 ? new Error('connection reset') : null,
    )
    const result = await run({
      rules: [rule()],
      actor: actor(FULL_GRANTS),
      performer,
    })

    expect(performer.calls).toHaveLength(3)
    expect(ranActions(result)[0].outcome).toEqual({
      status: 'executed',
      attempts: 3,
    })
  })

  it('stops at the attempt cap and reports the failure', async () => {
    const performer = new RecordingPerformer(() => new Error('still down'))
    const result = await run({
      rules: [rule()],
      actor: actor(FULL_GRANTS),
      performer,
      maxAttempts: 2,
    })

    expect(performer.calls).toHaveLength(2)
    const outcome = ranActions(result)[0].outcome
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.attempts).toBe(2)
      expect(outcome.retryable).toBe(true)
      expect(outcome.error).toContain('still down')
    }
  })

  it('does not retry a permanent failure', async () => {
    const permanent = new AppError({
      code: 'guest_has_no_phone',
      status: 422,
      message: 'guest has no telephone number',
      userMessage: 'לאורח אין מספר טלפון.',
      retryable: false,
    })
    const performer = new RecordingPerformer(() => permanent)

    const result = await run({
      rules: [rule()],
      actor: actor(FULL_GRANTS),
      performer,
      maxAttempts: 5,
    })

    expect(performer.calls).toHaveLength(1)
    const outcome = ranActions(result)[0].outcome
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.retryable).toBe(false)
  })

  it('releases the claim after a retryable failure, so a redelivery tries again', async () => {
    const ledger = new InMemoryAutomationLedger()
    let calls = 0
    const performer: AutomationPerformer = {
      async perform() {
        calls += 1
        if (calls <= 2) throw new Error('down')
      },
    }

    const rules = [rule()]
    const who = actor(FULL_GRANTS)

    const first = await run({
      rules,
      actor: who,
      performer,
      ledger,
      maxAttempts: 2,
    })
    expect(ranActions(first)[0].outcome.status).toBe('failed')

    const second = await run({ rules, actor: who, performer, ledger })
    expect(ranActions(second)[0].outcome.status).toBe('executed')
    expect(calls).toBe(3)
  })

  it('keeps the claim after a permanent failure, so a redelivery does not repeat it', async () => {
    const ledger = new InMemoryAutomationLedger()
    const permanent = new AppError({
      code: 'invalid_template',
      status: 422,
      message: 'the message template does not exist',
      userMessage: 'התבנית אינה קיימת.',
      retryable: false,
    })
    const performer = new RecordingPerformer(() => permanent)
    const rules = [rule()]
    const who = actor(FULL_GRANTS)

    await run({ rules, actor: who, performer, ledger })
    const second = await run({ rules, actor: who, performer, ledger })

    expect(performer.calls).toHaveLength(1)
    expect(ranActions(second)[0].outcome.status).toBe('skipped_duplicate')
  })
})

/* ---------------------------------------------------------------- audit --- */

describe('audit', () => {
  it('writes exactly one record per executed action', async () => {
    const audit = new InMemoryAuditWriter()
    await run({
      rules: [
        rule({
          actions: [
            { kind: 'notify_team', note: 'הצוות עודכן על הזמנה שאושרה' },
            { kind: 'create_task', note: 'נפתחה משימת הכנה' },
          ],
        }),
      ],
      actor: actor(FULL_GRANTS),
      performer: new RecordingPerformer(),
      audit,
    })

    expect(audit.records).toHaveLength(2)
  })

  it('attributes the action to the system and names the rule', async () => {
    const audit = new InMemoryAuditWriter()
    await run({
      rules: [rule({ name: 'הזמנה אושרה — עדכון הצוות' })],
      actor: actor(FULL_GRANTS),
      performer: new RecordingPerformer(),
      audit,
    })

    const record = audit.records[0]
    expect(record.actorType).toBe('system')
    expect(record.actorUserId).toBeNull()
    expect(record.actorLabel).toContain('הזמנה אושרה — עדכון הצוות')
    // The permission that authorised it, exactly as a human action records.
    expect(record.action).toBe('message.send')
    expect(record.resourceType).toBe('booking')
    expect(record.resourceId).toBe('booking-9')
    expect(record.organizationId).toBe(ORG)
    expect(record.summary).not.toBe(record.action)
  })

  it('writes nothing for an action that was refused or deduplicated', async () => {
    const audit = new InMemoryAuditWriter()
    const ledger = new InMemoryAutomationLedger()
    const rules = [rule()]
    const who = actor(FULL_GRANTS)

    await run({
      rules,
      actor: who,
      performer: new RecordingPerformer(),
      ledger,
      audit,
    })
    await run({
      rules,
      actor: who,
      performer: new RecordingPerformer(),
      ledger,
      audit,
    })
    await run({
      rules,
      actor: actor([]),
      performer: new RecordingPerformer(),
      audit,
    })

    expect(audit.records).toHaveLength(1)
  })

  it('reports work that happened with no trail as its own outcome', async () => {
    const performer = new RecordingPerformer()
    const result = await run({
      rules: [rule()],
      actor: actor(FULL_GRANTS),
      performer,
      audit: new FailingAuditWriter('audit table unavailable'),
    })

    // The action really ran. Calling it `failed` would be a lie, and calling
    // it `executed` would hide that nothing recorded it.
    expect(performer.calls).toHaveLength(1)
    const outcome = ranActions(result)[0].outcome
    expect(outcome.status).toBe('executed_unaudited')
    expect(executedActions(result)).toHaveLength(1)
    expect(needsAttention(result)).toHaveLength(1)
  })
})

/* --------------------------------------------------- permission and plan --- */

describe('permission-safe actions', () => {
  it('refuses an action whose grant the actor does not hold', async () => {
    const performer = new RecordingPerformer()
    const result = await run({
      rules: [rule({ actions: [{ kind: 'create_task', note: 'משימה' }] })],
      actor: actor(['message.send']),
      performer,
    })

    expect(performer.calls).toHaveLength(0)
    expect(ranActions(result)[0].outcome).toEqual({
      status: 'refused_permission',
      grant: 'task.create',
    })
  })

  it('performs the actions it may and refuses the ones it may not, in one rule', async () => {
    const performer = new RecordingPerformer()
    const result = await run({
      rules: [
        rule({
          actions: [
            { kind: 'notify_team', note: 'הצוות עודכן' },
            { kind: 'issue_invoice', note: 'הופקה חשבונית' },
          ],
        }),
      ],
      actor: actor(['message.send']),
      performer,
    })

    expect(performer.calls.map((call) => call.action.kind)).toEqual([
      'notify_team',
    ])
    const outcomes = ranActions(result).map((entry) => entry.outcome.status)
    expect(outcomes).toEqual(['executed', 'refused_permission'])
  })
})

describe('capability awareness', () => {
  it('runs nothing at all without the automation feature', async () => {
    const performer = new RecordingPerformer()
    const audit = new InMemoryAuditWriter()
    const result = await run({
      rules: [rule()],
      actor: actor(FULL_GRANTS, ['core']),
      performer,
      audit,
    })

    expect(performer.calls).toHaveLength(0)
    expect(audit.records).toHaveLength(0)
    const outcome =
      result.outcome.status === 'evaluated'
        ? result.outcome.rules[0].outcome
        : null
    expect(outcome).toEqual({
      status: 'refused_plan',
      entitlement: 'automation',
    })
  })

  it('distinguishes a missing feature from a missing permission on one action', async () => {
    const performer = new RecordingPerformer()
    // The role carries `task.create`; the package does not carry `operations`,
    // which is the feature `ENTITLEMENT_FOR_GRANT` maps that grant to.
    const result = await run({
      rules: [rule({ actions: [{ kind: 'create_task', note: 'משימה' }] })],
      actor: actor(['task.create'], ['core', 'automation']),
      performer,
    })

    expect(performer.calls).toHaveLength(0)
    expect(ranActions(result)[0].outcome).toEqual({
      status: 'refused_plan',
      grant: 'task.create',
      entitlement: 'operations',
    })
  })

  it('runs the same action once the feature is in the package', async () => {
    const performer = new RecordingPerformer()
    await run({
      rules: [rule({ actions: [{ kind: 'create_task', note: 'משימה' }] })],
      actor: actor(['task.create'], ['core', 'automation', 'operations']),
      performer,
    })

    expect(performer.calls).toHaveLength(1)
  })
})
