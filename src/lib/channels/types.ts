/**
 * The channel manager's vocabulary.
 *
 * A channel manager is the thing that keeps one calendar in step with several
 * places that sell it. Everything in this file exists to make the two ways
 * that quietly fails impossible to express:
 *
 *   1. **A channel that cannot do something being asked to do it.** Not every
 *      OTA accepts a restriction push, and a connector that answers a request
 *      it cannot serve with a shrug produces a sync that reports success and
 *      changes nothing. So capability is a closed vocabulary, a connector
 *      DECLARES what it supports, and the engine refuses an unsupported call
 *      rather than making it and hoping — see `connector.ts`.
 *
 *   2. **A channel nobody named.** `CHANNEL_CODES` is closed and is mapped
 *      onto `BOOKING_SOURCES` by a total `Record`, so a channel added here
 *      without an attribution fails the typecheck instead of arriving as a
 *      booking from nowhere.
 *
 * ── This file holds no availability arithmetic, and never will ────────────
 *
 * `src/lib/booking/availability.ts` is the one engine. There is exactly one
 * definition of overlap, of a minimum stay, and of what occupies a night, and
 * a channel manager is the single most likely place for a second one to appear
 * — Booking.com's calendar looks like a calendar, and reimplementing "is this
 * night taken" against it is a two-hour job that produces a system with two
 * opinions about the same Friday. What travels through here is a *request* to
 * the availability engine and a *difference* against its answer. Nothing more.
 */

import type { Agorot, BookingSource, DateRange } from '../booking/types'

/* -------------------------------------------------------------- channels -- */

/**
 * Every channel this product can be connected to.
 *
 * `direct` is in the list and is not a mistake. It is ESTIA's own inventory —
 * the side of every comparison that is not an OTA — and naming it here is what
 * lets reconciliation say "the direct calendar and the Booking.com calendar
 * disagree" in one vocabulary instead of special-casing "us" everywhere.
 *
 * Adding a fifth is a change here, a change to `BOOKING_SOURCE_FOR_CHANNEL`,
 * and — if it needs its own `booking_source` enum member — a migration. That
 * is the intended cost: an unnamed channel is a booking whose origin nobody
 * can report on later.
 */
export const CHANNEL_CODES = [
  'booking_com',
  'airbnb',
  'expedia',
  'direct',
] as const

export type ChannelCode = (typeof CHANNEL_CODES)[number]

/**
 * How a booking from each channel is attributed.
 *
 * Total over `CHANNEL_CODES`, and every value is a member of the frozen
 * `BOOKING_SOURCES` contract — consumed, never extended. `expedia` maps to
 * `other_channel` because the booking enum does not name it individually and
 * widening a database enum is not this module's decision to take; the specific
 * channel survives on `sourceChannel`, which is exactly what that field is for.
 */
export const BOOKING_SOURCE_FOR_CHANNEL: Readonly<
  Record<ChannelCode, BookingSource>
> = {
  booking_com: 'booking_com',
  airbnb: 'airbnb',
  expedia: 'other_channel',
  direct: 'direct_website',
}

/** As the channel's own brand spells it. Proper nouns are not translated. */
export const CHANNEL_LABEL: Readonly<Record<ChannelCode, string>> = {
  booking_com: 'Booking.com',
  airbnb: 'Airbnb',
  expedia: 'Expedia',
  direct: 'ישיר',
}

/* ---------------------------------------------------------- capabilities -- */

/**
 * What a connector may be asked to do.
 *
 * One member per method on `ConnectorContract` that touches the outside world,
 * because the question "can this channel do X" has to be answerable without
 * calling X. `health` and `authenticate` are deliberately absent: every
 * connector must be able to say whether it is alive and whether it is
 * authenticated, including the one that is neither.
 */
export const CONNECTOR_CAPABILITIES = [
  'discover_listings',
  'push_availability',
  'push_rates',
  'push_restrictions',
  'pull_reservations',
  'acknowledge_modification',
  'acknowledge_cancellation',
  /** The channel can call us, rather than only being polled. */
  'receive_webhooks',
] as const

export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number]

export const CAPABILITY_LABEL: Readonly<Record<ConnectorCapability, string>> = {
  discover_listings: 'איתור מודעות',
  push_availability: 'שליחת זמינות',
  push_rates: 'שליחת מחירים',
  push_restrictions: 'שליחת מגבלות שהייה',
  pull_reservations: 'משיכת הזמנות',
  acknowledge_modification: 'אישור שינוי',
  acknowledge_cancellation: 'אישור ביטול',
  receive_webhooks: 'קבלת עדכונים יזומים',
}

/* --------------------------------------------------------------- results -- */

/**
 * Why a connector said no.
 *
 * Every one of these is an *expected* answer, which is why they are values and
 * not exceptions. A channel being rate-limited, a credential having expired,
 * or a connector simply not supporting rate push are all ordinary Tuesday
 * outcomes; a `throw` for any of them turns the sync loop into a place where
 * one channel's bad afternoon stops the other three.
 *
 * `retryable` is on the refusal rather than derived from the kind at the call
 * site, because the same kind is retryable in one channel and terminal in
 * another — a 429 with a Retry-After is not a 429 that means "your account is
 * suspended", and only the connector can tell them apart.
 */
export const CHANNEL_REFUSAL_KINDS = [
  /** No connection record, or one that was never activated. */
  'not_configured',
  /** The connector does not declare this capability. Never attempted. */
  'capability_unsupported',
  'not_authenticated',
  'credentials_expired',
  'rate_limited',
  /** The channel answered, and the answer was no. */
  'channel_rejected',
  /** The channel did not answer, or answered with something unusable. */
  'channel_unavailable',
  /** We built a request the channel considers malformed. Ours to fix. */
  'invalid_request',
  /** The entity has no mapping, so there is nothing to address. */
  'mapping_missing',
] as const

export type ChannelRefusalKind = (typeof CHANNEL_REFUSAL_KINDS)[number]

export interface ChannelRefusal {
  kind: ChannelRefusalKind
  /** Hebrew, and specific enough that a person knows what to do next. */
  message: string
  /** Safe to try again unchanged. `false` means something must change first. */
  retryable: boolean
  /** The channel's own words, when it gave any. Never a credential. */
  detail?: string
  /** Present on `capability_unsupported`, so the log names what was refused. */
  capability?: ConnectorCapability
  retryAfterSeconds?: number
}

/**
 * Every outward call answers with one of these.
 *
 * A discriminated union rather than `T | null`, because "the push did not
 * happen" and "the push happened and changed nothing" are different sentences
 * and a nullable return flattens them into the same one.
 */
export type ChannelResult<T> =
  { ok: true; value: T } | { ok: false; refusal: ChannelRefusal }

export function refuse<T>(refusal: ChannelRefusal): ChannelResult<T> {
  return { ok: false, refusal }
}

export function succeed<T>(value: T): ChannelResult<T> {
  return { ok: true, value }
}

/* ------------------------------------------------------------ connectors -- */

export const CONNECTOR_STATES = [
  /** A record exists; nobody has authenticated it. */
  'draft',
  /** Authenticated, listings discovered, mappings not yet validated. */
  'connecting',
  'active',
  /** A person stopped it. Nothing is pushed or pulled. */
  'paused',
  /** The channel stopped it: revoked token, closed account. */
  'disconnected',
] as const

export type ConnectorState = (typeof CONNECTOR_STATES)[number]

/**
 * One channel, connected to one organization.
 *
 * **No credential lives on this type, and none may.** The same decision
 * `payment_collection_settings` took for the card processor and
 * `site_generation_requests` took for the AI provider: the record holds the
 * NAME of a credential and never its value, so the product can say "nothing is
 * configured" without ever having read a secret. `credentialRef` is a pointer
 * into a secret store this deployment does not have — see `null-connector.ts`.
 */
export interface Connector {
  id: string
  organizationId: string
  /** `null` for an organization-wide connection covering every property. */
  propertyId: string | null
  channelCode: ChannelCode
  state: ConnectorState
  /** What this connector will actually do. The engine reads it before calling. */
  capabilities: readonly ConnectorCapability[]
  /** A name in a secret store. Never a secret. `null` when unconfigured. */
  credentialRef: string | null
  /** When the credential stops working, if the channel tells us. */
  credentialsExpireAt: Date | null
  /** The channel's own account identifier, for support conversations. */
  externalAccountId: string | null
  lastInboundSyncAt: Date | null
  lastOutboundSyncAt: Date | null
  lastWebhookAt: Date | null
  createdAt: Date
  updatedAt: Date
  version: number
}

/* --------------------------------------------------------------- listings -- */

/**
 * A thing the channel sells, as the channel describes it.
 *
 * Raw. Nothing here has been matched to anything in ESTIA yet — that is
 * `mapping.ts` — and keeping the discovered record separate from the mapping
 * is what allows a listing to be discovered, looked at, and left unmapped
 * without inventing a unit for it.
 */
export interface Listing {
  id: string
  organizationId: string
  connectorId: string
  channelCode: ChannelCode
  /** The channel's identifier. Stable across renames; the name is not. */
  externalListingId: string
  /**
   * A room type or rate plan inside the listing.
   *
   * `null` for a whole-property listing. Present when one Booking.com listing
   * sells three different rooms, which is the case that makes a mapping keyed
   * on the listing alone silently collapse three units into one.
   */
  externalVariantId: string | null
  name: string
  /** Beds, guests — whatever the channel published. Advisory, never a rule. */
  maxOccupancy: number | null
  /** The channel has taken it off sale. Not the same as unmapped. */
  active: boolean
  discoveredAt: Date
}

export const MAPPING_STATES = [
  /** Matched by a person, not yet checked against the unit. */
  'draft',
  /** Checked: the unit exists, is sellable, and nothing else claims it. */
  'validated',
  /** Live. Availability and rates flow. */
  'active',
  /** Deliberately stopped. The listing stays discovered. */
  'suspended',
] as const

export type MappingState = (typeof MAPPING_STATES)[number]

/**
 * One listing, one unit.
 *
 * The key is `(channelCode, externalListingId, externalVariantId)` and not the
 * listing alone — see `Listing.externalVariantId`. The unit side is
 * `(propertyId, unitId)` and both are recorded, because a reservation arrives
 * naming a listing and every downstream system needs the property to answer a
 * scope question about it.
 */
export interface ListingMapping {
  id: string
  organizationId: string
  connectorId: string
  channelCode: ChannelCode
  externalListingId: string
  externalVariantId: string | null
  propertyId: string
  unitId: string
  state: MappingState
  /** Who matched it, and when. A mapping is a decision, not a computation. */
  mappedByUserId: string | null
  mappedAt: Date
  version: number
}

/* ---------------------------------------------------------- reservations -- */

/**
 * What an OTA says about a stay.
 *
 * The channel's own status, not ESTIA's — a `BookingStatus` here would be this
 * module deciding what "confirmed at Booking.com" means to the business, which
 * is `ingestion.ts`'s job and is a decision, not a rename.
 */
export const CHANNEL_RESERVATION_STATUSES = [
  'new',
  'modified',
  'cancelled',
] as const

export type ChannelReservationStatus =
  (typeof CHANNEL_RESERVATION_STATUSES)[number]

export interface ChannelReservation {
  channelCode: ChannelCode
  /** The channel's reservation id. Half of the idempotency key, always. */
  externalReservationId: string
  externalListingId: string
  externalVariantId: string | null
  status: ChannelReservationStatus
  /**
   * The channel's own revision counter, when it has one.
   *
   * The other half of what makes a modification distinguishable from a
   * redelivery of the original. A channel with no revision counter gets `null`
   * and is compared on content instead — see `contentFingerprint`.
   */
  revision: number | null
  stay: DateRange
  guestName: string
  guestCount: number
  adults: number | null
  children: number | null
  infants: number | null
  /** What the guest is paying the channel, gross. Integer agorot. */
  grossAgorot: Agorot
  /** What the business will actually receive, when the channel states it. */
  netAgorot: Agorot | null
  /** ISO 4217. Refused rather than converted when it is not the org's. */
  currency: string
  /** When the channel says it happened. Never when we read it. */
  externalCreatedAt: Date
  externalModifiedAt: Date | null
  /** Free text the channel attached. Shown, never parsed for rules. */
  note: string | null
}

/**
 * What ESTIA remembers about a reservation it has already seen.
 *
 * The dedupe ledger. `bookingId` is nullable because a reservation can be
 * legitimately received and *not* produce a booking — an unmapped listing
 * produces an exception, and that outcome must still be remembered or the next
 * redelivery raises the same exception again.
 */
export interface ChannelReservationRecord {
  id: string
  organizationId: string
  connectorId: string
  channelCode: ChannelCode
  externalReservationId: string
  /** `channel:<code>:<id>`. Unique per organization. The whole guarantee. */
  ledgerKey: string
  revision: number | null
  /** Hash of the content, for channels that do not number their revisions. */
  contentFingerprint: string
  bookingId: string | null
  lastStatus: ChannelReservationStatus
  firstSeenAt: Date
  lastSeenAt: Date
}

/* ------------------------------------------------------- outbound pushes -- */

export interface RateUpdate {
  channelCode: ChannelCode
  externalListingId: string
  externalVariantId: string | null
  /** One night. A range is expanded by the caller, never inferred here. */
  date: string
  amountAgorot: Agorot
  currency: string
}

/**
 * A stay rule pushed outward.
 *
 * These mirror `UnitAvailabilityRules` in the availability engine and are
 * *derived from* it, never authored here. A restriction this module invented
 * would be a second minimum-stay rule with no test against the first.
 */
export interface RestrictionUpdate {
  channelCode: ChannelCode
  externalListingId: string
  externalVariantId: string | null
  date: string
  minimumNights: number | null
  closedToArrival: boolean
  closedToDeparture: boolean
  /** The night is not sellable at all. */
  closed: boolean
}

/** One night's free/busy, as an external seller is allowed to see it. */
export interface AvailabilityUpdate {
  channelCode: ChannelCode
  externalListingId: string
  externalVariantId: string | null
  date: string
  /** `0` or `1` for a whole-unit listing. Never a booking, never a name. */
  unitsAvailable: number
}

/* ---------------------------------------------------------------- health -- */

export const SYNC_STATES = [
  /** Nothing has ever run. Not a failure. */
  'never_synced',
  'healthy',
  /** Working, but something is behind or a queue is building. */
  'degraded',
  /** Recent attempts are failing. Calendars are drifting right now. */
  'failing',
  /** The channel or a person stopped it. Nothing is expected to flow. */
  'stopped',
] as const

export type SyncState = (typeof SYNC_STATES)[number]

export const SYNC_STATE_LABEL: Readonly<Record<SyncState, string>> = {
  never_synced: 'טרם סונכרן',
  healthy: 'תקין',
  degraded: 'מתעכב',
  failing: 'נכשל',
  stopped: 'מושהה',
}

/**
 * The direction a sync ran in, because they fail differently.
 *
 * Inbound falling behind means bookings are missing from ESTIA. Outbound
 * falling behind means the channel is still selling nights that are gone. Both
 * are drift; only the second one sells the same Friday twice.
 */
export const SYNC_DIRECTIONS = ['inbound', 'outbound'] as const

export type SyncDirection = (typeof SYNC_DIRECTIONS)[number]

export interface SyncStatus {
  connectorId: string
  channelCode: ChannelCode
  state: SyncState
  lastInboundSyncAt: Date | null
  lastOutboundSyncAt: Date | null
  lastWebhookAt: Date | null
  /** Entities waiting to go out. A number that only grows is the alarm. */
  pendingOutbound: number
  /** Failures inside the health window. */
  recentFailures: number
  /** The specific listings or dates that could not be pushed. */
  failedEntities: readonly string[]
  credentialsExpireAt: Date | null
  openExceptions: number
  /** Hebrew, one line per thing wrong. Empty when the state is healthy. */
  concerns: readonly string[]
}

/* ------------------------------------------------------------ exceptions -- */

/**
 * Everything the channel manager refuses to decide on its own.
 *
 * An exception is not an error log. It is a row a person works, and each kind
 * exists because the alternative to somebody looking at it is the system
 * guessing — and every guess available here is one that either drops a real
 * booking or sells a night twice.
 */
export const CHANNEL_EXCEPTION_KINDS = [
  /** A reservation arrived for a listing nothing is mapped to. */
  'mapping_missing',
  /** Two mappings claim the same listing. Guessing picks a unit at random. */
  'duplicate_mapping',
  /** ESTIA and the channel disagree about whether a night is free. */
  'availability_mismatch',
  'rate_push_failed',
  /** A webhook arrived describing a state older than what we already hold. */
  'stale_webhook',
  /** The channel referenced a reservation ESTIA has never seen. */
  'unknown_booking',
  /** The OTA changed something a person had already changed here. */
  'modification_conflict',
  /**
   * A cancellation that cannot simply be applied — the guest has arrived, or
   * the stay is over. Separate from `modification_conflict` because the
   * resolution is a money conversation, not a calendar one.
   */
  'cancellation_conflict',
  /** The same stay arrived twice under two different reservation ids. */
  'duplicate_booking',
  /**
   * The channel sent something ESTIA cannot turn into a booking at all —
   * inverted dates, no guests, a currency this organization does not trade in.
   * Raised rather than coerced: guessing at any of those writes a wrong
   * booking, and dropping it loses a stay somebody has paid for.
   */
  'invalid_reservation',
] as const

export type ChannelExceptionKind = (typeof CHANNEL_EXCEPTION_KINDS)[number]

export const EXCEPTION_SEVERITIES = ['warning', 'urgent', 'critical'] as const

export type ExceptionSeverity = (typeof EXCEPTION_SEVERITIES)[number]

export const EXCEPTION_STATES = [
  'open',
  /** Somebody has seen it. Still open; no longer new. */
  'acknowledged',
  'resolved',
  /** Deliberately not acted on, with a reason. Not the same as resolved. */
  'dismissed',
] as const

export type ExceptionState = (typeof EXCEPTION_STATES)[number]

export interface ChannelException {
  id: string
  organizationId: string
  connectorId: string | null
  channelCode: ChannelCode
  kind: ChannelExceptionKind
  severity: ExceptionSeverity
  state: ExceptionState
  /** Hebrew. What happened, in the terms of the business. */
  title: string
  /** Hebrew. Enough detail to act without opening the channel's own site. */
  detail: string
  /** The channel-side thing this is about, when there is one. */
  externalReservationId: string | null
  externalListingId: string | null
  /** The ESTIA-side thing, when one exists. */
  bookingId: string | null
  unitId: string | null
  propertyId: string | null
  /**
   * Stable per underlying problem, so the same unmapped listing arriving
   * every four minutes is one row and not four hundred.
   */
  dedupeKey: string
  occurredAt: Date
  resolvedAt: Date | null
  resolvedByUserId: string | null
  resolutionNote: string | null
}

/**
 * The systems a change reaches.
 *
 * Closed, and named rather than described, because the whole value of stating
 * a delta is being able to say *what else* has to move. A date change that
 * nobody realises touches the laundry order is a stripped bed on a Friday.
 */
export const DOWNSTREAM_SYSTEMS = [
  'availability',
  'preparation',
  'tasks',
  'laundry',
  'inventory',
  'access',
  'revenue',
] as const

export type DownstreamSystem = (typeof DOWNSTREAM_SYSTEMS)[number]

export const DOWNSTREAM_LABEL: Readonly<Record<DownstreamSystem, string>> = {
  availability: 'זמינות',
  preparation: 'הכנת היחידה',
  tasks: 'משימות',
  laundry: 'כביסה',
  inventory: 'מלאי',
  access: 'כניסה וקודים',
  revenue: 'הכנסות',
}
