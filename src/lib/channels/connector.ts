/**
 * The contract every channel connector implements, and the guard around it.
 *
 * ── Nothing here throws for a refusal ─────────────────────────────────────
 *
 * Every method answers with a `ChannelResult`. A channel that is rate-limited,
 * a token that expired overnight, a listing the channel no longer recognises —
 * these are the ordinary weather of an integration, and modelling them as
 * exceptions produces a sync loop where one channel's bad afternoon aborts the
 * other three before they run. An exception thrown out of a connector means
 * the connector itself is broken, which is a different and much rarer thing.
 *
 * ── A connector declares what it can do, and the engine believes it ───────
 *
 * `capabilities` is not documentation. `guarded()` below wraps a connector so
 * that a call to something it did not declare is **refused without being
 * made**, and the refusal names the capability. The failure this prevents is
 * specific and silent: a connector whose `pushRestrictions` returns
 * `succeed({ accepted: 0 })` because the channel has no such endpoint. The
 * sync log then reads green, the minimum-stay rule never reaches the channel,
 * and the first anybody hears of it is a one-night booking on a three-night
 * weekend.
 *
 * So the engine never calls a connector directly. It calls the guard, and the
 * guard is the thing that knows the difference between "tried and failed" and
 * "was never going to work".
 *
 * ── What a connector is not allowed to decide ─────────────────────────────
 *
 * A connector translates. It does not map a listing to a unit, it does not
 * create a booking, and it does not decide what a channel's "confirmed" means
 * to the business. It hands back `ChannelReservation` — the channel's own
 * words, normalised — and `ingestion.ts` decides what happens next.
 */

import {
  refuse,
  type AvailabilityUpdate,
  type ChannelCode,
  type ChannelReservation,
  type ChannelResult,
  type ConnectorCapability,
  type Listing,
  type RateUpdate,
  type RestrictionUpdate,
} from './types'

/* --------------------------------------------------------------- inputs -- */

export interface ConnectorRequest {
  organizationId: string
  connectorId: string
  /** Ties a connector call to the operation that caused it, end to end. */
  correlationId: string
  now: Date
}

/** A listing as the channel described it, before ESTIA has an id for it. */
export type DiscoveredListing = Omit<
  Listing,
  'id' | 'organizationId' | 'connectorId' | 'discoveredAt'
>

export interface AuthenticationOutcome {
  /** The channel's own account id, for support conversations. */
  externalAccountId: string
  expiresAt: Date | null
  /** What the channel says this account may do. Narrows `capabilities`. */
  grantedCapabilities: readonly ConnectorCapability[]
}

/**
 * The result of one outward push.
 *
 * `accepted` and `rejected` are counted separately and the rejected entities
 * are named, because "the push worked" over a batch where nine of two hundred
 * dates bounced is the most expensive kind of true statement in this module.
 */
export interface PushOutcome {
  accepted: number
  rejected: number
  /** `listingId:date` for each entity the channel would not take. */
  rejectedEntities: readonly string[]
}

export interface ReservationPage {
  reservations: readonly ChannelReservation[]
  /** Opaque. Hand it back unchanged on the next call. `null` when done. */
  cursor: string | null
  /** The channel has more waiting. Used to decide whether to loop. */
  hasMore: boolean
}

export interface AcknowledgementOutcome {
  externalReservationId: string
  acknowledgedAt: Date
}

export interface ConnectorHealthReport {
  reachable: boolean
  /** The channel's own view of when it last accepted something from us. */
  channelLastSeenAt: Date | null
  credentialsExpireAt: Date | null
  /** Hebrew. What the channel is complaining about, if anything. */
  notes: readonly string[]
}

/* ------------------------------------------------------------- contract -- */

export interface ConnectorContract {
  readonly channelCode: ChannelCode
  /**
   * What this connector will actually do.
   *
   * Read by `guarded()` before every gated call. A connector that lists a
   * capability it cannot serve is a bug in the connector; a connector that
   * omits one is simply a channel that does less, which is normal.
   */
  readonly capabilities: readonly ConnectorCapability[]

  /** Never gated: a connector that cannot authenticate must still say so. */
  authenticate(
    request: ConnectorRequest,
  ): Promise<ChannelResult<AuthenticationOutcome>>

  discoverListings(
    request: ConnectorRequest,
  ): Promise<ChannelResult<readonly DiscoveredListing[]>>

  pushAvailability(
    request: ConnectorRequest,
    updates: readonly AvailabilityUpdate[],
  ): Promise<ChannelResult<PushOutcome>>

  pushRates(
    request: ConnectorRequest,
    updates: readonly RateUpdate[],
  ): Promise<ChannelResult<PushOutcome>>

  pushRestrictions(
    request: ConnectorRequest,
    updates: readonly RestrictionUpdate[],
  ): Promise<ChannelResult<PushOutcome>>

  pullReservations(
    request: ConnectorRequest,
    options: { since: Date | null; cursor: string | null },
  ): Promise<ChannelResult<ReservationPage>>

  acknowledgeModification(
    request: ConnectorRequest,
    externalReservationId: string,
  ): Promise<ChannelResult<AcknowledgementOutcome>>

  acknowledgeCancellation(
    request: ConnectorRequest,
    externalReservationId: string,
  ): Promise<ChannelResult<AcknowledgementOutcome>>

  /** Never gated, for the same reason `authenticate` is not. */
  health(
    request: ConnectorRequest,
  ): Promise<ChannelResult<ConnectorHealthReport>>
}

/* ---------------------------------------------------------------- guard -- */

/** Which capability each gated method needs. Total over the gated methods. */
export const CAPABILITY_FOR_METHOD = {
  discoverListings: 'discover_listings',
  pushAvailability: 'push_availability',
  pushRates: 'push_rates',
  pushRestrictions: 'push_restrictions',
  pullReservations: 'pull_reservations',
  acknowledgeModification: 'acknowledge_modification',
  acknowledgeCancellation: 'acknowledge_cancellation',
} as const satisfies Readonly<Record<string, ConnectorCapability>>

export type GatedMethod = keyof typeof CAPABILITY_FOR_METHOD

export function supports(
  connector: ConnectorContract,
  capability: ConnectorCapability,
): boolean {
  return connector.capabilities.includes(capability)
}

/**
 * The refusal a missing capability produces.
 *
 * `retryable: false` and it is the important field: a scheduler that treats
 * this as retryable will call the same absent endpoint every four minutes
 * forever. Nothing about the request can change the answer — what has to
 * change is the connector.
 */
export function unsupported<T>(
  connector: ConnectorContract,
  capability: ConnectorCapability,
): ChannelResult<T> {
  return refuse<T>({
    kind: 'capability_unsupported',
    capability,
    retryable: false,
    message:
      `הערוץ ${connector.channelCode} אינו תומך בפעולה הזו, ולכן היא לא ` +
      'בוצעה. אין טעם לנסות שוב — יש לבצע את השינוי הזה ישירות בערוץ.',
  })
}

/**
 * Wrap a connector so an undeclared capability is refused, never attempted.
 *
 * The returned object is a `ConnectorContract` itself, so the engine holds one
 * type and cannot accidentally hold the unguarded connector — which is the
 * whole point. There is no unwrap.
 */
export function guarded(connector: ConnectorContract): ConnectorContract {
  const gate = <T>(
    method: GatedMethod,
    call: () => Promise<ChannelResult<T>>,
  ): Promise<ChannelResult<T>> => {
    const capability = CAPABILITY_FOR_METHOD[method]
    if (!supports(connector, capability)) {
      return Promise.resolve(unsupported<T>(connector, capability))
    }
    return call()
  }

  return {
    channelCode: connector.channelCode,
    capabilities: connector.capabilities,

    authenticate: (request) => connector.authenticate(request),
    health: (request) => connector.health(request),

    discoverListings: (request) =>
      gate('discoverListings', () => connector.discoverListings(request)),

    pushAvailability: (request, updates) =>
      gate('pushAvailability', () =>
        connector.pushAvailability(request, updates),
      ),

    pushRates: (request, updates) =>
      gate('pushRates', () => connector.pushRates(request, updates)),

    pushRestrictions: (request, updates) =>
      gate('pushRestrictions', () =>
        connector.pushRestrictions(request, updates),
      ),

    pullReservations: (request, options) =>
      gate('pullReservations', () =>
        connector.pullReservations(request, options),
      ),

    acknowledgeModification: (request, id) =>
      gate('acknowledgeModification', () =>
        connector.acknowledgeModification(request, id),
      ),

    acknowledgeCancellation: (request, id) =>
      gate('acknowledgeCancellation', () =>
        connector.acknowledgeCancellation(request, id),
      ),
  }
}
