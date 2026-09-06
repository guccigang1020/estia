/**
 * The earlier-delivery request, through the real pipeline.
 *
 * Three claims, and only one of them is "it works":
 *
 *   1. A supervisor who may fold linen may not renegotiate with the provider.
 *   2. An order that has already arrived cannot be hurried.
 *   3. The moment the provider committed to survives the asking.
 *
 * The third is the one worth the file. A command that recorded the request by
 * overwriting `expected_return_at` would pass every happy-path assertion and
 * would have destroyed the only evidence of what was actually agreed — which
 * is the question asked on the day the van turns up late.
 */

import { describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../audit/pipeline'
import type { AuditActor } from '../audit/events'
import { AuthorizationError, type Actor } from '../authz/can'
import type { Grant } from '../authz/permissions'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'
import { FakeSupabaseClient } from '../persistence/fake-client'
import {
  InMemoryEventBus,
  RecordingTransactionRunner,
  type OperationContext,
  type OperationServices,
} from '../service'

import {
  LaundryAlreadyDeliveredError,
  LaundryNotEarlierError,
  LaundryOrderNotSentError,
  defineLaundryCommands,
  EARLIER_DELIVERY_KEY,
  type EarlierDeliveryRequest,
} from './commands'
import { LaundryOrderHasNoProviderError } from './operations'
import type { LaundryOrder, LaundryStatus } from './types'

const ORGANIZATION = 'org-example'
const PROPERTY = 'property-galilee'
const ORDER = 'order-1'
const PROVIDER = 'provider-north'
const USER = 'user-michal'
const NOW = new Date('2026-09-02T08:00:00.000Z')
const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

/** What the provider committed to, and what the business needs. */
const PROMISED = '2026-09-04T14:00:00.000Z'
const REQUIRED_BY = '2026-09-04T16:00:00.000Z'
/** Earlier than both, and after `NOW`. */
const ASKED_FOR = '2026-09-03T09:00:00.000Z'

// ── The world ─────────────────────────────────────────────────────────────

function order(overrides: Partial<LaundryOrder> = {}): LaundryOrder {
  return {
    id: ORDER,
    organizationId: ORGANIZATION,
    propertyId: PROPERTY,
    providerId: PROVIDER,
    status: 'washing',
    mode: 'external',
    dispatchMode: 'approval_required',
    channel: 'whatsapp',
    reference: 'L-2609-01',
    requirementKey: 'provider-north|external|2026-09-04|towels:40',
    requiredBy: REQUIRED_BY,
    pickupAt: '2026-09-02T06:00:00.000Z',
    expectedReturnAt: PROMISED,
    returnedAt: null,
    sentAt: '2026-09-01T10:00:00.000Z',
    sentBody: 'ההזמנה כפי שנשלחה',
    internalNotes: null,
    providerNotes: null,
    lines: [],
    version: 3,
    ...overrides,
  }
}

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

function context(grants: readonly Grant[]): OperationContext {
  return {
    actor: actor(grants),
    auditActor: AUDIT_ACTOR,
    correlationId: 'req-laundry-earlier-1',
    now: NOW,
  }
}

/**
 * A world with one order and a fake client seeded for the read and the write.
 *
 * `existingMetadata` is what the row already holds, so the append can be
 * checked against something rather than against an empty object — a command
 * that replaced the whole jsonb would look identical otherwise.
 */
function world(
  options: {
    entity?: LaundryOrder
    existingMetadata?: Record<string, unknown>
  } = {},
) {
  const entity = options.entity ?? order()
  const client = new FakeSupabaseClient({
    responses: {
      'laundry_orders:select': {
        data: { metadata: options.existingMetadata ?? {} },
      },
      'laundry_orders:update': { data: null },
    },
  })

  const audit = new InMemoryAuditWriter()
  const events = new InMemoryEventBus()
  const transactions = new RecordingTransactionRunner()
  const services: OperationServices = { audit, events, transactions }

  const commands = defineLaundryCommands({
    db: client.asDb(),
    ports: {
      async loadOrder(id) {
        return id === entity.id ? entity : null
      },
      async messageContext() {
        throw new Error('not used')
      },
    },
  })

  return { entity, client, audit, events, services, commands }
}

function run(
  built: ReturnType<typeof world>,
  grants: readonly Grant[],
  overrides: { requestedReturnAt?: string; expectedVersion?: number } = {},
) {
  return built.commands.requestEarlierDelivery.run({
    request: {
      resourceId: built.entity.id,
      expectedVersion: overrides.expectedVersion ?? built.entity.version,
      input: {
        requestedReturnAt: overrides.requestedReturnAt ?? ASKED_FOR,
        channel: 'whatsapp',
        body: 'שלום, אפשר להקדים את ההחזרה ליום חמישי בבוקר?',
      },
    },
    context: context(grants),
    services: built.services,
  })
}

/** The single request this command appended, read back off the update. */
function appended(client: FakeSupabaseClient): EarlierDeliveryRequest {
  const update = client
    .queriesFor('laundry_orders')
    .find((query) => query.verb === 'update')

  const payload = update?.payload as
    { metadata?: Record<string, unknown> } | undefined
  const list = payload?.metadata?.[EARLIER_DELIVERY_KEY]
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('no earlier-delivery request was written')
  }
  return list[list.length - 1] as EarlierDeliveryRequest
}

// ── The grant ─────────────────────────────────────────────────────────────

describe('requestEarlierDelivery — the grant', () => {
  it('refuses somebody who may run the laundry but not talk to the provider', async () => {
    const built = world()

    await expect(
      run(built, ['laundry.manage', 'laundry.order_create']),
    ).rejects.toBeInstanceOf(AuthorizationError)

    // Refused before anything was read. The whole point of checking the grant
    // ahead of the load.
    expect(built.client.queries).toHaveLength(0)
    expect(built.audit.records).toHaveLength(0)
  })

  it('allows the grant that gates leaving the organization', async () => {
    const built = world()
    const outcome = await run(built, ['laundry.order_send'])

    expect(outcome.ok).toBe(true)
    expect(outcome.data.requestedReturnAt).toBe(ASKED_FOR)
    expect(outcome.data.requestCount).toBe(1)
  })
})

// ── The states in which asking is meaningless ─────────────────────────────

describe('requestEarlierDelivery — refusals', () => {
  it('refuses an order that has already been delivered', async () => {
    const built = world({
      entity: order({ status: 'delivered_to_property' }),
    })

    await expect(run(built, ['laundry.order_send'])).rejects.toBeInstanceOf(
      LaundryAlreadyDeliveredError,
    )

    // Nothing was written. A refusal that had already touched the row would
    // leave a request recorded against linen sitting in the cupboard.
    expect(
      built.client
        .queriesFor('laundry_orders')
        .filter((q) => q.verb === 'update'),
    ).toHaveLength(0)
    expect(built.audit.records).toHaveLength(0)
  })

  it.each<LaundryStatus>(['completed', 'cancelled'])(
    'refuses a %s order',
    async (status) => {
      const built = world({ entity: order({ status }) })
      await expect(run(built, ['laundry.order_send'])).rejects.toThrow()
      expect(built.audit.records).toHaveLength(0)
    },
  )

  it('refuses an internal batch, which has no outside company to ask', async () => {
    const built = world({
      entity: order({ providerId: null, mode: 'internal' }),
    })

    await expect(run(built, ['laundry.order_send'])).rejects.toBeInstanceOf(
      LaundryOrderHasNoProviderError,
    )
  })

  it('refuses an order the provider has never been told about', async () => {
    const built = world({
      entity: order({ status: 'draft', sentAt: null, sentBody: null }),
    })

    await expect(run(built, ['laundry.order_send'])).rejects.toBeInstanceOf(
      LaundryOrderNotSentError,
    )
  })

  it('refuses a moment that is not earlier than the one promised', async () => {
    const built = world()

    await expect(
      run(built, ['laundry.order_send'], {
        requestedReturnAt: '2026-09-05T09:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(LaundryNotEarlierError)
  })
})

// ── The evidence ──────────────────────────────────────────────────────────

describe('requestEarlierDelivery — the original deadline survives', () => {
  it('never writes expected_return_at, required_by or status', async () => {
    const built = world()
    await run(built, ['laundry.order_send'])

    const update = built.client
      .queriesFor('laundry_orders')
      .find((query) => query.verb === 'update')
    const payload = update?.payload as Record<string, unknown>

    expect(payload).toBeDefined()
    expect(payload).not.toHaveProperty('expected_return_at')
    expect(payload).not.toHaveProperty('required_by')
    expect(payload).not.toHaveProperty('status')
    expect(payload).not.toHaveProperty('sent_body')
  })

  it('records the requested moment beside the promised one', async () => {
    const built = world()
    await run(built, ['laundry.order_send'])

    const request = appended(built.client)

    expect(request.requestedReturnAt).toBe(ASKED_FOR)
    expect(request.originalExpectedReturnAt).toBe(PROMISED)
    expect(request.originalRequiredBy).toBe(REQUIRED_BY)
    expect(request.requestedByUserId).toBe(USER)
    expect(request.body).toContain('להקדים')
  })

  it('keeps the audit row showing the unchanged commitment', async () => {
    const built = world()
    await run(built, ['laundry.order_send'])

    // The pipeline stores the difference between `before` and `after`. Naming
    // the promised time in both halves would delete it from the row, which is
    // why this operation supplies no `before` at all.
    const [record] = built.audit.records
    expect(record.after).toMatchObject({
      expectedReturnAt: PROMISED,
      requiredBy: REQUIRED_BY,
      requestedReturnAt: ASKED_FOR,
    })
    expect(record.summary).toContain('המועד שסוכם לא שונה')
  })

  it('appends a second request rather than replacing the first', async () => {
    const first: EarlierDeliveryRequest = {
      requestedAt: '2026-09-01T12:00:00.000Z',
      requestedByUserId: 'user-dana',
      originalExpectedReturnAt: PROMISED,
      originalRequiredBy: REQUIRED_BY,
      requestedReturnAt: '2026-09-03T18:00:00.000Z',
      channel: 'whatsapp',
      body: 'בקשה ראשונה',
    }

    const built = world({
      existingMetadata: {
        // Somebody else's note, which must survive the append.
        importedFrom: 'legacy',
        [EARLIER_DELIVERY_KEY]: [first],
      },
    })

    const outcome = await run(built, ['laundry.order_send'])
    expect(outcome.data.requestCount).toBe(2)

    const update = built.client
      .queriesFor('laundry_orders')
      .find((query) => query.verb === 'update')
    const metadata = (update?.payload as { metadata: Record<string, unknown> })
      .metadata

    expect(metadata.importedFrom).toBe('legacy')
    const list = metadata[EARLIER_DELIVERY_KEY] as EarlierDeliveryRequest[]
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual(first)
  })

  it('raises the earlier-delivery event and names the request in it', async () => {
    const built = world()
    await run(built, ['laundry.order_send'])

    const [event] = built.events.published
    expect(event.name).toBe('laundry.earlier_delivery_requested')
    expect(event.payload).toMatchObject({
      orderId: ORDER,
      earlierDeliveryRequested: true,
      requestedReturnAt: ASKED_FOR,
      expectedReturnAt: PROMISED,
    })
  })
})
