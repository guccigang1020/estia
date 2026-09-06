/**
 * The five operations, driven through the real pipeline with real actors.
 *
 * Actors are built from the **actual** role catalogue rather than hand-picked
 * grant sets, so "a cleaner may open a case and may not decide it" is a
 * statement about the product and not about a fixture:
 *
 *   · `cleaner` holds `incident.create` and nothing else about incidents;
 *   · `housekeeping_supervisor` holds `incident.update` and NOT
 *     `incident.resolve` — which makes it the exact negative case for the two
 *     operations that touch money;
 *   · `operations_manager` holds all four.
 *
 * The pipeline is not stubbed. Every run below authorizes, validates, applies
 * the rule, writes through a transaction runner and records an audit event,
 * because that is the thing being asserted as much as the outcome is.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../audit/pipeline'
import { AuthorizationError } from '../authz/can'
import { BusinessRuleError, ValidationError } from '../errors'
import { actorFor, ORG, PROPERTY, UNIT, BOOKING } from '../finance/testing'
import type { Db } from '../persistence/client'
import {
  InMemoryEventBus,
  InMemoryIdempotencyStore,
  type OperationContext,
  type OperationServices,
} from '../service'

import { defineIncidentOperations } from './operations'
import { InMemoryIncidentRepository } from './repository'

const NOW = new Date('2026-04-10T09:00:00.000Z')
const RATIONALE = 'הכיריים היו תקינות בבדיקה שלפני הכניסה ושרוטות ביציאה.'

let cases: InMemoryIncidentRepository
let audit: InMemoryAuditWriter
let idempotency: InMemoryIdempotencyStore
let events: InMemoryEventBus
let ops: ReturnType<typeof defineIncidentOperations>

beforeEach(() => {
  cases = new InMemoryIncidentRepository()
  audit = new InMemoryAuditWriter()
  idempotency = new InMemoryIdempotencyStore()
  events = new InMemoryEventBus()
  // The client is never reached: every operation is built over the in-memory
  // port, and `db` is only there because the Supabase adapter is the default.
  ops = defineIncidentOperations({ db: null as unknown as Db, cases })
})

function services(): OperationServices {
  return { audit, idempotency, events }
}

function context(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    actor: actorFor('operations_manager'),
    auditActor: {
      type: 'user',
      userId: 'user-operations_manager',
      label: 'דנה כהן',
    },
    correlationId: 'corr-1',
    now: NOW,
    reason: null,
    ...overrides,
  }
}

const openInput = {
  propertyId: PROPERTY,
  unitId: UNIT,
  bookingId: BOOKING,
  taskId: null,
  caseType: 'property_damage' as const,
  origin: 'checkout_inspection' as const,
  title: 'משטח המטבח נשרף',
  description: 'סימן שרוף בקוטר 10 ס״מ ליד הכיריים.',
  occurredAt: null,
}

async function openCase(overrides: Partial<OperationContext> = {}) {
  const outcome = await ops.openCase.run({
    request: { input: openInput },
    context: context(overrides),
    services: services(),
  })
  return outcome.data
}

/* ─────────────────────────────── opening ───────────────────────────────── */

describe('opening a case', () => {
  it('writes it open, and tells somebody', async () => {
    const outcome = await ops.openCase.run({
      request: { input: openInput },
      context: context(),
      services: services(),
    })

    expect(outcome.data.status).toBe('open')
    expect(outcome.data.bookingId).toBe(BOOKING)
    expect(audit.records).toHaveLength(1)
    expect(audit.records[0]?.summary).toContain('נפתח תיק נזק')
    // `incident.opened` is in ALERT_EVENTS — a damage case that reaches nobody
    // until somebody opens a screen is a deposit released by default.
    expect(outcome.events.map((event) => event.name)).toEqual([
      'incident.opened',
    ])
  })

  it('is open to the cleaner who found it', async () => {
    // She holds `incident.create` and nothing else about incidents. Opening
    // the case is her whole involvement, and it must not require more.
    const outcome = await ops.openCase.run({
      request: { input: openInput },
      context: context({
        actor: actorFor('cleaner'),
        auditActor: { type: 'user', userId: 'user-cleaner', label: 'מרים' },
      }),
      services: services(),
    })
    expect(outcome.data.status).toBe('open')
  })

  it('refuses damage that happened in the future', async () => {
    await expect(
      ops.openCase.run({
        request: {
          input: {
            ...openInput,
            occurredAt: '2026-05-01T10:00:00.000Z',
          },
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

/* ─────────────────────────────── evidence ──────────────────────────────── */

describe('attaching evidence', () => {
  it('stores a reference and never the file', async () => {
    const incident = await openCase()

    const outcome = await ops.addEvidence.run({
      request: {
        input: {
          caseId: incident.id,
          kind: 'after_photo',
          mediaRef: 'incidents/case-1/after-01.jpg',
          contentType: 'image/jpeg',
          byteSize: 244_113,
          statement: null,
          capturedAt: '2026-04-09T14:00:00.000Z',
          source: 'staff',
          note: null,
        },
      },
      context: context(),
      services: services(),
    })

    expect(outcome.data.mediaRef).toBe('incidents/case-1/after-01.jpg')
    expect(Object.keys(outcome.data)).not.toContain('data')
    // No event: the frozen catalogue has no name for "evidence was added", and
    // borrowing one would put a false sentence in the log. The audit row is
    // still written.
    expect(outcome.events).toEqual([])
    expect(audit.records.at(-1)?.summary).toContain('צורפה ראיה')
  })

  it('refuses the file itself', async () => {
    const incident = await openCase()

    await expect(
      ops.addEvidence.run({
        request: {
          input: {
            caseId: incident.id,
            kind: 'after_photo',
            mediaRef: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD',
            contentType: 'image/jpeg',
            byteSize: null,
            statement: null,
            capturedAt: null,
            source: 'staff',
            note: null,
          },
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('is refused to a cleaner, who may open a case and not work it', async () => {
    const incident = await openCase()

    await expect(
      ops.addEvidence.run({
        request: {
          input: {
            caseId: incident.id,
            kind: 'staff_statement',
            mediaRef: null,
            contentType: null,
            byteSize: null,
            statement: 'ראיתי את זה בבוקר',
            capturedAt: null,
            source: 'staff',
            note: null,
          },
        },
        context: context({
          actor: actorFor('cleaner'),
          auditActor: { type: 'user', userId: 'user-cleaner', label: 'מרים' },
        }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })
})

/* ─────────────────────────────── advancing ─────────────────────────────── */

describe('advancing a case', () => {
  it('emits approval.requested on the way to approval', async () => {
    const incident = await openCase()

    const outcome = await ops.advanceCase.run({
      request: { input: { caseId: incident.id, status: 'awaiting_approval' } },
      context: context(),
      services: services(),
    })

    expect(outcome.data.status).toBe('awaiting_approval')
    expect(outcome.events.map((event) => event.name)).toEqual([
      'approval.requested',
    ])
  })

  it('emits incident.resolved when it is resolved, and stamps the time', async () => {
    const incident = await openCase()
    await ops.advanceCase.run({
      request: { input: { caseId: incident.id, status: 'investigating' } },
      context: context(),
      services: services(),
    })

    const outcome = await ops.advanceCase.run({
      request: { input: { caseId: incident.id, status: 'resolved' } },
      context: context(),
      services: services(),
    })

    expect(outcome.data.resolvedAt).toEqual(NOW)
    expect(outcome.events.map((event) => event.name)).toEqual([
      'incident.resolved',
    ])
  })

  it('refuses to let a case awaiting a vendor resolve itself', async () => {
    const incident = await openCase()
    await ops.advanceCase.run({
      request: { input: { caseId: incident.id, status: 'awaiting_vendor' } },
      context: context(),
      services: services(),
    })

    await expect(
      ops.advanceCase.run({
        request: { input: { caseId: incident.id, status: 'resolved' } },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('will not close a case through the ordinary advance path', async () => {
    // Closing carries the money and needs `incident.resolve`. Routing it here
    // would let `incident.update` close a case with costs on it.
    const incident = await openCase()
    await expect(
      ops.advanceCase.run({
        request: { input: { caseId: incident.id, status: 'closed' } },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })
})

/* ────────────────────────────── the decision ───────────────────────────── */

const decisionInput = {
  outcome: 'guest_responsible' as const,
  basis: 'evidence_reviewed' as const,
  assessedTotalAgorot: 141_000,
  guestChargeAgorot: 141_000,
  ownerChargeAgorot: 0,
  businessAbsorbedAgorot: 0,
  supportingEvidenceIds: [],
  supersedesDecisionId: null,
}

describe('deciding who pays', () => {
  it('records the person, the ground and the sentence', async () => {
    const incident = await openCase()

    const outcome = await ops.decideLiability.run({
      request: { input: { ...decisionInput, caseId: incident.id } },
      context: context({ reason: RATIONALE }),
      services: services(),
    })

    expect(outcome.data.decidedByUserId).toBe('user-operations_manager')
    expect(outcome.data.rationale).toBe(RATIONALE)
    expect(outcome.data.basis).toBe('evidence_reviewed')
    expect(outcome.events.map((event) => event.name)).toEqual([
      'approval.decided',
    ])
  })

  it('is refused without a stated reason', async () => {
    // `requiresReason` is set explicitly on this operation, and the reason IS
    // the rationale. A decision nobody could be bothered to explain is not one.
    const incident = await openCase()

    await expect(
      ops.decideLiability.run({
        request: { input: { ...decisionInput, caseId: incident.id } },
        context: context({ reason: null }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('is refused to a scheduled job even holding every grant', async () => {
    // The grant is not the question. A system actor may open cases, attach
    // evidence and chase vendors; it may not say whose fault it was.
    const incident = await openCase()

    await expect(
      ops.decideLiability.run({
        request: { input: { ...decisionInput, caseId: incident.id } },
        context: context({
          reason: RATIONALE,
          auditActor: {
            type: 'system',
            userId: null,
            label: 'nightly-case-sweep',
          },
        }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('is refused to an AI agent for the same reason', async () => {
    const incident = await openCase()

    await expect(
      ops.decideLiability.run({
        request: { input: { ...decisionInput, caseId: incident.id } },
        context: context({
          reason: RATIONALE,
          auditActor: {
            type: 'ai_agent',
            userId: null,
            label: 'Damage Review · Vision',
            onBehalfOfUserId: 'user-operations_manager',
          },
        }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('is refused to a supervisor who may work a case but not settle it', async () => {
    const incident = await openCase()

    await expect(
      ops.decideLiability.run({
        request: { input: { ...decisionInput, caseId: incident.id } },
        context: context({
          reason: RATIONALE,
          actor: actorFor('housekeeping_supervisor'),
          auditActor: {
            type: 'user',
            userId: 'user-housekeeping_supervisor',
            label: 'אורית',
          },
        }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  it('refuses an allocation that does not add up', async () => {
    const incident = await openCase()

    await expect(
      ops.decideLiability.run({
        request: {
          input: {
            ...decisionInput,
            caseId: incident.id,
            guestChargeAgorot: 140_000,
          },
        },
        context: context({ reason: RATIONALE }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('moves no money — the decision is a row and nothing else', async () => {
    const incident = await openCase()
    await ops.decideLiability.run({
      request: { input: { ...decisionInput, caseId: incident.id } },
      context: context({ reason: RATIONALE }),
      services: services(),
    })

    // Nothing in the emitted events asks a payment provider for anything.
    // Applying the deposit is `money_access_cancellation` and goes through
    // `src/lib/payments` with its own grants and its own approval.
    for (const event of events.published) {
      expect(event.name).not.toMatch(/^(payment|deposit)\./)
    }
  })
})

/* ──────────────────────────────── closing ──────────────────────────────── */

describe('closing a case', () => {
  async function resolvedCase() {
    const incident = await openCase()
    await ops.advanceCase.run({
      request: { input: { caseId: incident.id, status: 'resolved' } },
      context: context(),
      services: services(),
    })
    return incident
  }

  it('closes a case with nothing outstanding', async () => {
    const incident = await resolvedCase()

    const outcome = await ops.closeCase.run({
      request: { input: { caseId: incident.id } },
      context: context(),
      services: services(),
    })

    expect(outcome.data.status).toBe('closed')
    expect(outcome.data.closedByUserId).toBe('user-operations_manager')
    // No event: `incident.closed` does not exist in the frozen catalogue.
    expect(outcome.events).toEqual([])
  })

  it('refuses to close over an unanswered question', async () => {
    const incident = await resolvedCase()
    await cases.insertQuestion(
      ORG,
      {
        caseId: incident.id,
        audience: 'guest',
        question: 'האם השיש היה שרוט כשנכנסת?',
        askedByUserId: 'user-operations_manager',
      },
      NOW,
    )

    await expect(
      ops.closeCase.run({
        request: { input: { caseId: incident.id } },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses to close over money nobody decided', async () => {
    const incident = await resolvedCase()
    await cases.insertCostLine(
      {
        organizationId: ORG,
        caseId: incident.id,
        kind: 'actual_repair',
        description: 'החלפת משטח עבודה',
        amountAgorot: 141_000,
        incurredOn: '2026-04-08',
        evidenceId: null,
        recordedByUserId: 'user-operations_manager',
      },
      NOW,
    )

    await expect(
      ops.closeCase.run({
        request: { input: { caseId: incident.id } },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('closes once the money has a decision behind it', async () => {
    const incident = await resolvedCase()
    await cases.insertCostLine(
      {
        organizationId: ORG,
        caseId: incident.id,
        kind: 'actual_repair',
        description: 'החלפת משטח עבודה',
        amountAgorot: 141_000,
        incurredOn: '2026-04-08',
        evidenceId: null,
        recordedByUserId: 'user-operations_manager',
      },
      NOW,
    )
    await ops.decideLiability.run({
      request: { input: { ...decisionInput, caseId: incident.id } },
      context: context({ reason: RATIONALE }),
      services: services(),
    })

    const outcome = await ops.closeCase.run({
      request: { input: { caseId: incident.id } },
      context: context(),
      services: services(),
    })
    expect(outcome.data.status).toBe('closed')
  })

  it('is refused to a supervisor holding only incident.update', async () => {
    const incident = await resolvedCase()

    await expect(
      ops.closeCase.run({
        request: { input: { caseId: incident.id } },
        context: context({
          actor: actorFor('housekeeping_supervisor'),
          auditActor: {
            type: 'user',
            userId: 'user-housekeeping_supervisor',
            label: 'אורית',
          },
        }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })
})
