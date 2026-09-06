/**
 * The operations, exercised through the real pipeline.
 *
 * Every test runs `defineOperation`'s whole sequence — authorize, validate,
 * load, authorize again, rule, transaction, audit, event — against the
 * in-memory repository, so a rule asserted here is a rule that holds on the
 * path the screens take rather than one a helper function happens to enforce.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../audit/pipeline'
import { AuthorizationError } from '../authz/can'
import { BusinessRuleError, ValidationError } from '../errors'
import {
  InMemoryEventBus,
  InMemoryIdempotencyStore,
  type OperationContext,
  type OperationServices,
} from '../service'
import type { PropertyPnl } from '../finance/pnl'
import { defineOwnerOperations, type OwnerFinanceSource } from './operations'
import { InMemoryOwnerRepository } from './repository'
import {
  ORG,
  OWNER_A,
  OWNER_B,
  PROPERTY,
  actorFor,
  financeActor,
  ownerFor,
  ownershipFor,
  pnlFor,
} from './testing'
import { FULL_SHARE_BPS } from './types'

const NOW = new Date('2026-04-01T09:00:00.000Z')
const STATEMENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const OWNERSHIP_ID = 'bbbbbbbb-0000-4000-8000-000000000002'
const PAYOUT_ID = 'cccccccc-0000-4000-8000-000000000003'

let repo: InMemoryOwnerRepository
let audit: InMemoryAuditWriter
let idempotency: InMemoryIdempotencyStore
let events: InMemoryEventBus
let ops: ReturnType<typeof defineOwnerOperations>
let pnl: PropertyPnl

const finance: OwnerFinanceSource = {
  async propertyPnl() {
    return pnl
  },
}

beforeEach(() => {
  repo = new InMemoryOwnerRepository()
  audit = new InMemoryAuditWriter()
  idempotency = new InMemoryIdempotencyStore()
  events = new InMemoryEventBus()
  pnl = pnlFor()
  ops = defineOwnerOperations(repo, finance)

  repo.seedOwner(ownerFor())
  repo.seedOwnership(ownershipFor())
})

function services(): OperationServices {
  return { audit, idempotency, events }
}

function context(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    actor: financeActor(),
    auditActor: { type: 'user', userId: 'user-finance', label: 'דנה כהן' },
    correlationId: 'corr-1',
    now: NOW,
    reason: null,
    ...overrides,
  }
}

const issueInput = {
  statementId: STATEMENT_ID,
  ownerId: OWNER_A,
  propertyId: PROPERTY,
  periodStart: '2026-03-01',
  periodEnd: '2026-03-31',
}

async function issueOnce(
  input: Record<string, unknown> = issueInput,
  over: Partial<OperationContext> = {},
) {
  return ops.issueStatement.run({
    request: { input },
    context: context(over),
    services: services(),
  })
}

// ── owner_statement.issue ─────────────────────────────────────────────────

describe('issuing a statement', () => {
  it('produces a frozen document that reconciles to the P&L', async () => {
    const outcome = await issueOnce()

    expect(outcome.data.status).toBe('issued')
    expect(outcome.data.issuedAt).toBe(NOW.toISOString())
    expect(outcome.data.propertyOwnerShareAgorot).toBe(pnl.ownerShareAgorot)
    expect(outcome.data.grossRevenueAgorot).toBe(pnl.grossRevenueAgorot)
  })

  it('refuses a second statement for the same owner and period', async () => {
    await issueOnce()

    await expect(
      issueOnce({
        ...issueInput,
        statementId: 'dddddddd-0000-4000-8000-000000000004',
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('admits the second one when it declares itself a correction', async () => {
    await issueOnce()

    const corrected = await issueOnce({
      ...issueInput,
      statementId: 'dddddddd-0000-4000-8000-000000000004',
      correction: true,
    })

    expect(corrected.data.id).toBe('dddddddd-0000-4000-8000-000000000004')
    // Two documents, not one edited. The first is still exactly as it was.
    const stored = await repo.listStatements(ORG, { ownerId: OWNER_A })
    expect(stored).toHaveLength(2)
    expect(stored[0].status).toBe('issued')
  })

  it('refuses somebody without owner_statement.issue', async () => {
    await expect(
      issueOnce(issueInput, { actor: actorFor('accountant') }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  it('refuses a reader scoped to another property', async () => {
    await expect(
      issueOnce(issueInput, {
        actor: financeActor({
          scope: { kind: 'properties', propertyIds: ['other-property'] },
        }),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  it('refuses an inverted period before it reads anything', async () => {
    await expect(
      issueOnce({
        ...issueInput,
        periodStart: '2026-03-31',
        periodEnd: '2026-03-01',
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('opens on the previous statement’s closing balance', async () => {
    const first = await issueOnce()

    const second = await issueOnce({
      ...issueInput,
      statementId: 'eeeeeeee-0000-4000-8000-000000000005',
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
    })

    expect(second.data.openingBalanceAgorot).toBe(
      first.data.closingBalanceAgorot,
    )
  })

  it('writes exactly one audit row and one domain event', async () => {
    await issueOnce()

    expect(audit.records).toHaveLength(1)
    expect(audit.records[0].summary).toContain('דוח בעלים')
    expect(events.published).toHaveLength(1)
    expect(events.published[0].name).toBe('owner_statement.issued')
  })

  it('replays a retry rather than issuing twice', async () => {
    const first = await ops.issueStatement.run({
      request: { input: issueInput, idempotencyKey: 'key-1' },
      context: context(),
      services: services(),
    })
    const second = await ops.issueStatement.run({
      request: { input: issueInput, idempotencyKey: 'key-1' },
      context: context(),
      services: services(),
    })

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(await repo.listStatements(ORG)).toHaveLength(1)
  })
})

// ── owner.link_property ───────────────────────────────────────────────────

describe('linking an owner to a property', () => {
  const linkInput = {
    ownershipId: OWNERSHIP_ID,
    ownerId: OWNER_A,
    propertyId: 'ffffffff-0000-4000-8000-000000000009',
    shareBps: 5_000,
    effectiveFrom: '2026-01-01',
  }

  it('records the share as basis points', async () => {
    const outcome = await ops.linkProperty.run({
      request: { input: linkInput },
      context: context({ actor: actorFor('organization_owner') }),
      services: services(),
    })

    expect(outcome.data.shareBps).toBe(5_000)
    expect(audit.records[0].summary).toContain('50%')
  })

  it('refuses a link that would take the property past 100%', async () => {
    // The seeded ownership already holds the whole property.
    repo.seedOwner(ownerFor({ id: OWNER_B, userId: 'user-owner-b' }))
    await expect(
      ops.linkProperty.run({
        request: {
          input: {
            ...linkInput,
            ownerId: OWNER_B,
            propertyId: PROPERTY,
            shareBps: 1,
          },
        },
        context: context({ actor: actorFor('organization_owner') }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses a finance manager, who does not hold owner.manage', async () => {
    await expect(
      ops.linkProperty.run({
        request: { input: linkInput },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  it('refuses a share outside 1..10000 at validation', async () => {
    await expect(
      ops.linkProperty.run({
        request: { input: { ...linkInput, shareBps: FULL_SHARE_BPS + 1 } },
        context: context({ actor: actorFor('organization_owner') }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

// ── owner_payout.record ───────────────────────────────────────────────────

describe('recording a payout', () => {
  const payoutInput = {
    payoutId: PAYOUT_ID,
    ownerId: OWNER_A,
    propertyId: PROPERTY,
    direction: 'to_owner' as const,
    amountAgorot: 250_000,
    method: 'bank_transfer' as const,
    paidOn: '2026-04-05',
    reference: 'העברה 4471',
  }

  it('demands a stated reason, because money left the business', async () => {
    await expect(
      ops.recordPayout.run({
        request: { input: payoutInput },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('records the movement and emits the payout event', async () => {
    const outcome = await ops.recordPayout.run({
      request: { input: payoutInput },
      context: context({ reason: 'העברת רבעון ראשון' }),
      services: services(),
    })

    expect(outcome.data.amountAgorot).toBe(250_000)
    expect(outcome.data.recordedBy).toBe('user-finance_manager')
    expect(events.published[0].name).toBe('owner_payout.paid')
  })

  it('carries the direction in its own field, never in the sign', async () => {
    await expect(
      ops.recordPayout.run({
        request: { input: { ...payoutInput, amountAgorot: 0 } },
        context: context({ reason: 'test' }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })
})

// ── owner_approval.decide ─────────────────────────────────────────────────

describe('deciding an owner approval', () => {
  beforeEach(() => {
    repo.seedApproval({
      id: 'approval-1',
      organizationId: ORG,
      propertyId: PROPERTY,
      ownerId: OWNER_A,
      kind: 'maintenance_expense',
      status: 'requested',
      reason: 'הדוד התפוצץ',
      requestedAgorot: 420_000,
      limitAgorot: 150_000,
      requestedBy: 'user-property_manager',
      requestedAt: '2026-03-15T10:00:00.000Z',
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      expiresAt: null,
      version: 1,
    })
  })

  it('records the decision and emits approval.decided', async () => {
    const outcome = await ops.decideApproval.run({
      request: {
        input: { decision: 'approved' },
        resourceId: 'approval-1',
        expectedVersion: 1,
      },
      context: context(),
      services: services(),
    })

    expect(outcome.data.status).toBe('approved')
    expect(outcome.data.decidedBy).toBe('user-finance_manager')
    expect(events.published[0].name).toBe('approval.decided')
  })

  it('refuses the requester deciding their own', async () => {
    await expect(
      ops.decideApproval.run({
        request: {
          input: { decision: 'approved' },
          resourceId: 'approval-1',
          expectedVersion: 1,
        },
        context: context({
          actor: financeActor({ userId: 'user-property_manager' }),
        }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('demands the version it is editing', async () => {
    await expect(
      ops.decideApproval.run({
        request: { input: { decision: 'approved' }, resourceId: 'approval-1' },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})
