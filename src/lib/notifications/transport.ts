/**
 * The port a real e-mail, SMS or WhatsApp client would implement — and the
 * null implementation that is what this product actually ships.
 *
 * ══ WHY THERE IS NO REAL TRANSPORT IN THIS REPOSITORY ═══════════════════════
 *
 * Email, SMS and WhatsApp all need a provider credential this project does not
 * have. Half a client behind a missing key is worse than none: it compiles, it
 * looks finished, it is exercised by tests that mock the very thing that does
 * not exist, and the first person to discover it is a guesthouse owner whose
 * guests were never told anything. That decision was already taken here once,
 * for payment proof storage and for `payment_collection_settings.live_provider`
 * — which holds a provider's NAME and never a secret, so the product can say
 * "nothing is configured" without reading one. This is the same decision.
 *
 * ══ THE ABSENCE IS A STATE, NOT A SILENCE ═══════════════════════════════════
 *
 * `NullTransport` does not throw and does not pretend. It returns
 * `not_configured`, which becomes a row in `notification_deliveries` with that
 * status, which becomes a number on a screen: "היינו שולחים 14 הודעות ואין
 * ערוץ מחובר".
 *
 * That number is the point. A business cannot act on an integration it does
 * not know it is missing, and a product that quietly discarded the messages
 * would be hiding its own strongest argument. The count is what makes
 * connecting a channel a decision somebody can make with a figure in front of
 * them rather than a feature request.
 *
 * ══ IN-APP IS DIFFERENT AND IS FULLY DELIVERED ══════════════════════════════
 *
 * `InAppTransport` needs no credential, because the delivery IS the
 * `notifications` row — it was written before the transport was ever asked.
 * So it reports `delivered` rather than `sent`: nothing is in flight, there is
 * no provider to confirm anything later, and a `sent` that could never become
 * `delivered` would leave a permanently pending row on every screen.
 */

import type { NotificationChannel, NotificationSeverity } from './types'

/* ------------------------------------------------------------- messages -- */

/**
 * What a transport is handed.
 *
 * Note what is NOT here: no recipient address. A transport reads the address
 * for `to.userId` from wherever that channel's addresses live — a mail
 * transport from the profile, an SMS transport from `user_profiles.phone_e164`
 * — at the moment it sends. Passing it through here would mean
 * `notification_deliveries` had to carry it to be auditable, and that table
 * would become a copy of every staff telephone number in the business for no
 * purpose any screen has.
 */
export interface OutboundMessage {
  organizationId: string
  notificationId: string
  channel: NotificationChannel
  to: { userId: string }
  severity: NotificationSeverity
  /** Hebrew. The catalogue's title. */
  subject: string
  /** Hebrew. The catalogue's body, plus the event's own detail if it had one. */
  body: string
  /** Relative. A transport that needs an absolute URL prefixes its own host. */
  actionHref: string | null
  /** Ties this back to the request that caused it. */
  correlationId: string | null
}

/* --------------------------------------------------------------- result -- */

export type TransportResult =
  /** Handed to a provider that accepted it. Confirmation may follow. */
  | { status: 'sent'; provider: string; providerMessageId: string | null }
  /** Arrived, and there is nothing further to wait for. In-app only. */
  | { status: 'delivered'; provider: string }
  /** The provider refused or errored. `retryable` decides whether to try again. */
  | {
      status: 'failed'
      provider: string
      errorCode: string
      errorDetail: string | null
      retryable: boolean
    }
  /**
   * There is nothing behind this channel.
   *
   * Not an error and never thrown. `reason` is English and diagnostic — the
   * Hebrew a person reads comes from `labels.ts`, because a provider's own
   * words must never reach a screen.
   */
  | { status: 'not_configured'; reason: string }

/* ----------------------------------------------------------------- port -- */

export interface NotificationTransport {
  readonly channel: NotificationChannel
  /**
   * Whether this transport can actually do anything.
   *
   * Read BEFORE `send` by the settings screen, so it can say what is connected
   * without sending anything to find out. A transport must answer this from
   * configuration alone and must never make a network call to decide.
   */
  readonly configured: boolean
  /**
   * Deliver, or say why not.
   *
   * **Must not throw.** A transport that throws would propagate into whichever
   * operation raised the event, and `service/events.ts` is explicit that a
   * failed message must never undo the business act that caused it. Every
   * failure is a `TransportResult`, including the ones a provider client would
   * ordinarily raise.
   */
  send(message: OutboundMessage): Promise<TransportResult>
}

/* ----------------------------------------------------------------- null -- */

/**
 * The implementation every channel but `in_app` has.
 *
 * It is deliberately not a stub that logs and returns success. Success is the
 * one answer it must never give: a delivery row saying `sent` for a message
 * that does not exist would put a false reassurance in the one table the
 * business consults to find out what it is not sending.
 */
export class NullTransport implements NotificationTransport {
  readonly configured = false

  constructor(
    readonly channel: NotificationChannel,
    private readonly note = 'no transport is configured for this channel',
  ) {}

  async send(): Promise<TransportResult> {
    return { status: 'not_configured', reason: this.note }
  }
}

/**
 * The one channel that works.
 *
 * The `notifications` row was written before this was called, so there is
 * nothing left to do — which is exactly why in-app can be delivered without a
 * credential and why it is the channel this product finished.
 */
export class InAppTransport implements NotificationTransport {
  readonly channel: NotificationChannel = 'in_app'
  readonly configured = true

  async send(): Promise<TransportResult> {
    return { status: 'delivered', provider: 'estia_in_app' }
  }
}

/* ------------------------------------------------------------- registry -- */

/**
 * Which transport serves which channel.
 *
 * Unregistered channels get a `NullTransport` rather than an error, because
 * "nothing is connected" is the ordinary state of this product and must not be
 * a crash. The registry is constructed with `in_app` already present: a
 * deployment that forgot to register it would have a routing engine and
 * nowhere at all for its output to land, which reads on screen as a broken
 * product rather than as a missing integration.
 */
export class TransportRegistry {
  private readonly transports = new Map<
    NotificationChannel,
    NotificationTransport
  >()

  constructor(transports: readonly NotificationTransport[] = []) {
    this.transports.set('in_app', new InAppTransport())
    for (const transport of transports) {
      this.transports.set(transport.channel, transport)
    }
  }

  for(channel: NotificationChannel): NotificationTransport {
    return this.transports.get(channel) ?? new NullTransport(channel)
  }

  /** Which channels can actually deliver. What the settings screen reports. */
  configuredChannels(): readonly NotificationChannel[] {
    return [...this.transports.values()]
      .filter((transport) => transport.configured)
      .map((transport) => transport.channel)
  }

  isConfigured(channel: NotificationChannel): boolean {
    return this.for(channel).configured
  }
}

/**
 * The registry this product ships with.
 *
 * In-app, and nothing else. Written as a function rather than as a constant so
 * that a deployment which one day has credentials constructs its own rather
 * than mutating a shared object — a registry that can be added to at runtime is
 * a registry whose contents depend on import order.
 */
export function defaultTransportRegistry(): TransportRegistry {
  return new TransportRegistry()
}
