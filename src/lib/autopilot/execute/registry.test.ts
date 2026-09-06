/**
 * The registry, held to the one rule it exists for.
 *
 * The important test in this file is the one that runs a real
 * `defineOperation` operation end to end: it is what makes "Autopilot writes no
 * business table" a statement a test makes rather than a comment. The handler
 * accepts an operation, hands it the action's prose as the stated reason and
 * the action's key as the idempotency key, and a second call replays instead of
 * running the work twice.
 *
 * The rest of the file is about honesty: every command the catalogue names is
 * accounted for, and the eighteen that resolve to nothing say so in a sentence
 * a person can read rather than by quietly succeeding.
 */

import { describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../../audit/pipeline'
import type { Actor } from '../../authz/can'
import type { Grant } from '../../authz/permissions'
import type { Entitlement } from '../../plans/entitlements'
import { InMemoryIdempotencyStore, defineOperation, s } from '../../service'
import { AUTOPILOT_ACTIONS } from '../actions'
import { REVERSALS } from './undo'
import type { PlannedAction } from '../types'

import {
  COMMAND_BINDINGS,
  boundCommands,
  catalogueCommands,
  createCommandRegistry,
  operationHandler,
  unavailableCommands,
  type CommandInvocation,
} from './registry'

const ORG = 'org-estia'

function actor(grants: readonly Grant[]): Actor {
  return {
    userId: 'user-1',
    organizationId: ORG,
    membershipStatus: 'active',
    grants: new Set<Grant>(grants),
    scope: { kind: 'all_organization' },
    entitlements: new Set<Entitlement>(['core', 'laundry', 'operations']),
  }
}

function planned(overrides: Partial<PlannedAction> = {}): PlannedAction {
  return {
    organizationId: ORG,
    propertyId: 'property-1',
    kind: 'laundry.draft_order',
    safetyLevel: 'safe_internal',
    disposition: 'auto',
    runMode: 'live',
    confidence: 'high',
    reason: 'נותרו שש מגבות והאספקה מאחרת',
    triggerEvent: null,
    evidence: [],
    command: 'laundry.draftOrder',
    commandInput: { propertyId: 'property-1', resourceId: 'order-7' },
    idempotencyKey: 'evt-1::laundry.draft_order',
    correlationId: 'corr-1',
    exceptionDedupeKey: null,
    scheduledFor: null,
    ...overrides,
  }
}

function invocation(action: PlannedAction): CommandInvocation {
  return {
    action,
    attempt: 1,
    idempotencyKey: action.idempotencyKey,
    correlationId: 'corr-1',
    now: new Date('2026-09-06T06:00:00.000Z'),
  }
}

/* --------------------------------------------------------- the catalogue -- */

describe('the bindings', () => {
  it('accounts for every command the action catalogue names', () => {
    const unaccounted = catalogueCommands().filter(
      (command) => !(command in COMMAND_BINDINGS),
    )
    // A command with no entry would resolve as "not in the catalogue", which is
    // a different and much more confusing failure than "not implemented yet".
    expect(unaccounted).toEqual([])
  })

  it('names an operation for every command it claims is available', () => {
    for (const command of boundCommands()) {
      expect(COMMAND_BINDINGS[command].operation).toEqual(expect.any(String))
    }
  })

  it('leaves nothing bound that neither an action nor a reversal names', () => {
    // Two legitimate sources. An action's own `command`, and a REVERSAL —
    // `tasks.cancelTask` is only ever reached as the undo for task.create and
    // is not something anybody plans, so requiring it to be an action's
    // command would have kept the undo path dead to satisfy a test.
    const named = new Set<string>([
      ...Object.values(AUTOPILOT_ACTIONS)
        .map((spec) => spec.command)
        .filter((command): command is string => command !== null),
      ...Object.values(REVERSALS).map((reversal) => reversal.command),
    ])
    for (const command of Object.keys(COMMAND_BINDINGS)) {
      expect(named.has(command)).toBe(true)
    }
  })

  it('binds holds.releaseExpired only now that the precondition is asserted', () => {
    // hold.release exists and would run, and it releases ANY hold — the
    // safe_internal rating rests entirely on the hold having already expired,
    // which nothing verified. That is why this stayed unbound.
    //
    // src/lib/booking/holds-commands now asserts it: assertHoldHasExpired
    // refuses not_expired, already_released, already_converted and
    // expiry_unreadable, with the clock injected. The binding is to that
    // command and must never be moved to the bare hold.release.
    expect(COMMAND_BINDINGS['holds.releaseExpired']?.operation).toBe(
      'hold.release_expired',
    )
    expect(COMMAND_BINDINGS['holds.releaseExpired']?.operation).not.toBe(
      'hold.release',
    )
  })
})

/* -------------------------------------------------------- the refusals --- */

describe('resolution', () => {
  it('refuses a command with no operation, in a sentence a person can read', () => {
    const registry = createCommandRegistry()
    const resolution = registry.resolve('access.issueCode')

    expect(resolution.status).toBe('unavailable')
    if (resolution.status === 'unavailable') {
      expect(resolution.detail).toContain('access.issueCode')
      expect(resolution.detail).toContain('אינה ממומשת')
    }
  })

  it('refuses a command the catalogue has never heard of', () => {
    const resolution = createCommandRegistry().resolve('rm.minusRf')
    expect(resolution.status).toBe('unavailable')
  })

  it('refuses a real command that nobody wired, and names the operation', () => {
    const resolution = createCommandRegistry().resolve('payments.refund')

    expect(resolution.status).toBe('unavailable')
    if (resolution.status === 'unavailable') {
      expect(resolution.detail).toContain('payment.refund')
    }
  })

  it('ignores a handler supplied for a command with no operation', () => {
    // Wiring a handler must not be a way to smuggle in a callable that is not
    // an operation: the binding table decides, not the caller.
    const registry = createCommandRegistry({
      'access.issueCode': async () => ({ sneaked: true }),
    })

    expect(registry.resolve('access.issueCode').status).toBe('unavailable')
  })
})

/* ------------------------------------------------- through an operation -- */

describe('operationHandler', () => {
  it('runs a real defineOperation operation and hands it the action', async () => {
    const seen: {
      reason: string | null
      propertyId: string
      resourceId: string | null
      idempotencyKey: string | null
    }[] = []

    const createOrder = defineOperation<
      { propertyId: string },
      null,
      { orderId: string }
    >({
      name: 'laundry.order.create',
      permission: 'laundry.order_create',
      resourceType: 'laundry_order',
      // Demanded so the test proves the action's prose satisfies it.
      requiresReason: true,
      input: s.object({ propertyId: s.string({ label: 'נכס' }) }),
      async execute({ input, request, context }) {
        seen.push({
          reason: context.reason ?? null,
          propertyId: input.propertyId,
          resourceId: request.resourceId ?? null,
          idempotencyKey: request.idempotencyKey ?? null,
        })
        return { orderId: 'order-1' }
      },
      audit: ({ result }) => ({
        resourceId: result.orderId,
        summary: `אוטופיילוט הכין הזמנת כביסה ${result.orderId}`,
      }),
    })

    const audit = new InMemoryAuditWriter()
    const handler = operationHandler({
      operation: createOrder,
      services: { audit, idempotency: new InMemoryIdempotencyStore() },
      context: () => ({
        actor: actor(['laundry.order_create']),
        auditActor: { type: 'system', userId: null, label: 'אוטופיילוט' },
        correlationId: 'corr-1',
      }),
    })

    const registry = createCommandRegistry({ 'laundry.draftOrder': handler })
    const resolution = registry.resolve('laundry.draftOrder')
    expect(resolution.status).toBe('available')
    if (resolution.status !== 'available') return

    const action = planned()
    const first = await resolution.run(invocation(action))

    expect(first.operation).toBe('laundry.order.create')
    expect(first.replayed).toBe(false)
    expect(seen).toHaveLength(1)
    // The reason a person would have had to state is the reason Autopilot
    // composed when it decided.
    expect(seen[0].reason).toBe('נותרו שש מגבות והאספקה מאחרת')
    // `resourceId` is lifted out of the command input rather than validated as
    // a field the operation's schema has never heard of.
    expect(seen[0].resourceId).toBe('order-7')
    expect(seen[0].propertyId).toBe('property-1')
    expect(seen[0].idempotencyKey).toBe(action.idempotencyKey)

    // The operation went through the whole pipeline, audit included.
    expect(audit.records).toHaveLength(1)

    // And a second dispatch of the same action replays rather than ordering a
    // second wash.
    const second = await resolution.run(invocation(action))
    expect(second.replayed).toBe(true)
    expect(seen).toHaveLength(1)
  })
})
