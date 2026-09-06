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
  // Raising a maintenance fault as an arrival approaches. Emitted as
  // task.created until now, which reached no subscriber but said the wrong
  // thing in the event log.
  'task.priority_changed',
  // The work on this task ended without being done. Distinct from completed,
  // which the cancel path was borrowing.
  'task.cancelled',
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
  // Asking a provider to bring a confirmed delivery forward. Emitted as
  // deadline_risk until now — true, but not the event that happened.
  'laundry.earlier_delivery_requested',

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
  'channel.connected',
  'channel.disconnected',
  'channel.listing_mapped',
  'channel.mapping_activated',
  'channel.mapping_suspended',
  'channel.reservation_modified',
  'channel.reservation_cancelled',
  // The idempotent no-op, and it is not noise for the same reason
  // `autopilot.action_suppressed` is not: the count of what the ingestion path
  // DECLINED to do is the only honest answer to "is deduplication working",
  // and without it a silent bug dropping real reservations is
  // indistinguishable from a healthy day.
  'channel.reservation_duplicate_ignored',
  'channel.exception_raised',
  'channel.exception_resolved',
  'channel.sync_completed',
  // A push that was never ATTEMPTED — the capability is unsupported or nothing
  // is configured. A different event from one that failed, and it must not be
  // counted as a failure.
  'channel.push_refused',

  // Security — these exist so somebody can be told, not merely so it is logged
  'security.new_device_login',
  'security.permission_escalated',
  'security.bulk_export',
  'security.payment_config_changed',

  // Autopilot. The capability's own lifecycle, then one event per thing that
  // happened to a decision — raised, prepared, approved, done, or refused with
  // a reason. `action_suppressed` is not a failure and is not noise: the count
  // of what Autopilot declined to do, and why, is the only honest answer to
  // "what is it actually doing", and a customer who cannot see that will not
  // trust it with anything that matters.
  'autopilot.enabled',
  'autopilot.disabled',
  'autopilot.paused',
  'autopilot.resumed',
  'autopilot.policy_changed',
  'autopilot.exception_raised',
  'autopilot.exception_acknowledged',
  'autopilot.exception_resolved',
  'autopilot.exception_dismissed',
  'autopilot.action_planned',
  'autopilot.action_approval_requested',
  'autopilot.action_approved',
  'autopilot.action_executed',
  'autopilot.action_failed',
  'autopilot.action_suppressed',
  'autopilot.action_simulated',
  'autopilot.action_undone',
  // A pattern was noticed, and separately a person turned one into a rule.
  // Two events because they are two decisions, and only the second binds.
  'autopilot.rule_candidate_observed',
  'autopilot.rule_candidate_adopted',
  'autopilot.brief_sent',

  // Fiscal documents. Separate from `invoice.*`, which is ESTIA's own
  // document: these are what an external accounting vendor did with it.
  // `document_refused` is an ordinary outcome and not a failure — a provider
  // that is not connected refuses honestly, and a retry queue treating that as
  // a failure would loop forever.
  'fiscal.document_requested',
  'fiscal.document_issued',
  'fiscal.document_refused',
  // The vendor did not answer. A numbered legal document may exist that ESTIA
  // cannot see, so retrying would create a duplicate tax invoice — and a tax
  // invoice cannot be un-issued.
  'fiscal.document_outcome_unknown',
  // Money arrived and the paperwork did not.
  'fiscal.payment_undocumented',
  'fiscal.reconciliation_completed',
  'fiscal.reconciliation_difference_found',

  // The guest register.
  'guest_book.entry_created',
  'guest_book.entry_updated',
  // A required field is still empty. This is what makes the holes workable
  // rather than invisible.
  'guest_book.entry_incomplete',
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
  // A numbered document may exist that ESTIA cannot see, and nobody should
  // discover that from an accountant in March.
  'fiscal.document_outcome_unknown',
  'fiscal.payment_undocumented',
  'fiscal.reconciliation_difference_found',
  'channel.sync_failed',
  // A reservation that did not become a booking is not a sync failure, and
  // before this it reached nobody.
  'channel.exception_raised',
  'inventory.shortage_detected',
  'task.overdue',
  'incident.opened',
  'approval.requested',
  'security.new_device_login',
  'security.permission_escalated',
  'security.bulk_export',
  'security.payment_config_changed',
]
