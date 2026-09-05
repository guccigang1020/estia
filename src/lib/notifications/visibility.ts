/**
 * May this person still see this notification?
 *
 * ── Why the question is asked twice ───────────────────────────────────────
 *
 * `routing.ts` asked it when the notification was created. That answer was
 * true at 02:00 on Tuesday. It is now Thursday, the person has been narrowed
 * from three properties to two, and the alert about the third is still sitting
 * in their inbox.
 *
 * `notifications_select` in 0043 catches the property half of that, because
 * `property_in_scope` is re-evaluated on every read. It deliberately does NOT
 * catch the grant half: `has_permission` is a coarse mirror that knows nothing
 * of plan entitlements or per-family scope overrides — 0004 says so in its own
 * comment — and a policy that half-checked the grant would be a second, weaker
 * opinion sitting beside `can()`.
 *
 * So the grant half is asked here, against the real engine, with the grant the
 * routing decision recorded on the row. Two floors, and neither of them is
 * trusting the other.
 *
 * ── An unreadable notification is dropped, not redacted ───────────────────
 *
 * `redact()` exists for a record somebody may see part of. A notification is
 * not that: its title and body are written to explain a payment failure to
 * somebody who may see payments, and a version with the money removed would be
 * a sentence that says nothing while implying something was hidden. If the
 * grant is gone, the row is not theirs to read.
 */

import { can, type Actor, type Resource } from '../authz/can'
import { isPermission, type Grant } from '../authz/permissions'
import { FIELD_PERMISSIONS } from '../authz/permissions'

import { specFor } from './catalogue'
import type { NotificationRecord } from './types'

const FIELD_PERMISSION_SET: ReadonlySet<string> = new Set(FIELD_PERMISSIONS)

function isGrant(value: string): value is Grant {
  return isPermission(value) || FIELD_PERMISSION_SET.has(value)
}

/**
 * Filter a fetched inbox down to what this actor may still read.
 *
 * Called on every read path — the panel, the settings screen, any future
 * count. Written once so there is no path that fetches rows and forgets.
 */
export function visibleTo(
  actor: Actor,
  notifications: readonly NotificationRecord[],
): readonly NotificationRecord[] {
  return notifications.filter((notification) =>
    isStillVisible(actor, notification),
  )
}

export function isStillVisible(
  actor: Actor,
  notification: NotificationRecord,
): boolean {
  // Addressed to somebody else. Reached only if a caller passed the wrong
  // actor, and refused here rather than assumed away: a bell that could be
  // handed another person's rows by a mistake in a query is a bell nobody
  // should trust.
  if (notification.recipientUserId !== actor.userId) return false
  if (notification.organizationId !== actor.organizationId) return false

  const grant = requiredGrantFor(notification)
  // No grant recorded and none derivable means the notification predates the
  // catalogue entry, or was written by something that did not state one. It
  // stays visible: the row is addressed to this person, in this organization,
  // and refusing it would hide history for a reason nobody can explain.
  if (!grant) return true

  return can(actor, grant, resourceFor(notification))
}

/**
 * The grant to check.
 *
 * The stored column first, because it is what the routing decision actually
 * used and a catalogue edited since must not retroactively change who could
 * read yesterday's alerts. The catalogue is the fallback for rows written
 * before the column carried anything.
 */
function requiredGrantFor(notification: NotificationRecord): Grant | null {
  const stored = notification.requiredGrant
  if (stored !== null && isGrant(stored)) return stored
  return specFor(notification.eventName)?.requiredGrant ?? null
}

function resourceFor(notification: NotificationRecord): Resource {
  const spec = specFor(notification.eventName)
  return {
    organizationId: notification.organizationId,
    ...(notification.propertyId ? { propertyId: notification.propertyId } : {}),
    ...(spec?.family ? { family: spec.family } : {}),
  }
}

/** Unread and not dismissed. What a badge counts. */
export function unreadCount(
  notifications: readonly NotificationRecord[],
): number {
  return notifications.filter(
    (notification) =>
      notification.readAt === null && notification.dismissedAt === null,
  ).length
}
