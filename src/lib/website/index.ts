/**
 * The website domain, in one import.
 *
 * ── What a reader should look at first ────────────────────────────────────
 *
 * `facts.ts`. Everything else in this module is arranged around the rule it
 * enforces: a claim that cannot be traced to a row is not published. The
 * studio, the renderer, the quality passes and the AI port are all downstream
 * of that one file, and 0042's `site_sections_claims_sourced` is the floor
 * beneath it.
 *
 * Then `snapshot.ts`, for the second half of the promise: the public route
 * reads a published version and has no query against a draft table to forget a
 * filter in.
 */

export * from './types'

export {
  allClaims,
  authoredClaim,
  claimFromRow,
  driftedClaims,
  groundDraft,
  publishBlockers,
  unsourcedClaims,
  type DriftedClaim,
  type GeneratedDraft,
  type GroundingResult,
  type SourceRow,
  type UnsourcedClaim,
} from './facts'

export {
  amenityClaim,
  amenityClaims,
  factsForSection,
  propertyClaims,
  unitClaims,
  type SectionFactInput,
} from './content'

export {
  buildSnapshot,
  claimText,
  claimTexts,
  mediaOf,
  navigationOf,
  pageOf,
  type SnapshotInput,
  type SnapshotResult,
} from './snapshot'

export {
  SITE_TRANSITIONS,
  SiteClaimsUnsourcedError,
  SitePublishRefusedError,
  assertTransition,
  hasUnpublishedChanges,
  liveVersion,
  nextVersionNumber,
  rollbackTargets,
  transitionRefusal,
  type SiteAction,
} from './publish'

export {
  SITE_DENSITIES,
  SITE_HEADING_FONTS,
  SITE_PALETTES,
  SITE_RADII,
  cssVariables,
  isDarkPalette,
  readDesign,
} from './design'

export {
  blocksPublish,
  runAllPasses,
  runQualityPass,
  snapshotQualityInput,
  summarize,
  type Finding,
  type QualityInput,
} from './quality'

export {
  fixedContentGenerator,
  nullContentGenerator,
  type ContentGenerator,
  type GenerationBrief,
  type GenerationOutcome,
  type GenerationRequest,
} from './ai'

export {
  SITE_REFUSAL_CODES,
  SiteRefusedError,
  publicAvailability,
  publicCalendar,
  publicQuote,
  publicRateFacts,
  publicSite,
  sendBookingRequest,
  submissionKeyFor,
  type BookingRequestInput,
  type PublicRateFacts,
  type PublicSite,
} from './public'

export { WebsiteRepository, isModuleAbsent, tolerant } from './repository'

export {
  RESERVED_PAGE_SLUGS,
  defineWebsiteOperations,
  type CreatedSite,
  type GenerationResult,
  type PageDraft,
  type PublishedSite,
  type RolledBackSite,
  type SectionDraft,
  type SiteDraft,
  type WebsiteOperations,
} from './operations'

export {
  BOOKING_REQUEST_STATUS_LABEL,
  DENSITY_LABEL,
  FONT_LABEL,
  PALETTE_LABEL,
  RADIUS_LABEL,
  DOMAIN_STATUS_LABEL,
  FACT_SOURCE_LABEL,
  FINDING_SEVERITY_LABEL,
  FINDING_STATUS_LABEL,
  GENERATION_STATUS_LABEL,
  QUALITY_KIND_LABEL,
  SITE_PAGE_KIND_LABEL,
  SITE_SECTION_KIND_LABEL,
  SITE_STATUS_LABEL,
  SITE_STATUS_SUMMARY,
} from './labels'
