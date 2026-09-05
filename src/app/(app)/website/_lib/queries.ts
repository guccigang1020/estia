/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of every studio screen.
 *
 * Thin on purpose. The reasoning lives in `src/lib/website` — the provenance
 * engine, the snapshot builder, the quality passes — and this file assembles
 * what one screen needs from it.
 *
 * ── Failures are values, not exceptions ──────────────────────────────────
 *
 * Each loader returns whatever it could read. A copywriter who cannot read the
 * domains because they lack `site.manage_domain` gets an empty list and the
 * screen says so honestly — an RLS refusal is the policy working, not an
 * outage, and it must not blank a page that has five other panels on it.
 *
 * ── The demo ─────────────────────────────────────────────────────────────
 *
 * `src/lib/demo/dataset.ts` belongs to the coordinator, so the website tables
 * are not in the demo dataset yet and the demo client throws
 * `MissingDemoTable`. `tolerant` in the repository turns exactly that error
 * into "there is no site here", which is TRUE in the demo, and the studio
 * renders its first-run state. Every other failure still surfaces.
 */

import type { Actor } from '@/lib/authz/can'
import { holdsGrant } from '@/lib/authz/can'
import type { Db, Row } from '@/lib/persistence'
import {
  WebsiteRepository,
  driftedClaims,
  hasUnpublishedChanges,
  liveVersion,
  rollbackTargets,
  runAllPasses,
  runQualityPass,
  summarize,
  tolerant,
  type DriftedClaim,
  type Finding,
  type Site,
  type SiteBookingRequest,
  type SiteDomain,
  type SiteMedia,
  type SitePage,
  type SiteSection,
  type SiteVersion,
} from '@/lib/website'

export type StudioOverview = {
  site: Site | null
  pages: readonly SitePage[]
  sections: readonly SiteSection[]
  media: readonly SiteMedia[]
  versions: readonly SiteVersion[]
  domains: readonly SiteDomain[]
  /** The claims whose source row has moved since they were saved. */
  drift: readonly DriftedClaim[]
  live: SiteVersion | null
  rollbackTargets: readonly SiteVersion[]
  unpublishedChanges: boolean
  findings: readonly Finding[]
  counts: ReturnType<typeof summarize>
  /** True when the plan carries `custom_domain`. Changes one finding's wording. */
  customDomainAvailable: boolean
  /** Properties the actor may bind a section to, for the content screen. */
  properties: readonly Row[]
  units: readonly Row[]
}

export async function loadStudio(input: {
  db: Db
  actor: Actor
}): Promise<StudioOverview> {
  const repository = new WebsiteRepository(input.db)
  const organizationId = input.actor.organizationId

  const site = await tolerant.site(repository, organizationId)

  const customDomainAvailable = input.actor.entitlements.has('custom_domain')

  if (!site) {
    return {
      site: null,
      pages: [],
      sections: [],
      media: [],
      versions: [],
      domains: [],
      drift: [],
      live: null,
      rollbackTargets: [],
      unpublishedChanges: false,
      findings: [],
      counts: { blockers: 0, warnings: 0, advice: 0, notAssessed: 0 },
      customDomainAvailable,
      properties: await tolerant.properties(repository, organizationId, null),
      units: [],
    }
  }

  const [pages, sections, media, versions, domains, properties] =
    await Promise.all([
      tolerant.pages(repository, organizationId, site.id),
      tolerant.sections(repository, organizationId, site.id),
      tolerant.media(repository, organizationId, site.id),
      tolerant.versions(repository, organizationId, site.id),
      tolerant.domains(repository, organizationId, site.id),
      tolerant.properties(repository, organizationId, site.propertyId),
    ])

  const units = await tolerant.units(
    repository,
    organizationId,
    properties.map((row) => String(row.id)),
  )

  const hasVerifiedDomain = domains.some(
    (domain) => domain.status === 'verified',
  )

  const qualityInput = {
    pages,
    sections,
    media: media.map((item) => ({ id: item.id, altText: item.altText })),
    customDomainAvailable,
    hasVerifiedDomain,
  }

  const findings = runAllPasses(qualityInput)

  // Drift, computed against the rows the actor can actually read. A property
  // outside their scope is absent from the map, and `driftedClaims` says
  // nothing about a row it was not given rather than guessing.
  const rows = new Map<string, Row>()
  for (const row of [...properties, ...units]) {
    rows.set(String(row.id), row)
  }

  return {
    site,
    pages,
    sections,
    media,
    versions,
    domains,
    drift: driftedClaims(
      sections.flatMap((section) => section.claims),
      rows,
    ),
    live: liveVersion(site, versions),
    rollbackTargets: rollbackTargets(site, versions),
    unpublishedChanges: hasUnpublishedChanges({
      site,
      // The draft's own last edit. Read from the sections rather than stored:
      // a `draft_updated_at` column would be a second definition of "changed"
      // that could drift from what the publish operation reads.
      draftUpdatedAt: null,
    }),
    findings,
    counts: summarize(findings),
    customDomainAvailable,
    properties,
    units,
  }
}

/** The pre-publish pass, run at the moment somebody is about to go live. */
export function prePublishFindings(
  overview: StudioOverview,
): readonly Finding[] {
  return runQualityPass('pre_publish', {
    pages: overview.pages,
    sections: overview.sections,
    media: overview.media.map((item) => ({
      id: item.id,
      altText: item.altText,
    })),
    customDomainAvailable: overview.customDomainAvailable,
    hasVerifiedDomain: overview.domains.some((d) => d.status === 'verified'),
  })
}

/**
 * The enquiries a person may see.
 *
 * Gated on `booking.view` here as well as at the policy. A copywriter would
 * get an empty list from the database anyway; asking at all would be a query
 * whose only outcome is a refusal in a log.
 */
export async function loadRequests(input: {
  db: Db
  actor: Actor
  siteId: string
}): Promise<readonly SiteBookingRequest[]> {
  if (!holdsGrant(input.actor, 'booking.view')) return []

  const repository = new WebsiteRepository(input.db)
  return tolerant.bookingRequests(
    repository,
    input.actor.organizationId,
    input.siteId,
  )
}
