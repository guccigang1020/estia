/**
 * EXECUTION CONTEXT — SERVER ONLY. Rows in, domain objects out.
 *
 * ── Flat queries, stitched here ───────────────────────────────────────────
 *
 * The same choice `src/lib/store/repository.ts` makes and for the same two
 * reasons: an embedded select ties the response shape to the foreign keys, and
 * the demo client resolves embeds through `DEMO_RELATIONS` in
 * `src/lib/demo/client.ts`, which belongs to another owner. An adapter needing
 * six new relations there would be an adapter this worker cannot land.
 *
 * ── Tenant scope in the query as well as in the policy ────────────────────
 *
 * Every read filters `organization_id` explicitly even though row level
 * security already does. `repository.test.ts` asserts it against the recorded
 * filters, so a missing scope is caught by a unit test rather than by a
 * customer seeing another customer's website.
 *
 * ── The demo ──────────────────────────────────────────────────────────────
 *
 * `src/lib/demo/dataset.ts` belongs to the coordinator, so the website tables
 * are not in it yet and the demo client throws `MissingDemoTable` for them.
 * That is a real condition with a correct answer — the demo genuinely has no
 * site — and `absent()` turns it into "there is no site here" rather than
 * letting a stack trace reach a screen. It is deliberately narrow: it matches
 * only that one error name, so a real query failure still surfaces.
 */

import {
  asBoolean,
  asEnum,
  asJsonRecord,
  asNumber,
  asNumberOrNull,
  asString,
  asStringOrNull,
  asTimestamp,
  asTimestampOrNull,
  toRows,
  type Db,
  type Row,
} from '../persistence'
import { readDesign } from './design'
import {
  SITE_BOOKING_REQUEST_STATUSES,
  SITE_DOMAIN_STATUSES,
  SITE_FACT_SOURCES,
  SITE_FINDING_SEVERITIES,
  SITE_FINDING_STATUSES,
  SITE_GENERATION_STATUSES,
  SITE_PAGE_KINDS,
  SITE_QUALITY_KINDS,
  SITE_SECTION_KINDS,
  SITE_STATUSES,
  type Site,
  type SiteBinding,
  type SiteBookingRequest,
  type SiteClaim,
  type SiteDomain,
  type SiteMedia,
  type SitePage,
  type SiteQualityFinding,
  type SiteQualityRun,
  type SiteSection,
  type SiteSeo,
  type SiteSnapshot,
  type SiteVersion,
} from './types'

/**
 * The demo has no website tables yet, and that is not an outage.
 *
 * Matched by error NAME rather than by message, and only that one name. A
 * broad `catch { return fallback }` here would swallow a genuine PostgREST
 * failure and show an empty studio to somebody whose database is down, which
 * is the worst possible way to report an outage.
 */
function absent<T>(fallback: T) {
  return (cause: unknown): T => {
    if (cause instanceof Error && cause.name === 'MissingDemoTable') {
      return fallback
    }
    throw cause
  }
}

/** True when the module's tables are not present in this environment at all. */
export function isModuleAbsent(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'MissingDemoTable'
}

/* ------------------------------------------------------------- primitives -- */

/**
 * Read stored claims back, dropping anything that is not one.
 *
 * The database refuses an unsourced claim on write —
 * `site_sections_claims_sourced` — so this should never drop anything. It
 * drops rather than throws because a single malformed row must not take down
 * the studio for the whole site, and because a row that predates the
 * constraint (an environment where 0042 was applied over existing data) should
 * be visible as a missing claim rather than as a broken page.
 */
function readClaims(value: unknown): readonly SiteClaim[] {
  if (!Array.isArray(value)) return []

  const claims: SiteClaim[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>

    const key = typeof row.key === 'string' ? row.key.trim() : ''
    const text = typeof row.text === 'string' ? row.text.trim() : ''
    const source = typeof row.source === 'string' ? row.source : ''

    if (key.length === 0 || text.length === 0) continue
    if (!(SITE_FACT_SOURCES as readonly string[]).includes(source)) continue

    const sourceId =
      typeof row.sourceId === 'string' && row.sourceId.length > 0
        ? row.sourceId
        : null

    // The law, re-asserted on read. A claim with no source is not shown even
    // if one somehow reached the table.
    if (sourceId === null) continue

    claims.push({
      key,
      text,
      source: source as SiteClaim['source'],
      sourceId,
      sourceField:
        typeof row.sourceField === 'string' && row.sourceField.length > 0
          ? row.sourceField
          : null,
      sourceValue: typeof row.sourceValue === 'string' ? row.sourceValue : null,
    })
  }

  return claims
}

function readBinding(row: Row): SiteBinding | null {
  const source = asStringOrNull(row, 'bound_source')
  const id = asStringOrNull(row, 'bound_id')
  if (!source || !id) return null
  if (!['property', 'unit', 'amenity', 'media'].includes(source)) return null
  return { source: source as SiteBinding['source'], id }
}

/* ------------------------------------------------------------ the mapping -- */

function toSite(row: Row): Site {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asStringOrNull(row, 'property_id'),
    slug: asString(row, 'slug'),
    name: asString(row, 'name'),
    status: asEnum(row, 'status', SITE_STATUSES),
    locale: asString(row, 'locale'),
    publishedVersionId: asStringOrNull(row, 'published_version_id'),
    publishedAt: asTimestampOrNull(row, 'published_at'),
    publishedBy: asStringOrNull(row, 'published_by'),
    design: readDesign(asJsonRecord(row, 'design')),
    version: asNumber(row, 'version'),
  }
}

function toPage(row: Row, seo: SiteSeo | null): SitePage {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    siteId: asString(row, 'site_id'),
    slug: asString(row, 'slug'),
    kind: asEnum(row, 'kind', SITE_PAGE_KINDS),
    title: asString(row, 'title'),
    navLabel: asStringOrNull(row, 'nav_label'),
    showInNav: asBoolean(row, 'show_in_nav'),
    sortOrder: asNumber(row, 'sort_order'),
    isActive: asBoolean(row, 'is_active'),
    seo,
  }
}

function toSection(row: Row): SiteSection {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    siteId: asString(row, 'site_id'),
    pageId: asString(row, 'page_id'),
    kind: asEnum(row, 'kind', SITE_SECTION_KINDS),
    sortOrder: asNumber(row, 'sort_order'),
    isActive: asBoolean(row, 'is_active'),
    boundTo: readBinding(row),
    claims: readClaims((row as Record<string, unknown>).claims),
    layout: asJsonRecord(row, 'layout'),
  }
}

function toSeo(row: Row): SiteSeo {
  return {
    pageId: asString(row, 'page_id'),
    metaTitle: asStringOrNull(row, 'meta_title'),
    metaDescription: asStringOrNull(row, 'meta_description'),
    canonicalUrl: asStringOrNull(row, 'canonical_url'),
    ogMediaId: asStringOrNull(row, 'og_media_id'),
    indexable: asBoolean(row, 'indexable'),
  }
}

function toMedia(row: Row): SiteMedia {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    siteId: asString(row, 'site_id'),
    url: asString(row, 'url'),
    altText: asStringOrNull(row, 'alt_text'),
    width: asNumberOrNull(row, 'width'),
    height: asNumberOrNull(row, 'height'),
    contentType: asStringOrNull(row, 'content_type'),
    boundTo: readBinding(row),
  }
}

function toVersion(row: Row): SiteVersion {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    siteId: asString(row, 'site_id'),
    versionNumber: asNumber(row, 'version_number'),
    label: asStringOrNull(row, 'label'),
    publishedAt: asTimestamp(row, 'published_at'),
    publishedBy: asStringOrNull(row, 'published_by'),
    restoredFromVersionId: asStringOrNull(row, 'restored_from_version_id'),
    snapshot: (row as Record<string, unknown>).snapshot as SiteSnapshot,
  }
}

function toDomain(row: Row): SiteDomain {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    siteId: asString(row, 'site_id'),
    hostname: asString(row, 'hostname'),
    status: asEnum(row, 'status', SITE_DOMAIN_STATUSES),
    verificationToken: asString(row, 'verification_token'),
    verifiedAt: asTimestampOrNull(row, 'verified_at'),
    failureReason: asStringOrNull(row, 'failure_reason'),
    isPrimary: asBoolean(row, 'is_primary'),
  }
}

function toBookingRequest(row: Row): SiteBookingRequest {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    siteId: asString(row, 'site_id'),
    propertyId: asStringOrNull(row, 'property_id'),
    unitId: asStringOrNull(row, 'unit_id'),
    checkIn: asString(row, 'check_in'),
    checkOut: asString(row, 'check_out'),
    adults: asNumber(row, 'adults'),
    children: asNumber(row, 'children'),
    infants: asNumber(row, 'infants'),
    contactName: asString(row, 'contact_name'),
    contactPhone: asString(row, 'contact_phone'),
    contactEmail: asStringOrNull(row, 'contact_email'),
    message: asStringOrNull(row, 'message'),
    status: asEnum(row, 'status', SITE_BOOKING_REQUEST_STATUSES),
    quotedTotalAgorot: asNumberOrNull(row, 'quoted_total_agorot'),
    createdAt: asTimestamp(row, 'created_at'),
  }
}

/* ----------------------------------------------------------- the adapter -- */

export class WebsiteRepository {
  constructor(private readonly db: Db) {}

  /** The organization's site. One per organization today; a list tomorrow. */
  async site(organizationId: string): Promise<Site | null> {
    const { data, error } = await this.db
      .from('sites')
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true })
      .limit(1)

    if (error) throw error
    const rows = toRows(data)
    return rows.length > 0 ? toSite(rows[0]) : null
  }

  async siteById(organizationId: string, siteId: string): Promise<Site | null> {
    const { data, error } = await this.db
      .from('sites')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('id', siteId)
      .maybeSingle()

    if (error) throw error
    return data ? toSite(data as Row) : null
  }

  /** Pages with their SEO rows attached. Two flat queries, stitched here. */
  async pages(
    organizationId: string,
    siteId: string,
  ): Promise<readonly SitePage[]> {
    const [pageResult, seoResult] = await Promise.all([
      this.db
        .from('site_pages')
        .select('*')
        .eq('organization_id', organizationId)
        .eq('site_id', siteId)
        .order('sort_order', { ascending: true }),
      this.db
        .from('site_seo')
        .select('*')
        .eq('organization_id', organizationId)
        .eq('site_id', siteId),
    ])

    if (pageResult.error) throw pageResult.error
    // SEO is gated on `site.manage_seo` and a copywriter does not hold it. An
    // RLS refusal here is the policy working, not an outage, so the pages come
    // back without their metadata rather than the screen failing.
    const seoRows = seoResult.error ? [] : toRows(seoResult.data)
    const seoByPage = new Map(
      seoRows.map((row) => [asString(row, 'page_id'), toSeo(row)]),
    )

    return toRows(pageResult.data).map((row) =>
      toPage(row, seoByPage.get(asString(row, 'id')) ?? null),
    )
  }

  async sections(
    organizationId: string,
    siteId: string,
  ): Promise<readonly SiteSection[]> {
    const { data, error } = await this.db
      .from('site_sections')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('site_id', siteId)
      .order('sort_order', { ascending: true })

    if (error) throw error
    return toRows(data).map(toSection)
  }

  async media(
    organizationId: string,
    siteId: string,
  ): Promise<readonly SiteMedia[]> {
    const { data, error } = await this.db
      .from('site_media')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('site_id', siteId)
      .order('sort_order', { ascending: true })

    if (error) throw error
    return toRows(data).map(toMedia)
  }

  /** Newest publish first. What the versions screen lists. */
  async versions(
    organizationId: string,
    siteId: string,
    limit = 50,
  ): Promise<readonly SiteVersion[]> {
    const { data, error } = await this.db
      .from('site_versions')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('site_id', siteId)
      .order('published_at', { ascending: false })
      .limit(limit)

    if (error) throw error
    return toRows(data).map(toVersion)
  }

  async version(
    organizationId: string,
    versionId: string,
  ): Promise<SiteVersion | null> {
    const { data, error } = await this.db
      .from('site_versions')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('id', versionId)
      .maybeSingle()

    if (error) throw error
    return data ? toVersion(data as Row) : null
  }

  /**
   * Domains. Empty for a reader without `site.manage_domain`.
   *
   * The refusal is swallowed for the same reason the SEO one is: a policy
   * returning no rows is the policy working, and it must not blank a screen
   * that has five other panels on it.
   */
  async domains(
    organizationId: string,
    siteId: string,
  ): Promise<readonly SiteDomain[]> {
    const { data, error } = await this.db
      .from('site_domains')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('site_id', siteId)
      .order('created_at', { ascending: true })

    if (error) return []
    return toRows(data).map(toDomain)
  }

  async qualityRuns(
    organizationId: string,
    siteId: string,
    limit = 10,
  ): Promise<readonly SiteQualityRun[]> {
    const { data, error } = await this.db
      .from('site_quality_runs')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('site_id', siteId)
      .order('ran_at', { ascending: false })
      .limit(limit)

    if (error) throw error
    const runs = toRows(data)
    if (runs.length === 0) return []

    const { data: findingData, error: findingError } = await this.db
      .from('site_quality_findings')
      .select('*')
      .eq('organization_id', organizationId)
      .in(
        'run_id',
        runs.map((row) => asString(row, 'id')),
      )

    const findings = findingError ? [] : toRows(findingData)
    const byRun = new Map<string, SiteQualityFinding[]>()

    for (const row of findings) {
      const runId = asString(row, 'run_id')
      const finding: SiteQualityFinding = {
        id: asString(row, 'id'),
        runId,
        checkCode: asString(row, 'check_code'),
        kind: asEnum(row, 'kind', SITE_QUALITY_KINDS),
        severity: asEnum(row, 'severity', SITE_FINDING_SEVERITIES),
        status: asEnum(row, 'status', SITE_FINDING_STATUSES),
        title: asString(row, 'title'),
        detail: asString(row, 'detail'),
        pageSlug: asStringOrNull(row, 'page_slug'),
        sectionId: asStringOrNull(row, 'section_id'),
      }
      const bucket = byRun.get(runId)
      if (bucket) bucket.push(finding)
      else byRun.set(runId, [finding])
    }

    return runs.map((row) => {
      const id = asString(row, 'id')
      return {
        id,
        organizationId: asString(row, 'organization_id'),
        siteId: asString(row, 'site_id'),
        kind: asEnum(row, 'kind', SITE_QUALITY_KINDS),
        ranAt: asTimestamp(row, 'ran_at'),
        ranBy: asStringOrNull(row, 'ran_by'),
        findings: byRun.get(id) ?? [],
      }
    })
  }

  /**
   * Enquiries from the public site.
   *
   * Gated on `booking.view` at the policy, not on `site.view` — an enquiry
   * carries a name and a telephone number and is guest data that happened to
   * arrive through a website. A copywriter gets an empty list, honestly.
   */
  async bookingRequests(
    organizationId: string,
    siteId: string,
    limit = 100,
  ): Promise<readonly SiteBookingRequest[]> {
    const { data, error } = await this.db
      .from('site_booking_requests')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('site_id', siteId)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) return []
    return toRows(data).map(toBookingRequest)
  }

  async generationRequests(
    organizationId: string,
    siteId: string,
    limit = 20,
  ): Promise<
    readonly {
      id: string
      status: (typeof SITE_GENERATION_STATUSES)[number]
      provider: string
      instruction: string | null
      refusalReason: string | null
      requestedAt: string
    }[]
  > {
    const { data, error } = await this.db
      .from('site_generation_requests')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('site_id', siteId)
      .order('requested_at', { ascending: false })
      .limit(limit)

    if (error) throw error
    return toRows(data).map((row) => ({
      id: asString(row, 'id'),
      status: asEnum(row, 'status', SITE_GENERATION_STATUSES),
      provider: asString(row, 'provider'),
      instruction: asStringOrNull(row, 'instruction'),
      refusalReason: asStringOrNull(row, 'refusal_reason'),
      requestedAt: asTimestamp(row, 'requested_at'),
    }))
  }

  /* ---------------------------------------------------- canonical sources -- */

  /**
   * The tenant's own name, for the `organization` fact source.
   *
   * Read rather than taken from the actor: `AuditActor` carries a label for a
   * person, not the organization's registered name, and a published site's
   * footer must say what the business is actually called. `null` when it
   * cannot be read, which produces no organization claim at all rather than a
   * placeholder.
   */
  async organizationName(organizationId: string): Promise<string | null> {
    const { data, error } = await this.db
      .from('organizations')
      .select('id, name')
      .eq('id', organizationId)
      .maybeSingle()

    if (error) return null
    return data ? asStringOrNull(data as Row, 'name') : null
  }

  /**
   * The property rows this site may quote facts from.
   *
   * Read through the caller's own row level security, so a manager scoped to
   * one property cannot bind a section to the other one. That is the
   * authorization; nothing here re-implements it.
   */
  async properties(
    organizationId: string,
    propertyId: string | null,
  ): Promise<readonly Row[]> {
    let query = this.db
      .from('properties')
      .select(
        'id, name, description, city, region, address_line1, country, ' +
          'default_check_in_time, default_check_out_time, min_nights, ' +
          'house_rules, cancellation_policy_text, contact_phone, ' +
          'contact_email, cover_image_url, status, currency, tax_rate_bps',
      )
      .eq('organization_id', organizationId)

    if (propertyId) query = query.eq('id', propertyId)

    const { data, error } = await query
    if (error) throw error
    return toRows(data)
  }

  async units(
    organizationId: string,
    propertyIds: readonly string[] | null,
  ): Promise<readonly Row[]> {
    let query = this.db
      .from('units')
      .select(
        'id, property_id, name, description, max_guests, standard_guests, ' +
          'bedrooms, bathrooms, beds, size_sqm, status, cover_image_url',
      )
      .eq('organization_id', organizationId)
      .is('deleted_at', null)

    if (propertyIds && propertyIds.length > 0) {
      query = query.in('property_id', propertyIds)
    }

    const { data, error } = await query
    if (error) throw error
    return toRows(data)
  }

  /**
   * The amenities a property has.
   *
   * Two flat queries rather than an embed, for the reason in the header. The
   * join table carries `organization_id` denormalised and it is filtered here
   * as well as by the policy.
   */
  async propertyAmenities(
    organizationId: string,
    propertyId: string,
  ): Promise<readonly Row[]> {
    const { data, error } = await this.db
      .from('property_amenities')
      .select('amenity_id')
      .eq('organization_id', organizationId)
      .eq('property_id', propertyId)

    if (error) throw error
    const ids = toRows(data).map((row) => asString(row, 'amenity_id'))
    if (ids.length === 0) return []

    const { data: amenityData, error: amenityError } = await this.db
      .from('amenities')
      .select('id, code, name, name_he, category, icon')
      .in('id', ids)

    if (amenityError) throw amenityError
    return toRows(amenityData)
  }
}

/* ------------------------------------------------ absent-module wrappers -- */

/**
 * The reads a screen performs, each answering "nothing" when the module's
 * tables are not present in this environment.
 *
 * Kept separate from the repository so the repository stays a plain adapter
 * that throws what the database throws — which is what `repository.test.ts`
 * asserts against — and the tolerance for a missing demo table is a decision a
 * caller opts into.
 */
export const tolerant = {
  site: (repository: WebsiteRepository, organizationId: string) =>
    repository.site(organizationId).catch(absent<Site | null>(null)),

  pages: (
    repository: WebsiteRepository,
    organizationId: string,
    siteId: string,
  ) =>
    repository
      .pages(organizationId, siteId)
      .catch(absent<readonly SitePage[]>([])),

  sections: (
    repository: WebsiteRepository,
    organizationId: string,
    siteId: string,
  ) =>
    repository
      .sections(organizationId, siteId)
      .catch(absent<readonly SiteSection[]>([])),

  media: (
    repository: WebsiteRepository,
    organizationId: string,
    siteId: string,
  ) =>
    repository
      .media(organizationId, siteId)
      .catch(absent<readonly SiteMedia[]>([])),

  versions: (
    repository: WebsiteRepository,
    organizationId: string,
    siteId: string,
  ) =>
    repository
      .versions(organizationId, siteId)
      .catch(absent<readonly SiteVersion[]>([])),

  domains: (
    repository: WebsiteRepository,
    organizationId: string,
    siteId: string,
  ) =>
    repository
      .domains(organizationId, siteId)
      .catch(absent<readonly SiteDomain[]>([])),

  bookingRequests: (
    repository: WebsiteRepository,
    organizationId: string,
    siteId: string,
  ) =>
    repository
      .bookingRequests(organizationId, siteId)
      .catch(absent<readonly SiteBookingRequest[]>([])),

  properties: (
    repository: WebsiteRepository,
    organizationId: string,
    propertyId: string | null,
  ) =>
    repository
      .properties(organizationId, propertyId)
      .catch(absent<readonly Row[]>([])),

  units: (
    repository: WebsiteRepository,
    organizationId: string,
    propertyIds: readonly string[] | null,
  ) =>
    repository
      .units(organizationId, propertyIds)
      .catch(absent<readonly Row[]>([])),
}
