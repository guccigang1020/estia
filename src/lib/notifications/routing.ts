/**
 * The routing engine.
 *
 * Given a domain event, decide WHO should be told, on WHICH channel, and
 * WHETHER now. This is the whole value of the module, and none of it needs a
 * transport — which is why all of it is tested without one.
 *
 * ── It decides. It does not write, and it does not send. ──────────────────
 *
 * `route()` is a pure function of (event, settings, candidates, transports,
 * now). It returns a PLAN. `dispatch.ts` is what turns a plan into rows and
 * hands the rows to transports; the split is what lets every rule below be
 * asserted against a table of inputs rather than against a database.
 *
 * ── The five gates, in the order they are asked ───────────────────────────
 *
 *   1. **Is this event notifiable at all?** `catalogue.ts` says. Most of the
 *      130 events are for automations and dashboards; silence is the default.
 *
 *   2. **May this person be told?** One call to `authorize(actor, grant,
 *      resource)`, which settles membership status, tenant, permission, plan
 *      entitlement and scope in that order and returns which one refused. This
 *      single call is:
 *
 *        · the capability rule — a module whose entitlement the organization
 *          does not hold has nobody who passes, because `laundry.view` is
 *          mapped to the `laundry` entitlement in `plans/entitlements.ts`;
 *        · the permission rule — a person who cannot see payments is never
 *          told about one, because `payment.received` asks for `payment.view`;
 *        · **the scope rule** — a property manager holding two properties is
 *          not told about the third, because the resource carries the event's
 *          `propertyId` and `isWithinScope` refuses it.
 *
 *      There is no role comparison anywhere in this file, and no second copy
 *      of any of those three rules.
 *
 *   3. **Is it their own doing?** Somebody who confirms a booking and is
 *      immediately told a booking was confirmed learns to dismiss the bell
 *      without reading it — and the next thing they dismiss without reading is
 *      the payment that failed.
 *
 *   4. **Do they want it, on this channel?** `preferences.ts`, three layers:
 *      module default, organization, person.
 *
 *   5. **May it wake them now?** `quiet-hours.ts`. Held, never dropped.
 *
 * ── Nothing is ever silently discarded ────────────────────────────────────
 *
 * A recipient who fails gate 2 or 3 appears in `plan.skipped` with the reason.
 * A channel that fails gate 4 or 5 appears as a delivery with status
 * `suppressed` or `deferred` and a stated reason. A channel with no transport
 * appears as `not_configured`. The plan is a complete account of what the
 * engine decided and why, because "nobody was told and I do not know why" is
 * the single worst thing a notification system can say.
 */

import {
  authorize,
  type Actor,
  type Decision,
  type Resource,
} from '../authz/can'
import type { Grant } from '../authz/permissions'

import { specFor, type NotificationSpec } from './catalogue'
import { notificationDedupeKey } from './dedupe'
import { eventDetail, type NotifiableEvent } from './event'
import { PreferenceSet, suppressionFor } from './preferences'
import { quietHoursVerdict } from './quiet-hours'
import type { TransportRegistry } from './transport'
import {
  type NotificationCategory,
  type NotificationChannel,
  type NotificationSettings,
  type NotificationSeverity,
  type PreferenceRecord,
  type SuppressionReason,
} from './types'

/* ---------------------------------------------------------------- inputs -- */

/**
 * One person the event might concern, with their own preferences.
 *
 * The `Actor` is the resolved one — grants already flattened from roles, plan
 * entitlements already attached, scope already narrowed. It is built by
 * `src/lib/actor`, exactly as it is for a request; the routing engine does not
 * resolve anybody and must not, because a second resolution is a second answer
 * to "what may this person see".
 */
export interface NotificationCandidate {
  actor: Actor
  preferences: readonly PreferenceRecord[]
}

export interface RoutingInput {
  event: NotifiableEvent
  settings: NotificationSettings
  candidates: readonly NotificationCandidate[]
  transports: TransportRegistry
  now: Date
  /**
   * Set when this pass is raising an escalation rather than the original.
   * Feeds the dedupe key, so level 1 cannot collide with level 0.
   */
  escalation?: { level: number; fromNotificationId: string }
  /** Raise the severity for an escalated copy. Defaults to the spec's own. */
  severityOverride?: NotificationSeverity
}

/* --------------------------------------------------------------- outputs -- */

export type SkipReason =
  | 'membership_not_active'
  | 'cross_organization'
  | 'missing_permission'
  | 'plan_does_not_include'
  | 'out_of_scope'
  | 'requires_approval'
  /** They caused it. See gate 3. */
  | 'is_actor'
  /** The event is addressed to its actor and this is somebody else. */
  | 'not_the_actor'

export interface SkippedRecipient {
  userId: string
  reason: SkipReason
  /** The grant that was missing, when the refusal was about one. */
  grant?: Grant
}

export type PlannedDeliveryStatus =
  'pending' | 'deferred' | 'not_configured' | 'suppressed'

export interface PlannedDelivery {
  channel: NotificationChannel
  status: PlannedDeliveryStatus
  /** Set only for `deferred`. 0043 refuses a deferral with no time. */
  scheduledFor: Date | null
  /** Set only for `suppressed`. 0043 refuses a suppression with no reason. */
  suppressedReason: SuppressionReason | null
}

export interface PlannedNotification {
  recipientUserId: string
  eventName: NotifiableEvent['name']
  category: NotificationCategory
  severity: NotificationSeverity
  organizationId: string
  propertyId: string | null
  resourceType: string
  resourceId: string | null
  title: string
  body: string
  actionHref: string | null
  requiredGrant: Grant | null
  dedupeKey: string
  correlationId: string
  occurredAt: Date
  escalationLevel: number
  escalatedFrom: string | null
  deliveries: readonly PlannedDelivery[]
}

export interface RoutingPlan {
  event: NotifiableEvent['name']
  /** `false` when the event has no catalogue entry. Not an error. */
  notifiable: boolean
  notifications: readonly PlannedNotification[]
  skipped: readonly SkippedRecipient[]
}

/* ---------------------------------------------------------------- engine -- */

export function route(input: RoutingInput): RoutingPlan {
  const { event, settings, candidates, transports, now } = input

  const spec = specFor(event.name)
  if (!spec) {
    return {
      event: event.name,
      notifiable: false,
      notifications: [],
      skipped: [],
    }
  }

  const severity = input.severityOverride ?? spec.severity
  const resource = resourceFor(event, spec)

  const notifications: PlannedNotification[] = []
  const skipped: SkippedRecipient[] = []

  for (const candidate of candidates) {
    const { actor } = candidate

    // Gate 2 — one question, five refusals, no second copy of any of them.
    //
    // The `null` branch is not a bypass. It is reached only by an event the
    // catalogue addresses to its own actor — "somebody signed in to your
    // account" — where the gate is identity rather than authority, and where
    // demanding a grant would mean the people least able to notice an account
    // takeover are the ones never told about it. Membership and tenant are
    // still settled, because a suspended person is not an actor at all and a
    // notification must never cross an organization.
    const decision =
      spec.requiredGrant === null
        ? membershipOnly(actor, event.organizationId)
        : authorize(actor, spec.requiredGrant, resource)

    if (!decision.allowed) {
      skipped.push({
        userId: actor.userId,
        reason: decision.reason,
        ...(decision.grant ? { grant: decision.grant } : {}),
      })
      continue
    }

    // Gate 3 — whose doing was it, and is this event addressed to them?
    const isActor =
      event.actorUserId !== null &&
      event.actorUserId !== undefined &&
      event.actorUserId === actor.userId

    if (spec.audience === 'actor') {
      if (!isActor) {
        skipped.push({ userId: actor.userId, reason: 'not_the_actor' })
        continue
      }
    } else if (isActor && spec.notifyActor !== true) {
      skipped.push({ userId: actor.userId, reason: 'is_actor' })
      continue
    }

    notifications.push(
      planFor({
        event,
        spec,
        severity,
        actor,
        preferences: new PreferenceSet(candidate.preferences, settings),
        settings,
        transports,
        now,
        escalation: input.escalation,
      }),
    )
  }

  return { event: event.name, notifiable: true, notifications, skipped }
}

/* ------------------------------------------------------------ one person -- */

function planFor(args: {
  event: NotifiableEvent
  spec: NotificationSpec
  severity: NotificationSeverity
  actor: Actor
  preferences: PreferenceSet
  settings: NotificationSettings
  transports: TransportRegistry
  now: Date
  escalation?: { level: number; fromNotificationId: string }
}): PlannedNotification {
  const {
    event,
    spec,
    severity,
    actor,
    preferences,
    settings,
    transports,
    now,
    escalation,
  } = args

  const deliveries: PlannedDelivery[] = []

  // Every channel the ORGANIZATION has switched on. A channel it has not is
  // absent entirely rather than present-and-suppressed: a business that never
  // asked for WhatsApp should not be shown a row explaining that its WhatsApp
  // was suppressed.
  for (const channel of settings.enabledChannels) {
    const preference = preferences.resolve(spec.category, channel)

    // Gate 4 — does this person want it here, at this severity?
    const suppression = suppressionFor(preference, severity)
    if (suppression) {
      deliveries.push({
        channel,
        status: 'suppressed',
        scheduledFor: null,
        suppressedReason: suppression,
      })
      continue
    }

    // The honest gap. Checked BEFORE quiet hours, because deferring a message
    // to seven in the morning on a channel that does not exist would produce a
    // queue of things that will never be sent and a screen that says "waiting"
    // about them forever.
    if (!transports.isConfigured(channel)) {
      deliveries.push({
        channel,
        status: 'not_configured',
        scheduledFor: null,
        suppressedReason: null,
      })
      continue
    }

    // Gate 5 — may it wake them now?
    const verdict = quietHoursVerdict({ channel, severity, settings, now })
    deliveries.push(
      verdict.held
        ? {
            channel,
            status: 'deferred',
            scheduledFor: verdict.until,
            suppressedReason: 'quiet_hours',
          }
        : {
            channel,
            status: 'pending',
            scheduledFor: null,
            suppressedReason: null,
          },
    )
  }

  const detail = eventDetail(event)

  return {
    recipientUserId: actor.userId,
    eventName: event.name,
    category: spec.category,
    severity,
    organizationId: event.organizationId,
    propertyId: event.propertyId ?? null,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    title: spec.title,
    // The catalogue's sentence, and the raising module's own detail beneath it
    // when there was one. Two lines rather than one interpolated string: the
    // fixed half is written in Hebrew by a person and the variable half is
    // not, and a template would let a missing value read as a typo.
    body: detail ? `${spec.body}\n${detail}` : spec.body,
    actionHref: spec.href ? spec.href(event.resourceId) : null,
    requiredGrant: spec.requiredGrant,
    dedupeKey: notificationDedupeKey({
      event,
      recipientUserId: actor.userId,
      escalationLevel: escalation?.level ?? 0,
    }),
    correlationId: event.correlationId,
    occurredAt: new Date(event.occurredAt),
    escalationLevel: escalation?.level ?? 0,
    escalatedFrom: escalation?.fromNotificationId ?? null,
    deliveries,
  }
}

/**
 * The two refusals that apply to everybody, whatever the event.
 *
 * The same two `authorize()` makes first, in the same order, and written here
 * rather than reached by passing a token grant — a gate whose answer varies by
 * role for a decision that does not is worse than no gate, because it looks
 * like a rule.
 */
function membershipOnly(actor: Actor, organizationId: string): Decision {
  if (actor.membershipStatus !== 'active') {
    return { allowed: false, reason: 'membership_not_active' }
  }
  if (actor.organizationId !== organizationId) {
    return { allowed: false, reason: 'cross_organization' }
  }
  return { allowed: true }
}

/**
 * The authorization view of what happened.
 *
 * `propertyId` is passed through exactly as the event carried it, including
 * when it is absent — and the absence is meaningful. An organization-wide
 * event has no property, so a membership scoped to properties does not reach
 * it, which is `isWithinScope` refusing rather than this file deciding. That is
 * the correct answer: somebody who manages one villa has no business being
 * paged about a change to the organization's payment configuration.
 */
function resourceFor(event: NotifiableEvent, spec: NotificationSpec): Resource {
  return {
    organizationId: event.organizationId,
    ...(event.propertyId ? { propertyId: event.propertyId } : {}),
    ...(spec.family ? { family: spec.family } : {}),
  }
}

/* ----------------------------------------------------------------- reads -- */

/**
 * How many messages this plan would have sent if a channel existed.
 *
 * The figure the settings screen puts in front of a business. Deliberately
 * counts only `not_configured` — a suppressed delivery is somebody having said
 * no, and rolling the two together would make the product argue for buying a
 * channel its own staff switched off.
 */
export function unsentCount(plan: RoutingPlan): number {
  return plan.notifications.reduce(
    (total, notification) =>
      total +
      notification.deliveries.filter(
        (delivery) => delivery.status === 'not_configured',
      ).length,
    0,
  )
}
