/**
 * The website vocabulary.
 *
 * ── Why these tuples are here and not in `src/lib/contracts/states.ts` ────
 *
 * They belong there. Every other module's enums are transcribed into the
 * migration FROM that file, in order, and the order is load-bearing because an
 * enum's ordinal is what `order by` sorts on. `states.ts` belongs to the
 * coordinator and this worker may not write it, so the tuples live here, the
 * migration transcribes them from here, and the report asks for them to be
 * moved. When they move, this file re-exports them and there is still one
 * declaration — what must never happen is a second copy appearing in
 * `states.ts` while this one stays.
 *
 * ══ THE ONE RULE THE WHOLE MODULE TURNS ON ═══════════════════════════════
 *
 *   A PUBLISHED SENTENCE MUST BE TRACEABLE TO A ROW.
 *
 * `SiteFactSource` is where that rule becomes a type rather than a promise.
 * Every claim a section makes carries one, and `authored` — a person typed it
 * and stands behind it — is a source like any other. What does not exist is a
 * value meaning "we do not know where this came from": a claim with no source
 * cannot be represented, so it cannot be stored, so it cannot be published.
 *
 * See `facts.ts` for the engine and `snapshot.ts` for the moment the rule is
 * enforced.
 */

/* ------------------------------------------------------------ the site --- */

/**
 * Where a site is in its life.
 *
 * `draft` is a site nobody outside the business has ever seen. `published`
 * has a live snapshot. `unpublished` HAS a snapshot and has been taken down —
 * distinct from `draft`, because the versions are still there to roll back to
 * and a business that took its site down has not lost its work.
 */
export const SITE_STATUSES = ['draft', 'published', 'unpublished'] as const
export type SiteStatus = (typeof SITE_STATUSES)[number]

/**
 * What a page is for.
 *
 * Not decoration: `booking` is the page the availability engine renders on,
 * `property` is the page whose facts come from a property row, and the studio
 * refuses to bind a property section to a `policy` page.
 */
export const SITE_PAGE_KINDS = [
  'home',
  'property',
  'units',
  'amenities',
  'gallery',
  'location',
  'booking',
  'contact',
  'policy',
  'custom',
] as const
export type SitePageKind = (typeof SITE_PAGE_KINDS)[number]

/** What a block on a page is. Each one declares which facts it may consume. */
export const SITE_SECTION_KINDS = [
  'hero',
  'rich_text',
  'property_intro',
  'unit_grid',
  'amenity_list',
  'gallery',
  'location_map',
  'contact_details',
  'booking_widget',
  'faq',
  'cta',
] as const
export type SiteSectionKind = (typeof SITE_SECTION_KINDS)[number]

/* ------------------------------------------------------ where facts come -- */

/**
 * WHERE A PUBLISHED SENTENCE CAME FROM.
 *
 * The heart of the module. Seven canonical sources and one honest human one:
 *
 *   `organization`  the tenant's own name
 *   `property`      `public.properties` — name, description, address, times,
 *                   house rules, the cancellation paragraph
 *   `unit`          `public.units` — capacity, bedrooms, beds, size, rates
 *   `amenity`       `public.amenities` through the two join tables
 *   `pricing`       the canonical pricing engine's output for a real request
 *   `availability`  the canonical availability engine's output
 *   `media`         a `site_media` row, which itself points at a real file
 *   `authored`      a person wrote it and stands behind it
 *
 * There is deliberately no `generated` member. A model's draft is not a
 * source; it is a proposal, and it becomes `authored` at the moment a person
 * with `site.edit_content` accepts it — which is the only way an AI sentence
 * ever reaches a published page.
 */
export const SITE_FACT_SOURCES = [
  'organization',
  'property',
  'unit',
  'amenity',
  'pricing',
  'availability',
  'media',
  'authored',
] as const
export type SiteFactSource = (typeof SITE_FACT_SOURCES)[number]

/** The canonical ones. `authored` is a person, not a table, and is excluded. */
export const CANONICAL_FACT_SOURCES: readonly SiteFactSource[] = [
  'organization',
  'property',
  'unit',
  'amenity',
  'pricing',
  'availability',
  'media',
]

/* ------------------------------------------------------------- domains --- */

/**
 * A custom hostname's life.
 *
 * `pending` is a hostname somebody typed. `verifying` means the DNS record was
 * asked for. `verified` means it answered. `failed` records that it did not,
 * with a reason, because "it doesn't work" is the support call this status
 * exists to prevent. `released` is a hostname the business gave up, kept as a
 * row so the history of which domain served which snapshot survives.
 */
export const SITE_DOMAIN_STATUSES = [
  'pending',
  'verifying',
  'verified',
  'failed',
  'released',
] as const
export type SiteDomainStatus = (typeof SITE_DOMAIN_STATUSES)[number]

/* ------------------------------------------------------------- quality --- */

/** The four passes the specification asks for, in the order they run. */
export const SITE_QUALITY_KINDS = [
  'content',
  'conversion',
  'technical',
  'pre_publish',
] as const
export type SiteQualityKind = (typeof SITE_QUALITY_KINDS)[number]

/**
 * How much a finding matters.
 *
 * `blocker` is the only one that stops a publish, and only three checks can
 * raise one — all three about a claim that cannot be sourced. Everything else
 * is advice a person may take or leave, because a quality tool that refuses to
 * let somebody publish their own website is a tool they turn off.
 */
export const SITE_FINDING_SEVERITIES = ['blocker', 'warning', 'advice'] as const
export type SiteFindingSeverity = (typeof SITE_FINDING_SEVERITIES)[number]

/**
 * What a person did about a finding.
 *
 * `not_assessed` is a first-class outcome and the reason this list is not
 * three long. A check that cannot be sourced from real data reports
 * `not_assessed` rather than inventing a score — see `quality.ts`. Scoring an
 * unmeasurable thing is how a quality report becomes decoration.
 */
export const SITE_FINDING_STATUSES = [
  'open',
  'accepted',
  'dismissed',
  'resolved',
  'not_assessed',
] as const
export type SiteFindingStatus = (typeof SITE_FINDING_STATUSES)[number]

/* ---------------------------------------------------------- generation --- */

/**
 * What happened to a request for generated copy.
 *
 * `refused` is not a failure state. There is no model client in this codebase
 * and the null implementation refuses honestly; a refusal is the ordinary
 * outcome today and it is recorded, with its reason, so that the studio can
 * say "generation is not configured" instead of spinning.
 */
export const SITE_GENERATION_STATUSES = [
  'requested',
  'refused',
  'drafted',
  'accepted',
  'discarded',
] as const
export type SiteGenerationStatus = (typeof SITE_GENERATION_STATUSES)[number]

/* ----------------------------------------------------- booking requests --- */

/**
 * A direct enquiry from the public site.
 *
 * NOT a booking, and the vocabulary says so. A visitor with no account cannot
 * hold a calendar — the exclusion constraint in 0009 is what stops a double
 * booking and it is reached through `defineBookingOperations`, which needs an
 * actor. So the public site produces a request, a person confirms it through
 * the ordinary booking screen, and nothing here ever writes to `bookings`.
 */
export const SITE_BOOKING_REQUEST_STATUSES = [
  'new',
  'contacted',
  'converted',
  'declined',
  'expired',
] as const
export type SiteBookingRequestStatus =
  (typeof SITE_BOOKING_REQUEST_STATUSES)[number]

/* ------------------------------------------------------- domain objects --- */

export type Site = {
  id: string
  organizationId: string
  /** NULL means the site presents the whole organization. */
  propertyId: string | null
  slug: string
  name: string
  status: SiteStatus
  locale: string
  /** The snapshot a visitor is served. NULL until the first publish. */
  publishedVersionId: string | null
  publishedAt: string | null
  publishedBy: string | null
  design: SiteDesign
  version: number
}

/**
 * The look, as tokens rather than as CSS.
 *
 * Stored as a bounded record so a design edit cannot become an injection
 * point: the public renderer maps these onto CSS custom properties and never
 * interpolates a stored string into a style attribute unchecked. See
 * `design.ts`.
 */
export type SiteDesign = {
  palette: 'sand' | 'olive' | 'sea' | 'stone' | 'night'
  /** A display font choice, from a fixed list. Never an arbitrary font URL. */
  headingFont: 'system' | 'serif' | 'display'
  radius: 'sharp' | 'soft' | 'round'
  density: 'comfortable' | 'compact'
  /** A `site_media` id. Never an arbitrary URL. */
  logoMediaId: string | null
}

export const DEFAULT_SITE_DESIGN: SiteDesign = Object.freeze({
  palette: 'sand',
  headingFont: 'system',
  radius: 'soft',
  density: 'comfortable',
  logoMediaId: null,
})

export type SitePage = {
  id: string
  organizationId: string
  siteId: string
  /** `''` is the home page. Every other page has a slug. */
  slug: string
  kind: SitePageKind
  title: string
  navLabel: string | null
  showInNav: boolean
  sortOrder: number
  isActive: boolean
  seo: SiteSeo | null
}

export type SiteSeo = {
  pageId: string
  metaTitle: string | null
  metaDescription: string | null
  canonicalUrl: string | null
  ogMediaId: string | null
  /** False keeps the page out of search engines. Default true. */
  indexable: boolean
}

/**
 * One block on one page.
 *
 * `claims` is the part that matters. A section does not hold prose; it holds
 * claims, each of which knows where it came from. Rendering reads `claims`,
 * the quality passes read `claims`, and the publish gate reads `claims`.
 */
export type SiteSection = {
  id: string
  organizationId: string
  siteId: string
  pageId: string
  kind: SiteSectionKind
  sortOrder: number
  isActive: boolean
  /**
   * What this section is bound to, when it is bound to something. A
   * `property_intro` with no `sourceId` has nothing to say and the quality
   * pass raises a blocker rather than the renderer inventing a villa.
   */
  boundTo: SiteBinding | null
  claims: readonly SiteClaim[]
  /** Presentation only. Never prose, never a fact. */
  layout: Record<string, unknown>
}

export type SiteBinding = {
  source: Extract<SiteFactSource, 'property' | 'unit' | 'amenity' | 'media'>
  id: string
}

/**
 * One assertion the published page makes, and its provenance.
 *
 * `key` is what the renderer asks for — `heading`, `body`, `bedrooms`. `text`
 * is what is shown. `source` and `sourceId` are how it can be checked. There
 * is no constructor here that omits a source; see `facts.ts`.
 */
export type SiteClaim = {
  key: string
  text: string
  source: SiteFactSource
  /** The row this came from. NULL is legal only for `authored`. */
  sourceId: string | null
  /**
   * The column or field on that row, when the source is canonical. `name`,
   * `description`, `max_guests`. Recorded so a stale claim can be found when
   * the row changes underneath it.
   */
  sourceField: string | null
  /** What the source said when the claim was made. Used to detect drift. */
  sourceValue: string | null
}

export type SiteMedia = {
  id: string
  organizationId: string
  siteId: string
  url: string
  /** Hebrew. A published image with no alt text is a technical finding. */
  altText: string | null
  width: number | null
  height: number | null
  contentType: string | null
  /** When the image came from a property or unit row rather than an upload. */
  boundTo: SiteBinding | null
}

export type SiteVersion = {
  id: string
  organizationId: string
  siteId: string
  versionNumber: number
  label: string | null
  publishedAt: string
  publishedBy: string | null
  /** Set when this version was created by rolling back to an earlier one. */
  restoredFromVersionId: string | null
  snapshot: SiteSnapshot
}

/**
 * What a visitor is actually served.
 *
 * Immutable and complete. The public route reads this and nothing else — not
 * the draft tables, not the property rows, not the pricing engine's
 * configuration. That is what makes "a visitor must never see an unpublished
 * change" a property of the data rather than of every query remembering to
 * filter.
 *
 * Availability and price are the two exceptions and they are not stored here
 * at all: they are computed live from the canonical engines at request time,
 * because a snapshot of who is free next Tuesday would be a lie within hours.
 * See `public.ts`.
 */
export type SiteSnapshot = {
  siteId: string
  slug: string
  name: string
  locale: string
  design: SiteDesign
  organizationName: string
  pages: readonly SiteSnapshotPage[]
  media: readonly SiteMedia[]
  /**
   * Which units this site may quote and check availability for. Resolved at
   * publish time from the bound properties, so an unpublished draft that adds
   * a unit cannot make that unit bookable on the live site.
   */
  bookableUnitIds: readonly string[]
  /** Every claim in the snapshot, flattened. What the audit reads. */
  factManifest: readonly SiteClaim[]
  builtAt: string
}

export type SiteSnapshotPage = {
  slug: string
  kind: SitePageKind
  title: string
  navLabel: string | null
  showInNav: boolean
  sortOrder: number
  seo: SiteSeo | null
  sections: readonly SiteSection[]
}

export type SiteDomain = {
  id: string
  organizationId: string
  siteId: string
  hostname: string
  status: SiteDomainStatus
  verificationToken: string
  verifiedAt: string | null
  failureReason: string | null
  isPrimary: boolean
}

export type SiteQualityFinding = {
  id: string
  runId: string
  checkCode: string
  kind: SiteQualityKind
  severity: SiteFindingSeverity
  status: SiteFindingStatus
  title: string
  detail: string
  pageSlug: string | null
  sectionId: string | null
}

export type SiteQualityRun = {
  id: string
  organizationId: string
  siteId: string
  kind: SiteQualityKind
  ranAt: string
  ranBy: string | null
  findings: readonly SiteQualityFinding[]
}

export type SiteBookingRequest = {
  id: string
  organizationId: string
  siteId: string
  propertyId: string | null
  unitId: string | null
  checkIn: string
  checkOut: string
  adults: number
  children: number
  infants: number
  contactName: string
  contactPhone: string
  contactEmail: string | null
  message: string | null
  status: SiteBookingRequestStatus
  /** The quote the visitor was shown, in agorot. Never re-derived on read. */
  quotedTotalAgorot: number | null
  createdAt: string
}
