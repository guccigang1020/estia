/**
 * Reading and writing the five tables 0043 creates.
 *
 * A port and two implementations: one over Supabase, one in memory for the
 * tests. The port exists because the routing engine must be exercisable
 * without a database and the operations must be exercisable without PostgREST
 * — and because `src/lib/persistence/**` belongs to another owner, so the
 * adapter for this module's own tables lives beside the module that reads
 * them. That is the same argument `src/lib/payments/repository.ts` makes, and
 * it is made the same way on purpose.
 *
 * Every read is scoped by `organization_id` in the query as well as by row
 * level security. The policy is the enforcement; the filter is what stops a
 * mistake in this file from becoming a cross-tenant read the first time
 * somebody runs it as `service_role`.
 *
 * ── The one operation with unusual semantics ──────────────────────────────
 *
 * `insertNotification` is expected to collide. `notifications_dedupe_key` is
 * what makes a retried handler harmless, so hitting it is the system working
 * rather than failing — and the adapter therefore reports `created: false` and
 * hands back the row that was already there, instead of throwing a 23505 into
 * a caller that would have to know the constraint's name to interpret it.
 */

import {
  asBoolean,
  asDate,
  asDateOrNull,
  asNumber,
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
import { isDomainEvent, type DomainEventName } from '../contracts/events'

import type { PlannedNotification } from './routing'
import {
  DEFAULT_SETTINGS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_DELIVERY_STATUSES,
  NOTIFICATION_SEVERITIES,
  SUPPRESSION_REASONS,
  type DeliveryRecord,
  type EscalationRule,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationDeliveryStatus,
  type NotificationRecord,
  type NotificationSettings,
  type NotificationSeverity,
  type PreferenceRecord,
  type SuppressionReason,
} from './types'

/* ------------------------------------------------------------------ port -- */

export interface SettingsDraft {
  enabledChannels: readonly NotificationChannel[]
  quietHoursEnabled: boolean
  quietHoursStart: string
  quietHoursEnd: string
  timezone: string
  urgentOverridesQuietHours: boolean
  defaultEscalationMinutes: number
  retainReadDays: number
}

export interface PreferenceDraft {
  category: NotificationCategory
  channel: NotificationChannel
  enabled: boolean
  minSeverity: NotificationSeverity
}

/** How many deliveries ended in each state, over a window. */
export type DeliveryTally = Record<NotificationDeliveryStatus, number>

export function emptyTally(): DeliveryTally {
  return Object.fromEntries(
    NOTIFICATION_DELIVERY_STATUSES.map((status) => [status, 0]),
  ) as DeliveryTally
}

export interface NotificationRepository {
  /** `null` when the organization has never saved a row. Not an error. */
  loadSettings(organizationId: string): Promise<NotificationSettings | null>
  saveSettings(
    organizationId: string,
    draft: SettingsDraft,
    actorUserId: string | null,
    tx?: TransactionHandle,
  ): Promise<NotificationSettings>

  listPreferences(
    organizationId: string,
    userId: string,
  ): Promise<readonly PreferenceRecord[]>
  savePreference(
    organizationId: string,
    userId: string,
    draft: PreferenceDraft,
    tx?: TransactionHandle,
  ): Promise<PreferenceRecord>

  listEscalationRules(
    organizationId: string,
  ): Promise<readonly EscalationRule[]>

  /** This person's inbox, newest first. */
  listInbox(
    organizationId: string,
    userId: string,
    options?: { limit?: number; includeDismissed?: boolean },
  ): Promise<readonly NotificationRecord[]>

  /**
   * Write one planned notification, or discover it is already there.
   *
   * `created: false` means the dedupe constraint held — the ordinary outcome
   * of a retry, and not a failure.
   */
  insertNotification(
    planned: PlannedNotification,
    tx?: TransactionHandle,
  ): Promise<{ record: NotificationRecord; created: boolean }>

  insertDeliveries(
    organizationId: string,
    notificationId: string,
    deliveries: readonly Omit<
      DeliveryRecord,
      'id' | 'organizationId' | 'notificationId'
    >[],
    tx?: TransactionHandle,
  ): Promise<readonly DeliveryRecord[]>

  markState(
    organizationId: string,
    userId: string,
    notificationId: string,
    state: 'read' | 'dismissed' | 'acted',
    at: Date,
    tx?: TransactionHandle,
  ): Promise<void>

  /** What the settings screen counts. `sinceDays` bounds the window. */
  deliveryTally(
    organizationId: string,
    sinceDays: number,
  ): Promise<DeliveryTally>
}

/* --------------------------------------------------------------- mapping -- */

const SETTINGS_COLUMNS =
  'id, organization_id, enabled_channels, quiet_hours_enabled, ' +
  'quiet_hours_start, quiet_hours_end, timezone, urgent_overrides_quiet_hours, ' +
  'default_escalation_minutes, retain_read_days, version'

const PREFERENCE_COLUMNS =
  'id, organization_id, user_id, category, channel, enabled, min_severity'

const NOTIFICATION_COLUMNS =
  'id, organization_id, property_id, recipient_user_id, event_name, category, ' +
  'severity, resource_type, resource_id, title, body, action_href, ' +
  'required_grant, dedupe_key, correlation_id, occurred_at, escalated_from, ' +
  'escalation_level, read_at, dismissed_at, acted_at, created_at'

const DELIVERY_COLUMNS =
  'id, organization_id, notification_id, channel, status, attempt, ' +
  'scheduled_for, provider, provider_message_id, error_code, error_detail, ' +
  'suppressed_reason, attempted_at, settled_at'

const RULE_COLUMNS =
  'id, organization_id, event_name, min_severity, after_minutes, ' +
  'escalate_to_role_code, max_level, enabled'

/**
 * A vocabulary read back from the database, refused rather than coerced.
 *
 * A value outside the enum means the migration and this file disagree, and the
 * honest response is a loud failure at the mapping boundary rather than a
 * notification that renders with a blank severity three screens later.
 */
function asMember<T extends string>(
  row: Row,
  column: string,
  known: readonly string[],
  what: string,
): T {
  const value = asString(row, column)
  if (!known.includes(value)) {
    throw new Error(`Unknown ${what} in ${column}: ${value}`)
  }
  return value as T
}

function asChannels(value: unknown): readonly NotificationChannel[] {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.startsWith('{')
      ? value
          .slice(1, -1)
          .split(',')
          .filter((part) => part.length > 0)
      : []

  const known = new Set<string>(NOTIFICATION_CHANNELS)
  return raw.filter(
    (entry): entry is NotificationChannel =>
      typeof entry === 'string' && known.has(entry),
  )
}

/** `HH:MM:SS` from Postgres `time`, trimmed to what a person types. */
function asClock(row: Row, column: string): string {
  return asString(row, column).slice(0, 5)
}

function asEventName(row: Row, column: string): DomainEventName {
  const value = asString(row, column)
  if (!isDomainEvent(value)) {
    // The frozen catalogue is the vocabulary; a row naming something outside
    // it came from somewhere that bypassed the routing engine, and rendering
    // it would put a name in front of a person that no screen can act on.
    throw new Error(`Not a domain event name in ${column}: ${value}`)
  }
  return value
}

export function settingsFromRow(row: Row): NotificationSettings {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    enabledChannels: asChannels(row.enabled_channels),
    quietHoursEnabled: asBoolean(row, 'quiet_hours_enabled'),
    quietHoursStart: asClock(row, 'quiet_hours_start'),
    quietHoursEnd: asClock(row, 'quiet_hours_end'),
    timezone: asString(row, 'timezone'),
    urgentOverridesQuietHours: asBoolean(row, 'urgent_overrides_quiet_hours'),
    defaultEscalationMinutes: asNumber(row, 'default_escalation_minutes'),
    retainReadDays: asNumber(row, 'retain_read_days'),
    version: asNumber(row, 'version'),
  }
}

export function preferenceFromRow(row: Row): PreferenceRecord {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    userId: asString(row, 'user_id'),
    category: asMember<NotificationCategory>(
      row,
      'category',
      NOTIFICATION_CATEGORIES,
      'notification category',
    ),
    channel: asMember<NotificationChannel>(
      row,
      'channel',
      NOTIFICATION_CHANNELS,
      'notification channel',
    ),
    enabled: asBoolean(row, 'enabled'),
    minSeverity: asMember<NotificationSeverity>(
      row,
      'min_severity',
      NOTIFICATION_SEVERITIES,
      'notification severity',
    ),
  }
}

export function notificationFromRow(row: Row): NotificationRecord {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asStringOrNull(row, 'property_id'),
    recipientUserId: asString(row, 'recipient_user_id'),
    eventName: asEventName(row, 'event_name'),
    category: asMember<NotificationCategory>(
      row,
      'category',
      NOTIFICATION_CATEGORIES,
      'notification category',
    ),
    severity: asMember<NotificationSeverity>(
      row,
      'severity',
      NOTIFICATION_SEVERITIES,
      'notification severity',
    ),
    resourceType: asString(row, 'resource_type'),
    resourceId: asStringOrNull(row, 'resource_id'),
    title: asString(row, 'title'),
    body: asString(row, 'body'),
    actionHref: asStringOrNull(row, 'action_href'),
    requiredGrant: asStringOrNull(row, 'required_grant'),
    dedupeKey: asString(row, 'dedupe_key'),
    correlationId: asStringOrNull(row, 'correlation_id'),
    occurredAt: asDate(row, 'occurred_at'),
    escalatedFrom: asStringOrNull(row, 'escalated_from'),
    escalationLevel: asNumber(row, 'escalation_level'),
    readAt: asDateOrNull(row, 'read_at'),
    dismissedAt: asDateOrNull(row, 'dismissed_at'),
    actedAt: asDateOrNull(row, 'acted_at'),
    createdAt: asDate(row, 'created_at'),
  }
}

export function deliveryFromRow(row: Row): DeliveryRecord {
  const reason = asStringOrNull(row, 'suppressed_reason')
  const known: readonly string[] = SUPPRESSION_REASONS

  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    notificationId: asString(row, 'notification_id'),
    channel: asMember<NotificationChannel>(
      row,
      'channel',
      NOTIFICATION_CHANNELS,
      'notification channel',
    ),
    status: asMember<NotificationDeliveryStatus>(
      row,
      'status',
      NOTIFICATION_DELIVERY_STATUSES,
      'delivery status',
    ),
    attempt: asNumber(row, 'attempt'),
    scheduledFor: asDateOrNull(row, 'scheduled_for'),
    provider: asStringOrNull(row, 'provider'),
    providerMessageId: asStringOrNull(row, 'provider_message_id'),
    errorCode: asStringOrNull(row, 'error_code'),
    errorDetail: asStringOrNull(row, 'error_detail'),
    // An unrecognised reason is dropped rather than thrown on: it is a
    // diagnostic column with no enum behind it, and a screen showing one fewer
    // explanation is a much smaller failure than an inbox that will not load.
    suppressedReason:
      reason !== null && known.includes(reason)
        ? (reason as SuppressionReason)
        : null,
    attemptedAt: asDateOrNull(row, 'attempted_at'),
    settledAt: asDateOrNull(row, 'settled_at'),
  }
}

export function ruleFromRow(row: Row): EscalationRule {
  const eventName = asStringOrNull(row, 'event_name')

  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    eventName:
      eventName !== null && isDomainEvent(eventName) ? eventName : null,
    minSeverity: asMember<NotificationSeverity>(
      row,
      'min_severity',
      NOTIFICATION_SEVERITIES,
      'notification severity',
    ),
    afterMinutes:
      row.after_minutes == null ? null : asNumber(row, 'after_minutes'),
    escalateToRoleCode: asString(row, 'escalate_to_role_code'),
    maxLevel: asNumber(row, 'max_level'),
    enabled: asBoolean(row, 'enabled'),
  }
}

/* --------------------------------------------------------------- adapter -- */

/** PostgREST's code for a unique violation. The dedupe constraint, working. */
const UNIQUE_VIOLATION = '23505'

export class SupabaseNotificationRepository implements NotificationRepository {
  constructor(private readonly db: Db) {}

  async loadSettings(
    organizationId: string,
  ): Promise<NotificationSettings | null> {
    const { data, error } = await this.db
      .from('notification_settings')
      .select(SETTINGS_COLUMNS)
      .eq('organization_id', organizationId)
      .maybeSingle()

    if (error) throw error
    return data ? settingsFromRow(toRow(data)) : null
  }

  async saveSettings(
    organizationId: string,
    draft: SettingsDraft,
    actorUserId: string | null,
    tx?: TransactionHandle,
  ): Promise<NotificationSettings> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('notification_settings')
      .upsert(
        {
          organization_id: organizationId,
          enabled_channels: [...draft.enabledChannels],
          quiet_hours_enabled: draft.quietHoursEnabled,
          quiet_hours_start: draft.quietHoursStart,
          quiet_hours_end: draft.quietHoursEnd,
          timezone: draft.timezone,
          urgent_overrides_quiet_hours: draft.urgentOverridesQuietHours,
          default_escalation_minutes: draft.defaultEscalationMinutes,
          retain_read_days: draft.retainReadDays,
          created_by: actorUserId,
          updated_by: actorUserId,
        },
        { onConflict: 'organization_id' },
      )
      .select(SETTINGS_COLUMNS)
      .single()

    if (error) throw error
    if (tx) recordWrite(tx, 'notification_settings.upsert')
    return settingsFromRow(toRow(data))
  }

  async listPreferences(
    organizationId: string,
    userId: string,
  ): Promise<readonly PreferenceRecord[]> {
    const { data, error } = await this.db
      .from('notification_preferences')
      .select(PREFERENCE_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('user_id', userId)

    if (error) throw error
    return toRows(data).map(preferenceFromRow)
  }

  async savePreference(
    organizationId: string,
    userId: string,
    draft: PreferenceDraft,
    tx?: TransactionHandle,
  ): Promise<PreferenceRecord> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('notification_preferences')
      .upsert(
        {
          organization_id: organizationId,
          user_id: userId,
          category: draft.category,
          channel: draft.channel,
          enabled: draft.enabled,
          min_severity: draft.minSeverity,
          updated_by: userId,
        },
        { onConflict: 'organization_id,user_id,category,channel' },
      )
      .select(PREFERENCE_COLUMNS)
      .single()

    if (error) throw error
    if (tx) recordWrite(tx, 'notification_preferences.upsert')
    return preferenceFromRow(toRow(data))
  }

  async listEscalationRules(
    organizationId: string,
  ): Promise<readonly EscalationRule[]> {
    const { data, error } = await this.db
      .from('notification_escalation_rules')
      .select(RULE_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('enabled', true)

    if (error) throw error
    return toRows(data).map(ruleFromRow)
  }

  async listInbox(
    organizationId: string,
    userId: string,
    options: { limit?: number; includeDismissed?: boolean } = {},
  ): Promise<readonly NotificationRecord[]> {
    let query = this.db
      .from('notifications')
      .select(NOTIFICATION_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('recipient_user_id', userId)

    if (!options.includeDismissed) query = query.is('dismissed_at', null)

    const { data, error } = await query
      .order('occurred_at', { ascending: false })
      .limit(options.limit ?? 50)

    if (error) throw error
    return toRows(data).map(notificationFromRow)
  }

  async insertNotification(
    planned: PlannedNotification,
    tx?: TransactionHandle,
  ): Promise<{ record: NotificationRecord; created: boolean }> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('notifications')
      .insert({
        organization_id: planned.organizationId,
        property_id: planned.propertyId,
        recipient_user_id: planned.recipientUserId,
        event_name: planned.eventName,
        category: planned.category,
        severity: planned.severity,
        resource_type: planned.resourceType,
        resource_id: planned.resourceId,
        title: planned.title,
        body: planned.body,
        action_href: planned.actionHref,
        required_grant: planned.requiredGrant,
        dedupe_key: planned.dedupeKey,
        correlation_id: planned.correlationId,
        occurred_at: planned.occurredAt.toISOString(),
        escalated_from: planned.escalatedFrom,
        escalation_level: planned.escalationLevel,
      })
      .select(NOTIFICATION_COLUMNS)
      .single()

    if (error) {
      // The dedupe constraint held. That is this module working, not failing —
      // see the header — so the existing row is read back and the caller is
      // told nothing new was created.
      if (error.code === UNIQUE_VIOLATION) {
        const existing = await this.findByDedupeKey(
          planned.organizationId,
          planned.recipientUserId,
          planned.dedupeKey,
        )
        if (existing) return { record: existing, created: false }
      }
      throw error
    }

    if (tx) recordWrite(tx, 'notifications.insert')
    return { record: notificationFromRow(toRow(data)), created: true }
  }

  private async findByDedupeKey(
    organizationId: string,
    recipientUserId: string,
    dedupeKey: string,
  ): Promise<NotificationRecord | null> {
    const { data, error } = await this.db
      .from('notifications')
      .select(NOTIFICATION_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('recipient_user_id', recipientUserId)
      .eq('dedupe_key', dedupeKey)
      .maybeSingle()

    if (error) throw error
    return data ? notificationFromRow(toRow(data)) : null
  }

  async insertDeliveries(
    organizationId: string,
    notificationId: string,
    deliveries: readonly Omit<
      DeliveryRecord,
      'id' | 'organizationId' | 'notificationId'
    >[],
    tx?: TransactionHandle,
  ): Promise<readonly DeliveryRecord[]> {
    if (deliveries.length === 0) return []

    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('notification_deliveries')
      .insert(
        deliveries.map((delivery) => ({
          organization_id: organizationId,
          notification_id: notificationId,
          channel: delivery.channel,
          status: delivery.status,
          attempt: delivery.attempt,
          scheduled_for: delivery.scheduledFor?.toISOString() ?? null,
          provider: delivery.provider,
          provider_message_id: delivery.providerMessageId,
          error_code: delivery.errorCode,
          error_detail: delivery.errorDetail,
          suppressed_reason: delivery.suppressedReason,
          attempted_at: delivery.attemptedAt?.toISOString() ?? null,
          settled_at: delivery.settledAt?.toISOString() ?? null,
        })),
      )
      .select(DELIVERY_COLUMNS)

    if (error) throw error
    if (tx) recordWrite(tx, 'notification_deliveries.insert')
    return toRows(data).map(deliveryFromRow)
  }

  async markState(
    organizationId: string,
    userId: string,
    notificationId: string,
    state: 'read' | 'dismissed' | 'acted',
    at: Date,
    tx?: TransactionHandle,
  ): Promise<void> {
    const db = clientFor(tx, this.db)
    const column =
      state === 'read'
        ? 'read_at'
        : state === 'dismissed'
          ? 'dismissed_at'
          : 'acted_at'

    const { error } = await db
      .from('notifications')
      .update({ [column]: at.toISOString() })
      .eq('organization_id', organizationId)
      // The recipient filter is here as well as in the policy. Row level
      // security already refuses somebody else's row; this makes a mistake in
      // this file fail as "nothing updated" rather than as an alert one person
      // silenced on another's behalf, which is the shape of bug that is
      // invisible until it matters.
      .eq('recipient_user_id', userId)
      .eq('id', notificationId)

    if (error) throw error
    if (tx) recordWrite(tx, `notifications.${state}`)
  }

  async deliveryTally(
    organizationId: string,
    sinceDays: number,
  ): Promise<DeliveryTally> {
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString()

    const { data, error } = await this.db
      .from('notification_deliveries')
      .select('status')
      .eq('organization_id', organizationId)
      .gte('created_at', since)

    if (error) throw error

    const tally = emptyTally()
    for (const row of toRows(data)) {
      const status = asString(row, 'status')
      if (status in tally) {
        tally[status as NotificationDeliveryStatus] += 1
      }
    }
    return tally
  }
}

/* ------------------------------------------------------------ in memory -- */

/**
 * The double the domain tests run against.
 *
 * It implements the dedupe constraint faithfully — the same key twice returns
 * `created: false` — because that is the behaviour the module's most important
 * test asserts, and a double that quietly allowed the duplicate would let that
 * test pass for the wrong reason.
 */
export class InMemoryNotificationRepository implements NotificationRepository {
  settings = new Map<string, NotificationSettings>()
  preferences: PreferenceRecord[] = []
  rules: EscalationRule[] = []
  notifications: NotificationRecord[] = []
  deliveries: DeliveryRecord[] = []

  private sequence = 0

  private nextId(prefix: string): string {
    this.sequence += 1
    return `${prefix}-${this.sequence}`
  }

  async loadSettings(
    organizationId: string,
  ): Promise<NotificationSettings | null> {
    return this.settings.get(organizationId) ?? null
  }

  async saveSettings(
    organizationId: string,
    draft: SettingsDraft,
  ): Promise<NotificationSettings> {
    const existing = this.settings.get(organizationId)
    const saved: NotificationSettings = {
      id: existing?.id ?? this.nextId('settings'),
      organizationId,
      ...draft,
      version: (existing?.version ?? 0) + 1,
    }
    this.settings.set(organizationId, saved)
    return saved
  }

  async listPreferences(
    organizationId: string,
    userId: string,
  ): Promise<readonly PreferenceRecord[]> {
    return this.preferences.filter(
      (row) => row.organizationId === organizationId && row.userId === userId,
    )
  }

  async savePreference(
    organizationId: string,
    userId: string,
    draft: PreferenceDraft,
  ): Promise<PreferenceRecord> {
    const index = this.preferences.findIndex(
      (row) =>
        row.organizationId === organizationId &&
        row.userId === userId &&
        row.category === draft.category &&
        row.channel === draft.channel,
    )

    const saved: PreferenceRecord = {
      id: index >= 0 ? this.preferences[index].id : this.nextId('pref'),
      organizationId,
      userId,
      ...draft,
    }

    if (index >= 0) this.preferences[index] = saved
    else this.preferences.push(saved)

    return saved
  }

  async listEscalationRules(
    organizationId: string,
  ): Promise<readonly EscalationRule[]> {
    return this.rules.filter((rule) => rule.organizationId === organizationId)
  }

  async listInbox(
    organizationId: string,
    userId: string,
    options: { limit?: number; includeDismissed?: boolean } = {},
  ): Promise<readonly NotificationRecord[]> {
    return this.notifications
      .filter(
        (row) =>
          row.organizationId === organizationId &&
          row.recipientUserId === userId &&
          (options.includeDismissed || row.dismissedAt === null),
      )
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, options.limit ?? 50)
  }

  async insertNotification(
    planned: PlannedNotification,
  ): Promise<{ record: NotificationRecord; created: boolean }> {
    const existing = this.notifications.find(
      (row) =>
        row.organizationId === planned.organizationId &&
        row.recipientUserId === planned.recipientUserId &&
        row.dedupeKey === planned.dedupeKey,
    )
    if (existing) return { record: existing, created: false }

    const record: NotificationRecord = {
      id: this.nextId('notification'),
      organizationId: planned.organizationId,
      propertyId: planned.propertyId,
      recipientUserId: planned.recipientUserId,
      eventName: planned.eventName,
      category: planned.category,
      severity: planned.severity,
      resourceType: planned.resourceType,
      resourceId: planned.resourceId,
      title: planned.title,
      body: planned.body,
      actionHref: planned.actionHref,
      requiredGrant: planned.requiredGrant,
      dedupeKey: planned.dedupeKey,
      correlationId: planned.correlationId,
      occurredAt: planned.occurredAt,
      escalatedFrom: planned.escalatedFrom,
      escalationLevel: planned.escalationLevel,
      readAt: null,
      dismissedAt: null,
      actedAt: null,
      createdAt: new Date(),
    }

    this.notifications.push(record)
    return { record, created: true }
  }

  async insertDeliveries(
    organizationId: string,
    notificationId: string,
    deliveries: readonly Omit<
      DeliveryRecord,
      'id' | 'organizationId' | 'notificationId'
    >[],
  ): Promise<readonly DeliveryRecord[]> {
    const written = deliveries.map((delivery) => ({
      id: this.nextId('delivery'),
      organizationId,
      notificationId,
      ...delivery,
    }))
    this.deliveries.push(...written)
    return written
  }

  async markState(
    organizationId: string,
    userId: string,
    notificationId: string,
    state: 'read' | 'dismissed' | 'acted',
    at: Date,
  ): Promise<void> {
    const index = this.notifications.findIndex(
      (row) =>
        row.id === notificationId &&
        row.organizationId === organizationId &&
        row.recipientUserId === userId,
    )
    if (index < 0) return

    const row = this.notifications[index]
    this.notifications[index] = {
      ...row,
      readAt: state === 'read' ? at : row.readAt,
      dismissedAt: state === 'dismissed' ? at : row.dismissedAt,
      actedAt: state === 'acted' ? at : row.actedAt,
    }
  }

  async deliveryTally(organizationId: string): Promise<DeliveryTally> {
    const tally = emptyTally()
    for (const delivery of this.deliveries) {
      if (delivery.organizationId !== organizationId) continue
      tally[delivery.status] += 1
    }
    return tally
  }
}

/**
 * The settings an organization has, whether or not it saved a row.
 *
 * Written once so the screen, the routing engine and the tests cannot hold
 * three opinions about what "never configured" means — and returning an object
 * with a synthetic id rather than `null` because every caller downstream wants
 * settings, not a decision about whether settings exist. The decision is made
 * here, in one place.
 */
export function settingsOrDefaults(
  organizationId: string,
  saved: NotificationSettings | null,
): NotificationSettings {
  return (
    saved ?? {
      id: `default:${organizationId}`,
      organizationId,
      version: 0,
      ...DEFAULT_SETTINGS,
    }
  )
}
