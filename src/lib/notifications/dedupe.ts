/**
 * One event must not produce two notifications.
 *
 * ── The key, and why each part of it is there ─────────────────────────────
 *
 *     <event name> · <resource type>:<resource id> · <event idempotency key>
 *                  · u:<recipient user id> · l:<escalation level>
 *
 *   · **The event's own `idempotencyKey`** is the load-bearing part.
 *     `contracts/events.ts` defines it as "stable across retries of the same
 *     logical event, so a handler can refuse to act twice" — a webhook
 *     delivered three times is one event and carries one key. Nothing else in
 *     the envelope has that property: `correlationId` is per request, and
 *     `occurredAt` is a timestamp that a retry may well recompute.
 *
 *   · **The recipient** is in the key because one event legitimately produces
 *     N notifications, one per person. Without it, the second recipient's
 *     insert would collide with the first's and four people would be reduced
 *     to one, silently — the worst possible shape for this bug, because the
 *     product would look like it was working.
 *
 *   · **The escalation level** is in it because an escalation IS a second
 *     notification about the same event, deliberately. Level 1 must not
 *     collide with level 0, and level 2 must not collide with level 1.
 *
 *   · **The event name and the resource** are in it for readability rather
 *     than for correctness — the key ends up in a database column that
 *     somebody will one day read while trying to work out why a guest got
 *     three messages, and an opaque hash would tell them nothing. They cost
 *     nothing: two different events cannot share an idempotency key without
 *     already being the same event.
 *
 * The guarantee is NOT this function. It is
 * `notifications_dedupe_key unique (organization_id, recipient_user_id,
 * dedupe_key)` in 0043 — a retried handler is a failed insert, not a second
 * message. This function only has to be stable and unique; the database is
 * what makes it enforced. A handler that looked the key up first and then
 * inserted would have a window, which is the entire argument
 * `src/lib/service/idempotency.ts` makes at length about two requests eight
 * milliseconds apart.
 *
 * The organization is deliberately NOT in the string: it is a separate column
 * in the unique constraint, so putting it here as well would only make the
 * value longer.
 */

import type { NotifiableEvent } from './event'

/** How long a key may be before it stops being readable. Not a schema limit. */
const MAX_LENGTH = 400

export interface DedupeParts {
  event: NotifiableEvent
  recipientUserId: string
  /** `0` for the original notification. See the header. */
  escalationLevel?: number
}

export function notificationDedupeKey({
  event,
  recipientUserId,
  escalationLevel = 0,
}: DedupeParts): string {
  const key = [
    event.name,
    `${event.resourceType}:${event.resourceId}`,
    event.idempotencyKey,
    `u:${recipientUserId}`,
    `l:${escalationLevel}`,
  ].join('·')

  // Truncating would destroy uniqueness silently, so the long part is dropped
  // from the FRONT — the readable prefix — and never from the identity that
  // follows it. In practice this never fires: it exists so that a module
  // raising an event with a pathological resource id degrades into an ugly key
  // rather than into a collision.
  if (key.length <= MAX_LENGTH) return key

  return [
    event.name,
    event.idempotencyKey,
    `u:${recipientUserId}`,
    `l:${escalationLevel}`,
  ].join('·')
}

/**
 * Would these two produce the same notification?
 *
 * Used by the tests and by the in-memory repository. Not used to decide
 * anything in production — the database decides, for the reason above.
 */
export function isSameNotification(a: string, b: string): boolean {
  return a === b
}
