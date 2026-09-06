/**
 * The automation vocabulary: WHEN · IF · THEN.
 *
 * An automation is one sentence with three clauses and no fourth. WHEN names a
 * domain event, IF narrows it to the cases worth acting on, and THEN is the
 * work that happens. Anything that cannot be said in that shape is a program,
 * not an automation, and the moment this file grows a loop or a branch the
 * product has quietly acquired a scripting language nobody can audit.
 *
 * ── WHEN is not a string ──────────────────────────────────────────────────
 *
 * `when` is a `DomainEventName` — a member of the frozen catalogue in
 * `src/lib/contracts/events.ts` — and deliberately not a template literal type
 * such as `${string}.${string}`. A permissive event type would compile happily
 * against `'booking.confirmedd'` and against `'booking.almost_confirmed'`,
 * which is an automation that silently never runs: the customer configured it,
 * the screen showed it as active, and nothing ever fired. The catalogue is the
 * union, the union is closed, and a trigger the product needs and the catalogue
 * lacks is a proposal to the coordinator rather than a widening here.
 *
 * ── IF is data, and an unknown fact is not a true one ─────────────────────
 *
 * Conditions are compared against a flat record of facts extracted from the
 * event. A field the event did not carry evaluates to **unmet**, never to
 * "vacuously true": an automation that refunds a deposit when
 * `damage_reported = false` must not fire because nobody said anything about
 * damage. Fail closed, and the engine says which fact was missing so the
 * silence is diagnosable.
 *
 * ── THEN is a closed catalogue, and every action names its permission ─────
 *
 * The action a rule performs is one of a fixed set, and each one declares the
 * `Grant` a human would have needed to do it by hand. An automation is not a
 * way around the authorization engine: it runs under an actor, and an action
 * whose grant that actor does not hold is refused exactly as a click would be.
 */

import type { DomainEventName } from '../contracts/events'
import type { Grant } from '../authz/permissions'
import type { Entitlement } from '../plans/entitlements'

/* ------------------------------------------------------------------ IF --- */

/** A value an event fact can hold. Flat on purpose — see the header. */
export type FactValue = string | number | boolean | null

/**
 * Facts about one event, flattened for comparison.
 *
 * Built by the caller from the event payload rather than read out of it by
 * path, so the engine never walks an arbitrary object graph and a rule can
 * never reach into a nested structure the product did not mean to expose.
 */
export type AutomationFacts = Readonly<Record<string, FactValue>>

export type AutomationCondition =
  | { kind: 'equals'; field: string; value: FactValue }
  | { kind: 'not_equals'; field: string; value: FactValue }
  | { kind: 'greater_than'; field: string; value: number }
  | { kind: 'at_least'; field: string; value: number }
  | { kind: 'less_than'; field: string; value: number }
  | { kind: 'at_most'; field: string; value: number }
  | { kind: 'one_of'; field: string; values: readonly FactValue[] }
  | { kind: 'is_present'; field: string }
  | { kind: 'is_absent'; field: string }

/* ---------------------------------------------------------------- THEN --- */

/**
 * Everything an automation is allowed to do.
 *
 * Closed, and short. Each entry is a thing the product already does through a
 * screen, which is what makes "the automation did it" and "somebody did it"
 * the same kind of event in the audit trail rather than two parallel worlds.
 */
export const AUTOMATION_ACTION_KINDS = [
  'notify_team',
  'message_guest',
  'create_task',
  'request_approval',
  'send_payment_link',
  'issue_invoice',
  'request_review',
  'block_availability',
] as const

export type AutomationActionKind = (typeof AUTOMATION_ACTION_KINDS)[number]

/**
 * What an action needs before it may run.
 *
 * `requires` is the grant a person would have needed. The package feature is
 * read from `ENTITLEMENT_FOR_GRANT` at check time rather than copied here, so
 * the plan answer cannot drift from the catalogue's.
 */
export interface AutomationActionMeta {
  kind: AutomationActionKind
  /** Hebrew. Shown on the rule card as the THEN clause. */
  label: string
  requires: Grant
}

export const AUTOMATION_ACTIONS: Readonly<
  Record<AutomationActionKind, AutomationActionMeta>
> = {
  notify_team: {
    kind: 'notify_team',
    label: 'שליחת התראה לצוות',
    requires: 'message.send',
  },
  message_guest: {
    kind: 'message_guest',
    label: 'שליחת הודעה לאורח',
    requires: 'message.send',
  },
  create_task: {
    kind: 'create_task',
    label: 'פתיחת משימה',
    requires: 'task.create',
  },
  request_approval: {
    kind: 'request_approval',
    label: 'בקשת אישור',
    requires: 'approval.request',
  },
  send_payment_link: {
    kind: 'send_payment_link',
    label: 'שליחת קישור לתשלום',
    requires: 'payment.request_link',
  },
  issue_invoice: {
    kind: 'issue_invoice',
    label: 'הפקת חשבונית',
    requires: 'invoice.issue',
  },
  request_review: {
    kind: 'request_review',
    label: 'בקשת חוות דעת',
    requires: 'message.send',
  },
  block_availability: {
    kind: 'block_availability',
    label: 'חסימת זמינות',
    requires: 'hold.create',
  },
}

/** Every grant the action catalogue can demand. Used by the screens. */
export function actionGrant(kind: AutomationActionKind): Grant {
  return AUTOMATION_ACTIONS[kind].requires
}

/**
 * Actions somebody outside the business would notice.
 *
 * `library.ts` states the dividing line in prose — anything that speaks to a
 * guest, spends money or issues a document ships **off**, anything that tells
 * the business's own staff something ships **on** — and until now that was a
 * sentence a human had to apply by hand to each new template. It is a
 * predicate now, so a template that messages a guest and ships enabled is a
 * failing test rather than an apology.
 *
 * `request_approval` is deliberately NOT here: an approval request goes to a
 * colleague, and a redundant one costs a click. `block_availability` is,
 * because a date that stops being sellable is visible to every channel the
 * business sells through.
 */
export const EXTERNALLY_VISIBLE_ACTIONS: ReadonlySet<AutomationActionKind> =
  new Set<AutomationActionKind>([
    'message_guest',
    'request_review',
    'send_payment_link',
    'issue_invoice',
    'block_availability',
  ])

/** Would switching this rule on be noticed outside the business? */
export function reachesOutsideTheBusiness(rule: {
  actions: readonly AutomationAction[]
}): boolean {
  return rule.actions.some((action) =>
    EXTERNALLY_VISIBLE_ACTIONS.has(action.kind),
  )
}

/**
 * One THEN clause.
 *
 * `note` is Hebrew and is what the audit summary says happened. It is required:
 * an audit line reading "automation ran action create_task" tells a manager
 * nothing, and `recordAuditEvent` refuses a summary that merely repeats the
 * action anyway.
 */
export interface AutomationAction {
  kind: AutomationActionKind
  note: string
}

/* ---------------------------------------------------------------- rule --- */

export interface AutomationRule {
  id: string
  /** Hebrew. Names the rule in the timeline and on the card. */
  name: string
  description: string
  /** WHEN. A member of the frozen catalogue and nothing else. */
  when: DomainEventName
  /** IF. Empty means "every occurrence of this event", said deliberately. */
  conditions: readonly AutomationCondition[]
  /** THEN. At least one; a rule with no action is not a rule. */
  actions: readonly [AutomationAction, ...AutomationAction[]]
  /**
   * Off by default for anything that spends money or speaks to a guest.
   *
   * A library entry is a suggestion, not a running rule, and the difference
   * matters: shipping an enabled "message the guest" rule would have ESTIA
   * writing to somebody's customers the day they signed up.
   */
  enabled: boolean
}

/**
 * The plan feature a whole rule needs, beyond its actions.
 *
 * Automation itself is gated — `automation.view` and `automation.manage` are
 * mapped to the `automation` entitlement — so this is not per rule. It is
 * stated here as a constant so the screens and the engine name the same one.
 */
export const AUTOMATION_ENTITLEMENT: Entitlement = 'automation'
