/**
 * The one question this file exists to answer: does `hold.release_expired`
 * refuse a hold that has not expired?
 *
 * Everything else here is in service of that. The action's `safe_internal`
 * rating is claimed from the expiry having already passed, so a test that only
 * proved the happy path would prove the wrong thing — `hold.release` already
 * passes the happy path, and it is the operation this one exists to be
 * different from.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../audit/pipeline'
import { AuthorizationError, type Actor } from '../authz/can'
import { PERMISSIONS, type Grant } from '../authz/permissions'
import { BusinessRuleError, NotFoundError } from '../errors'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'
import {
  InMemoryEventBus,
  InMemoryIdempotencyStore,
  RecordingTransactionRunner,
  type OperationContext,
} from '../service'
import type { HoldDraft } from './holds'
import {
  assertHoldHasExpired,
  defineHoldExpiryCommands,
} from './holds-commands'
import type { HoldStore } from './repository'
import type { Hold } from './types'

const ORG = 'org-a'
const UNIT = 'unit-1'
const USER = 'user-dana'
const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

/** 14:00 Israel time. The seeded hold expires at 14:30. */
const NOW = new Date('2026-08-20T11:00:00.000Z')
const EXPIRES_AT = '2026-08-20T11:30:00.000Z'
/** One second after the expiry. The earliest honest moment to release. */
const JUST_AFTER = new Date('2026-08-20T11:30:01.000Z')

class MemoryHoldStore implements HoldStore {
  readonly holds = new Map<string, Hold>()
  writes = 0
  private seq = 0

  async loadHold(organizationId: string, holdId: string): Promise<Hold | null> {
    const hold = this.holds.get(holdId)
    return hold && hold.organizationId === organizationId ? hold : null
  }

  async loadHoldsByUser(): Promise<readonly Hold[]> {
    return [...this.holds.values()]
  }

  async insertHold(draft: HoldDraft): Promise<Hold> {
    this.seq += 1
    const hold: Hold = { ...draft, id: `hold-${this.seq}` }
    this.holds.set(hold.id, hold)
    return hold
  }

  async saveHold(hold: Hold): Promise<Hold> {
    this.writes += 1
    this.holds.set(hold.id, hold)
    return hold
  }

  seed(overrides: Partial<Hold> = {}): Hold {
    this.seq += 1
    const hold: Hold = {
      id: `hold-${this.seq}`,
      organizationId: ORG,
      unitId: UNIT,
      checkIn: '2026-10-01',
      checkOut: '2026-10-03',
      reason: 'agent_quote',
      heldByUserId: USER,
      expiresAt: EXPIRES_AT,
      releasedAt: null,
      convertedToBookingId: null,
      ...overrides,
    }
    this.holds.set(hold.id, hold)
    return hold
  }
}

let store: MemoryHoldStore
let commands: ReturnType<typeof defineHoldExpiryCommands>

beforeEach(() => {
  store = new MemoryHoldStore()
  commands = defineHoldExpiryCommands(store)
})

function actorWith(grants: readonly Grant[]): Actor {
  return {
    userId: USER,
    organizationId: ORG,
    membershipStatus: 'active',
    grants: new Set<Grant>(grants),
    scope: { kind: 'all_organization' },
    entitlements: EVERY_ENTITLEMENT,
  }
}

function contextFor(actor: Actor, now: Date): OperationContext {
  return {
    actor,
    auditActor: { type: 'system', userId: null, label: 'טייס אוטומטי' },
    correlationId: 'req-hold-expiry',
    now,
  }
}

function wiring() {
  return {
    audit: new InMemoryAuditWriter(),
    events: new InMemoryEventBus(),
    idempotency: new InMemoryIdempotencyStore(),
    transactions: new RecordingTransactionRunner(),
  }
}

function rejection<E>(promise: Promise<unknown>): Promise<E> {
  return promise.then(
    () => {
      throw new Error('expected the operation to be refused, but it succeeded')
    },
    (error: unknown) => error as E,
  )
}

// ── The refusal this operation exists for ─────────────────────────────────

describe('hold.release_expired refuses a hold that has not expired', () => {
  it('names the hold, says how long is left, and writes nothing', async () => {
    const hold = store.seed()
    const services = wiring()

    const error = await rejection<BusinessRuleError>(
      commands.releaseExpired.run({
        request: { input: { holdId: hold.id } },
        context: contextFor(actorWith(PERMISSIONS), NOW),
        services,
      }),
    )

    expect(error).toBeInstanceOf(BusinessRuleError)
    expect(error.code).toBe('hold.release_expired.not_expired')
    // BY NAME. A planner reading `error_detail` at midnight has to be able to
    // say which hold survived.
    expect(error.userMessage).toContain(hold.id)
    expect(error.userMessage).toContain('30 דקות')

    // The hold is untouched and still live.
    expect(store.writes).toBe(0)
    expect(store.holds.get(hold.id)?.releasedAt).toBeNull()
    expect(services.audit.records).toHaveLength(0)
    expect(services.events.published).toHaveLength(0)
  })

  it('refuses one second before the expiry and allows one second after', async () => {
    const hold = store.seed()
    const oneSecondBefore = new Date(Date.parse(EXPIRES_AT) - 1000)

    await expect(
      commands.releaseExpired.run({
        request: { input: { holdId: hold.id } },
        context: contextFor(actorWith(PERMISSIONS), oneSecondBefore),
        services: wiring(),
      }),
    ).rejects.toThrow()

    const outcome = await commands.releaseExpired.run({
      request: { input: { holdId: hold.id } },
      context: contextFor(actorWith(PERMISSIONS), JUST_AFTER),
      services: wiring(),
    })

    expect(outcome.data.releasedAt).toBe(JUST_AFTER.toISOString())
  })

  it('refuses a hold that was already released, by name', async () => {
    const hold = store.seed({ releasedAt: '2026-08-20T10:00:00.000Z' })

    const error = await rejection<BusinessRuleError>(
      commands.releaseExpired.run({
        request: { input: { holdId: hold.id } },
        context: contextFor(actorWith(PERMISSIONS), JUST_AFTER),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('hold.release_expired.already_released')
    expect(error.userMessage).toContain(hold.id)
    expect(store.writes).toBe(0)
  })

  it('refuses a hold that already became a booking, by name', async () => {
    const hold = store.seed({ convertedToBookingId: 'bk-9' })

    const error = await rejection<BusinessRuleError>(
      commands.releaseExpired.run({
        request: { input: { holdId: hold.id } },
        context: contextFor(actorWith(PERMISSIONS), JUST_AFTER),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('hold.release_expired.already_converted')
    expect(error.userMessage).toContain(hold.id)
    expect(store.writes).toBe(0)
  })

  /**
   * The one place this deliberately disagrees with `isHoldLive`, which treats
   * an unreadable expiry as expired. That is right for a read that decides
   * whether inventory is blocked and wrong for a write justified by the expiry
   * having passed.
   */
  it('refuses a hold whose expiry cannot be read', async () => {
    const hold = store.seed({ expiresAt: 'שלשום' })

    const error = await rejection<BusinessRuleError>(
      commands.releaseExpired.run({
        request: { input: { holdId: hold.id } },
        context: contextFor(actorWith(PERMISSIONS), JUST_AFTER),
        services: wiring(),
      }),
    )

    expect(error.code).toBe('hold.release_expired.expiry_unreadable')
    expect(store.writes).toBe(0)
  })
})

// ── What it does when the premise really holds ────────────────────────────

describe('hold.release_expired releases a hold whose time has run out', () => {
  it('writes the release, audits it in Hebrew and raises hold.released', async () => {
    const hold = store.seed()
    const services = wiring()

    const outcome = await commands.releaseExpired.run({
      request: { input: { holdId: hold.id } },
      context: contextFor(actorWith(PERMISSIONS), JUST_AFTER),
      services,
    })

    expect(outcome.data.holdId).toBe(hold.id)
    expect(outcome.data.expiredAt).toBe(EXPIRES_AT)
    expect(outcome.data.verifiedAt).toBe(JUST_AFTER.toISOString())
    expect(store.holds.get(hold.id)?.releasedAt).toBe(JUST_AFTER.toISOString())

    expect(services.audit.records).toHaveLength(1)
    expect(services.audit.records[0].summary).toContain('לאחר שתוקפה כבר פג')

    expect(services.events.published).toHaveLength(1)
    expect(services.events.published[0].name).toBe('hold.released')
    expect(services.events.published[0].payload).toMatchObject({
      releasedBecause: 'expired',
    })
    // NOT `hold.expired` — that moment was `expiresAt`, not now.
    expect(
      services.events.published.some((event) => event.name === 'hold.expired'),
    ).toBe(false)
  })
})

// ── Authorization ─────────────────────────────────────────────────────────

describe('hold.release_expired and the grant', () => {
  it('refuses without hold.release, before the hold is read', async () => {
    const hold = store.seed()
    const services = wiring()

    const error = await rejection<AuthorizationError>(
      commands.releaseExpired.run({
        request: { input: { holdId: hold.id } },
        context: contextFor(actorWith(['hold.create']), JUST_AFTER),
        services,
      }),
    )

    expect(error).toBeInstanceOf(AuthorizationError)
    expect(store.writes).toBe(0)
    expect(services.audit.records).toHaveLength(0)
  })

  it('reports a hold from another organization as not found', async () => {
    const hold = store.seed({ organizationId: 'org-b' })

    await expect(
      rejection<NotFoundError>(
        commands.releaseExpired.run({
          request: { input: { holdId: hold.id } },
          context: contextFor(actorWith(PERMISSIONS), JUST_AFTER),
          services: wiring(),
        }),
      ),
    ).resolves.toBeInstanceOf(NotFoundError)
  })
})

// ── The assertion on its own ──────────────────────────────────────────────

describe('assertHoldHasExpired', () => {
  it('takes the clock as an argument, so both sides of the line are testable', () => {
    const hold: Hold = {
      id: 'hold-x',
      organizationId: ORG,
      unitId: UNIT,
      checkIn: '2026-10-01',
      checkOut: '2026-10-03',
      reason: 'guest_checkout',
      heldByUserId: USER,
      expiresAt: EXPIRES_AT,
      releasedAt: null,
      convertedToBookingId: null,
    }

    expect(() => assertHoldHasExpired(hold, NOW)).toThrow(BusinessRuleError)
    expect(() => assertHoldHasExpired(hold, JUST_AFTER)).not.toThrow()
  })
})
