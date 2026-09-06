/**
 * Everything Autopilot is allowed to do, and what each one costs if it is
 * wrong.
 *
 * ── This is a catalogue, not a capability ─────────────────────────────────
 *
 * Nothing here performs anything. Each entry declares four facts about one
 * action — the grant a person would have needed to do it by hand, the harm it
 * can do, the module it depends on, and the domain command that actually does
 * the work — and the engine reads those four to decide whether it may proceed.
 *
 * The point of the shape is that adding an action is a decision somebody has
 * to make in public. A new entry cannot be added without naming its safety
 * level, and naming a safety level is exactly the moment to notice that
 * "send the guest their door code" is not the same kind of thing as
 * "open a task for the cleaner".
 *
 * ── `command` is what keeps this from becoming a second product ───────────
 *
 * Every action names a domain command — the same `defineOperation` a person's
 * click calls. Autopilot writes no business table directly, so validation,
 * permissions, audit, events and invariants happen exactly as they do for a
 * human, and "Autopilot did it" and "Dana did it" are the same kind of record
 * with a different actor. An action whose `command` is `null` is one that ends
 * inside Autopilot itself — raising an exception, composing a brief — and
 * those are the only ones with no command, deliberately and visibly.
 *
 * ── `requires` is why Autopilot never talks about a module you do not have ─
 *
 * A business with inventory switched off must never be told to "reserve six
 * towels from stock", because there is no stock. It should be told that the
 * preparation needs six more towels, which is true regardless. So an action
 * declares the entitlement it needs, the engine drops it when the module is
 * absent, and the surrounding language is chosen per action rather than
 * patched afterwards with a conditional in a template.
 *
 * ── The safety level is a floor, not a preference ─────────────────────────
 *
 * `autopilot_safety_rules` in 0046 caps `business_impact` and
 * `money_access_cancellation` at `ask_approval` for every customer on every
 * package, and the table is not writable by any tenant role. A customer can
 * make an action *less* automatic than this catalogue allows and can never
 * make it more.
 */

import type { Grant } from '../authz/permissions'
import type { Entitlement } from '../plans/entitlements'
import type { ActionSafetyLevel, AutopilotDomain } from '../contracts/states'

/* ------------------------------------------------------------ the list -- */

/**
 * The closed vocabulary of action kinds.
 *
 * Named `<subject>.<verb>` and constrained to that shape by
 * `autopilot_policies_action_kind_shape` in the database, so a policy row can
 * never name something outside this file's naming convention even if it
 * escapes the type.
 */
export const AUTOPILOT_ACTION_KINDS = [
  // ── Information. Says something, changes nothing. ───────────────────────
  'brief.compose',
  'exception.raise',
  'readiness.explain',

  // ── Safe internal. Reversible, and invisible outside the business. ──────
  'task.create',
  'task.assign',
  'preparation.generate',
  'workplan.publish',
  'stock_count.request',
  'laundry.draft_order',
  'hold.release_expired',
  'inventory.flag_shortage',
  'maintenance.raise_priority',

  // ── External communication. Somebody outside reads it. ──────────────────
  'guest.send_reminder',
  'guest.send_arrival_info',
  'guest.request_review',
  'cleaner.notify',
  'cleaner.escalate',
  'laundry.send_order',
  'laundry.request_earlier',
  'provider.chase',
  'agent.remind',
  'team.notify',

  // ── Business impact. Changes what the business offers or promises. ──────
  'price.suggest',
  'upsell.offer',
  'opportunity.publish',
  'booking.suggest_extension',
  'inventory.suggest_transfer',
  'procurement.draft',

  // ── Money, access, cancellation. Never automatic. ───────────────────────
  'payment.request',
  'access.issue_code',
  'access.revoke_code',
  'booking.cancel',
  'payment.refund',
] as const

export type AutopilotActionKind = (typeof AUTOPILOT_ACTION_KINDS)[number]

/* ------------------------------------------------------- the four facts -- */

export interface AutopilotActionSpec {
  kind: AutopilotActionKind
  /** What this belongs to, for triage order. */
  domain: AutopilotDomain
  /** The grant a person would have needed to do this by hand. */
  grant: Grant
  /**
   * Further grants the WRITE needs, beyond the one that names the action.
   *
   * Two actions land in a table whose RLS insert policy checks a different
   * permission from the one the action is about: asking somebody to count
   * stock opens a task, and drafting a purchase raises an approval. An actor
   * holding only `inventory.adjust` or `expense.create` passes every
   * application check and is then refused by Postgres as a bare SQLSTATE —
   * Autopilot planning work it cannot perform, and failing at the least
   * legible possible moment.
   *
   * Found by the agent that built those two commands, which asserts both in
   * its own `rule()` as well, so the refusal happens in the domain with a
   * sentence rather than at the database with an error code.
   */
  alsoRequires?: readonly Grant[]
  /** How much harm a wrong one does. */
  safety: ActionSafetyLevel
  /**
   * The module this needs. `null` means core — every customer has it.
   * An action whose entitlement the organization lacks is never planned, never
   * suggested, and never mentioned in prose.
   */
  requires: Entitlement | null
  /**
   * The domain command that does the work. `null` means the action completes
   * inside Autopilot and touches no business table — the only honest reason
   * for a command-less action.
   */
  command: string | null
  /** Hebrew, for the screens and for the reason line. */
  label: string
}

/**
 * The catalogue.
 *
 * Ordered by safety level so that reading it top to bottom is reading the
 * escalation of consequence, which is the order somebody reviewing it cares
 * about.
 */
export const AUTOPILOT_ACTIONS: Readonly<
  Record<AutopilotActionKind, AutopilotActionSpec>
> = {
  /* ── information ─────────────────────────────────────────────────────── */

  'brief.compose': {
    kind: 'brief.compose',
    domain: 'optimization',
    grant: 'autopilot.view',
    safety: 'information',
    requires: null,
    command: null,
    label: 'חיבור סיכום יומי',
  },
  'exception.raise': {
    kind: 'exception.raise',
    domain: 'safety',
    grant: 'autopilot.use',
    safety: 'information',
    requires: null,
    command: null,
    label: 'העלאת חריגה',
  },
  'readiness.explain': {
    kind: 'readiness.explain',
    domain: 'preparation',
    grant: 'autopilot.view',
    safety: 'information',
    requires: null,
    command: null,
    label: 'הסבר מוכנות',
  },

  /* ── safe internal ───────────────────────────────────────────────────── */

  'task.create': {
    kind: 'task.create',
    domain: 'preparation',
    grant: 'task.create',
    safety: 'safe_internal',
    requires: 'operations',
    command: 'tasks.createTask',
    label: 'פתיחת משימה',
  },
  'task.assign': {
    kind: 'task.assign',
    domain: 'staff',
    grant: 'task.assign',
    safety: 'safe_internal',
    requires: 'operations',
    command: 'tasks.assignTask',
    label: 'שיוך משימה',
  },
  'preparation.generate': {
    kind: 'preparation.generate',
    domain: 'preparation',
    grant: 'task.create',
    safety: 'safe_internal',
    requires: 'operations',
    command: 'preparation.generateRequirements',
    label: 'חישוב דרישות הכנה',
  },
  'workplan.publish': {
    kind: 'workplan.publish',
    domain: 'preparation',
    grant: 'task.update',
    safety: 'safe_internal',
    requires: 'operations',
    command: 'preparation.publishWorkPlan',
    label: 'פרסום תוכנית עבודה',
  },
  'stock_count.request': {
    kind: 'stock_count.request',
    domain: 'inventory',
    grant: 'inventory.adjust',
    // The request is an errand, and an errand is a task.
    alsoRequires: ['task.create'],
    safety: 'safe_internal',
    requires: 'operations',
    command: 'inventory.requestCount',
    label: 'בקשת ספירת מלאי',
  },
  'laundry.draft_order': {
    kind: 'laundry.draft_order',
    domain: 'laundry',
    grant: 'laundry.order_create',
    safety: 'safe_internal',
    requires: 'laundry',
    command: 'laundry.draftOrder',
    label: 'הכנת הזמנת כביסה',
  },
  // Releasing a hold that has ALREADY expired is safe_internal rather than
  // business_impact, and the distinction is the whole argument: the canonical
  // expiry policy decided this hold is over. Autopilot is applying a decision
  // the business already made, not making a commercial one. Releasing a hold
  // that has NOT expired is a different action and is not in this catalogue.
  'hold.release_expired': {
    kind: 'hold.release_expired',
    domain: 'sales_opportunity',
    grant: 'hold.release',
    safety: 'safe_internal',
    requires: 'agent_network',
    command: 'holds.releaseExpired',
    label: 'שחרור שריון שפג',
  },
  'inventory.flag_shortage': {
    kind: 'inventory.flag_shortage',
    domain: 'inventory',
    grant: 'inventory.view',
    safety: 'safe_internal',
    requires: 'operations',
    command: null,
    label: 'סימון חוסר צפוי',
  },
  'maintenance.raise_priority': {
    kind: 'maintenance.raise_priority',
    domain: 'maintenance',
    grant: 'task.update',
    safety: 'safe_internal',
    requires: 'operations',
    command: 'tasks.changePriority',
    label: 'העלאת דחיפות תקלה',
  },

  /* ── external communication ──────────────────────────────────────────── */

  'guest.send_reminder': {
    kind: 'guest.send_reminder',
    domain: 'payment_risk',
    grant: 'message.send',
    safety: 'external_communication',
    requires: null,
    command: 'messaging.sendGuestMessage',
    label: 'תזכורת לאורח',
  },
  'guest.send_arrival_info': {
    kind: 'guest.send_arrival_info',
    domain: 'guest_access',
    grant: 'message.send',
    safety: 'external_communication',
    requires: null,
    command: 'messaging.sendGuestMessage',
    label: 'שליחת פרטי הגעה',
  },
  'guest.request_review': {
    kind: 'guest.request_review',
    domain: 'optimization',
    grant: 'message.send',
    safety: 'external_communication',
    requires: null,
    command: 'messaging.sendGuestMessage',
    label: 'בקשת חוות דעת',
  },
  'cleaner.notify': {
    kind: 'cleaner.notify',
    domain: 'staff',
    grant: 'task.assign',
    safety: 'external_communication',
    requires: 'operations',
    command: 'messaging.notifyAssignee',
    label: 'הודעה למנקה',
  },
  'cleaner.escalate': {
    kind: 'cleaner.escalate',
    domain: 'staff',
    grant: 'task.assign',
    safety: 'external_communication',
    requires: 'operations',
    command: 'messaging.notifyAssignee',
    label: 'הסלמה על איחור ניקיון',
  },
  'laundry.send_order': {
    kind: 'laundry.send_order',
    domain: 'laundry',
    grant: 'laundry.order_send',
    safety: 'external_communication',
    requires: 'laundry',
    command: 'laundry.sendOrder',
    label: 'שליחת הזמנה למכבסה',
  },
  'laundry.request_earlier': {
    kind: 'laundry.request_earlier',
    domain: 'laundry',
    grant: 'laundry.order_send',
    safety: 'external_communication',
    requires: 'laundry',
    command: 'laundry.requestEarlierDelivery',
    label: 'בקשת הקדמת אספקה',
  },
  'provider.chase': {
    kind: 'provider.chase',
    domain: 'sales_opportunity',
    grant: 'provider.manage',
    safety: 'external_communication',
    requires: 'commerce',
    command: 'store.chaseProvider',
    label: 'תזכורת לספק',
  },
  'agent.remind': {
    kind: 'agent.remind',
    domain: 'sales_opportunity',
    grant: 'agent.manage',
    safety: 'external_communication',
    requires: 'agent_network',
    command: 'agents.sendReminder',
    label: 'תזכורת לסוכן',
  },
  'team.notify': {
    kind: 'team.notify',
    domain: 'staff',
    grant: 'notification.preferences.manage',
    safety: 'external_communication',
    requires: null,
    command: 'notifications.notifyTeam',
    label: 'התראה לצוות',
  },

  /* ── business impact ─────────────────────────────────────────────────── */

  'price.suggest': {
    kind: 'price.suggest',
    domain: 'optimization',
    grant: 'pricing.manage',
    safety: 'business_impact',
    requires: 'dynamic_pricing',
    command: null,
    label: 'הצעת מחיר',
  },
  'upsell.offer': {
    kind: 'upsell.offer',
    domain: 'sales_opportunity',
    grant: 'order.manage',
    safety: 'business_impact',
    requires: 'commerce',
    command: 'store.offerUpsell',
    label: 'הצעת שדרוג',
  },
  'opportunity.publish': {
    kind: 'opportunity.publish',
    domain: 'sales_opportunity',
    grant: 'agent.manage',
    safety: 'business_impact',
    requires: 'agent_network',
    command: 'agents.publishOpportunity',
    label: 'פרסום הזדמנות לסוכנים',
  },
  'booking.suggest_extension': {
    kind: 'booking.suggest_extension',
    domain: 'sales_opportunity',
    grant: 'booking.amend_dates',
    safety: 'business_impact',
    requires: null,
    command: null,
    label: 'הצעת הארכת שהייה',
  },
  'inventory.suggest_transfer': {
    kind: 'inventory.suggest_transfer',
    domain: 'inventory',
    grant: 'inventory.transfer',
    safety: 'business_impact',
    requires: 'operations',
    command: 'inventory.transfer',
    label: 'הצעת העברת מלאי',
  },
  'procurement.draft': {
    kind: 'procurement.draft',
    domain: 'inventory',
    grant: 'expense.create',
    // A draft purchase is an approval somebody else has to decide, and
    // approvals_no_self_approval in 0011 means Autopilot cannot decide its own.
    alsoRequires: ['approval.request'],
    safety: 'business_impact',
    requires: 'operations',
    command: 'inventory.draftProcurement',
    label: 'טיוטת רכש',
  },

  /* ── money, access, cancellation ─────────────────────────────────────── */

  'payment.request': {
    kind: 'payment.request',
    domain: 'payment_risk',
    grant: 'payment.request_link',
    safety: 'money_access_cancellation',
    requires: 'payments',
    command: 'payments.requestPayment',
    label: 'בקשת תשלום',
  },
  'access.issue_code': {
    kind: 'access.issue_code',
    domain: 'guest_access',
    grant: 'booking.update',
    safety: 'money_access_cancellation',
    requires: null,
    command: 'access.issueCode',
    label: 'הנפקת קוד כניסה',
  },
  'access.revoke_code': {
    kind: 'access.revoke_code',
    domain: 'guest_access',
    grant: 'booking.update',
    safety: 'money_access_cancellation',
    requires: null,
    command: 'access.revokeCode',
    label: 'ביטול קוד כניסה',
  },
  'booking.cancel': {
    kind: 'booking.cancel',
    domain: 'safety',
    grant: 'booking.cancel',
    safety: 'money_access_cancellation',
    requires: null,
    command: 'bookings.cancelBooking',
    label: 'ביטול הזמנה',
  },
  'payment.refund': {
    kind: 'payment.refund',
    domain: 'payment_risk',
    grant: 'payment.refund',
    safety: 'money_access_cancellation',
    requires: 'payments',
    command: 'payments.refund',
    label: 'החזר כספי',
  },
}

/* ------------------------------------------------------------ helpers --- */

/** Runtime membership, for a kind arriving as text from the database. */
export function isAutopilotActionKind(
  value: string,
): value is AutopilotActionKind {
  return value in AUTOPILOT_ACTIONS
}

/**
 * The spec, or `null` for a kind that is not in the catalogue.
 *
 * Returns rather than throws: a policy row naming an action kind that has
 * since been removed is a stale row, not a crash, and the screen should say
 * so rather than fail to render.
 */
export function actionSpec(kind: string): AutopilotActionSpec | null {
  return isAutopilotActionKind(kind) ? AUTOPILOT_ACTIONS[kind] : null
}

/** Every action in one domain, for the triage pass. */
export function actionsInDomain(
  domain: AutopilotDomain,
): readonly AutopilotActionSpec[] {
  return Object.values(AUTOPILOT_ACTIONS).filter(
    (spec) => spec.domain === domain,
  )
}
