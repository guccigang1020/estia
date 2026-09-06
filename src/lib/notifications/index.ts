/**
 * Notifications, in one import.
 *
 * ── What this module is, and what it deliberately is not ──────────────────
 *
 * It is everything ABOVE a transport: which events reach a person, which
 * person, on which channel, whether now or after the quiet hours, what happens
 * when nobody acts, and how a retried handler stays harmless. All of it is
 * pure and all of it is tested without sending anything.
 *
 * It is **not** a mailer, an SMS client or a WhatsApp client. Those need
 * credentials this project does not have, and half a client behind a missing
 * key is worse than none. `transport.ts` declares the port and ships a null
 * implementation that records `not_configured` — a real state, on a real
 * screen, that a business can read and act on.
 *
 * The one channel with no credential is `in_app`, and it is delivered end to
 * end: the `notifications` row is written, the person sees it, marks it read,
 * dismisses it or acts on it, and escalation reads the last of those.
 *
 * ── Where to start reading ────────────────────────────────────────────────
 *
 *   `catalogue.ts`   which events are worth a person's attention, and whose
 *   `routing.ts`     the engine — five gates, in order, with reasons
 *   `dedupe.ts`      why one event cannot become two notifications
 *   `quiet-hours.ts` deferral, and why in-app is never deferred
 *   `escalation.ts`  `actedAt`, never `readAt`
 *   `transport.ts`   the port, the null, and the honest gap
 */

export {
  NOTIFICATION_CATALOGUE,
  notifiableEvents,
  specFor,
  unroutedAlertEvents,
  type NotificationAudience,
  type NotificationSpec,
} from './catalogue'

export {
  isSameNotification,
  notificationDedupeKey,
  type DedupeParts,
} from './dedupe'

export { dispatch, type DispatchOutcome } from './dispatch'

export {
  escalationsDue,
  SUGGESTED_ESCALATION,
  type EscalationDue,
} from './escalation'

export {
  eventDetail,
  notifiableFromServiceEvent,
  type NotifiableEvent,
} from './event'

export {
  CATEGORY_HINT,
  CATEGORY_LABEL,
  CHANNEL_HINT,
  CHANNEL_LABEL,
  DELIVERY_STATUS_LABEL,
  SEVERITY_LABEL,
  SUPPRESSION_LABEL,
  unsentSummary,
} from './labels'

export {
  defineNotificationOperations,
  loadSettings,
  markNotificationState,
  setPreference,
  PERSONAL_GRANT,
  type NotificationOperationDeps,
  type PersonalWriteContext,
} from './operations'

export {
  PreferenceSet,
  suppressionFor,
  type ResolvedPreference,
} from './preferences'

export {
  describeQuietHours,
  localMinutes,
  minutesOfDay,
  quietHoursVerdict,
  windowEndsAt,
  withinWindow,
  type QuietHoursVerdict,
} from './quiet-hours'

export {
  emptyTally,
  InMemoryNotificationRepository,
  settingsOrDefaults,
  SupabaseNotificationRepository,
  type DeliveryTally,
  type NotificationRepository,
  type PreferenceDraft,
  type SettingsDraft,
} from './repository'

export {
  route,
  unsentCount,
  type NotificationCandidate,
  type PlannedDelivery,
  type PlannedNotification,
  type RoutingInput,
  type RoutingPlan,
  type SkippedRecipient,
  type SkipReason,
} from './routing'

export {
  defaultTransportRegistry,
  InAppTransport,
  NullTransport,
  TransportRegistry,
  type NotificationTransport,
  type OutboundMessage,
  type TransportResult,
} from './transport'

export {
  DEFAULT_SETTINGS,
  defaultPreference,
  isPushChannel,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_DELIVERY_STATUSES,
  NOTIFICATION_SEVERITIES,
  overridesQuietHours,
  PUSH_CHANNELS,
  severityAtLeast,
  severityRank,
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

export { isStillVisible, unreadCount, visibleTo } from './visibility'

export {
  STALE_DEFERRAL,
  planDeliveryRelease,
  releaseDueDeliveries,
  type DeliveryPatch,
  type DeliveryReleaseDecision,
  type DeliveryReleasePlan,
  type DeliveryReleaseStore,
  type DeliveryReleaseSummary,
  type DueDelivery,
  type ReleaseSuppressionReason,
} from './release'
