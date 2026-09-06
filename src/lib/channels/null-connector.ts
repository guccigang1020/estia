/**
 * The connector for a channel nobody has credentials for — which is every
 * channel, in this codebase, today.
 *
 * ══ THERE ARE NO OTA CREDENTIALS HERE, AND THIS FILE IS HOW THAT IS SAID ══
 *
 * No Booking.com account, no Airbnb API key, no Expedia contract. Writing an
 * HTTP client against any of them would produce code that has never once run,
 * cannot be tested, and — far worse — makes the channel manager *look*
 * finished. A dashboard drawn over an integration that has never made a
 * request is the single most dangerous screen this product could ship: a
 * business reads "Booking.com ✓", stops checking its own calendar, and the
 * first consequence is the same Friday sold twice.
 *
 * So this connector declares **no capabilities at all** and refuses every
 * gated call before it is made. It is the same decision
 * `site_generation_requests` took for the absent AI provider and
 * `notification_deliveries.status = 'not_configured'` took for the absent
 * mailer, and it is taken here for the same reason: a first-class "there is
 * nothing behind this" is honest, is visible on a screen, and is the strongest
 * argument that exists for connecting something real. An empty table would
 * have said nothing at all.
 *
 * ── What it still answers ─────────────────────────────────────────────────
 *
 * `authenticate` and `health` are not gated on a capability — see
 * `connector.ts` — and this connector answers both, negatively and with a
 * reason. That is deliberate: the health centre must be able to render a row
 * for a channel that does not work, saying why, rather than rendering nothing
 * and leaving an owner to conclude that silence means fine.
 *
 * ── When a real connector arrives ─────────────────────────────────────────
 *
 * It implements `ConnectorContract`, declares the capabilities that channel
 * genuinely has, and is registered in `CONNECTOR_REGISTRY` below. Nothing else
 * in this module changes — `mapping.ts`, `ingestion.ts`, `modification.ts` and
 * `reconciliation.ts` are all pure functions over the contract's types and
 * have never met an HTTP client. That is why they are written first.
 */

import {
  refuse,
  type ChannelCode,
  type ChannelRefusal,
  type ChannelResult,
  type ConnectorCapability,
} from './types'
import type {
  AcknowledgementOutcome,
  AuthenticationOutcome,
  ConnectorContract,
  ConnectorHealthReport,
  ConnectorRequest,
  DiscoveredListing,
  PushOutcome,
  ReservationPage,
} from './connector'

/**
 * The one reason, written once.
 *
 * `retryable: false` because retrying will not conjure a credential, and a
 * scheduler that believed otherwise would poll an unconfigured channel for
 * ever. `not_configured` rather than `not_authenticated`: nobody failed to log
 * in, there is nothing to log in to.
 */
export function noCredentialRefusal(channelCode: ChannelCode): ChannelRefusal {
  return {
    kind: 'not_configured',
    retryable: false,
    message:
      `אין חיבור פעיל ל-${channelCode}. לא הוגדרו פרטי גישה לערוץ הזה ` +
      'במערכת, ולכן שום דבר לא נשלח אליו ושום דבר לא נמשך ממנו. היומן ' +
      'בערוץ אינו מתעדכן — מי שמוכר גם שם חייב להמשיך לעדכן ידנית.',
  }
}

/**
 * A connector that does nothing and says so.
 *
 * Note the empty `capabilities`. Wrapped in `guarded()`, every gated method is
 * refused with `capability_unsupported` before this object is reached — the
 * implementations below are the answer for anyone who calls it unguarded, and
 * they refuse for the more precise reason.
 */
export class NullConnector implements ConnectorContract {
  readonly capabilities: readonly ConnectorCapability[] = []

  constructor(readonly channelCode: ChannelCode) {}

  private no<T>(): Promise<ChannelResult<T>> {
    return Promise.resolve(refuse<T>(noCredentialRefusal(this.channelCode)))
  }

  authenticate(
    _request: ConnectorRequest,
  ): Promise<ChannelResult<AuthenticationOutcome>> {
    return this.no<AuthenticationOutcome>()
  }

  discoverListings(
    _request: ConnectorRequest,
  ): Promise<ChannelResult<readonly DiscoveredListing[]>> {
    return this.no<readonly DiscoveredListing[]>()
  }

  pushAvailability(): Promise<ChannelResult<PushOutcome>> {
    return this.no<PushOutcome>()
  }

  pushRates(): Promise<ChannelResult<PushOutcome>> {
    return this.no<PushOutcome>()
  }

  pushRestrictions(): Promise<ChannelResult<PushOutcome>> {
    return this.no<PushOutcome>()
  }

  pullReservations(): Promise<ChannelResult<ReservationPage>> {
    return this.no<ReservationPage>()
  }

  acknowledgeModification(): Promise<ChannelResult<AcknowledgementOutcome>> {
    return this.no<AcknowledgementOutcome>()
  }

  acknowledgeCancellation(): Promise<ChannelResult<AcknowledgementOutcome>> {
    return this.no<AcknowledgementOutcome>()
  }

  /**
   * Health answers, and the answer is "unreachable, because unconfigured".
   *
   * `ok: true` with `reachable: false` rather than a refusal: the question
   * "how is this channel doing" *was* answered, and the answer is bad news.
   * Refusing it would leave the health centre with nothing to render, which is
   * indistinguishable on screen from everything being fine.
   */
  health(
    _request: ConnectorRequest,
  ): Promise<ChannelResult<ConnectorHealthReport>> {
    return Promise.resolve({
      ok: true as const,
      value: {
        reachable: false,
        channelLastSeenAt: null,
        credentialsExpireAt: null,
        notes: [noCredentialRefusal(this.channelCode).message],
      },
    })
  }
}

/**
 * Which connector serves which channel, today.
 *
 * A function rather than a constant object, so the day a real connector exists
 * this is the one place that changes and every caller already reads it. A
 * `new NullConnector(...)` inlined at a call site is a decision nobody finds
 * again.
 */
export function connectorFor(channelCode: ChannelCode): ConnectorContract {
  return new NullConnector(channelCode)
}

/** Is anything at all connected? Today, and honestly, no. */
export function anyChannelConfigured(): boolean {
  return false
}
