/**
 * The permission catalogue.
 *
 * Every capability in ESTIA is named here exactly once. Authorization asks
 * `can(actor, permission, resource)` — never `if (role === "manager")` — so a
 * role is only ever a bundle of these strings, and a custom role built by a
 * customer is no different in kind from a built-in one.
 *
 * Adding a capability to the product means adding its permission here first.
 */

export const PERMISSIONS = [
  // ── Organization ────────────────────────────────────────────────────────
  'organization.view',
  'organization.settings.edit',
  'organization.billing.manage',
  'organization.transfer_ownership',
  'organization.close',

  // ── Property & Unit ─────────────────────────────────────────────────────
  'property.view',
  'property.create',
  'property.update',
  'property.delete',
  'unit.manage',

  // ── Booking ─────────────────────────────────────────────────────────────
  'booking.view',
  'booking.create',
  'booking.update',
  // The amendment family. `booking.update` is the staff-level right to edit a
  // booking as a whole; these name one change each, so an external seller can
  // be allowed to add a cot without being allowed to move the dates or cut the
  // price. Every one of them is independently grantable — they are not a
  // ladder, because no ordering between them is true: a business may well let
  // an agent change dates and never touch money.
  'booking.amend_guest_count',
  'booking.amend_extras',
  'booking.amend_dates',
  'booking.amend_price',
  'booking.cancel',
  'booking.delete',
  'booking.change_status',
  'booking.override_price',
  'booking.override_availability',
  'booking.export',
  'booking.assign',
  'booking.note.internal',

  // ── Availability & holds ────────────────────────────────────────────────
  // `availability.view` is free/busy and nothing else: which dates a unit can
  // still be sold on, without the booking that occupies them. It exists as its
  // own permission because an external seller must be told "taken" without
  // being told by whom, for how much, or through which channel. `booking.view`
  // is strictly more than this and never a substitute for it.
  'availability.view',
  // A hold is inventory removed from sale for a short while without a booking
  // behind it. Creating one costs the business real money if it is forgotten,
  // so releasing it is named separately from creating it.
  'hold.view',
  'hold.create',
  'hold.release',
  // Extending a hold keeps inventory off sale for longer, which is the thing
  // the concurrent, daily and extension limits exist to bound. The limits
  // themselves are data; the right to extend at all is this.
  'hold.extend',

  // ── Guest ───────────────────────────────────────────────────────────────
  'guest.view',
  'guest.create',
  'guest.update',
  'guest.delete',
  'guest.export',
  // The historical register, separate from 'guest.view' because the two serve
  // different people: an accountant needs the register without today's guest
  // cards, and a receptionist needs today's cards without five years of
  // history.
  'guest_book.view',
  // Deciding which fields this business records, and correcting an entry.
  'guest_book.manage',

  // ── Lead & quote ────────────────────────────────────────────────────────
  // Both are worked from two sides — the business's desk and an external
  // seller — so they are first-class here rather than states hidden inside a
  // booking. Sending a quote is split from writing one for the same reason
  // publishing a site is split from editing it: it is the moment a price
  // reaches a customer and stops being reversible.
  'lead.view',
  'lead.create',
  'lead.update',
  'lead.assign',
  'quote.view',
  'quote.create',
  'quote.update',
  'quote.send',

  // ── Finance ─────────────────────────────────────────────────────────────
  'finance.view',
  'payment.view',
  'payment.create',
  // Asking the system to send the guest a payment link is not taking money:
  // it exposes no card, no ledger and no balance. Separated so somebody who
  // sells can get paid without being given the payment record.
  'payment.request_link',
  'payment.capture',
  // Deciding what a guest must do before a booking is confirmed — nothing, a
  // signature, a deposit, the whole amount. It is not a payment right and does
  // not carry a plan entitlement: a business collecting by bank transfer on a
  // package with no card processing still has to be able to say so.
  //
  // `payment.manual_record` and `payment.live_charge` from the specification
  // are not added: `payment.create` already records money that arrived, and
  // `payment.capture` already takes it through a provider.
  'payment.policy_manage',
  'payment.refund',
  'payment.void',
  'deposit.hold',
  'deposit.release',
  'expense.view',
  'expense.create',
  'expense.approve',
  'invoice.view',
  'invoice.issue',
  // Working the queue of accounting documents that failed, were refused, or
  // whose outcome the vendor never confirmed. Deliberately NOT 'invoice.issue':
  // resolving one issues nothing and touches no money, and a bookkeeper who
  // should retry a failed document is not thereby somebody who may raise a tax
  // invoice.
  'fiscal.resolve',
  'report.financial.view',
  'report.financial.export',

  // ── Team & access ───────────────────────────────────────────────────────
  'user.view',
  'user.invite',
  'user.edit',
  'user.suspend',
  'user.remove',
  'role.create',
  'role.assign',
  'permission.edit',
  'team.manage',

  // ── Operations ──────────────────────────────────────────────────────────
  'task.view',
  'task.create',
  'task.assign',
  'task.update',
  'task.complete',
  'task.verify',
  'checklist.manage',
  // Preparation deliberately has no grants of its own. The specification asks
  // for `preparation.view` and `preparation.manage`; `task.view` already means
  // the first and `checklist.manage` already means the second, and every
  // preparation screen in the product is gated on them today. A second name
  // for a right somebody already holds is a right that can be revoked in one
  // place and kept in the other.
  'inventory.view',
  'inventory.edit',
  // Correcting a count against what is actually on the shelf. Separate from
  // `inventory.edit`, which renames an item or changes its par level: an
  // adjustment rewrites history's arithmetic and is the one a supervisor signs
  // for.
  'inventory.adjust',
  'inventory.import',
  // Moving stock between properties. Its own right because it takes from one
  // manager to give to another, and neither of them is the person pressing it.
  'inventory.transfer',
  'laundry.view',
  'laundry.manage',
  'laundry.order_create',
  // Sending is not creating. This one talks to an outside company in the
  // organization's name, which is exactly the boundary `payment.request_link`
  // is drawn on a few lines above.
  'laundry.order_send',
  'laundry.provider_manage',
  'incident.view',
  'incident.create',
  'incident.update',
  'incident.resolve',

  // ── Communication ───────────────────────────────────────────────────────
  // Held by every role there is, including a cleaner and an external vendor.
  // It governs a person's own inbox and their own channel preferences — not
  // anybody else's — so withholding it would mean somebody who cannot mute
  // their own SMS at midnight. It is the only grant in this catalogue that is
  // universal by design, and the notification module's personal writes are
  // ordinary operations because of it.
  'notification.preferences.manage',
  'message.view',
  'message.send',
  'message.assign',
  'template.manage',

  // ── Sales & marketing ───────────────────────────────────────────────────
  'product.view',
  'product.manage',
  // Setting what a guest pays for a bottle of wine is not the same right as
  // writing its description, and it is not `pricing.manage`, which is the
  // accommodation rate card. Its own grant because it is its own money.
  'product.price_manage',
  'order.view',
  // Approving, amending, assigning a provider, cancelling. `order.fulfil`
  // below stays what it always was — marking the work done — because a
  // cleaner who completes a setup must not thereby be able to cancel it.
  'order.manage',
  'order.fulfil',
  'order.discount_manage',
  'order.refund',
  // The external supplier directory — caterers, DJs, photographers,
  // decorators. `laundry.provider_manage` stays separate: one is a standing
  // operational contract, the other is who to call for a birthday.
  'provider.manage',
  'review.view',
  'review.manage',
  // Website Studio. Split finely because the roles genuinely differ: a
  // marketing employee writes copy, a manager approves, and only a publisher
  // puts it in front of customers. Domain and SEO are separated again because
  // a mistake in either is expensive and slow to notice.
  'site.view',
  'site.edit_content',
  'site.edit_design',
  'site.manage_seo',
  'site.manage_domain',
  'site.publish',
  'site.rollback',
  'site.ai_generate',

  // ── Autopilot ───────────────────────────────────────────────────────────
  // Eight, and the split is the point. Seeing what Autopilot noticed,
  // approving one prepared action, and changing the rule that prepared it are
  // three different amounts of authority — a shift manager who can approve a
  // reminder must not thereby be able to set the whole business to automatic.
  'autopilot.view',
  /** Ask it to do something now: "sort out my day", resolve an exception. */
  'autopilot.use',
  /** Press the button on a prepared action. Never implies configure. */
  'autopilot.approve',
  'autopilot.configure',
  /** The kill switch and the temporary pause. Separate because it is urgent: */
  /** the person who must stop it at 23:00 is rarely the person who set it up. */
  'autopilot.pause',
  'autopilot.activity_view',
  /** Override the disposition for one booking or one property. */
  'autopilot.override',
  /** Turn an observed pattern into a standing rule. */
  'autopilot.rules_manage',

  'pricing.manage',
  'channel.manage',

  // ── Owners ──────────────────────────────────────────────────────────────
  'owner.view',
  'owner.manage',
  'owner_statement.view',
  'owner_statement.issue',

  // ── Agent network ───────────────────────────────────────────────────────
  // External sellers are members of the organization with a narrow role and a
  // narrow scope — not a second identity system. What is genuinely new is the
  // business side: the relationship, its commercial terms, and the money it
  // owes. Those are split finely because they are decided by different people.
  //
  //   · `agent.manage` edits who the seller is.
  //   · `agent.membership.manage` is the *membership* behind the seller — see
  //     below, because it is the one that touches a table other people are in.
  //   · `agent.scope.manage` decides which inventory an outsider can see, and
  //     is therefore the blast radius, not an attribute. It is separated for
  //     the same reason `permission.edit` is separated from `user.edit`.
  //   · `agent_agreement.manage` sets the commission rule — the price of a
  //     sale — and is held by whoever owns the commercial relationship.
  //   · `commission.approve` and `commission.payout` release the money, and
  //     are deliberately not held by whoever wrote the rule.
  'agent.view',
  'agent.invite',
  'agent.manage',
  /**
   * Admitting, suspending, reinstating and removing an agent's **membership**,
   * and giving that membership one of the four agent preset roles.
   *
   * ── Why this is not `user.edit` ───────────────────────────────────────
   *
   * The status an owner presses "suspend" on lives on `memberships`, and the
   * role an agent resolves through lives on `membership_roles`. Both tables
   * hold every employee in the business, so their policies are written around
   * `user.edit` and `role.assign` — the organization-wide team authority.
   *
   * A general manager owns the agent network and holds neither of those, by
   * design: whoever runs the sellers must not be able to change an
   * administrator's membership. Handing them `user.edit` to make the agent
   * screen work would be exactly that privilege escalation, because
   * `memberships_update` cannot see that the row it is admitting happens to
   * belong to an agent.
   *
   * So the authority is named for what it actually is, and the policies that
   * honour it (0025) are narrowed to match the name: they reach a membership
   * only when an `agent_organization_settings` row exists for it, and never
   * when that membership itself holds elevated authority — so an owner or an
   * administrator who is also an agent stays out of reach.
   *
   * It is a strict subset of `user.edit` + `role.assign`, never a substitute:
   * an actor holding those keeps every path they had.
   */
  'agent.membership.manage',
  'agent.scope.manage',
  'agency.manage',
  'agent_agreement.view',
  'agent_agreement.manage',
  // The guardrails, kept apart from the agreement: a discount cap and the
  // hold limits are operational ceilings that the revenue side sets, while the
  // commission rule is the commercial deal. The numbers behind both are data —
  // this is only the right to choose them.
  'agent_limits.manage',
  'agent_booking.approve',
  'commission.view',
  /**
   * Moving a commission along its lifecycle by hand. The
   * `estimated → pending → eligible` steps happen on their own, but somebody
   * occasionally has to correct one.
   *
   * Separate from `commission.approve` because adjusting a figure and
   * releasing the money are different acts, and separate from
   * `agent_agreement.manage` because whoever sets the commercial terms should
   * not also be quietly changing what one agent is owed this month.
   */
  'commission.manage',
  'commission.approve',
  'commission.payout',
  'agent_statement.view',
  'agent_statement.issue',
  'report.agent.view',
  // The agent trail alone, not the organization's whole audit log. Somebody
  // running the network needs to see what an agent did without being handed
  // every payroll and guest event in the business.
  'agent.audit.view',

  // ── Governance ──────────────────────────────────────────────────────────
  'audit.view',
  'approval.request',
  'approval.decide',
  'automation.view',
  'automation.manage',
  'integration.manage',

  // ── Platform (ESTIA staff only, never granted to a customer role) ───────
  'platform.organization.view',
  'platform.organization.manage',
  'platform.plan.manage',
  'platform.impersonate',
  'platform.feature_flag.manage',
] as const

export type Permission = (typeof PERMISSIONS)[number]

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS)

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value)
}

/**
 * Field-level permissions.
 *
 * Access to a record is not access to every column of it. A cleaner needs the
 * booking to know which unit to prepare, and must not receive the guest's phone
 * number or what they paid. Enforced where data is shaped for the response —
 * never by hiding it in the UI.
 */
export const SENSITIVE_FIELDS = {
  // The name is its own field. Contact details were never a synonym for it:
  // a record redacted of phone and email still identified the guest by name to
  // anyone allowed to see the row at all — a cleaner, and now an external
  // seller, both of whom must see the stay without seeing the person.
  // Guest identity, one field at a time and defaulting to nothing. `name`,
  // `phone` and `email` were previously a single `guest.view_contact`, which
  // could not express the request an agent network actually makes: give the
  // seller the phone so they can call their own client, and never the email,
  // which is the business's channel for the next stay.
  'guest.name': ['guest.view_name'],
  'guest.phone': ['guest.view_phone'],
  'guest.email': ['guest.view_email'],
  'guest.document_id': ['guest.view_document_id'],
  'booking.price': ['booking.view_price'],
  // Coarse on purpose: not paid · deposit paid · paid. Enough for a seller to
  // chase their own client, and nothing about the card, the provider or the
  // ledger. A separate grant from the amount, because knowing that money
  // arrived is not knowing how much.
  'booking.payment_status': ['booking.view_payment_status'],
  'booking.source': ['booking.view_source'],
  'booking.deposit': ['booking.view_deposit'],
  'booking.profitability': ['booking.view_profitability'],
  // Internal notes are guarded by the permission that writes them, so there is
  // one name for the concept rather than two that can drift apart.
  'booking.internal_notes': ['booking.note.internal'],
  'owner.commission': ['owner.view_commission'],
  // Three prices for the same night, and three different circles of trust.
  // The public rate is what a guest is quoted; the agent rate is what a seller
  // may offer; the net rate is what the business will actually accept, and
  // handing it to the wrong person hands away the negotiation. None of the
  // three implies another — they are separate grants, compared whole.
  'rate.public': ['rate.view_public'],
  'rate.agent': ['rate.view_agent'],
  'rate.net': ['rate.view_net'],
} as const

export const FIELD_PERMISSIONS = [
  'guest.view_name',
  'guest.view_phone',
  'guest.view_email',
  'guest.view_document_id',
  'booking.view_price',
  'booking.view_payment_status',
  'booking.view_source',
  'booking.view_deposit',
  'booking.view_profitability',
  'owner.view_commission',
  'rate.view_public',
  'rate.view_agent',
  'rate.view_net',
] as const

export type FieldPermission = (typeof FIELD_PERMISSIONS)[number]

/** Every string the authorization engine understands. */
export type Grant = Permission | FieldPermission

/**
 * Actions that must never be performed on the strength of a permission alone.
 * They additionally require a fresh authentication, a stated reason, or an
 * approval — decided by organization policy, enforced in the service layer.
 */
export const SENSITIVE_ACTIONS: ReadonlySet<Grant> = new Set<Grant>([
  'booking.delete',
  'payment.refund',
  'payment.void',
  'organization.transfer_ownership',
  'organization.close',
  'organization.billing.manage',
  'permission.edit',
  'guest.export',
  'integration.manage',
  'platform.impersonate',
  // Money owed to a third party. Writing the commission rule decides what the
  // business will pay on every future sale; approving and paying out move it.
  'agent_agreement.manage',
  'agent_limits.manage',
  'commission.approve',
  'commission.payout',
  // Widening what an outsider may see is a change to reach, not to a record —
  // the same class of decision as `permission.edit`.
  'agent.scope.manage',
])
