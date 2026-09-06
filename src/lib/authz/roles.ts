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
 * A position on all three ladders at once, with the grant they share counted
 * once.
 *
 * `rate.view_public` sits on two of them, correctly and for different reasons:
 * the calendar's `availability_price` rung has it because a quote is a price
 * put in front of a customer, and the price ladder's first rung has it because
 * it is the first price anyone may be shown. Neither may give it up, so a
 * preset standing on both listed it twice — which is invisible to the engine,
 * since `grantsForRoles()` flattens into a `Set`, and visible in every count
 * taken of the array. The union is taken here rather than left to drift.
 */
function grantsForLadders(
  calendar: CalendarLevel,
  price: PriceLevel,
  guestData: GuestDataLevel,
): readonly Grant[] {
  return [
    ...new Set<Grant>([
      ...grantsForCalendarLevel(calendar),
      ...grantsForPriceLevel(price),
      ...grantsForGuestDataLevel(guestData),
    ]),
  ]
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

/**
 * Free/busy plus the selling desk, with the grant they share counted once.
 *
 * `availability.view` genuinely belongs to both bundles — it is the free/busy
 * half of reading a booking, and it is the first thing anybody selling looks
 * at — so neither list may drop it. Spreading both, though, put it into every
 * composed role twice, which made the role's array length disagree with the
 * number of grants it actually holds. The union is taken once, here, rather
 * than left for `grantsForRoles()` to flatten silently.
 */
const SELLING_FLOOR: Grant[] = [...new Set([...BOOKING_READ, ...SELLING_DESK])]

const BOOKING_DESK: Grant[] = [
  ...SELLING_FLOOR,
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
  'inventory.adjust',
  'inventory.import',
  'inventory.transfer',
  // The whole laundry operation, including sending an order out. Somebody who
  // runs operations is exactly who talks to the provider.
  'laundry.view',
  'laundry.manage',
  'laundry.order_create',
  'laundry.order_send',
  'laundry.provider_manage',
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

/**
 * Held by every role, without exception.
 *
 * One entry, and it earns the mechanism: a person's own notification inbox and
 * their own channel preferences belong to them whatever they do for the
 * business. Listing it twenty times would mean the twenty-first role forgets
 * it, and the person who then cannot mute their own alerts is a cleaner being
 * telephoned at midnight.
 *
 * Unioned in `grantsForSystemRole` rather than pasted into each preset, so
 * `ALL_ORGANIZATION_GRANTS` — which the owner and the administrator derive
 * from — already carries it and needs no special case.
 */
/**
 * Working Autopilot day to day: read what it noticed, ask it to act, approve
 * one prepared action, read the log, and stop it.
 *
 * `autopilot.configure`, `autopilot.override` and `autopilot.rules_manage`
 * are deliberately NOT here. Those three change what the business does when
 * nobody is watching, and they stay with the owner and the administrator until
 * somebody hands them over on purpose. `autopilot.pause` IS here, because the
 * person who has to stop it at 23:00 is rarely the person who set it up.
 */
const AUTOPILOT_OPERATOR: readonly Grant[] = [
  'autopilot.view',
  'autopilot.use',
  'autopilot.approve',
  'autopilot.pause',
  'autopilot.activity_view',
]

export const UNIVERSAL_GRANTS: readonly Grant[] = [
  'notification.preferences.manage',
]

const COMPOSED_ROLE_GRANTS: Record<ComposedRole, readonly Grant[]> = {
  general_manager: [
    ...BOOKING_DESK,
    ...OPERATIONS_CORE,
    ...AUTOPILOT_OPERATOR,
    // The one non-owner role that may change the policy matrix: running the
    // business day to day is exactly the job that knows which reminders should
    // send themselves.
    'autopilot.configure',
    'autopilot.override',
    // Runs the business, so decides what the business records and works the
    // queue of accounting documents that did not go through.
    'fiscal.resolve',
    'guest_book.view',
    'guest_book.manage',
    // Moving a business onto ESTIA is a general manager's job, and it happens
    // roughly once.
    'migration.view',
    'migration.apply',
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
    'product.price_manage',
    'order.view',
    'order.manage',
    'order.fulfil',
    'order.discount_manage',
    'provider.manage',
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
    //
    // `agent.membership.manage` and not `user.edit` + `role.assign`. Owning
    // the network means adding and suspending the people in it, and both of
    // those write `memberships` and `membership_roles` — tables that hold
    // every employee. The organization-wide grants would let whoever runs the
    // sellers change an administrator's membership; the agent-specific one is
    // policed (0025) to reach only memberships that have agent terms and do
    // not themselves hold elevated authority.
    'agent.view',
    'agent.invite',
    'agent.manage',
    'agent.membership.manage',
    'agent.scope.manage',
    'agency.manage',
    'agent_agreement.view',
    'agent_agreement.manage',
    'agent_limits.manage',
    'agent_booking.approve',
    'agent.audit.view',
    'commission.view',
    // Correcting a commission that the automatic `estimated → pending →
    // eligible` steps got wrong, and issuing the period statement it lands on.
    // It is the commercial half of the network, which is this role's, and it
    // is bounded: `commission.manage` policies nothing but insert and update
    // on `commission_statements`. Approving and paying out are separate grants
    // above, and stay with finance.
    'commission.manage',
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
    ...AUTOPILOT_OPERATOR,
    // May mark one booking as manual-only — a wedding, a returning VIP — but
    // not change the organization's settings.
    'autopilot.override',
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
    // Approves, amends and assigns a provider for their own properties.
    // Deliberately not `product.price_manage` or `provider.manage`: what a
    // bottle of wine costs and who caters are decisions for the business, not
    // for one house.
    'order.manage',
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
    ...SELLING_FLOOR,
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
    'product.view',
    'order.view',
    // Creates an order for a guest who rang up asking for pool heating, and
    // marks it done. Approving one, discounting it or refunding it are three
    // other people's jobs.
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
    // Approves the payment reminders and the reconciliation prompts. Cannot
    // configure, and — as everywhere else — cannot make Autopilot charge
    // anybody: that is a platform safety rule, not a permission.
    ...AUTOPILOT_OPERATOR,
    // Works the failed-document queue and reads the register. Not
    // `guest_book.manage`: which fields a business is required to record is a
    // decision about the business, not about its bookkeeping.
    'fiscal.resolve',
    'guest_book.view',
    'guest.view_name',
    'guest.view_phone',
    'guest.view_email',
    'owner.view',
    'owner_statement.view',
    'owner_statement.issue',
    'owner.view_commission',
    'approval.decide',
    'booking.export',
    // Approves and pays the commission, corrects a figure that came out wrong,
    // and may read the agreement it is computed from — but cannot write that
    // agreement. The person who sets the rate is never the person who releases
    // the money.
    'commission.view',
    'commission.manage',
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
    ...AUTOPILOT_OPERATOR,
    // `task.assign` is not repeated here: `OPERATIONS_CORE` carries it, and
    // this role's whole point is that it holds all of it.
    ...OPERATIONS_CORE,
    ...BOOKING_READ,
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
    // Counts what is on the shelf, because they are the one holding it.
    'inventory.adjust',
    // Prepares the laundry and raises the order. Deliberately not
    // `laundry.order_send` or `laundry.provider_manage`: sending is a message
    // to an outside company in the organization's name, and choosing the
    // company is a commercial decision. Both belong a level up, and the order
    // this role raises is waiting there for approval.
    'laundry.view',
    'laundry.manage',
    'laundry.order_create',
    'user.view',
    'property.view',
    'booking.view',
  ],

  /**
   * Mobile, task-first, and the sharpest test of the privacy model: a cleaner
   * sees which unit and when, and never a phone number or a price.
   *
   * No laundry grant, and that is the right reading of "assigned laundry tasks
   * only": internal laundry work reaches a cleaner as a task, which these four
   * grants already cover. `laundry.view` would additionally show them provider
   * orders and the forward demand curve — somebody else's job, and somebody
   * else's commercial information.
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
  referral_agent: [...AGENT_BASE, ...grantsForLadders('none', 'none', 'none')],

  /**
   * The main model. Sees what is free, quotes it, holds it, books it — and
   * still sees no guest, no amount paid and no booking source, because none of
   * those are needed to sell a night that is free.
   */
  sales_agent: [
    ...AGENT_BASE,
    ...grantsForLadders('availability_booking', 'agent', 'none'),
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
    ...grantsForLadders('availability_booking', 'agent', 'none'),
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
    ...grantsForLadders('availability_booking', 'net', 'phone'),
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
  // The union, taken here so no preset can omit it and no future preset has
  // to remember it.
  return [
    ...new Set<Grant>([...COMPOSED_ROLE_GRANTS[role], ...UNIVERSAL_GRANTS]),
  ]
}

/** Union of the grants held across every role on a membership. */
export function grantsForRoles(roles: readonly SystemRole[]): Set<Grant> {
  const grants = new Set<Grant>()
  for (const role of roles) {
    for (const grant of grantsForSystemRole(role)) grants.add(grant)
  }
  return grants
}
