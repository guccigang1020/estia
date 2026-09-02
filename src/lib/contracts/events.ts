/**
 * The domain event catalogue.
 *
 * An event is the past tense of something the business did. Automations,
 * notifications, dashboards and the audit trail all key off these names, so a
 * module that invents its own event name is a module nothing can react to.
 *
 * Two rules that keep this useful rather than decorative:
 *
 *   · **Events are emitted after the transaction commits.** An automation must
 *     never fire for a booking that was rolled back. A handler that throws is
 *     reported, never rethrown into the business operation — a failed WhatsApp
 *     message must not undo a confirmed booking.
 *
 *   · **Every payload carries the organization.** A subscriber that has to
 *     look up which tenant an event belongs to will eventually forget, and a
 *     cross-tenant notification is a data leak with a delivery receipt.
 */

export const DOMAIN_EVENTS = [
  // Booking
  //
  // The lifecycle is here in full rather than as a single
  // `booking.status_changed`, because these are the moments automations
  // genuinely hang off: preparation is created a set time before arrival, the
  // door code goes out when housekeeping has signed the unit off, and the
  // review request follows the stay. A subscriber filtering one generic event
  // by an inner field is a subscriber that runs on every transition and
  // discards most of them.
  'booking.created',
  'booking.optioned', // dates held for a named guest, not yet committed
  'booking.deposit_paid',
  'booking.confirmed',
  'booking.dates_changed',
  'booking.guests_changed',
  'booking.unit_changed',
  'booking.price_changed',
  'booking.cancelled',
  'booking.no_show',
  'booking.pre_arrival',
  'booking.ready_for_check_in', // housekeeping has signed off; keys may go out
  'booking.checked_in',
  'booking.in_house',
  'booking.checkout_pending',
  'booking.checked_out',
  'booking.inspection',
  'booking.completed',
  'booking.review_requested',

  // Availability
  'hold.created',
  'hold.extended',
  'hold.released',
  'hold.expired',
  'hold.converted',
  'availability.blocked',
  'availability.unblocked',

  // Guest
  'guest.created',
  'guest.merged',
  'guest.request_submitted',
  // The guest journey. A guest holds a capability URL rather than an account,
  // so every one of these is an act by somebody outside the business — which
  // is why they are named separately from the `booking.*` family rather than
  // folded into it.
  'guest.link_sent',
  'guest.link_opened',
  'guest.link_rotated',
  'guest.link_revoked',
  'guest.confirmed',
  // The business changed the terms after the guest agreed to them. The old
  // confirmation must not silently apply to the new price.
  'guest.reconfirmation_required',
  'guest.details_submitted',
  'arrival.instructions_released',
  'lead.created',
  'lead.status_changed',
  'quote.sent',
  'quote.viewed',
  'quote.accepted',
  'quote.expired',

  // Money
  'payment.link_sent',
  'payment.authorized', // reserved on the card, not yet taken
  'payment.received',
  'payment.failed',
  'payment.cancelled',
  /**
   * The processor did not answer, so nobody knows whether the card was
   * charged. This is a queue a person works, not a log line: it is on
   * `ALERT_EVENTS` because the alternative to somebody reconciling it is a
   * guest who paid and has no booking, or one who did not and has one.
   */
  'payment.outcome_unknown',
  'payment.refunded',
  // The collection policy's own events. `payment.received` is money arriving
  // through a provider; `payment.recorded` is a human writing down that a bank
  // transfer landed, which is the majority of Israeli guesthouse income and
  // must not be second-class.
  'payment.instructions_sent',
  'payment.proof_uploaded',
  'payment.recorded',
  'deposit.authorized',
  'deposit.captured',
  'deposit.released',
  'invoice.issued',
  'invoice.failed',

  // Contract
  'contract.sent',
  'contract.signed',

  // Agent network
  'agent.invited',
  'agent.activated',
  'agent.suspended',
  'agent.permissions_changed',
  'commission.created',
  'commission.became_eligible',
  'commission.approved',
  'commission.paid',
  'commission.cancelled',

  // Owners
  'owner_statement.issued',
  'owner_payout.approved',
  'owner_payout.paid',

  // Operations
  'preparation.calculated',
  'preparation.changed',
  'task.created',
  'task.assigned',
  'task.started',
  'task.completed',
  'task.verified',
  'task.overdue',
  'incident.opened',
  'incident.resolved',
  // The shortage somebody is standing in front of, now.
  'inventory.shortage_detected',
  // The shortage that has not happened yet, and is the point of the forecast:
  // fifty towels, twenty-five needed on Friday and thirty on Saturday, and
  // Friday's will still be in the machine. Kept apart from the line above
  // because they call for different actions and arrive at different times.
  'inventory.projected_shortage',
  'inventory.discrepancy_detected',
  'inventory.transferred',

  // Laundry
  //
  // `preparation.calculated` above is what the specification calls
  // `preparation.generated`; it already existed and is not duplicated here.
  'laundry.requirements_generated',
  'laundry.order_ready',
  'laundry.order_sent',
  'laundry.shortage_detected',
  'laundry.ready',
  'laundry.overdue',
  // The turnaround does not reach the arrival. Raised before anybody is
  // standing in an unmade bedroom.
  'laundry.deadline_risk',

  // The store
  'store.order_created',
  'store.order_approved',
  'store.order_paid',
  'store.order_confirmed',
  'store.order_changed',
  'store.order_cancelled',
  'store.order_refunded',
  'store.order_overdue',
  'store.provider_requested',
  'store.provider_confirmed',
  // The provider has not answered and the service is close. Raised before
  // somebody discovers on the day that no DJ is coming.
  'store.provider_unconfirmed',
  'store.service_due',

  // Approvals
  'approval.requested',
  'approval.decided',
  'approval.expired',

  // Website
  'site.generated',
  'site.published',
  'site.rolled_back',

  // Channels
  'channel.reservation_received',
  'channel.sync_failed',

  // Security — these exist so somebody can be told, not merely so it is logged
  'security.new_device_login',
  'security.permission_escalated',
  'security.bulk_export',
  'security.payment_config_changed',
] as const

export type DomainEventName = (typeof DOMAIN_EVENTS)[number]

/**
 * The envelope every event travels in.
 *
 * `occurredAt` is when the thing happened, not when the handler ran — a
 * retried notification must not claim the payment arrived an hour late.
 * `correlationId` ties an event back to the request that caused it, which is
 * the only way to answer "why did this guest get three messages".
 */
export interface DomainEvent<TPayload = unknown> {
  name: DomainEventName
  /** Always present. A subscriber must never have to infer the tenant. */
  organizationId: string
  /** The thing the event is about. */
  resourceType: string
  resourceId: string
  propertyId?: string | null
  /** Who caused it. Absent for events raised by a scheduled job. */
  actorUserId?: string | null
  occurredAt: string
  correlationId: string
  /**
   * Stable across retries of the same logical event, so a handler can refuse
   * to act twice. A webhook delivered three times is one event.
   */
  idempotencyKey: string
  payload: TPayload
}

const EVENT_SET: ReadonlySet<string> = new Set(DOMAIN_EVENTS)

export function isDomainEvent(name: string): name is DomainEventName {
  return EVENT_SET.has(name)
}

/**
 * Events that must reach a person rather than only a log.
 *
 * Kept as data so notification routing does not become a growing switch
 * statement that somebody forgets to extend.
 */
export const ALERT_EVENTS: readonly DomainEventName[] = [
  'payment.failed',
  'payment.outcome_unknown',
  'invoice.failed',
  'channel.sync_failed',
  'inventory.shortage_detected',
  'task.overdue',
  'incident.opened',
  'approval.requested',
  'security.new_device_login',
  'security.permission_escalated',
  'security.bulk_export',
  'security.payment_config_changed',
]
