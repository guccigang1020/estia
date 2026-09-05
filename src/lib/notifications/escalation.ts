/**
 * When nobody acts, tell somebody else.
 *
 * ── The reason this exists at all ─────────────────────────────────────────
 *
 * A payment whose outcome is unknown, raised at 02:00 to a reception clerk who
 * is asleep, must reach the manager by 02:30 rather than be found at nine.
 * Without escalation the routing engine's guarantee is only "the right person
 * was told" — and the right person being asleep is the ordinary case, not the
 * exception, in a business that runs overnight.
 *
 * ── `actedAt`, never `readAt` ─────────────────────────────────────────────
 *
 * This is the single most important line in the file. Escalation asks whether
 * anybody DID anything. Somebody opening a bell panel at 02:04 and going back
 * to sleep has read the notification and has not reconciled the payment, and a
 * rule that escalated on `readAt` would fall silent at exactly the moment it
 * was most needed. 0043 keeps the two columns apart for this reason and says so
 * in the column comment.
 *
 * ── A rule names a ROLE, never a person ───────────────────────────────────
 *
 * Naming a person is how an escalation path dies quietly the month they leave,
 * and nobody discovers it until the night it was supposed to fire. The role is
 * resolved to people at sweep time, by the caller, through the ordinary
 * membership path — so somebody joining the role inherits the path and
 * somebody leaving it stops being paged for a business they left.
 *
 * ── This module decides. It does not sweep. ───────────────────────────────
 *
 * `escalationsDue` is a pure function of (notifications, rules, settings,
 * now). There is no timer here and no job runner: whatever calls it — a cron
 * route, a queue worker, a request that happens to pass by — supplies the
 * unacted rows and the clock. That is what makes every rule below testable
 * against a table of inputs, and it is why the module has no scheduler
 * dependency to be missing in production.
 */

import { specFor } from './catalogue'
import {
  severityAtLeast,
  type EscalationRule,
  type NotificationRecord,
  type NotificationSettings,
} from './types'

export interface EscalationDue {
  notification: NotificationRecord
  rule: EscalationRule
  /** The level the raised copy will carry. Always `notification.level + 1`. */
  nextLevel: number
  /** Whom to raise it to. Resolved to people by the caller. */
  roleCode: string
  /** The interval that actually applied, after the settings fallback. */
  afterMinutes: number
}

const MINUTE = 60_000

/**
 * Which unacted notifications are now overdue, and under which rule.
 *
 * Ordered by how long they have been waiting, longest first — so a sweep that
 * can only process part of its batch processes the oldest neglect rather than
 * the newest.
 */
export function escalationsDue(args: {
  notifications: readonly NotificationRecord[]
  rules: readonly EscalationRule[]
  settings: Pick<NotificationSettings, 'defaultEscalationMinutes'>
  now: Date
}): readonly EscalationDue[] {
  const { notifications, rules, settings, now } = args
  const active = rules.filter((rule) => rule.enabled)

  const due: EscalationDue[] = []

  for (const notification of notifications) {
    if (notification.actedAt !== null) continue
    if (notification.dismissedAt !== null) continue

    // The catalogue decides whether an event is escalatable at all. A rule
    // matching `booking.created` would otherwise page a manager about an
    // ordinary reservation nobody was ever asked to act on.
    const spec = specFor(notification.eventName)
    if (!spec?.escalates) continue

    const rule = bestRuleFor(notification, active)
    if (!rule) continue

    const nextLevel = notification.escalationLevel + 1
    if (nextLevel > rule.maxLevel) continue

    const afterMinutes = rule.afterMinutes ?? settings.defaultEscalationMinutes
    const waited = (now.getTime() - notification.occurredAt.getTime()) / MINUTE
    // Each level waits the interval again: level 1 at 30 minutes, level 2 at
    // 60. A ladder that fired every level at the same threshold would page
    // three people simultaneously and teach all three to ignore it.
    if (waited < afterMinutes * nextLevel) continue

    due.push({
      notification,
      rule,
      nextLevel,
      roleCode: rule.escalateToRoleCode,
      afterMinutes,
    })
  }

  return due.sort(
    (a, b) =>
      a.notification.occurredAt.getTime() - b.notification.occurredAt.getTime(),
  )
}

/**
 * The rule that governs this notification.
 *
 * Most specific wins, and "specific" has an order rather than a preference:
 *
 *   1. a rule naming this event beats a rule naming none;
 *   2. among equals, the shortest interval beats the longest — a business that
 *      wrote both "everything urgent after 30 minutes" and "payments after 5"
 *      meant the five, and reading it the other way would make the tighter
 *      rule they deliberately added do nothing at all.
 *
 * Deliberately returns ONE rule rather than every match. Two matching rules
 * escalating the same notification twice is two people paged for one problem,
 * which is how a business learns that the escalation is noise.
 */
function bestRuleFor(
  notification: NotificationRecord,
  rules: readonly EscalationRule[],
): EscalationRule | null {
  const matching = rules.filter(
    (rule) =>
      (rule.eventName === null || rule.eventName === notification.eventName) &&
      severityAtLeast(notification.severity, rule.minSeverity),
  )

  if (matching.length === 0) return null

  return matching.reduce((best, rule) => {
    const bestNamed = best.eventName !== null
    const ruleNamed = rule.eventName !== null
    if (ruleNamed !== bestNamed) return ruleNamed ? rule : best

    const bestAfter = best.afterMinutes ?? Number.POSITIVE_INFINITY
    const ruleAfter = rule.afterMinutes ?? Number.POSITIVE_INFINITY
    return ruleAfter < bestAfter ? rule : best
  })
}

/**
 * The default ladder a business gets before it writes any rules of its own.
 *
 * Not seeded into the database by 0043, deliberately: a row in
 * `notification_escalation_rules` is a business's own decision, and seeding one
 * would make "we never configured escalation" indistinguishable from "we chose
 * this". This is what the settings screen offers as a starting point, and it
 * becomes real only when somebody saves it.
 */
export const SUGGESTED_ESCALATION: Omit<
  EscalationRule,
  'id' | 'organizationId'
> = {
  eventName: null,
  minSeverity: 'urgent',
  afterMinutes: null,
  escalateToRoleCode: 'general_manager',
  maxLevel: 2,
  enabled: true,
}
