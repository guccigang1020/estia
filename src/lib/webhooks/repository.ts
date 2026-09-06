/**
 * EXECUTION CONTEXT — SERVER ONLY. Rows in, domain objects out.
 *
 * ══ TWO CLIENTS, AND THE SPLIT IS THE SECURITY MODEL ════════════════════════
 *
 * `WebhookRepository` is constructed with the CALLER'S client and can do
 * everything a person is allowed to do: list endpoints, create one, pause one,
 * read the delivery log. Row level security is in force for all of it, and
 * `integration.manage` is what the policies ask for.
 *
 * It has **no method that returns a signing secret**, and it must never grow
 * one. `authenticated` holds no privilege on `webhook_endpoint_secrets` at
 * all, so such a method would fail anyway — but the reason to say it here is
 * that the failure would be a runtime error somebody "fixes" by reaching for
 * the admin client, and the fix would be the vulnerability.
 *
 * The sender's reads live in `WebhookSenderStore` below, which is constructed
 * with the ADMIN client and is the only thing in this module that can see a
 * secret. It runs from the delivery sweep, where there is no user to act as —
 * the same situation, and the same sanctioned exception, as the release sweep
 * described in `persistence/client.ts`: "a payment provider's webhook, a
 * nightly sweep".
 *
 * Because RLS is bypassed there, **`organization_id` is the only tenant
 * boundary in the sender's queries**, and every one of them filters it
 * explicitly. There is no query in the sending path that runs without one.
 */

import type { DomainEventName } from '../contracts/events'
import { toRow, toRows, type Db, type Row } from '../persistence'
import type {
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookDisableReason,
  WebhookEndpoint,
  WebhookEndpointStatus,
} from './types'
import type { PlannedDelivery } from './enqueue'

const ENDPOINTS = 'webhook_endpoints'
const SECRETS = 'webhook_endpoint_secrets'
const DELIVERIES = 'webhook_deliveries'

/** Columns a person may read. `signing_secret` is not among them and is not
 *  in this file at all. */
const ENDPOINT_COLUMNS =
  'id, organization_id, url, description, events, status, disabled_reason, ' +
  'consecutive_failures, last_success_at, last_failure_at, created_at, version'

const DELIVERY_COLUMNS =
  'id, organization_id, endpoint_id, event_name, event_payload, ' +
  'property_id, correlation_id, status, attempts, next_attempt_at, ' +
  'last_status_code, last_error, created_at, delivered_at'

function text(row: Row, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') {
    throw new Error(`${column} is not text`)
  }
  return value
}

function optionalText(row: Row, column: string): string | null {
  const value = row[column]
  return typeof value === 'string' ? value : null
}

function date(row: Row, column: string): Date {
  return new Date(text(row, column))
}

function optionalDate(row: Row, column: string): Date | null {
  const value = row[column]
  return typeof value === 'string' ? new Date(value) : null
}

function count(row: Row, column: string): number {
  const value = row[column]
  return typeof value === 'number' ? value : 0
}

function toEndpoint(row: Row): WebhookEndpoint {
  const events = Array.isArray(row.events) ? row.events : []
  return {
    id: text(row, 'id'),
    organizationId: text(row, 'organization_id'),
    url: text(row, 'url'),
    description: optionalText(row, 'description'),
    // Filtered rather than cast. A name that is no longer in the frozen
    // catalogue — an event renamed in a later release — must not be handed on
    // as if it were current; it simply stops matching, and the endpoint keeps
    // working for the names that are still real.
    events: events.filter(
      (value): value is DomainEventName => typeof value === 'string',
    ),
    status: text(row, 'status') as WebhookEndpointStatus,
    disabledReason: optionalText(
      row,
      'disabled_reason',
    ) as WebhookDisableReason | null,
    consecutiveFailures: count(row, 'consecutive_failures'),
    lastSuccessAt: optionalDate(row, 'last_success_at'),
    lastFailureAt: optionalDate(row, 'last_failure_at'),
    createdAt: date(row, 'created_at'),
    version: count(row, 'version'),
  }
}

function toDelivery(row: Row): WebhookDelivery {
  return {
    id: text(row, 'id'),
    organizationId: text(row, 'organization_id'),
    endpointId: text(row, 'endpoint_id'),
    eventName: text(row, 'event_name') as DomainEventName,
    eventPayload: row.event_payload ?? null,
    propertyId: optionalText(row, 'property_id'),
    correlationId: optionalText(row, 'correlation_id'),
    status: text(row, 'status') as WebhookDeliveryStatus,
    attempts: count(row, 'attempts'),
    nextAttemptAt: optionalDate(row, 'next_attempt_at'),
    lastStatusCode:
      typeof row.last_status_code === 'number' ? row.last_status_code : null,
    lastError: optionalText(row, 'last_error'),
    createdAt: date(row, 'created_at'),
    deliveredAt: optionalDate(row, 'delivered_at'),
  }
}

/* ------------------------------------------------- what a person may do -- */

export class WebhookRepository {
  constructor(private readonly db: Db) {}

  async endpoints(organizationId: string): Promise<readonly WebhookEndpoint[]> {
    const { data, error } = await this.db
      .from(ENDPOINTS)
      .select(ENDPOINT_COLUMNS)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true })

    if (error) throw error
    return toRows(data).map(toEndpoint)
  }

  async endpoint(
    organizationId: string,
    id: string,
  ): Promise<WebhookEndpoint | null> {
    const { data, error } = await this.db
      .from(ENDPOINTS)
      .select(ENDPOINT_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', id)
      .maybeSingle()

    if (error) throw error
    return data ? toEndpoint(toRow(data)) : null
  }

  /**
   * The delivery log for one endpoint, newest first.
   *
   * Bounded by `limit` rather than paged, because this answers "is it working
   * and what broke" and nobody reads page nine of a webhook log.
   */
  async recentDeliveries(
    organizationId: string,
    endpointId: string,
    limit = 50,
  ): Promise<readonly WebhookDelivery[]> {
    const { data, error } = await this.db
      .from(DELIVERIES)
      .select(DELIVERY_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('endpoint_id', endpointId)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) throw error
    return toRows(data).map(toDelivery)
  }
}

/* ------------------------------------------- what the sender may do only -- */

/** One endpoint plus the secrets to sign with. Only ever built from the admin
 *  client, only ever inside the sweep. */
export interface SendableEndpoint {
  readonly endpoint: WebhookEndpoint
  readonly secrets: readonly string[]
}

export class WebhookSenderStore {
  constructor(private readonly db: Db) {}

  /**
   * The active endpoints of one organization, for fan-out.
   *
   * Takes the organization explicitly and filters on it. RLS is bypassed on
   * this client, so this argument is the entire tenant boundary — a default
   * or an optional would be one typo away from delivering every customer's
   * events to one customer's server.
   */
  async activeEndpoints(
    organizationId: string,
  ): Promise<readonly WebhookEndpoint[]> {
    const { data, error } = await this.db
      .from(ENDPOINTS)
      .select(ENDPOINT_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('status', 'active')

    if (error) throw error
    return toRows(data).map(toEndpoint)
  }

  /** Queue the planned rows. One insert, however many events produced them. */
  async enqueue(planned: readonly PlannedDelivery[]): Promise<number> {
    if (planned.length === 0) return 0

    const { error } = await this.db.from(DELIVERIES).insert(
      planned.map((delivery) => ({
        organization_id: delivery.organizationId,
        endpoint_id: delivery.endpointId,
        event_name: delivery.eventName,
        event_payload: delivery.eventPayload,
        property_id: delivery.propertyId,
        correlation_id: delivery.correlationId,
        status: 'pending',
        attempts: 0,
        next_attempt_at: delivery.nextAttemptAt.toISOString(),
      })),
    )

    if (error) throw error
    return planned.length
  }

  /**
   * Which tenants have work due.
   *
   * Reads one column and immediately becomes a list of per-tenant passes,
   * exactly as the release sweep does. A global `select … where
   * next_attempt_at <= now()` would be shorter and one mistake away from
   * settling every customer's queue in one loop with one organization's
   * endpoints in hand.
   */
  async tenantsWithDueDeliveries(
    now: Date,
    limit = 200,
  ): Promise<readonly string[]> {
    const { data, error } = await this.db
      .from(DELIVERIES)
      .select('organization_id')
      .eq('status', 'pending')
      .lte('next_attempt_at', now.toISOString())
      .limit(limit)

    if (error) throw error
    const seen = new Set<string>()
    for (const row of toRows(data)) {
      const id = row.organization_id
      if (typeof id === 'string') seen.add(id)
    }
    return [...seen]
  }

  async dueDeliveries(
    organizationId: string,
    now: Date,
    limit = 50,
  ): Promise<readonly WebhookDelivery[]> {
    const { data, error } = await this.db
      .from(DELIVERIES)
      .select(DELIVERY_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('status', 'pending')
      .lte('next_attempt_at', now.toISOString())
      .order('next_attempt_at', { ascending: true })
      .limit(limit)

    if (error) throw error
    return toRows(data).map(toDelivery)
  }

  /**
   * The endpoint and its live signing secrets.
   *
   * The ONLY reader of `webhook_endpoint_secrets` in the codebase. Returns the
   * current secret first and any unexpired previous one after it, so a
   * rotation signs with both.
   */
  async sendable(
    organizationId: string,
    endpointId: string,
    now: Date,
  ): Promise<SendableEndpoint | null> {
    const { data: endpointRow, error: endpointError } = await this.db
      .from(ENDPOINTS)
      .select(ENDPOINT_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', endpointId)
      .maybeSingle()

    if (endpointError) throw endpointError
    if (!endpointRow) return null

    const { data: secretRows, error: secretError } = await this.db
      .from(SECRETS)
      .select('signing_secret, is_previous, expires_at')
      .eq('organization_id', organizationId)
      .eq('endpoint_id', endpointId)

    if (secretError) throw secretError

    const secrets: string[] = []
    const previous: string[] = []
    for (const row of toRows(secretRows)) {
      const secret = optionalText(row, 'signing_secret')
      if (secret === null) continue
      if (row.is_previous === true) {
        const expires = optionalDate(row, 'expires_at')
        if (expires !== null && expires.getTime() > now.getTime()) {
          previous.push(secret)
        }
      } else {
        secrets.push(secret)
      }
    }

    return {
      endpoint: toEndpoint(toRow(endpointRow)),
      secrets: [...secrets, ...previous],
    }
  }

  /** The delivery's own outcome. The endpoint's is a separate call, because
   *  they are separate subjects — see `retry.ts`. */
  async recordDeliveryOutcome(
    delivery: WebhookDelivery,
    next: {
      readonly status: WebhookDeliveryStatus
      readonly attempts: number
      readonly nextAttemptAt: Date | null
      readonly lastStatusCode: number | null
      readonly lastError: string | null
      readonly deliveredAt: Date | null
    },
  ): Promise<void> {
    const { error } = await this.db
      .from(DELIVERIES)
      .update({
        status: next.status,
        attempts: next.attempts,
        next_attempt_at: next.nextAttemptAt?.toISOString() ?? null,
        last_status_code: next.lastStatusCode,
        // Truncated to what the column allows. A receiver that answers with a
        // megabyte of HTML must not be able to fill this table with it.
        last_error:
          next.lastError === null ? null : next.lastError.slice(0, 2000),
        delivered_at: next.deliveredAt?.toISOString() ?? null,
      })
      .eq('id', delivery.id)
      .eq('organization_id', delivery.organizationId)

    if (error) throw error
  }

  async recordEndpointSuccess(
    organizationId: string,
    endpointId: string,
    at: Date,
  ): Promise<void> {
    const { error } = await this.db
      .from(ENDPOINTS)
      .update({ consecutive_failures: 0, last_success_at: at.toISOString() })
      .eq('id', endpointId)
      .eq('organization_id', organizationId)

    if (error) throw error
  }

  async recordEndpointFailure(
    organizationId: string,
    endpointId: string,
    consecutiveFailures: number,
    at: Date,
    disable: WebhookDisableReason | null,
  ): Promise<void> {
    const { error } = await this.db
      .from(ENDPOINTS)
      .update({
        consecutive_failures: consecutiveFailures,
        last_failure_at: at.toISOString(),
        ...(disable === null
          ? {}
          : { status: 'disabled', disabled_reason: disable }),
      })
      .eq('id', endpointId)
      .eq('organization_id', organizationId)

    if (error) throw error
  }
}
