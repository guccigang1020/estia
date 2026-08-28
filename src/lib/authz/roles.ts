/**
 * System roles — the bundles of permissions ESTIA ships with.
 *
 * These are seeds, not a closed set. A customer can compose custom roles from
 * the same catalogue, and the engine cannot tell the difference: a role is only
 * ever a name attached to a set of grants.
 *
 * Two rules hold for every role defined here:
 *   1. Deny by default — a role grants exactly what it lists and nothing more.
 *   2. Privacy by minimum necessity — an operational role does not receive
 *      guest contact details or money, because its work does not need them.
 */

import { FIELD_PERMISSIONS, PERMISSIONS, type Grant } from './permissions'

export const SYSTEM_ROLES = [
  'organization_owner',
  'administrator',
  'general_manager',
  'property_manager',
  'reservation_manager',
  'reception',
  'revenue_manager',
  'finance_manager',
  'accountant',
  'operations_manager',
  'housekeeping_supervisor',
  'cleaner',
  'maintenance',
  'property_owner',
  'external_vendor',
  'marketing_editor',
  // The agent network. External sellers are members of the organization with a
  // deliberately narrow role and a narrow scope, decided by the same engine as
  // everybody else. The commercial agreement behind them is a contract, not an
  // authorization concept, and does not appear here.
  'referral_agent',
  'sales_agent',
  'senior_agent',
  'agency_manager',
] as const

export type SystemRole = (typeof SYSTEM_ROLES)[number]

/** Roles held by ESTIA's own staff. Never assignable inside a customer org. */
export const PLATFORM_ROLES = [
  'platform_super_admin',
  'platform_support',
] as const

export type PlatformRole = (typeof PLATFORM_ROLES)[number]

// ── Graduated access: the ladders ─────────────────────────────────────────

/**
 * Some access is a dial, not a switch.
 *
 * An owner deciding what an external seller may see does not want forty
 * checkboxes; they want to say "this one may quote, that one may book". Worse,
 * checkboxes permit combinations that are not opinions but mistakes — an agent
 * holding the net rate and not the public rate is nobody's intention, and yet
 * it is one misclick away.
 *
 * So the three questions that are genuinely ordered are modelled as ladders.
 * Choosing a rung grants that rung and every rung below it, which makes the
 * incoherent combinations unrepresentable rather than merely discouraged.
 *
 * The engine never learns about any of this. A ladder is resolved to a flat
 * set of grants here, and `can()` sees what it always sees.
 */

/** How much of the calendar an external seller reaches. */
export const CALENDAR_LEVELS = [
  'none',
  'availability',
  'availability_price',
  'availability_hold',
  'availability_booking',
] as const

export type CalendarLevel = (typeof CALENDAR_LEVELS)[number]

/** Which price an external seller is shown. */
export const PRICE_LEVELS = [
  'none',
  'public',
  'agent',
  'net',
  'net_commission',
] as const

export type PriceLevel = (typeof PRICE_LEVELS)[number]

/**
 * How much of the guest an external seller is shown.
 *
 * The ladder stops at the email deliberately. Identity documents, full payment
 * detail and internal notes are not rungs at all — they are off by default and
 * there is no level of the dial that turns them on for an external party.
 */
export const GUEST_DATA_LEVELS = ['none', 'name', 'phone', 'email'] as const

export type GuestDataLevel = (typeof GUEST_DATA_LEVELS)[number]

/** What each rung adds on top of the rung below it. */
const CALENDAR_RUNG: Record<CalendarLevel, readonly Grant[]> = {
  none: [],
  availability: ['availability.view'],
  // A quote is a price put in front of a customer, so it belongs to the rung
  // where prices become visible rather than to the booking rung.
  availability_price: [
    'rate.view_public',
    'quote.view',
    'quote.create',
    'quote.update',
    'quote.send',
  ],
  availability_hold: [
    'hold.view',
    'hold.create',
    'hold.release',
    'hold.extend',
  ],
  // Booking includes entering the guest's details, which is writing, not
  // reading: it grants nothing about guests already in the system. Correcting
  // those details afterwards is not here — it is an amendment right, granted
  // on its own, because fixing a spelling and moving the dates are different
  // decisions about the same booking.
  availability_booking: ['booking.view', 'booking.create', 'guest.create'],
}

const PRICE_RUNG: Record<PriceLevel, readonly Grant[]> = {
  none: [],
  public: ['rate.view_public'],
  agent: ['rate.view_agent'],
  net: ['rate.view_net'],
  // The top rung is the fully trusted agency: what the guest actually paid,
  // alongside the commission the agent already sees on their own records.
  net_commission: ['booking.view_price'],
}

const GUEST_DATA_RUNG: Record<GuestDataLevel, readonly Grant[]> = {
  none: [],
  name: ['guest.view_name'],
  phone: ['guest.view_phone'],
  email: ['guest.view_email'],
}

/** Every rung up to and including the chosen one. */
function cumulative<L extends string>(
  ladder: readonly L[],
  rungs: Record<L, readonly Grant[]>,
  level: L,
): readonly Grant[] {
  const top = ladder.indexOf(level)
  // Deny by default: an unrecognised level grants nothing rather than
  // everything, which is the failure mode that matters.
  if (top < 0) return []
  return ladder.slice(0, top + 1).flatMap((rung) => rungs[rung])
}

export function grantsForCalendarLevel(level: CalendarLevel): readonly Grant[] {
  return cumulative(CALENDAR_LEVELS, CALENDAR_RUNG, level)
}

export function grantsForPriceLevel(level: PriceLevel): readonly Grant[] {
  return cumulative(PRICE_LEVELS, PRICE_RUNG, level)
}

export function grantsForGuestDataLevel(
  level: GuestDataLevel,
): readonly Grant[] {
  return cumulative(GUEST_DATA_LEVELS, GUEST_DATA_RUNG, level)
}

/**
 * The amendment rights, which are deliberately *not* a ladder.
 *
 * No ordering between them is true. A business may happily let an agent move
 * dates and never let them touch the price, and the reverse is equally
 * sensible, so these stay independently grantable.
 *
 * Cancellation is listed with them in the specification but is not here: it
 * already exists as `booking.cancel`, and is granted role by role so that
 * widening the amendment set never quietly hands somebody the power to cancel.
 */
export const AMENDMENT_GRANTS: readonly Grant[] = [
  // "Edit guest details" in the specification. It is `guest.update` rather
  // than a new name for the same act, because a booking's guest is a guest.
  'guest.update',
  'booking.amend_guest_count',
  'booking.amend_extras',
  'booking.amend_dates',
  'booking.amend_price',
]

// ── Reusable bundles ──────────────────────────────────────────────────────

/** Free/busy is strictly less than the booking behind it, so it comes with it. */
const BOOKING_READ: Grant[] = [
  'booking.view',
  'availability.view',
  'guest.view',
  'property.view',
]

/**
 * Selling, as the business's own staff do it: hold a unit for a caller, send
 * them a quote, work the lead. None of this is part of the agent network — a
 * single-cabin owner on the cheapest package does all of it on the telephone —
 * so none of it is gated behind that feature.
 */
const SELLING_DESK: Grant[] = [
  'availability.view',
  'hold.view',
  'hold.create',
  'hold.release',
  'hold.extend',
  'quote.view',
  'quote.create',
  'quote.update',
  'quote.send',
  'lead.view',
  'lead.create',
  'lead.update',
  'rate.view_public',
  'payment.request_link',
]

const BOOKING_DESK: Grant[] = [
  ...BOOKING_READ,
  ...SELLING_DESK,
  'booking.create',
  'booking.update',
  ...AMENDMENT_GRANTS,
  'booking.change_status',
  'booking.assign',
  'booking.note.internal',
  'guest.create',
  'guest.view_name',
  'guest.view_phone',
  'guest.view_email',
  'booking.view_price',
  'booking.view_payment_status',
  'message.view',
  'message.send',
]

const OPERATIONS_CORE: Grant[] = [
  'task.view',
  'task.create',
  'task.assign',
  'task.update',
  'task.complete',
  'task.verify',
  'checklist.manage',
  'incident.view',
  'incident.create',
  'incident.update',
  'incident.resolve',
  'inventory.view',
  'inventory.edit',
]

const FINANCE_CORE: Grant[] = [
  'finance.view',
  'payment.view',
  'payment.create',
  'payment.request_link',
  'payment.capture',
  'payment.refund',
  'payment.void',
  'deposit.hold',
  'deposit.release',
  'expense.view',
  'expense.create',
  'expense.approve',
  'invoice.view',
  'invoice.issue',
  'report.financial.view',
  'report.financial.export',
  'booking.view_price',
  'booking.view_payment_status',
  'booking.view_deposit',
  'booking.view_profitability',
]

/**
 * What every external seller holds, whatever their preset.
 *
 * Their own pay and the leads they bring. Both are confined to their own
 * records by the membership's scope, not by a different permission: the same
 * `commission.view` serves a finance manager looking across the whole network
 * and an agent looking at one line, because the scope answers "whose".
 */
/**
 * Exported so the agent domain composes from this rather than keeping a copy.
 * Two lists that must agree are two lists that eventually will not.
 */
export const AGENT_BASE: Grant[] = [
  'lead.view',
  'lead.create',
  'commission.view',
  'agent_statement.view',
  /**
   * An agent must be able to ask.
   *
   * When a discount exceeds their cap the product raises an approval rather
   * than refusing. Without this grant that flow has nowhere to start, the
   * refusal is final, and the negotiation moves to WhatsApp — where the sale
   * leaves the system entirely.
   */
  'approval.request',
]

const MARKETING_CORE: Grant[] = [
  // Writes and designs, but does not publish. Publishing is a manager's
  // decision, and separating the two is what makes the approval flow real
  // rather than a convention people are asked to follow.
  'site.view',
  'site.edit_content',
  'site.edit_design',
  'site.manage_seo',
  'site.ai_generate',
  'review.view',
  'review.manage',
  'product.view',
  'property.view',
]

// ── Role definitions ──────────────────────────────────────────────────────

/**
 * Roles composed explicitly. `organization_owner` and `administrator` are
 * absent by design — they are derived from the catalogue below, so that a
 * permission added next year is covered by them automatically instead of
 * being silently missing until someone notices.
 */
type ComposedRole = Exclude<SystemRole, 'organization_owner' | 'administrator'>

const COMPOSED_ROLE_GRANTS: Record<ComposedRole, readonly Grant[]> = {
  general_manager: [
    ...BOOKING_DESK,
    ...OPERATIONS_CORE,
    'booking.override_price',
    'booking.override_availability',
    'booking.export',
    'booking.view_source',
    'guest.export',
    'property.create',
    'property.update',
    'unit.manage',
    'pricing.manage',
    'product.view',
    'product.manage',
    'order.view',
    'order.fulfil',
    'review.view',
    'review.manage',
    'user.view',
    'user.invite',
    'team.manage',
    'message.assign',
    'template.manage',
    'automation.view',
    'expense.view',
    'expense.create',
    'approval.request',
    // The agent network is a commercial relationship, and the GM owns it:
    // who sells, what inventory they see, and on what terms. They are
    // deliberately not given `commission.approve` or `commission.payout` —
    // whoever writes the commission rule does not also release the money.
    'agent.view',
    'agent.invite',
    'agent.manage',
    'agent.scope.manage',
    'agency.manage',
    'agent_agreement.view',
    'agent_agreement.manage',
    'agent_limits.manage',
    'agent_booking.approve',
    'agent.audit.view',
    'commission.view',
    'agent_statement.view',
    'report.agent.view',
    'lead.assign',
    'rate.view_agent',
    'rate.view_net',
  ],

  /** Same operational reach as a GM, but confined to assigned properties. */
  property_manager: [
    ...BOOKING_DESK,
    ...OPERATIONS_CORE,
    'booking.export',
    'booking.view_source',
    'unit.manage',
    // Approves the agent bookings that land on their property, and sees who
    // sold them and at what rate. Not who the agents are commercially.
    'agent.view',
    'agent_booking.approve',
    'lead.assign',
    'rate.view_agent',
    'property.update',
    'product.view',
    'order.view',
    'order.fulfil',
    'review.view',
    'user.view',
    'message.assign',
    'expense.view',
    'expense.create',
    'approval.request',
  ],

  reservation_manager: [
    ...BOOKING_DESK,
    'booking.override_price',
    'booking.override_availability',
    'booking.export',
    'booking.view_source',
    'booking.view_deposit',
    'payment.view',
    'payment.create',
    'invoice.view',
    'template.manage',
    'approval.request',
    // The desk that receives what the agents sell.
    'agent.view',
    'agent_booking.approve',
    'lead.assign',
    'rate.view_agent',
  ],

  /**
   * The front desk. Handles people in the building, and is deliberately not
   * given business profitability or export.
   */
  reception: [
    ...BOOKING_READ,
    ...SELLING_DESK,
    'booking.update',
    ...AMENDMENT_GRANTS,
    'booking.change_status',
    'booking.note.internal',
    'guest.create',
    'guest.view_name',
    'guest.view_phone',
    'guest.view_email',
    'booking.view_price',
    'booking.view_payment_status',
    'booking.view_deposit',
    'message.view',
    'message.send',
    'task.view',
    'task.create',
    'incident.create',
    'payment.view',
    'payment.create',
    'order.view',
    'order.fulfil',
  ],

  revenue_manager: [
    ...BOOKING_READ,
    'booking.view_price',
    'booking.view_source',
    'pricing.manage',
    'booking.override_price',
    'channel.manage',
    'report.financial.view',
    'unit.manage',
    // Prices the agent network sells at are prices, and this is the role that
    // sets them. It also owns the ceilings an agent may discount within.
    'rate.view_public',
    'rate.view_agent',
    'rate.view_net',
    'agent_limits.manage',
    'report.agent.view',
  ],

  finance_manager: [
    ...BOOKING_READ,
    ...FINANCE_CORE,
    'guest.view_name',
    'guest.view_phone',
    'guest.view_email',
    'owner.view',
    'owner_statement.view',
    'owner_statement.issue',
    'owner.view_commission',
    'approval.decide',
    'booking.export',
    // Approves and pays the commission, and may read the agreement it is
    // computed from — but cannot write that agreement. The person who sets
    // the rate is never the person who releases the money.
    'commission.view',
    'commission.approve',
    'commission.payout',
    'agent_agreement.view',
    'agent_statement.view',
    'agent_statement.issue',
    'report.agent.view',
    'rate.view_public',
    'rate.view_agent',
    'rate.view_net',
  ],

  /** Read and export. Never alters an operational record. */
  accountant: [
    'finance.view',
    'payment.view',
    'expense.view',
    'invoice.view',
    'report.financial.view',
    'report.financial.export',
    'booking.view',
    'booking.view_price',
    'property.view',
    'owner_statement.view',
    // Reads what the network cost, and approves none of it.
    'commission.view',
    'agent_statement.view',
  ],

  operations_manager: [
    ...OPERATIONS_CORE,
    ...BOOKING_READ,
    'task.assign',
    'user.view',
    'team.manage',
    'expense.view',
    'expense.create',
    'approval.request',
  ],

  housekeeping_supervisor: [
    'task.view',
    'task.create',
    'task.assign',
    'task.update',
    'task.complete',
    'task.verify',
    'checklist.manage',
    'incident.view',
    'incident.create',
    'incident.update',
    'inventory.view',
    'inventory.edit',
    'user.view',
    'property.view',
    'booking.view',
  ],

  /**
   * Mobile, task-first, and the sharpest test of the privacy model: a cleaner
   * sees which unit and when, and never a phone number or a price.
   */
  cleaner: ['task.view', 'task.update', 'task.complete', 'incident.create'],

  maintenance: [
    'task.view',
    'task.update',
    'task.complete',
    'incident.view',
    'incident.create',
    'incident.update',
    'inventory.view',
  ],

  /** External owner of a managed property. Sees their asset, nothing else. */
  property_owner: [
    'property.view',
    'booking.view',
    'owner_statement.view',
    'report.financial.view',
  ],

  /** A contractor holding a single job. Not a member of the business. */
  external_vendor: ['task.view', 'task.update', 'task.complete'],

  marketing_editor: MARKETING_CORE,

  // ── The agent network ───────────────────────────────────────────────────
  //
  // Four presets, so that an owner chooses a person rather than forty
  // toggles. They are seeds like every other role here: a customer may copy
  // one and edit it, and the engine will not know the difference.
  //
  // Each is a position on the three ladders plus whatever that preset adds.
  // Where a preset stands on a ladder is the whole design, so it is written
  // as a level and not as a hand-copied list of grants that could drift.

  /**
   * Brings a lead and is paid if it closes. Never sees the calendar — not the
   * dates, not a price, not a guest. The commission and statement they do see
   * are their own pay, confined to their own records by the membership scope.
   */
  referral_agent: [
    ...AGENT_BASE,
    ...grantsForCalendarLevel('none'),
    ...grantsForPriceLevel('none'),
    ...grantsForGuestDataLevel('none'),
  ],

  /**
   * The main model. Sees what is free, quotes it, holds it, books it — and
   * still sees no guest, no amount paid and no booking source, because none of
   * those are needed to sell a night that is free.
   */
  sales_agent: [
    ...AGENT_BASE,
    ...grantsForCalendarLevel('availability_booking'),
    ...grantsForPriceLevel('agent'),
    ...grantsForGuestDataLevel('none'),
    'lead.update',
  ],

  /**
   * A sales agent trusted with the booking after it exists: amendments within
   * the limits set for them, a discount up to their cap, and a payment link.
   * Exceeding the cap is not a refusal — it raises an approval request, which
   * is policy in the service layer, not a grant here.
   */
  senior_agent: [
    ...AGENT_BASE,
    ...grantsForCalendarLevel('availability_booking'),
    ...grantsForPriceLevel('agent'),
    ...grantsForGuestDataLevel('none'),
    'lead.update',
    ...AMENDMENT_GRANTS,
    'booking.cancel',
    'booking.view_payment_status',
    'payment.request_link',
  ],

  /**
   * The authorised agency: the broadest preset, and still narrow. It adds the
   * net rate, the agency's own agreement, and the running of the agents
   * underneath it — never the creation of another agency, never the setting of
   * an agent's inventory scope, and never the release of money.
   */
  agency_manager: [
    ...AGENT_BASE,
    ...grantsForCalendarLevel('availability_booking'),
    ...grantsForPriceLevel('net'),
    ...grantsForGuestDataLevel('phone'),
    'lead.update',
    'lead.assign',
    ...AMENDMENT_GRANTS,
    'booking.cancel',
    'booking.view_payment_status',
    'payment.request_link',
    'agent.view',
    'agent.invite',
    'agent_agreement.view',
    'report.agent.view',
  ],
}

// ── Derived roles ─────────────────────────────────────────────────────────

/**
 * Actions reserved to the owner. An administrator is defined as "everything
 * except these", so the exclusion cannot drift out of step with the catalogue
 * as new permissions are added.
 */
export const OWNER_ONLY: readonly Grant[] = [
  'organization.transfer_ownership',
  'organization.close',
  'organization.billing.manage',
  'permission.edit',
]

/** Platform permissions never belong to a role inside a customer organization. */
function isPlatformGrant(grant: Grant): boolean {
  return grant.startsWith('platform.')
}

/** Everything a customer organization can ever be granted. */
const ALL_ORGANIZATION_GRANTS: readonly Grant[] = [
  ...PERMISSIONS.filter((p) => !isPlatformGrant(p)),
  ...FIELD_PERMISSIONS,
]

/**
 * Resolve a system role to its grants.
 *
 * Owner and administrator are computed from the catalogue rather than listed,
 * so adding a permission does not quietly leave the two most senior roles
 * unable to use it.
 */
export function grantsForSystemRole(role: SystemRole): readonly Grant[] {
  if (role === 'organization_owner') return ALL_ORGANIZATION_GRANTS
  if (role === 'administrator') {
    return ALL_ORGANIZATION_GRANTS.filter((g) => !OWNER_ONLY.includes(g))
  }
  return COMPOSED_ROLE_GRANTS[role]
}

/** Union of the grants held across every role on a membership. */
export function grantsForRoles(roles: readonly SystemRole[]): Set<Grant> {
  const grants = new Set<Grant>()
  for (const role of roles) {
    for (const grant of grantsForSystemRole(role)) grants.add(grant)
  }
  return grants
}
