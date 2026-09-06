/**
 * The channel manager, in one import.
 *
 * ── `repository.ts` is deliberately not re-exported ───────────────────────
 *
 * It imports `@/lib/persistence`, which reaches the `postgres` driver, which
 * needs `fs`. A Client Component that imported this barrel for a label would
 * take the whole application down with an error naming a file in
 * `node_modules` — the failure `scripts/client-bundle.mjs` exists to catch,
 * and which its header records as having happened three times in one day.
 *
 * So the barrel carries the pure domain only: types, the connector contract,
 * the engines. Anything that needs persistence imports
 * `@/lib/channels/repository` directly, from a Server Component, and the
 * bundle checker keeps that honest.
 */

export {
  BOOKING_SOURCE_FOR_CHANNEL,
  CAPABILITY_LABEL,
  CHANNEL_CODES,
  CHANNEL_EXCEPTION_KINDS,
  CHANNEL_LABEL,
  CHANNEL_REFUSAL_KINDS,
  CHANNEL_RESERVATION_STATUSES,
  CONNECTOR_CAPABILITIES,
  CONNECTOR_STATES,
  DOWNSTREAM_LABEL,
  DOWNSTREAM_SYSTEMS,
  EXCEPTION_SEVERITIES,
  EXCEPTION_STATES,
  MAPPING_STATES,
  SYNC_DIRECTIONS,
  SYNC_STATES,
  SYNC_STATE_LABEL,
  refuse,
  succeed,
  type AvailabilityUpdate,
  type ChannelCode,
  type ChannelException,
  type ChannelExceptionKind,
  type ChannelRefusal,
  type ChannelRefusalKind,
  type ChannelReservation,
  type ChannelReservationRecord,
  type ChannelReservationStatus,
  type ChannelResult,
  type Connector,
  type ConnectorCapability,
  type ConnectorState,
  type DownstreamSystem,
  type ExceptionSeverity,
  type ExceptionState,
  type Listing,
  type ListingMapping,
  type MappingState,
  type RateUpdate,
  type RestrictionUpdate,
  type SyncDirection,
  type SyncState,
  type SyncStatus,
} from './types'

export {
  CAPABILITY_FOR_METHOD,
  guarded,
  supports,
  unsupported,
  type AcknowledgementOutcome,
  type AuthenticationOutcome,
  type ConnectorContract,
  type ConnectorHealthReport,
  type ConnectorRequest,
  type DiscoveredListing,
  type GatedMethod,
  type PushOutcome,
  type ReservationPage,
} from './connector'

export {
  NullConnector,
  anyChannelConfigured,
  connectorFor,
  noCredentialRefusal,
} from './null-connector'

export {
  EXCEPTION_PLAYBOOK,
  SEVERITY_RANK,
  bySeverityThenAge,
  draftException,
  exceptionDedupeKey,
  playbookFor,
  tallyExceptions,
  type ChannelExceptionDraft,
  type ExceptionPlaybook,
  type ExceptionTally,
} from './exceptions'

export {
  MAPPING_PROBLEM_KINDS,
  ambiguousMappingException,
  inactiveMappingException,
  listingKey,
  listingsForUnit,
  planMappings,
  refOf,
  refOfListing,
  resolveListing,
  unmappedListingException,
  validateMapping,
  type ListingRef,
  type MappingDraft,
  type MappingPlan,
  type MappingPlanRow,
  type MappingProblem,
  type MappingProblemKind,
  type MappingResolution,
  type MappingValidation,
  type UnitFact,
} from './mapping'

export {
  contentFingerprint,
  ingestReservation,
  reservationLedgerKey,
  type BookingIntent,
  type DuplicateReason,
  type ExistingStay,
  type IngestionInput,
  type IngestionOutcome,
  type LedgerUpsert,
} from './ingestion'

export {
  DOWNSTREAM_FOR_FIELD,
  GRANT_FOR_FIELD,
  MODIFICATION_FIELDS,
  MODIFICATION_FIELD_LABEL,
  downstreamOf,
  planModification,
  type FieldChange,
  type FieldConflict,
  type LocalBookingState,
  type LocalEdit,
  type ModificationCommand,
  type ModificationField,
  type ModificationInput,
  type ModificationPlan,
} from './modification'

export {
  cancellationSummary,
  hasArrivedOrFinished,
  planCancellation,
  type CancellationInput,
  type CancellationPlan,
  type ReleaseStep,
} from './cancellation'

export {
  ASK_ALWAYS,
  DIFFERENCE_KINDS,
  DIFFERENCE_PRIORITY,
  RECONCILIATION_AUTHORITIES,
  byPriority,
  exceptionsFrom,
  openFor,
  reconcile,
  type AuthorityPolicy,
  type DifferenceKind,
  type ExternalDay,
  type ExternalReservationRef,
  type LocalReservationRef,
  type ReconciliationAuthority,
  type ReconciliationDecision,
  type ReconciliationInput,
  type ReconciliationReport,
  type RecommendedAction,
} from './reconciliation'

export {
  DEFAULT_THRESHOLDS,
  connectorHealth,
  describeAge,
  fleetHealth,
  type FleetHealth,
  type HealthInput,
  type HealthThresholds,
} from './health'
