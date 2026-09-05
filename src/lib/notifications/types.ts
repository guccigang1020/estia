/**
 * The notification vocabulary.
 *
 * Declared here and transcribed into `0043_notifications.sql` as four enums,
 * in the same order — the migration says so in its own comment, and the order
 * of `NOTIFICATION_SEVERITIES` is load-bearing rather than cosmetic: a
 * preference stores a MINIMUM severity, the filter is `severity >= minimum`,
 * and that comparison is an ordinal one on both sides of the wire.
 *
 * ── What is deliberately not here ─────────────────────────────────────────
 *
 * There is no event vocabulary. `src/lib/contracts/events.ts` is frozen and
 * holds roughly 130 names; a second list would be a second catalogue, and the
 * one thing this module must never do is invent an event string. Every type
 * below that names an event names it as `DomainEventName`.
 */

import type { DomainEventName } from '../contracts/events'

/* -------------------------------------------------------------- channels -- */

/**
 * How a person can be reached.
 *
 * `in_app` is first and is the only one this product delivers. The other four
 * are declared — not aspirationally, but because a delivery attempt against a
 * channel with no transport has to be RECORDABLE as `not_configured`, and a
 * channel that does not exist in the vocabulary cannot be recorded as missing.
 * That count is the whole argument for connecting one.
 */
export const NOTIFICATION_CHANNELS = [
  'in_app',
  'email',
  'sms',
  'whatsapp',
  'push',
] as const

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

/**
 * The channels that interrupt somebody.
 *
 * Quiet hours apply to exactly these and never to `in_app`, which is pull:
 * opening the product at eight in the morning and finding what happened
 * overnight is the point of the in-app channel, not an interruption. A quiet
 * hours rule that suppressed the in-app record would produce a business with
 * no history of its own nights.
 */
export const PUSH_CHANNELS: readonly NotificationChannel[] = [
  'email',
  'sms',
  'whatsapp',
  'push',
]

export function isPushChannel(channel: NotificationChannel): boolean {
  return channel !== 'in_app'
}

/* ------------------------------------------------------------- severities -- */

/**
 * Ascending. Never reorder.
 *
 * `severityRank` below is the only place the ordinal is taken, and the
 * rehearsal block in 0043 asserts the same order at the database — because if
 * these two ever disagree, the product silently starts waking different people
 * and nothing fails.
 */
export const NOTIFICATION_SEVERITIES = [
  /** Worth knowing. Never worth a telephone. */
  'info',
  /** Somebody should look today. */
  'attention',
  /** Somebody should look now, and it may pass through quiet hours. */
  'urgent',
  /** Money or safety is at stake and nobody knows the answer yet. */
  'critical',
] as const

export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number]

const SEVERITY_RANK: ReadonlyMap<NotificationSeverity, number> = new Map(
  NOTIFICATION_SEVERITIES.map((severity, index) => [severity, index]),
)

export function severityRank(severity: NotificationSeverity): number {
  return SEVERITY_RANK.get(severity) ?? 0
}

export function severityAtLeast(
  severity: NotificationSeverity,
  floor: NotificationSeverity,
): boolean {
  return severityRank(severity) >= severityRank(floor)
}

/** The severities allowed through quiet hours when the setting permits it. */
export function overridesQuietHours(severity: NotificationSeverity): boolean {
  return severityAtLeast(severity, 'urgent')
}

/* ------------------------------------------------------------- categories -- */

/**
 * The unit a PERSON tunes.
 *
 * Not one switch per domain event. 130 switches is a preferences screen nobody
 * finishes, and a screen nobody finishes is a person who never turns anything
 * off and eventually mutes the whole product in their mail client — which is
 * strictly worse than a coarse control they actually use.
 */
export const NOTIFICATION_CATEGORIES = [
  'booking',
  'guest',
  'money',
  'operations',
  'inventory',
  'approval',
  'security',
  'system',
] as const

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

/* --------------------------------------------------------------- delivery -- */

export const NOTIFICATION_DELIVERY_STATUSES = [
  'pending',
  /** Held by quiet hours. `scheduledFor` says when it may go. Not dropped. */
  'deferred',
  'sent',
  'delivered',
  'failed',
  /**
   * The engine chose this channel and there is no transport behind it.
   *
   * A first-class outcome and never an error. It is what lets a business be
   * shown "we would have sent 14 messages and nothing is connected", which is
   * both honest and the strongest argument for connecting something.
   */
  'not_configured',
  /** A person, a severity floor or a capability said no. */
  'suppressed',
] as const

export type NotificationDeliveryStatus =
  (typeof NOTIFICATION_DELIVERY_STATUSES)[number]

/**
 * Why nothing was sent.
 *
 * Stored as text in the database rather than as an enum, because it is a
 * diagnostic and not a lifecycle: a new reason must not need a migration
 * before somebody can write it down. Typed here so the labels module cannot
 * be handed a reason it has no Hebrew for.
 */
export const SUPPRESSION_REASONS = [
  /** Held until the quiet window ends. Paired with status `deferred`. */
  'quiet_hours',
  /** This person switched this category off on this channel. */
  'preference_off',
  /** Above their floor is not what this was. */
  'below_min_severity',
  /** The organization has not enabled this channel at all. */
  'channel_disabled',
  /** The channel is enabled and nothing implements it. */
  'no_transport',
] as const

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number]

/* ---------------------------------------------------------------- records -- */

/** A notification, as the product reads one back. */
export interface NotificationRecord {
  id: string
  organizationId: string
  propertyId: string | null
  recipientUserId: string
  eventName: DomainEventName
  category: NotificationCategory
  severity: NotificationSeverity
  resourceType: string
  resourceId: string | null
  title: string
  body: string
  actionHref: string | null
  /**
   * The grant the recipient had to hold for this to be routed to them.
   *
   * Read again at display time by `visibility.ts` rather than trusted from the
   * moment of routing, so somebody whose role is narrowed today stops seeing
   * yesterday's payment alert.
   */
  requiredGrant: string | null
  dedupeKey: string
  correlationId: string | null
  occurredAt: Date
  escalatedFrom: string | null
  escalationLevel: number
  readAt: Date | null
  dismissedAt: Date | null
  actedAt: Date | null
  createdAt: Date
}

/** One attempt on one channel. */
export interface DeliveryRecord {
  id: string
  organizationId: string
  notificationId: string
  channel: NotificationChannel
  status: NotificationDeliveryStatus
  attempt: number
  scheduledFor: Date | null
  provider: string | null
  providerMessageId: string | null
  errorCode: string | null
  errorDetail: string | null
  suppressedReason: SuppressionReason | null
  attemptedAt: Date | null
  settledAt: Date | null
}

/** One person's answer for one category on one channel. */
export interface PreferenceRecord {
  id: string
  organizationId: string
  userId: string
  category: NotificationCategory
  channel: NotificationChannel
  enabled: boolean
  minSeverity: NotificationSeverity
}

/** The organization's own answer. `null` from the repository means defaults. */
export interface NotificationSettings {
  id: string
  organizationId: string
  enabledChannels: readonly NotificationChannel[]
  quietHoursEnabled: boolean
  /** `HH:MM`, local to `timezone`. */
  quietHoursStart: string
  quietHoursEnd: string
  timezone: string
  urgentOverridesQuietHours: boolean
  defaultEscalationMinutes: number
  retainReadDays: number
  version: number
}

/** One escalation rule. Names a role, never a person — see 0043. */
export interface EscalationRule {
  id: string
  organizationId: string
  /** `null` means every event at or above `minSeverity`. */
  eventName: DomainEventName | null
  minSeverity: NotificationSeverity
  /** `null` falls back to `NotificationSettings.defaultEscalationMinutes`. */
  afterMinutes: number | null
  escalateToRoleCode: string
  maxLevel: number
  enabled: boolean
}

/* --------------------------------------------------------------- defaults -- */

/**
 * What an organization that has never saved a row actually has.
 *
 * A complete configuration, not an unfinished one — the same statement 0043
 * makes about the absent row, made once here so the resolver and the screen
 * cannot hold two opinions about what "not configured" means.
 *
 * `in_app` alone, because on the day a business signs up that is the truth.
 */
export const DEFAULT_SETTINGS: Omit<
  NotificationSettings,
  'id' | 'organizationId' | 'version'
> = {
  enabledChannels: ['in_app'],
  quietHoursEnabled: true,
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
  timezone: 'Asia/Jerusalem',
  urgentOverridesQuietHours: true,
  defaultEscalationMinutes: 30,
  retainReadDays: 30,
}

/**
 * The floor a person gets on a channel they have never expressed an opinion
 * about.
 *
 * In-app takes everything, because it costs nobody anything and the inbox is
 * where "why did I not know" is answered. Every channel that interrupts starts
 * at `attention` — a product that sends an SMS for `booking.created` on the
 * first day is a product whose SMS is muted by the second.
 */
export function defaultPreference(channel: NotificationChannel): {
  enabled: boolean
  minSeverity: NotificationSeverity
} {
  return channel === 'in_app'
    ? { enabled: true, minSeverity: 'info' }
    : { enabled: true, minSeverity: 'attention' }
}
