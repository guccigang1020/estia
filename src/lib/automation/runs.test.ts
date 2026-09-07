/**
 * Writing and reading the decision record.
 *
 * The write is one RPC call and almost all of it is shape, so what is asserted
 * is the part a mistake would be invisible in:
 *
 *   · **no round trip when nothing listens.** Ninety-odd catalogue names reach
 *     no shipped rule, and every one of them passes through this on somebody's
 *     booking request. A call per event would be a cost nobody measured.
 *   · **the key is stable and it separates.** Two redeliveries of one event are
 *     one key; two different events of one operation are two. The unique
 *     constraint in 0075 is only as good as what is handed to it.
 *   · **the argument names match the function.** A misspelled `p_` name is a
 *     silent null on the SQL side, not an error.
 */

import { describe, expect, it } from 'vitest'

import type { Db } from '../persistence/client'
import type { DomainEvent } from '../service'

import {
  AutomationRunRepository,
  automationEventKey,
  recordAutomationEvaluation,
} from './runs'

const ORG = '11111111-1111-4111-8111-111111111111'
const PROPERTY = '22222222-2222-4222-8222-222222222222'

interface Calls {
  rpc: { name: string; args: Record<string, unknown> }[]
}

function fakeRpcDb(calls: Calls, result: unknown = 1): Db {
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.rpc.push({ name, args })
      return { data: result, error: null }
    },
  } as unknown as Db
}

function event(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    name: 'payment.failed',
    organizationId: ORG,
    propertyId: PROPERTY,
    correlationId: 'corr-1',
    occurredAt: new Date('2026-03-01T10:00:00.000Z'),
    payload: { status: 'failed' },
    ...overrides,
  }
}

describe('automationEventKey', () => {
  it('is the same for two deliveries of one event', () => {
    expect(automationEventKey(event())).toBe(automationEventKey(event()))
  })

  it('does not depend on the order of keys in the payload', () => {
    const a = automationEventKey(event({ payload: { a: 1, b: 2 } }))
    const b = automationEventKey(event({ payload: { b: 2, a: 1 } }))
    expect(a).toBe(b)
  })

  it('separates two events of the same operation', () => {
    // One booking confirmation emits several events under one correlation id.
    // A key that was only the correlation would deduplicate them into one.
    const first = automationEventKey(event({ name: 'booking.confirmed' }))
    const second = automationEventKey(event({ name: 'booking.deposit_paid' }))
    expect(first).not.toBe(second)
  })

  it('separates two events of one name about different things', () => {
    const first = automationEventKey(event({ payload: { id: 'a' } }))
    const second = automationEventKey(event({ payload: { id: 'b' } }))
    expect(first).not.toBe(second)
  })
})

describe('recordAutomationEvaluation', () => {
  it('does not reach the database for an event no rule listens to', async () => {
    const calls: Calls = { rpc: [] }
    const written = await recordAutomationEvaluation(
      fakeRpcDb(calls),
      event({ name: 'guest.link_opened' }),
    )

    expect(written).toBe(0)
    expect(calls.rpc).toEqual([])
  })

  it('calls the recorder with the arguments the function declares', async () => {
    const calls: Calls = { rpc: [] }
    await recordAutomationEvaluation(fakeRpcDb(calls, 1), event())

    expect(calls.rpc).toHaveLength(1)
    const [call] = calls.rpc
    expect(call.name).toBe('record_automation_evaluation')
    expect(Object.keys(call.args).sort()).toEqual([
      'p_candidates',
      'p_correlation_id',
      'p_event_key',
      'p_event_name',
      'p_occurred_at',
      'p_organization_id',
      'p_property_id',
    ])
    expect(call.args.p_organization_id).toBe(ORG)
    expect(call.args.p_property_id).toBe(PROPERTY)
    expect(call.args.p_event_name).toBe('payment.failed')
    expect(call.args.p_occurred_at).toBe('2026-03-01T10:00:00.000Z')
  })

  it('sends each candidate in the shape 0075 reads out of jsonb', async () => {
    const calls: Calls = { rpc: [] }
    await recordAutomationEvaluation(
      fakeRpcDb(calls, 1),
      event({ name: 'booking.completed', payload: { nights: 3 } }),
    )

    const candidates = calls.rpc[0].args.p_candidates as Record<
      string,
      unknown
    >[]
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toEqual({
      template_id: 'review-request-after-stay',
      shipped_enabled: false,
      conditions_met: true,
      reason: null,
      gates: [
        {
          key: 'minimum_nights',
          operator: 'at_least',
          fact: 3,
          shipped: 2,
        },
      ],
      would_perform: [
        { kind: 'request_review', note: 'נשלחה לאורח בקשה לחוות דעת' },
      ],
      facts: { nights: 3 },
    })
  })

  it('sends only the facts a rule compares, never the whole payload', async () => {
    const calls: Calls = { rpc: [] }
    await recordAutomationEvaluation(
      fakeRpcDb(calls, 1),
      event({
        name: 'booking.completed',
        payload: { nights: 2, guestName: 'דנה כהן', guestEmail: 'a@b.c' },
      }),
    )

    const candidates = calls.rpc[0].args.p_candidates as Record<
      string,
      unknown
    >[]
    expect(candidates[0].facts).toEqual({ nights: 2 })
  })

  it('returns what the recorder counted, so a redelivery reads as zero', async () => {
    const calls: Calls = { rpc: [] }
    // The second delivery of one event loses the ON CONFLICT and writes nothing.
    const written = await recordAutomationEvaluation(
      fakeRpcDb(calls, 0),
      event(),
    )
    expect(written).toBe(0)
  })

  it('throws when the database refuses, so the bus can collect it', async () => {
    const db = {
      async rpc() {
        return { data: null, error: { message: 'not a member' } }
      },
    } as unknown as Db

    await expect(recordAutomationEvaluation(db, event())).rejects.toBeDefined()
  })
})

describe('AutomationRunRepository', () => {
  interface Issued {
    filters: Record<string, unknown>
    or: string[]
    order: { column: string; ascending: boolean }[]
    limit: number | null
  }

  function fakeDb(
    rows: readonly Record<string, unknown>[],
    issued: Issued,
  ): Db {
    const chain = {
      eq(column: string, value: unknown) {
        issued.filters[column] = value
        return chain
      },
      or(expression: string) {
        issued.or.push(expression)
        return chain
      },
      order(column: string, options: { ascending: boolean }) {
        issued.order.push({ column, ascending: options.ascending })
        return chain
      },
      async limit(value: number) {
        issued.limit = value
        return { data: rows, error: null }
      },
      async maybeSingle() {
        return { data: rows[0] ?? null, error: null }
      },
    }

    return {
      from() {
        return { select: () => chain }
      },
    } as unknown as Db
  }

  function issued(): Issued {
    return { filters: {}, or: [], order: [], limit: null }
  }

  const row = {
    id: '33333333-3333-4333-8333-333333333333',
    property_id: PROPERTY,
    template_id: 'payment-failed-alert',
    event_name: 'payment.failed',
    decision: 'would_act',
    source: 'shipped',
    reason: null,
    would_perform: [{ kind: 'notify_team', note: 'הצוות עודכן' }],
    facts: { status: 'failed' },
    occurred_at: '2026-03-01T10:00:00.000Z',
    decided_at: '2026-03-01T10:00:01.000Z',
    performed_at: null,
  }

  it('reads the newest decisions first', async () => {
    const seen = issued()
    await new AutomationRunRepository(fakeDb([row], seen)).recent(ORG, null, 50)

    expect(seen.filters.organization_id).toBe(ORG)
    expect(seen.order).toEqual([{ column: 'decided_at', ascending: false }])
    expect(seen.limit).toBe(50)
    // An organization view asks for no property, so it must not narrow.
    expect(seen.or).toEqual([])
  })

  it('includes the organization-wide rows in a property view', async () => {
    const seen = issued()
    await new AutomationRunRepository(fakeDb([row], seen)).recent(
      ORG,
      PROPERTY,
      50,
    )

    // `eq` alone would hide every decision about an event that named no
    // property, which is most of them.
    expect(seen.or).toEqual([`property_id.eq.${PROPERTY},property_id.is.null`])
  })

  it('maps a decision without inventing anything', async () => {
    const [decision] = await new AutomationRunRepository(
      fakeDb([row], issued()),
    ).recent(ORG, null, 50)

    expect(decision.decision).toBe('would_act')
    expect(decision.source).toBe('shipped')
    expect(decision.wouldPerform).toEqual([
      { kind: 'notify_team', note: 'הצוות עודכן' },
    ])
    // Nothing performs. The column is null and the screen says why.
    expect(decision.performedAt).toBeNull()
  })

  it('drops an action entry the screen could not render, keeping the rest', async () => {
    const [decision] = await new AutomationRunRepository(
      fakeDb(
        [
          {
            ...row,
            would_perform: [
              { kind: 'notify_team', note: 'הצוות עודכן' },
              { kind: 'create_task' },
              'not an action',
            ],
          },
        ],
        issued(),
      ),
    ).recent(ORG, null, 50)

    // One bad row must not make a whole organization's screen fail to render.
    expect(decision.wouldPerform).toEqual([
      { kind: 'notify_team', note: 'הצוות עודכן' },
    ])
  })

  it('reads no consent as null, which is the state every business is in', async () => {
    const consent = await new AutomationRunRepository(
      fakeDb([], issued()),
    ).consent(ORG)

    expect(consent).toBeNull()
  })

  it('reads a stored consent without softening what it says', async () => {
    const consent = await new AutomationRunRepository(
      fakeDb(
        [
          {
            organization_id: ORG,
            performing_enabled: false,
            note: 'נבדק במשך שבוע',
            consented_at: null,
            consented_by: null,
            revoked_at: '2026-03-02T09:00:00.000Z',
          },
        ],
        issued(),
      ),
    ).consent(ORG)

    expect(consent?.performingEnabled).toBe(false)
    expect(consent?.revokedAt).toBe('2026-03-02T09:00:00.000Z')
  })
})
