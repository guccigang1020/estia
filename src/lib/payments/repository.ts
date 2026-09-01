/**
 * Reading and writing the four tables 0031 creates.
 *
 * A port and two implementations: one over Supabase, one in memory for the
 * tests. The port exists because the resolver must be exercisable without a
 * database and the operations must be exercisable without PostgREST — and
 * because `src/lib/persistence/**` belongs to another owner, so the adapter
 * for this module's own tables lives beside the module that reads them.
 *
 * Every read here is scoped by `organization_id` in the query as well as by
 * row level security. The policy is the enforcement; the filter is what stops
 * a mistake in this file from becoming a cross-tenant read the moment somebody
 * runs it as `service_role`.
 */

import {
  CONFIRMATION_REQUIREMENTS,
  PAYMENT_COLLECTION_POLICIES,
  type ConfirmationRequirement,
  type PaymentCollectionPolicy,
} from '../contracts/states'
import {
  asBoolean,
  asDate,
  asNumber,
  asNumberOrNull,
  asString,
  asStringOrNull,
  clientFor,
  recordWrite,
  toRow,
  toRows,
  type Db,
  type Row,
} from '../persistence'
import type { TransactionHandle } from '../service'

import { MANUAL_PAYMENT_CHANNELS, type ManualPaymentChannel } from './channels'
import {
  PAYMENT_PROOF_REVIEWS,
  type CollectionOverride,
  type CollectionSettings,
  type ManualChannel,
  type PaymentProof,
  type PaymentProofReview,
} from './types'

/* ------------------------------------------------------------------ port -- */

export interface CollectionSettingsDraft {
  policy: PaymentCollectionPolicy
  requirements: readonly ConfirmationRequirement[]
  depositPercentBps: number | null
  depositFixedAgorot: number | null
  balanceDueDaysBefore: number | null
  livePaymentsEnabled: boolean
  liveProvider: string | null
  guestInstructions: string | null
}

export interface CollectionOverrideDraft {
  bookingId: string
  propertyId: string
  policy: PaymentCollectionPolicy
  requirements: readonly ConfirmationRequirement[]
  depositPercentBps: number | null
  depositFixedAgorot: number | null
  balanceDueDaysBefore: number | null
  reason: string
}

export interface ManualChannelDraft {
  channel: ManualPaymentChannel
  enabled: boolean
  displayName: string | null
  instructions: string | null
  sortOrder: number
}

export interface PaymentProofDraft {
  bookingId: string
  propertyId: string
  storageKey: string
  fileName: string
  contentType: string
  byteSize: number
  checksumSha256: string | null
  note: string | null
}

export interface PaymentPolicyRepository {
  loadSettings(organizationId: string): Promise<CollectionSettings | null>
  /** Insert or update the single row for this organization. */
  saveSettings(
    organizationId: string,
    draft: CollectionSettingsDraft,
    actorUserId: string | null,
    tx?: TransactionHandle,
  ): Promise<CollectionSettings>

  loadOverride(
    organizationId: string,
    bookingId: string,
  ): Promise<CollectionOverride | null>
  saveOverride(
    organizationId: string,
    draft: CollectionOverrideDraft,
    actorUserId: string | null,
    tx?: TransactionHandle,
  ): Promise<CollectionOverride>
  clearOverride(
    organizationId: string,
    bookingId: string,
    tx?: TransactionHandle,
  ): Promise<void>

  listChannels(organizationId: string): Promise<readonly ManualChannel[]>
  saveChannel(
    organizationId: string,
    draft: ManualChannelDraft,
    actorUserId: string | null,
    tx?: TransactionHandle,
  ): Promise<ManualChannel>

  listProofs(
    organizationId: string,
    bookingId: string,
  ): Promise<readonly PaymentProof[]>
  insertProof(
    organizationId: string,
    draft: PaymentProofDraft,
    actorUserId: string,
    tx?: TransactionHandle,
  ): Promise<PaymentProof>
}

/* --------------------------------------------------------------- mapping -- */

const SETTINGS_COLUMNS =
  'id, organization_id, policy, requirements, deposit_percent_bps, ' +
  'deposit_fixed_agorot, balance_due_days_before, live_payments_enabled, ' +
  'live_provider, guest_instructions, version'

const OVERRIDE_COLUMNS =
  'id, organization_id, property_id, booking_id, policy, requirements, ' +
  'deposit_percent_bps, deposit_fixed_agorot, balance_due_days_before, ' +
  'reason, set_by, set_at, version'

const CHANNEL_COLUMNS =
  'id, organization_id, channel, enabled, display_name, instructions, sort_order'

const PROOF_COLUMNS =
  'id, organization_id, property_id, booking_id, storage_key, file_name, ' +
  'content_type, byte_size, checksum_sha256, submitted_by_guest, submitted_by, ' +
  'submitted_at, note, review, reviewed_at, reviewed_by, review_note, payment_id'

/**
 * A Postgres array arrives from PostgREST as a JavaScript array. The literal
 * form (`{deposit_recorded}`) is tolerated because one caller — the jsonb from
 * `guest_collection_context()` — can hand it over, and one parser that copes
 * with both beats two parsers that each cope with one.
 */
function asRequirements(value: unknown): readonly ConfirmationRequirement[] {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.startsWith('{')
      ? value
          .slice(1, -1)
          .split(',')
          .filter((part) => part.length > 0)
      : []

  const known = new Set<string>(CONFIRMATION_REQUIREMENTS)
  return raw.filter(
    (entry): entry is ConfirmationRequirement =>
      typeof entry === 'string' && known.has(entry),
  )
}

function asPolicy(row: Row, column: string): PaymentCollectionPolicy {
  const value = asString(row, column)
  const known: readonly string[] = PAYMENT_COLLECTION_POLICIES
  if (!known.includes(value)) {
    throw new Error(`Unknown payment collection policy in ${column}: ${value}`)
  }
  return value as PaymentCollectionPolicy
}

function asChannel(row: Row, column: string): ManualPaymentChannel {
  const value = asString(row, column)
  const known: readonly string[] = MANUAL_PAYMENT_CHANNELS
  if (!known.includes(value)) {
    throw new Error(`Unknown manual payment channel in ${column}: ${value}`)
  }
  return value as ManualPaymentChannel
}

function asReview(row: Row, column: string): PaymentProofReview {
  const value = asString(row, column)
  const known: readonly string[] = PAYMENT_PROOF_REVIEWS
  if (!known.includes(value)) {
    throw new Error(`Unknown payment proof review state in ${column}: ${value}`)
  }
  return value as PaymentProofReview
}

export function settingsFromRow(row: Row): CollectionSettings {
  return {
    policy: asPolicy(row, 'policy'),
    requirements: asRequirements(row.requirements),
    depositPercentBps: asNumberOrNull(row, 'deposit_percent_bps'),
    depositFixedAgorot: asNumberOrNull(row, 'deposit_fixed_agorot'),
    balanceDueDaysBefore: asNumberOrNull(row, 'balance_due_days_before'),
    livePaymentsEnabled: asBoolean(row, 'live_payments_enabled'),
    liveProvider: asStringOrNull(row, 'live_provider'),
    guestInstructions: asStringOrNull(row, 'guest_instructions'),
  }
}

export function overrideFromRow(row: Row): CollectionOverride {
  return {
    id: asString(row, 'id'),
    bookingId: asString(row, 'booking_id'),
    policy: asPolicy(row, 'policy'),
    requirements: asRequirements(row.requirements),
    depositPercentBps: asNumberOrNull(row, 'deposit_percent_bps'),
    depositFixedAgorot: asNumberOrNull(row, 'deposit_fixed_agorot'),
    balanceDueDaysBefore: asNumberOrNull(row, 'balance_due_days_before'),
    reason: asString(row, 'reason'),
    setByUserId: asStringOrNull(row, 'set_by'),
    setAt: asDate(row, 'set_at'),
    version: asNumber(row, 'version'),
  }
}

export function channelFromRow(row: Row): ManualChannel {
  return {
    id: asString(row, 'id'),
    channel: asChannel(row, 'channel'),
    enabled: asBoolean(row, 'enabled'),
    displayName: asStringOrNull(row, 'display_name'),
    instructions: asStringOrNull(row, 'instructions'),
    sortOrder: asNumber(row, 'sort_order'),
  }
}

export function proofFromRow(row: Row): PaymentProof {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asString(row, 'property_id'),
    bookingId: asString(row, 'booking_id'),
    storageKey: asString(row, 'storage_key'),
    fileName: asString(row, 'file_name'),
    contentType: asString(row, 'content_type'),
    byteSize: asNumber(row, 'byte_size'),
    checksumSha256: asStringOrNull(row, 'checksum_sha256'),
    submittedByGuest: asBoolean(row, 'submitted_by_guest'),
    submittedByUserId: asStringOrNull(row, 'submitted_by'),
    submittedAt: asDate(row, 'submitted_at'),
    note: asStringOrNull(row, 'note'),
    review: asReview(row, 'review'),
    reviewedAt: row.reviewed_at == null ? null : asDate(row, 'reviewed_at'),
    reviewedByUserId: asStringOrNull(row, 'reviewed_by'),
    reviewNote: asStringOrNull(row, 'review_note'),
    paymentId: asStringOrNull(row, 'payment_id'),
  }
}

/* --------------------------------------------------------------- adapter -- */

export class SupabasePaymentPolicyRepository implements PaymentPolicyRepository {
  constructor(private readonly db: Db) {}

  async loadSettings(
    organizationId: string,
  ): Promise<CollectionSettings | null> {
    const { data, error } = await this.db
      .from('payment_collection_settings')
      .select(SETTINGS_COLUMNS)
      .eq('organization_id', organizationId)
      .maybeSingle()

    if (error) throw error
    // No row is not an error and is not an empty state. It is the defaults,
    // and the resolver is handed `null` rather than a fabricated row so that
    // "never configured" stays visible to a screen that cares.
    return data ? settingsFromRow(toRow(data)) : null
  }

  async saveSettings(
    organizationId: string,
    draft: CollectionSettingsDraft,
    actorUserId: string | null,
    tx?: TransactionHandle,
  ): Promise<CollectionSettings> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('payment_collection_settings')
      .upsert(
        {
          organization_id: organizationId,
          policy: draft.policy,
          requirements: [...draft.requirements],
          deposit_percent_bps: draft.depositPercentBps,
          deposit_fixed_agorot: draft.depositFixedAgorot,
          balance_due_days_before: draft.balanceDueDaysBefore,
          live_payments_enabled: draft.livePaymentsEnabled,
          live_provider: draft.liveProvider,
          guest_instructions: draft.guestInstructions,
          created_by: actorUserId,
          updated_by: actorUserId,
        },
        { onConflict: 'organization_id' },
      )
      .select(SETTINGS_COLUMNS)
      .single()

    if (error) throw error
    if (tx) recordWrite(tx, 'payment_collection_settings.upsert')
    return settingsFromRow(toRow(data))
  }

  async loadOverride(
    organizationId: string,
    bookingId: string,
  ): Promise<CollectionOverride | null> {
    const { data, error } = await this.db
      .from('payment_collection_overrides')
      .select(OVERRIDE_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('booking_id', bookingId)
      .maybeSingle()

    if (error) throw error
    return data ? overrideFromRow(toRow(data)) : null
  }

  async saveOverride(
    organizationId: string,
    draft: CollectionOverrideDraft,
    actorUserId: string | null,
    tx?: TransactionHandle,
  ): Promise<CollectionOverride> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('payment_collection_overrides')
      .upsert(
        {
          organization_id: organizationId,
          property_id: draft.propertyId,
          booking_id: draft.bookingId,
          policy: draft.policy,
          requirements: [...draft.requirements],
          deposit_percent_bps: draft.depositPercentBps,
          deposit_fixed_agorot: draft.depositFixedAgorot,
          balance_due_days_before: draft.balanceDueDaysBefore,
          reason: draft.reason,
          set_by: actorUserId,
          created_by: actorUserId,
          updated_by: actorUserId,
        },
        { onConflict: 'booking_id' },
      )
      .select(OVERRIDE_COLUMNS)
      .single()

    if (error) throw error
    if (tx) recordWrite(tx, 'payment_collection_overrides.upsert')
    return overrideFromRow(toRow(data))
  }

  async clearOverride(
    organizationId: string,
    bookingId: string,
    tx?: TransactionHandle,
  ): Promise<void> {
    const db = clientFor(tx, this.db)

    const { error } = await db
      .from('payment_collection_overrides')
      .delete()
      .eq('organization_id', organizationId)
      .eq('booking_id', bookingId)

    if (error) throw error
    if (tx) recordWrite(tx, 'payment_collection_overrides.delete')
  }

  async listChannels(
    organizationId: string,
  ): Promise<readonly ManualChannel[]> {
    const { data, error } = await this.db
      .from('payment_manual_channels')
      .select(CHANNEL_COLUMNS)
      .eq('organization_id', organizationId)
      .order('sort_order', { ascending: true })

    if (error) throw error
    return toRows(data ?? []).map(channelFromRow)
  }

  async saveChannel(
    organizationId: string,
    draft: ManualChannelDraft,
    actorUserId: string | null,
    tx?: TransactionHandle,
  ): Promise<ManualChannel> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('payment_manual_channels')
      .upsert(
        {
          organization_id: organizationId,
          channel: draft.channel,
          enabled: draft.enabled,
          display_name: draft.displayName,
          instructions: draft.instructions,
          sort_order: draft.sortOrder,
          created_by: actorUserId,
          updated_by: actorUserId,
        },
        { onConflict: 'organization_id,channel' },
      )
      .select(CHANNEL_COLUMNS)
      .single()

    if (error) throw error
    if (tx) recordWrite(tx, 'payment_manual_channels.upsert')
    return channelFromRow(toRow(data))
  }

  async listProofs(
    organizationId: string,
    bookingId: string,
  ): Promise<readonly PaymentProof[]> {
    const { data, error } = await this.db
      .from('payment_proofs')
      .select(PROOF_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('booking_id', bookingId)
      .order('submitted_at', { ascending: false })

    if (error) throw error
    return toRows(data ?? []).map(proofFromRow)
  }

  async insertProof(
    organizationId: string,
    draft: PaymentProofDraft,
    actorUserId: string,
    tx?: TransactionHandle,
  ): Promise<PaymentProof> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('payment_proofs')
      .insert({
        organization_id: organizationId,
        property_id: draft.propertyId,
        booking_id: draft.bookingId,
        storage_key: draft.storageKey,
        file_name: draft.fileName,
        content_type: draft.contentType,
        byte_size: draft.byteSize,
        checksum_sha256: draft.checksumSha256,
        // Staff, always. A guest's upload never reaches this table through
        // PostgREST — `payment_proofs_insert` refuses it — and
        // `submit_payment_proof()` is the only path that can write one.
        submitted_by_guest: false,
        submitted_by: actorUserId,
        note: draft.note,
        created_by: actorUserId,
        updated_by: actorUserId,
      })
      .select(PROOF_COLUMNS)
      .single()

    if (error) throw error
    if (tx) recordWrite(tx, 'payment_proofs.insert')
    return proofFromRow(toRow(data))
  }
}

/* ------------------------------------------------------------ in memory -- */

/**
 * The same port, without a database.
 *
 * Used by `operations.test.ts` so that the pipeline — authorization,
 * validation, the rule, the audit event, idempotency — is exercised over real
 * state rather than over a mock that agrees with whatever was asserted.
 */
export class InMemoryPaymentPolicyRepository implements PaymentPolicyRepository {
  private readonly settings = new Map<string, CollectionSettings>()
  private readonly overrides = new Map<string, CollectionOverride>()
  private readonly channels = new Map<string, ManualChannel>()
  private readonly proofs: PaymentProof[] = []
  private sequence = 0

  /** Fixed, so an audit summary asserted in a test does not drift with the clock. */
  private readonly stamp = new Date('2026-01-01T00:00:00.000Z')

  private nextId(prefix: string): string {
    this.sequence += 1
    return `${prefix}-${this.sequence}`
  }

  loadSettings(organizationId: string): Promise<CollectionSettings | null> {
    return Promise.resolve(this.settings.get(organizationId) ?? null)
  }

  saveSettings(
    organizationId: string,
    draft: CollectionSettingsDraft,
  ): Promise<CollectionSettings> {
    const saved: CollectionSettings = {
      policy: draft.policy,
      requirements: [...draft.requirements],
      depositPercentBps: draft.depositPercentBps,
      depositFixedAgorot: draft.depositFixedAgorot,
      balanceDueDaysBefore: draft.balanceDueDaysBefore,
      livePaymentsEnabled: draft.livePaymentsEnabled,
      liveProvider: draft.liveProvider,
      guestInstructions: draft.guestInstructions,
    }
    this.settings.set(organizationId, saved)
    return Promise.resolve(saved)
  }

  loadOverride(
    organizationId: string,
    bookingId: string,
  ): Promise<CollectionOverride | null> {
    return Promise.resolve(
      this.overrides.get(`${organizationId}:${bookingId}`) ?? null,
    )
  }

  saveOverride(
    organizationId: string,
    draft: CollectionOverrideDraft,
    actorUserId: string | null,
  ): Promise<CollectionOverride> {
    const key = `${organizationId}:${draft.bookingId}`
    const existing = this.overrides.get(key)
    const saved: CollectionOverride = {
      id: existing?.id ?? this.nextId('override'),
      bookingId: draft.bookingId,
      policy: draft.policy,
      requirements: [...draft.requirements],
      depositPercentBps: draft.depositPercentBps,
      depositFixedAgorot: draft.depositFixedAgorot,
      balanceDueDaysBefore: draft.balanceDueDaysBefore,
      reason: draft.reason,
      setByUserId: actorUserId,
      setAt: this.stamp,
      version: (existing?.version ?? 0) + 1,
    }
    this.overrides.set(key, saved)
    return Promise.resolve(saved)
  }

  clearOverride(organizationId: string, bookingId: string): Promise<void> {
    this.overrides.delete(`${organizationId}:${bookingId}`)
    return Promise.resolve()
  }

  listChannels(organizationId: string): Promise<readonly ManualChannel[]> {
    return Promise.resolve(
      [...this.channels.entries()]
        .filter(([key]) => key.startsWith(`${organizationId}:`))
        .map(([, channel]) => channel)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    )
  }

  saveChannel(
    organizationId: string,
    draft: ManualChannelDraft,
  ): Promise<ManualChannel> {
    const key = `${organizationId}:${draft.channel}`
    const saved: ManualChannel = {
      id: this.channels.get(key)?.id ?? this.nextId('channel'),
      channel: draft.channel,
      enabled: draft.enabled,
      displayName: draft.displayName,
      instructions: draft.instructions,
      sortOrder: draft.sortOrder,
    }
    this.channels.set(key, saved)
    return Promise.resolve(saved)
  }

  listProofs(
    organizationId: string,
    bookingId: string,
  ): Promise<readonly PaymentProof[]> {
    return Promise.resolve(
      this.proofs.filter(
        (proof) =>
          proof.organizationId === organizationId &&
          proof.bookingId === bookingId,
      ),
    )
  }

  insertProof(
    organizationId: string,
    draft: PaymentProofDraft,
    actorUserId: string,
  ): Promise<PaymentProof> {
    const saved: PaymentProof = {
      id: this.nextId('proof'),
      organizationId,
      propertyId: draft.propertyId,
      bookingId: draft.bookingId,
      storageKey: draft.storageKey,
      fileName: draft.fileName,
      contentType: draft.contentType,
      byteSize: draft.byteSize,
      checksumSha256: draft.checksumSha256,
      submittedByGuest: false,
      submittedByUserId: actorUserId,
      submittedAt: this.stamp,
      note: draft.note,
      review: 'pending',
      reviewedAt: null,
      reviewedByUserId: null,
      reviewNote: null,
      paymentId: null,
    }
    this.proofs.push(saved)
    return Promise.resolve(saved)
  }
}
