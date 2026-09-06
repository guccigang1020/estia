/**
 * Reading and writing the six tables the channel manager needs.
 *
 * ══ THE TABLES DO NOT EXIST YET ═════════════════════════════════════════════
 *
 * This file is written against a schema that has been *proposed* and not yet
 * applied. Agents do not write migrations here — the coordinator does — and the
 * proposal is stated in full in this module's report: `channel_connections`,
 * `channel_listings`, `channel_listing_mappings`, `channel_reservations`,
 * `channel_sync_runs`, `channel_exceptions`.
 *
 * Writing the adapter first is deliberate rather than premature. Every column
 * name below is a claim about the schema, and a claim written as code is one
 * the typecheck and the in-memory double can be held against; a claim written
 * as a paragraph in a document is one that drifts the first week. Until the
 * migration lands, `SupabaseChannelRepository` compiles, is never constructed
 * by any screen, and every domain test runs against `InMemoryChannelRepository`.
 *
 * ── The port exists for two reasons ───────────────────────────────────────
 *
 * The engines in this module — mapping, ingestion, modification, cancellation,
 * reconciliation, health — are pure functions over plain data and are tested
 * without a database, a client or a secret. That is only possible while
 * nothing above them reaches for PostgREST. And `src/lib/persistence/**`
 * belongs to another owner, so this module's own adapter lives beside the
 * module that reads it — the same argument `notifications/repository.ts` and
 * `payments/repository.ts` make, made the same way.
 *
 * ── Two operations have unusual semantics, and both are the point ─────────
 *
 * `upsertReservation` is **expected to collide**. The unique index on
 * `(organization_id, ledger_key)` is what makes a redelivered webhook harmless,
 * so hitting it is the system working. The adapter reports `created: false`
 * with the row that was already there rather than throwing a 23505 at a caller
 * who would have to know the constraint's name to interpret it.
 *
 * `raiseException` is the same shape for the same reason:
 * `(organization_id, dedupe_key)` collapses one unmapped listing arriving four
 * hundred times into one row somebody can actually work.
 *
 * Every read is filtered by `organization_id` in the query as well as by row
 * level security. The policy is the enforcement; the filter is what stops a
 * mistake in this file from becoming a cross-tenant read the first time
 * somebody runs it as `service_role`.
 */

import {
  asBoolean,
  asDate,
  asDateOrNull,
  asEnum,
  asNumber,
  asNumberOrNull,
  asString,
  asStringArray,
  asStringOrNull,
  clientFor,
  recordWrite,
  toRow,
  toRows,
  type Db,
  type Row,
} from '../persistence'
import type { TransactionHandle } from '../service'

import {
  CHANNEL_CODES,
  CHANNEL_EXCEPTION_KINDS,
  CHANNEL_RESERVATION_STATUSES,
  CONNECTOR_CAPABILITIES,
  CONNECTOR_STATES,
  EXCEPTION_SEVERITIES,
  EXCEPTION_STATES,
  MAPPING_STATES,
  type ChannelCode,
  type ChannelException,
  type ChannelReservationRecord,
  type Connector,
  type ConnectorCapability,
  type Listing,
  type ListingMapping,
  type SyncDirection,
} from './types'
import type { ChannelExceptionDraft } from './exceptions'
import type { LedgerUpsert } from './ingestion'
import type { DiscoveredListing } from './connector'
import type { MappingDraft } from './mapping'

/* ------------------------------------------------------------------ port -- */

export interface SyncRunRecord {
  organizationId: string
  connectorId: string
  direction: SyncDirection
  capability: ConnectorCapability
  /** `ok` when the channel accepted everything it was sent. */
  status: 'ok' | 'partial' | 'refused'
  startedAt: Date
  finishedAt: Date
  entitiesAttempted: number
  entitiesAccepted: number
  entitiesRejected: number
  failedEntities: readonly string[]
  /** The `ChannelRefusalKind`, when the run was refused. */
  refusalKind: string | null
  refusalDetail: string | null
  correlationId: string
}

/** What `health.ts` needs that is not on the connector row itself. */
export interface SyncCounters {
  pendingOutbound: number
  recentFailures: number
  failedEntities: readonly string[]
}

export interface ExceptionQuery {
  connectorId?: string
  /** Defaults to open plus acknowledged — the ones still waiting on a person. */
  includeSettled?: boolean
  limit?: number
}

export interface ChannelRepository {
  listConnectors(
    organizationId: string,
    propertyId?: string | null,
  ): Promise<readonly Connector[]>

  loadConnector(
    organizationId: string,
    connectorId: string,
  ): Promise<Connector | null>

  listListings(
    organizationId: string,
    connectorId: string,
  ): Promise<readonly Listing[]>

  /**
   * Record what discovery found.
   *
   * An upsert on `(connection_id, external_listing_id, external_variant_id)`
   * and never a delete-then-insert: a listing's id is referenced by every
   * mapping and every exception about it, and re-creating the row would orphan
   * both every time discovery runs. A listing that has vanished from the
   * channel is marked `active = false`, which is information; deleting it is
   * the loss of information dressed as tidiness.
   */
  saveListings(
    organizationId: string,
    connectorId: string,
    listings: readonly DiscoveredListing[],
    at: Date,
    tx?: TransactionHandle,
  ): Promise<readonly Listing[]>

  listMappings(
    organizationId: string,
    connectorId?: string,
  ): Promise<readonly ListingMapping[]>

  saveMapping(
    organizationId: string,
    connectorId: string,
    draft: MappingDraft,
    actorUserId: string | null,
    tx?: TransactionHandle,
  ): Promise<ListingMapping>

  setMappingState(
    organizationId: string,
    mappingId: string,
    state: ListingMapping['state'],
    actorUserId: string | null,
    tx?: TransactionHandle,
  ): Promise<void>

  /** `null` on a first sighting. The read that makes ingestion idempotent. */
  findReservation(
    organizationId: string,
    ledgerKey: string,
  ): Promise<ChannelReservationRecord | null>

  /** `created: false` means the unique index held — see the header. */
  upsertReservation(
    ledger: LedgerUpsert,
    tx?: TransactionHandle,
  ): Promise<{ record: ChannelReservationRecord; created: boolean }>

  /** Called after `booking.create` succeeds, closing the loop. */
  attachBooking(
    organizationId: string,
    ledgerKey: string,
    bookingId: string,
    tx?: TransactionHandle,
  ): Promise<void>

  listExceptions(
    organizationId: string,
    query?: ExceptionQuery,
  ): Promise<readonly ChannelException[]>

  raiseException(
    draft: ChannelExceptionDraft,
    tx?: TransactionHandle,
  ): Promise<{ exception: ChannelException; created: boolean }>

  settleException(
    organizationId: string,
    exceptionId: string,
    state: 'acknowledged' | 'resolved' | 'dismissed',
    actorUserId: string | null,
    note: string | null,
    at: Date,
    tx?: TransactionHandle,
  ): Promise<void>

  recordSyncRun(run: SyncRunRecord, tx?: TransactionHandle): Promise<void>

  syncCounters(
    organizationId: string,
    connectorId: string,
    windowHours: number,
  ): Promise<SyncCounters>
}

/* --------------------------------------------------------------- columns -- */

const CONNECTOR_COLUMNS =
  'id, organization_id, property_id, channel_code, state, capabilities, ' +
  'credential_ref, credentials_expire_at, external_account_id, ' +
  'last_inbound_sync_at, last_outbound_sync_at, last_webhook_at, ' +
  'created_at, updated_at, version'

const LISTING_COLUMNS =
  'id, organization_id, connection_id, channel_code, external_listing_id, ' +
  'external_variant_id, name, max_occupancy, active, discovered_at'

const MAPPING_COLUMNS =
  'id, organization_id, connection_id, channel_code, external_listing_id, ' +
  'external_variant_id, property_id, unit_id, state, mapped_by, mapped_at, ' +
  'version'

const RESERVATION_COLUMNS =
  'id, organization_id, connection_id, channel_code, external_reservation_id, ' +
  'ledger_key, revision, content_fingerprint, booking_id, last_status, ' +
  'first_seen_at, last_seen_at'

const EXCEPTION_COLUMNS =
  'id, organization_id, connection_id, channel_code, kind, severity, state, ' +
  'title, detail, external_reservation_id, external_listing_id, booking_id, ' +
  'unit_id, property_id, dedupe_key, occurred_at, resolved_at, resolved_by, ' +
  'resolution_note'

/* --------------------------------------------------------------- mapping -- */

/**
 * A `text[]` of capabilities, read back defensively.
 *
 * A value outside `CONNECTOR_CAPABILITIES` is DROPPED rather than thrown on,
 * and that direction is deliberate: an unknown capability that survived would
 * be a capability the engine believes the connector has and would then call.
 * Dropping it makes the connector do less, which is the safe failure — the
 * opposite of the enum columns below, which are refused loudly because a
 * mangled *state* renders as a blank badge three screens later.
 */
function asCapabilities(value: unknown): readonly ConnectorCapability[] {
  const raw: readonly unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.startsWith('{')
      ? value
          .slice(1, -1)
          .split(',')
          .filter((part) => part.length > 0)
      : []

  const known = new Set<string>(CONNECTOR_CAPABILITIES)
  return raw.filter(
    (entry): entry is ConnectorCapability =>
      typeof entry === 'string' && known.has(entry),
  )
}

export function connectorFromRow(row: Row): Connector {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asStringOrNull(row, 'property_id'),
    channelCode: asEnum<ChannelCode>(row, 'channel_code', CHANNEL_CODES),
    state: asEnum(row, 'state', CONNECTOR_STATES),
    capabilities: asCapabilities(row.capabilities),
    credentialRef: asStringOrNull(row, 'credential_ref'),
    credentialsExpireAt: asDateOrNull(row, 'credentials_expire_at'),
    externalAccountId: asStringOrNull(row, 'external_account_id'),
    lastInboundSyncAt: asDateOrNull(row, 'last_inbound_sync_at'),
    lastOutboundSyncAt: asDateOrNull(row, 'last_outbound_sync_at'),
    lastWebhookAt: asDateOrNull(row, 'last_webhook_at'),
    createdAt: asDate(row, 'created_at'),
    updatedAt: asDate(row, 'updated_at'),
    version: asNumber(row, 'version'),
  }
}

export function listingFromRow(row: Row): Listing {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    connectorId: asString(row, 'connection_id'),
    channelCode: asEnum<ChannelCode>(row, 'channel_code', CHANNEL_CODES),
    externalListingId: asString(row, 'external_listing_id'),
    externalVariantId: asStringOrNull(row, 'external_variant_id'),
    name: asString(row, 'name'),
    maxOccupancy: asNumberOrNull(row, 'max_occupancy'),
    active: asBoolean(row, 'active'),
    discoveredAt: asDate(row, 'discovered_at'),
  }
}

export function mappingFromRow(row: Row): ListingMapping {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    connectorId: asString(row, 'connection_id'),
    channelCode: asEnum<ChannelCode>(row, 'channel_code', CHANNEL_CODES),
    externalListingId: asString(row, 'external_listing_id'),
    externalVariantId: asStringOrNull(row, 'external_variant_id'),
    propertyId: asString(row, 'property_id'),
    unitId: asString(row, 'unit_id'),
    state: asEnum(row, 'state', MAPPING_STATES),
    mappedByUserId: asStringOrNull(row, 'mapped_by'),
    mappedAt: asDate(row, 'mapped_at'),
    version: asNumber(row, 'version'),
  }
}

export function reservationFromRow(row: Row): ChannelReservationRecord {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    connectorId: asString(row, 'connection_id'),
    channelCode: asEnum<ChannelCode>(row, 'channel_code', CHANNEL_CODES),
    externalReservationId: asString(row, 'external_reservation_id'),
    ledgerKey: asString(row, 'ledger_key'),
    revision: asNumberOrNull(row, 'revision'),
    contentFingerprint: asString(row, 'content_fingerprint'),
    bookingId: asStringOrNull(row, 'booking_id'),
    lastStatus: asEnum(row, 'last_status', CHANNEL_RESERVATION_STATUSES),
    firstSeenAt: asDate(row, 'first_seen_at'),
    lastSeenAt: asDate(row, 'last_seen_at'),
  }
}

export function exceptionFromRow(row: Row): ChannelException {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    connectorId: asStringOrNull(row, 'connection_id'),
    channelCode: asEnum<ChannelCode>(row, 'channel_code', CHANNEL_CODES),
    kind: asEnum(row, 'kind', CHANNEL_EXCEPTION_KINDS),
    severity: asEnum(row, 'severity', EXCEPTION_SEVERITIES),
    state: asEnum(row, 'state', EXCEPTION_STATES),
    title: asString(row, 'title'),
    detail: asString(row, 'detail'),
    externalReservationId: asStringOrNull(row, 'external_reservation_id'),
    externalListingId: asStringOrNull(row, 'external_listing_id'),
    bookingId: asStringOrNull(row, 'booking_id'),
    unitId: asStringOrNull(row, 'unit_id'),
    propertyId: asStringOrNull(row, 'property_id'),
    dedupeKey: asString(row, 'dedupe_key'),
    occurredAt: asDate(row, 'occurred_at'),
    resolvedAt: asDateOrNull(row, 'resolved_at'),
    resolvedByUserId: asStringOrNull(row, 'resolved_by'),
    resolutionNote: asStringOrNull(row, 'resolution_note'),
  }
}

/* --------------------------------------------------------------- adapter -- */

/** PostgREST's code for a unique violation. The dedupe constraints, working. */
const UNIQUE_VIOLATION = '23505'

export class SupabaseChannelRepository implements ChannelRepository {
  constructor(private readonly db: Db) {}

  async listConnectors(
    organizationId: string,
    propertyId?: string | null,
  ): Promise<readonly Connector[]> {
    let query = this.db
      .from('channel_connections')
      .select(CONNECTOR_COLUMNS)
      .eq('organization_id', organizationId)

    // An organization-wide connection (`property_id is null`) covers every
    // property, so a property filter must not exclude it — filtering it out
    // would make a correctly configured business look unconnected.
    if (propertyId) {
      query = query.or(`property_id.eq.${propertyId},property_id.is.null`)
    }

    const { data, error } = await query.order('channel_code')
    if (error) throw error
    return toRows(data).map(connectorFromRow)
  }

  async loadConnector(
    organizationId: string,
    connectorId: string,
  ): Promise<Connector | null> {
    const { data, error } = await this.db
      .from('channel_connections')
      .select(CONNECTOR_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', connectorId)
      .maybeSingle()

    if (error) throw error
    return data ? connectorFromRow(toRow(data)) : null
  }

  async listListings(
    organizationId: string,
    connectorId: string,
  ): Promise<readonly Listing[]> {
    const { data, error } = await this.db
      .from('channel_listings')
      .select(LISTING_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('connection_id', connectorId)
      .order('name')

    if (error) throw error
    return toRows(data).map(listingFromRow)
  }

  async saveListings(
    organizationId: string,
    connectorId: string,
    listings: readonly DiscoveredListing[],
    at: Date,
    tx?: TransactionHandle,
  ): Promise<readonly Listing[]> {
    if (listings.length === 0) return []
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('channel_listings')
      .upsert(
        listings.map((listing) => ({
          organization_id: organizationId,
          connection_id: connectorId,
          channel_code: listing.channelCode,
          external_listing_id: listing.externalListingId,
          external_variant_id: listing.externalVariantId,
          name: listing.name,
          max_occupancy: listing.maxOccupancy,
          active: listing.active,
          discovered_at: at.toISOString(),
        })),
        {
          onConflict: 'connection_id,external_listing_id,external_variant_key',
        },
      )
      .select(LISTING_COLUMNS)

    if (error) throw error
    if (tx) recordWrite(tx, 'channel_listings.upsert')
    return toRows(data).map(listingFromRow)
  }

  async listMappings(
    organizationId: string,
    connectorId?: string,
  ): Promise<readonly ListingMapping[]> {
    let query = this.db
      .from('channel_listing_mappings')
      .select(MAPPING_COLUMNS)
      .eq('organization_id', organizationId)

    if (connectorId) query = query.eq('connection_id', connectorId)

    const { data, error } = await query
    if (error) throw error
    return toRows(data).map(mappingFromRow)
  }

  async saveMapping(
    organizationId: string,
    connectorId: string,
    draft: MappingDraft,
    actorUserId: string | null,
    tx?: TransactionHandle,
  ): Promise<ListingMapping> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('channel_listing_mappings')
      .insert({
        organization_id: organizationId,
        connection_id: connectorId,
        channel_code: draft.channelCode,
        external_listing_id: draft.externalListingId,
        external_variant_id: draft.externalVariantId,
        property_id: draft.propertyId,
        unit_id: draft.unitId,
        // Never inserted `active`. The setup flow's last step is a person
        // pressing activate, and a mapping that goes live on save makes that
        // step decorative — see `resolveListing`.
        state: 'draft',
        mapped_by: actorUserId,
        created_by: actorUserId,
        updated_by: actorUserId,
      })
      .select(MAPPING_COLUMNS)
      .single()

    if (error) throw error
    if (tx) recordWrite(tx, 'channel_listing_mappings.insert')
    return mappingFromRow(toRow(data))
  }

  async setMappingState(
    organizationId: string,
    mappingId: string,
    state: ListingMapping['state'],
    actorUserId: string | null,
    tx?: TransactionHandle,
  ): Promise<void> {
    const db = clientFor(tx, this.db)

    const { error } = await db
      .from('channel_listing_mappings')
      .update({ state, updated_by: actorUserId })
      .eq('organization_id', organizationId)
      .eq('id', mappingId)

    if (error) throw error
    if (tx) recordWrite(tx, `channel_listing_mappings.${state}`)
  }

  async findReservation(
    organizationId: string,
    ledgerKey: string,
  ): Promise<ChannelReservationRecord | null> {
    const { data, error } = await this.db
      .from('channel_reservations')
      .select(RESERVATION_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('ledger_key', ledgerKey)
      .maybeSingle()

    if (error) throw error
    return data ? reservationFromRow(toRow(data)) : null
  }

  async upsertReservation(
    ledger: LedgerUpsert,
    tx?: TransactionHandle,
  ): Promise<{ record: ChannelReservationRecord; created: boolean }> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('channel_reservations')
      .insert({
        organization_id: ledger.organizationId,
        connection_id: ledger.connectorId,
        channel_code: ledger.channelCode,
        external_reservation_id: ledger.externalReservationId,
        ledger_key: ledger.ledgerKey,
        revision: ledger.revision,
        content_fingerprint: ledger.contentFingerprint,
        last_status: ledger.lastStatus,
        first_seen_at: ledger.seenAt.toISOString(),
        last_seen_at: ledger.seenAt.toISOString(),
      })
      .select(RESERVATION_COLUMNS)
      .single()

    if (error) {
      // The ledger's unique index held. That is this module working, not
      // failing — see the header — so the existing row is updated with what
      // this delivery said and handed back.
      if (error.code === UNIQUE_VIOLATION) {
        const { data: updated, error: updateError } = await db
          .from('channel_reservations')
          .update({
            revision: ledger.revision,
            content_fingerprint: ledger.contentFingerprint,
            last_status: ledger.lastStatus,
            last_seen_at: ledger.seenAt.toISOString(),
          })
          .eq('organization_id', ledger.organizationId)
          .eq('ledger_key', ledger.ledgerKey)
          .select(RESERVATION_COLUMNS)
          .single()

        if (updateError) throw updateError
        return { record: reservationFromRow(toRow(updated)), created: false }
      }
      throw error
    }

    if (tx) recordWrite(tx, 'channel_reservations.insert')
    return { record: reservationFromRow(toRow(data)), created: true }
  }

  async attachBooking(
    organizationId: string,
    ledgerKey: string,
    bookingId: string,
    tx?: TransactionHandle,
  ): Promise<void> {
    const db = clientFor(tx, this.db)

    const { error } = await db
      .from('channel_reservations')
      .update({ booking_id: bookingId })
      .eq('organization_id', organizationId)
      .eq('ledger_key', ledgerKey)
      // Only when nothing is attached yet. A ledger row that already names a
      // booking must never be repointed: that is how one OTA reservation ends
      // up claiming two bookings and neither can be cancelled correctly.
      .is('booking_id', null)

    if (error) throw error
    if (tx) recordWrite(tx, 'channel_reservations.attach_booking')
  }

  async listExceptions(
    organizationId: string,
    query: ExceptionQuery = {},
  ): Promise<readonly ChannelException[]> {
    let builder = this.db
      .from('channel_exceptions')
      .select(EXCEPTION_COLUMNS)
      .eq('organization_id', organizationId)

    if (query.connectorId) {
      builder = builder.eq('connection_id', query.connectorId)
    }
    if (!query.includeSettled) {
      builder = builder.in('state', ['open', 'acknowledged'])
    }

    const { data, error } = await builder
      .order('occurred_at', { ascending: false })
      .limit(query.limit ?? 100)

    if (error) throw error
    return toRows(data).map(exceptionFromRow)
  }

  async raiseException(
    draft: ChannelExceptionDraft,
    tx?: TransactionHandle,
  ): Promise<{ exception: ChannelException; created: boolean }> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('channel_exceptions')
      .insert({
        organization_id: draft.organizationId,
        connection_id: draft.connectorId,
        channel_code: draft.channelCode,
        kind: draft.kind,
        severity: draft.severity,
        state: 'open',
        title: draft.title,
        detail: draft.detail,
        external_reservation_id: draft.externalReservationId,
        external_listing_id: draft.externalListingId,
        booking_id: draft.bookingId,
        unit_id: draft.unitId,
        property_id: draft.propertyId,
        dedupe_key: draft.dedupeKey,
        occurred_at: draft.occurredAt.toISOString(),
      })
      .select(EXCEPTION_COLUMNS)
      .single()

    if (error) {
      if (error.code === UNIQUE_VIOLATION) {
        const existing = await this.findByDedupeKey(
          draft.organizationId,
          draft.dedupeKey,
        )
        if (existing) return { exception: existing, created: false }
      }
      throw error
    }

    if (tx) recordWrite(tx, 'channel_exceptions.insert')
    return { exception: exceptionFromRow(toRow(data)), created: true }
  }

  private async findByDedupeKey(
    organizationId: string,
    dedupeKey: string,
  ): Promise<ChannelException | null> {
    const { data, error } = await this.db
      .from('channel_exceptions')
      .select(EXCEPTION_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('dedupe_key', dedupeKey)
      .maybeSingle()

    if (error) throw error
    return data ? exceptionFromRow(toRow(data)) : null
  }

  async settleException(
    organizationId: string,
    exceptionId: string,
    state: 'acknowledged' | 'resolved' | 'dismissed',
    actorUserId: string | null,
    note: string | null,
    at: Date,
    tx?: TransactionHandle,
  ): Promise<void> {
    const db = clientFor(tx, this.db)
    const settled = state === 'resolved' || state === 'dismissed'

    const { error } = await db
      .from('channel_exceptions')
      .update({
        state,
        resolved_at: settled ? at.toISOString() : null,
        resolved_by: settled ? actorUserId : null,
        resolution_note: note,
        updated_by: actorUserId,
      })
      .eq('organization_id', organizationId)
      .eq('id', exceptionId)

    if (error) throw error
    if (tx) recordWrite(tx, `channel_exceptions.${state}`)
  }

  async recordSyncRun(
    run: SyncRunRecord,
    tx?: TransactionHandle,
  ): Promise<void> {
    const db = clientFor(tx, this.db)

    const { error } = await db.from('channel_sync_runs').insert({
      organization_id: run.organizationId,
      connection_id: run.connectorId,
      direction: run.direction,
      capability: run.capability,
      status: run.status,
      started_at: run.startedAt.toISOString(),
      finished_at: run.finishedAt.toISOString(),
      entities_attempted: run.entitiesAttempted,
      entities_accepted: run.entitiesAccepted,
      entities_rejected: run.entitiesRejected,
      failed_entities: [...run.failedEntities],
      refusal_kind: run.refusalKind,
      refusal_detail: run.refusalDetail,
      correlation_id: run.correlationId,
    })

    if (error) throw error
    if (tx) recordWrite(tx, 'channel_sync_runs.insert')
  }

  async syncCounters(
    organizationId: string,
    connectorId: string,
    windowHours: number,
  ): Promise<SyncCounters> {
    const since = new Date(Date.now() - windowHours * 3_600_000).toISOString()

    const { data, error } = await this.db
      .from('channel_sync_runs')
      .select('status, entities_rejected, failed_entities')
      .eq('organization_id', organizationId)
      .eq('connection_id', connectorId)
      .gte('started_at', since)

    if (error) throw error

    let failures = 0
    let pending = 0
    const failed = new Set<string>()

    for (const row of toRows(data)) {
      const status = asString(row, 'status')
      if (status !== 'ok') failures += 1
      pending += asNumber(row, 'entities_rejected')
      for (const entity of asStringArray(row, 'failed_entities')) {
        failed.add(entity)
      }
    }

    return {
      pendingOutbound: pending,
      recentFailures: failures,
      failedEntities: [...failed].sort(),
    }
  }
}

/* ------------------------------------------------------------- in memory -- */

/**
 * The double the domain tests run against.
 *
 * It implements the two unique constraints faithfully — the same `ledger_key`
 * twice returns `created: false`, and so does the same `dedupe_key` — because
 * those are the behaviours this module's most important tests assert, and a
 * double that quietly allowed the duplicate would let them pass for the wrong
 * reason.
 */
export class InMemoryChannelRepository implements ChannelRepository {
  connectors: Connector[] = []
  listings: Listing[] = []
  mappings: ListingMapping[] = []
  reservations: ChannelReservationRecord[] = []
  exceptions: ChannelException[] = []
  syncRuns: SyncRunRecord[] = []

  private sequence = 0

  private nextId(prefix: string): string {
    this.sequence += 1
    return `${prefix}-${this.sequence}`
  }

  async listConnectors(
    organizationId: string,
    propertyId?: string | null,
  ): Promise<readonly Connector[]> {
    return this.connectors.filter(
      (connector) =>
        connector.organizationId === organizationId &&
        (!propertyId ||
          connector.propertyId === null ||
          connector.propertyId === propertyId),
    )
  }

  async loadConnector(
    organizationId: string,
    connectorId: string,
  ): Promise<Connector | null> {
    return (
      this.connectors.find(
        (connector) =>
          connector.organizationId === organizationId &&
          connector.id === connectorId,
      ) ?? null
    )
  }

  async listListings(
    organizationId: string,
    connectorId: string,
  ): Promise<readonly Listing[]> {
    return this.listings.filter(
      (listing) =>
        listing.organizationId === organizationId &&
        listing.connectorId === connectorId,
    )
  }

  async saveListings(
    organizationId: string,
    connectorId: string,
    listings: readonly DiscoveredListing[],
    at: Date,
  ): Promise<readonly Listing[]> {
    return listings.map((listing) => {
      const index = this.listings.findIndex(
        (candidate) =>
          candidate.connectorId === connectorId &&
          candidate.externalListingId === listing.externalListingId &&
          candidate.externalVariantId === listing.externalVariantId,
      )

      const saved: Listing = {
        id: index >= 0 ? this.listings[index].id : this.nextId('listing'),
        organizationId,
        connectorId,
        discoveredAt: at,
        ...listing,
      }

      if (index >= 0) this.listings[index] = saved
      else this.listings.push(saved)

      return saved
    })
  }

  async listMappings(
    organizationId: string,
    connectorId?: string,
  ): Promise<readonly ListingMapping[]> {
    return this.mappings.filter(
      (mapping) =>
        mapping.organizationId === organizationId &&
        (!connectorId || mapping.connectorId === connectorId),
    )
  }

  async saveMapping(
    organizationId: string,
    connectorId: string,
    draft: MappingDraft,
    actorUserId: string | null,
  ): Promise<ListingMapping> {
    const mapping: ListingMapping = {
      id: this.nextId('mapping'),
      organizationId,
      connectorId,
      channelCode: draft.channelCode,
      externalListingId: draft.externalListingId,
      externalVariantId: draft.externalVariantId,
      propertyId: draft.propertyId,
      unitId: draft.unitId,
      state: 'draft',
      mappedByUserId: actorUserId,
      mappedAt: new Date(),
      version: 1,
    }
    this.mappings.push(mapping)
    return mapping
  }

  async setMappingState(
    organizationId: string,
    mappingId: string,
    state: ListingMapping['state'],
  ): Promise<void> {
    const index = this.mappings.findIndex(
      (mapping) =>
        mapping.id === mappingId && mapping.organizationId === organizationId,
    )
    if (index < 0) return
    this.mappings[index] = { ...this.mappings[index], state }
  }

  async findReservation(
    organizationId: string,
    ledgerKey: string,
  ): Promise<ChannelReservationRecord | null> {
    return (
      this.reservations.find(
        (record) =>
          record.organizationId === organizationId &&
          record.ledgerKey === ledgerKey,
      ) ?? null
    )
  }

  async upsertReservation(
    ledger: LedgerUpsert,
  ): Promise<{ record: ChannelReservationRecord; created: boolean }> {
    const index = this.reservations.findIndex(
      (record) =>
        record.organizationId === ledger.organizationId &&
        record.ledgerKey === ledger.ledgerKey,
    )

    if (index >= 0) {
      const updated: ChannelReservationRecord = {
        ...this.reservations[index],
        revision: ledger.revision,
        contentFingerprint: ledger.contentFingerprint,
        lastStatus: ledger.lastStatus,
        lastSeenAt: ledger.seenAt,
      }
      this.reservations[index] = updated
      return { record: updated, created: false }
    }

    const record: ChannelReservationRecord = {
      id: this.nextId('reservation'),
      organizationId: ledger.organizationId,
      connectorId: ledger.connectorId,
      channelCode: ledger.channelCode,
      externalReservationId: ledger.externalReservationId,
      ledgerKey: ledger.ledgerKey,
      revision: ledger.revision,
      contentFingerprint: ledger.contentFingerprint,
      bookingId: null,
      lastStatus: ledger.lastStatus,
      firstSeenAt: ledger.seenAt,
      lastSeenAt: ledger.seenAt,
    }
    this.reservations.push(record)
    return { record, created: true }
  }

  async attachBooking(
    organizationId: string,
    ledgerKey: string,
    bookingId: string,
  ): Promise<void> {
    const index = this.reservations.findIndex(
      (record) =>
        record.organizationId === organizationId &&
        record.ledgerKey === ledgerKey,
    )
    if (index < 0) return
    // Never repointed — see the adapter's `.is('booking_id', null)`.
    if (this.reservations[index].bookingId !== null) return
    this.reservations[index] = { ...this.reservations[index], bookingId }
  }

  async listExceptions(
    organizationId: string,
    query: ExceptionQuery = {},
  ): Promise<readonly ChannelException[]> {
    return this.exceptions.filter(
      (exception) =>
        exception.organizationId === organizationId &&
        (!query.connectorId || exception.connectorId === query.connectorId) &&
        (query.includeSettled ||
          exception.state === 'open' ||
          exception.state === 'acknowledged'),
    )
  }

  async raiseException(
    draft: ChannelExceptionDraft,
  ): Promise<{ exception: ChannelException; created: boolean }> {
    const existing = this.exceptions.find(
      (exception) =>
        exception.organizationId === draft.organizationId &&
        exception.dedupeKey === draft.dedupeKey,
    )
    if (existing) return { exception: existing, created: false }

    const exception: ChannelException = {
      id: this.nextId('exception'),
      state: 'open',
      resolvedAt: null,
      resolvedByUserId: null,
      resolutionNote: null,
      ...draft,
    }
    this.exceptions.push(exception)
    return { exception, created: true }
  }

  async settleException(
    organizationId: string,
    exceptionId: string,
    state: 'acknowledged' | 'resolved' | 'dismissed',
    actorUserId: string | null,
    note: string | null,
    at: Date,
  ): Promise<void> {
    const index = this.exceptions.findIndex(
      (exception) =>
        exception.id === exceptionId &&
        exception.organizationId === organizationId,
    )
    if (index < 0) return

    const settled = state === 'resolved' || state === 'dismissed'
    this.exceptions[index] = {
      ...this.exceptions[index],
      state,
      resolvedAt: settled ? at : null,
      resolvedByUserId: settled ? actorUserId : null,
      resolutionNote: note,
    }
  }

  async recordSyncRun(run: SyncRunRecord): Promise<void> {
    this.syncRuns.push(run)
  }

  async syncCounters(
    organizationId: string,
    connectorId: string,
    windowHours: number,
  ): Promise<SyncCounters> {
    const since = Date.now() - windowHours * 3_600_000
    const failed = new Set<string>()
    let failures = 0
    let pending = 0

    for (const run of this.syncRuns) {
      if (run.organizationId !== organizationId) continue
      if (run.connectorId !== connectorId) continue
      if (run.startedAt.getTime() < since) continue

      if (run.status !== 'ok') failures += 1
      pending += run.entitiesRejected
      for (const entity of run.failedEntities) failed.add(entity)
    }

    return {
      pendingOutbound: pending,
      recentFailures: failures,
      failedEntities: [...failed].sort(),
    }
  }
}
