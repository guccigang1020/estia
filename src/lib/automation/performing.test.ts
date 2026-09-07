/**
 * The half that acts, held to the one quality that matters: it does not.
 *
 * Every test below either proves a gate is shut or proves what would happen if
 * somebody opened all of them. The first group is the important one. This
 * module exists so that the code which would message a guest is written and
 * constrained BEFORE anybody needs it in a hurry — and a module in that
 * position is only trustworthy if the tests are about the refusals.
 *
 *   · what ESTIA ships performs nothing, because it has no handler for anything
 *   · no consent refuses before the engine is touched, so no idempotency key is
 *     claimed by a run that should not have started
 *   · a withdrawn consent refuses exactly as an absent one does
 *   · an unregistered action throws rather than reporting itself done, so no
 *     audit line can ever claim a guest was messaged when nothing was sent
 *   · with every gate open and a handler supplied, the engine really does run —
 *     otherwise the refusals above would be passing for the wrong reason
 */

import { describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../audit/pipeline'
import type { Actor } from '../authz/can'
import type { Grant } from '../authz/permissions'
import type { DomainEvent } from '../contracts/events'
import type { Entitlement } from '../plans/entitlements'

import { InMemoryAutomationLedger, type PerformInput } from './engine'
import {
  ActionHandlerRegistry,
  executionReadiness,
  mayConsentToPerforming,
  performEvaluatedEvent,
  shippedActionHandlers,
} from './performing'
import type { AutomationExecutionConsent } from './runs'
import type { AutomationRule } from './types'

const ORG = 'org-estia'

function actor(
  grants: readonly Grant[] = ['message.send', 'task.create'],
  entitlements: readonly Entitlement[] = ['core', 'automation', 'operations'],
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

function rule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule-1',
    name: 'תשלום נכשל — התראה לצוות',
    description: 'בדיקה',
    when: 'payment.failed',
    conditions: [],
    actions: [{ kind: 'notify_team', note: 'הצוות עודכן על כישלון בסליקה' }],
    enabled: true,
    ...overrides,
  }
}

function event(): DomainEvent {
  return {
    name: 'payment.failed',
    organizationId: ORG,
    resourceType: 'payment',
    resourceId: 'payment-9',
    propertyId: 'property-1',
    actorUserId: null,
    occurredAt: '2026-03-01T09:00:00.000Z',
    correlationId: 'corr-1',
    idempotencyKey: 'delivery-abc',
    payload: {},
  }
}

function consent(
  overrides: Partial<AutomationExecutionConsent> = {},
): AutomationExecutionConsent {
  return {
    organizationId: ORG,
    performingEnabled: true,
    note: 'צפינו בהחלטות במשך שבועיים לפני שהפעלנו',
    consentedAt: '2026-03-01T08:00:00.000Z',
    consentedBy: 'user-owner',
    revokedAt: null,
    ...overrides,
  }
}

/** A ledger that says whether anything ever asked it for a claim. */
class WatchfulLedger extends InMemoryAutomationLedger {
  readonly claims: string[] = []

  override async claim(organizationId: string, key: string): Promise<boolean> {
    this.claims.push(key)
    return super.claim(organizationId, key)
  }
}

async function run(input: {
  consent: AutomationExecutionConsent | null
  registry: ActionHandlerRegistry
  rules?: readonly AutomationRule[]
  actor?: Actor
  ledger?: WatchfulLedger
}) {
  const ledger = input.ledger ?? new WatchfulLedger()
  const outcome = await performEvaluatedEvent({
    event: event(),
    facts: {},
    rules: input.rules ?? [rule()],
    actor: input.actor ?? actor(),
    consent: input.consent,
    registry: input.registry,
    ledger,
    audit: new InMemoryAuditWriter(),
    requestId: 'req-1',
    retry: { maxAttempts: 1, backoffMs: 0 },
    sleep: async () => {},
  })
  return { outcome, ledger }
}

/* ------------------------------------------------------ what ships is off -- */

describe('what ESTIA ships', () => {
  it('has no handler for any action kind', () => {
    const registry = shippedActionHandlers()
    // Not a comment. If somebody registers a handler in the shipped set, this
    // is what fails, and the review that follows is the point.
    expect(registry.missingFor([rule()])).toEqual(['notify_team'])
  })

  it('gives a fresh registry each time, so one registration is not shared', () => {
    shippedActionHandlers().register('notify_team', async () => {})
    expect(shippedActionHandlers().has('notify_team')).toBe(false)
  })

  it('cannot act even for an organization that consented', async () => {
    const { outcome, ledger } = await run({
      consent: consent(),
      registry: shippedActionHandlers(),
    })

    expect(outcome.status).toBe('refused')
    if (outcome.status !== 'refused') throw new Error('unreachable')
    expect(outcome.blockers).toEqual([
      { kind: 'no_handler', action: 'notify_team' },
    ])
    expect(ledger.claims).toEqual([])
  })
})

/* -------------------------------------------------------------- the gates -- */

describe('the consent gate', () => {
  const working = () =>
    new ActionHandlerRegistry().register('notify_team', async () => {})

  it('refuses when no consent row exists, which is every organization', async () => {
    const { outcome, ledger } = await run({
      consent: null,
      registry: working(),
    })

    expect(outcome.status).toBe('refused')
    if (outcome.status !== 'refused') throw new Error('unreachable')
    expect(outcome.blockers).toEqual([{ kind: 'no_consent' }])
    // The refusal happens BEFORE the engine. A run that should never have
    // started must not leave claims behind that make a later, legitimate run
    // report `skipped_duplicate`.
    expect(ledger.claims).toEqual([])
  })

  it('refuses a consent that was withdrawn, and says when', async () => {
    const { outcome } = await run({
      consent: consent({
        performingEnabled: false,
        revokedAt: '2026-04-01T00:00:00.000Z',
      }),
      registry: working(),
    })

    expect(outcome.status).toBe('refused')
    if (outcome.status !== 'refused') throw new Error('unreachable')
    expect(outcome.blockers).toEqual([
      { kind: 'consent_withheld', revokedAt: '2026-04-01T00:00:00.000Z' },
    ])
  })

  it('refuses a package that does not include the module', async () => {
    const { outcome, ledger } = await run({
      consent: consent(),
      registry: working(),
      actor: actor(['message.send'], ['core']),
    })

    expect(outcome.status).toBe('refused')
    if (outcome.status !== 'refused') throw new Error('unreachable')
    expect(outcome.blockers).toContainEqual({ kind: 'no_entitlement' })
    expect(ledger.claims).toEqual([])
  })

  it('reports every blocker at once, not the first', () => {
    const readiness = executionReadiness({
      consent: null,
      registry: shippedActionHandlers(),
      actor: actor(['message.send'], ['core']),
      rules: [rule()],
    })

    // Consenting to something that still has no handler behind it would change
    // nothing and would look like it had.
    expect(readiness.ready).toBe(false)
    expect(readiness.blockers.map((blocker) => blocker.kind).sort()).toEqual([
      'no_consent',
      'no_entitlement',
      'no_handler',
    ])
  })

  it('ignores the handlers a disabled rule would have needed', () => {
    const readiness = executionReadiness({
      consent: consent(),
      registry: shippedActionHandlers(),
      actor: actor(),
      rules: [rule({ enabled: false })],
    })

    // A rule nobody switched on is not a missing capability.
    expect(readiness.ready).toBe(true)
  })
})

/* --------------------------------------------------- the door, when opened -- */

describe('with every gate open', () => {
  it('runs the real engine and performs the action once', async () => {
    const performed: PerformInput[] = []
    const registry = new ActionHandlerRegistry().register(
      'notify_team',
      async (input) => {
        performed.push(input)
      },
    )

    const { outcome, ledger } = await run({ consent: consent(), registry })

    expect(outcome.status).toBe('performed')
    if (outcome.status !== 'performed') throw new Error('unreachable')
    expect(performed).toHaveLength(1)
    expect(performed[0].action.kind).toBe('notify_team')
    // The engine claimed before performing, which is what makes a second
    // delivery of this event a no-op rather than a second notification.
    expect(ledger.claims).toHaveLength(1)
  })

  it('performs one logical event once, however many times it arrives', async () => {
    let calls = 0
    const registry = new ActionHandlerRegistry().register(
      'notify_team',
      async () => {
        calls += 1
      },
    )
    const ledger = new WatchfulLedger()

    await run({ consent: consent(), registry, ledger })
    await run({ consent: consent(), registry, ledger })

    expect(calls).toBe(1)
  })

  it('refuses an action nothing implements rather than reporting it done', async () => {
    // The registry has a handler for one of the rule's two actions. The other
    // must fail loudly: an audit line saying a guest was messaged when nothing
    // was sent is the worst outcome available here.
    const registry = new ActionHandlerRegistry().register(
      'notify_team',
      async () => {},
    )

    await expect(
      registry.perform({
        action: { kind: 'message_guest', note: 'נשלחה הודעה' },
        rule: rule(),
        event: event(),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: 'automation.action_not_implemented',
      retryable: false,
    })
  })
})

/* ------------------------------------------------------- who may consent --- */

describe('mayConsentToPerforming', () => {
  it('needs both grants, because this is not a rule-level decision', () => {
    expect(
      mayConsentToPerforming(
        actor(['automation.manage'], ['core', 'automation']),
      ),
    ).toBe(false)
    expect(
      mayConsentToPerforming(
        actor(['organization.settings.edit'], ['core', 'automation']),
      ),
    ).toBe(false)
    expect(
      mayConsentToPerforming(
        actor(
          ['automation.manage', 'organization.settings.edit'],
          ['core', 'automation'],
        ),
      ),
    ).toBe(true)
  })

  it('answers no without the package, exactly as the route would', () => {
    expect(
      mayConsentToPerforming(
        actor(['automation.manage', 'organization.settings.edit'], ['core']),
      ),
    ).toBe(false)
  })
})
