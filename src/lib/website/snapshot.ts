/**
 * BUILDING WHAT A VISITOR IS SERVED.
 *
 * ── The law this file exists to make true ─────────────────────────────────
 *
 *   A VISITOR MUST NEVER SEE AN UNPUBLISHED CHANGE.
 *
 * There are two ways to get that. One is to read the draft tables on every
 * public request and filter on a `published` flag, and it is the way that
 * fails: it is one forgotten `.eq('is_published', true)` away from serving a
 * half-written page, and the forgetting happens in the sixth query somebody
 * adds six months later.
 *
 * The other is that the draft is not reachable from the public path at all.
 * That is what this file does. `buildSnapshot` runs once, at publish, and
 * produces a self-contained document. `site_versions` stores it. The public
 * route reads a version and only a version — no page table, no section table,
 * no claim table — so there is no query for anybody to forget a filter in.
 *
 * ── What is deliberately NOT snapshotted ──────────────────────────────────
 *
 * Availability and price. A snapshot of who is free next Tuesday is a lie by
 * Wednesday, and a snapshot of a rate is a price the business has stopped
 * charging. Both are computed live, at request time, from the canonical
 * engines — `checkAvailability`, `availabilityCalendar` and `priceStay` — and
 * the snapshot carries only `bookableUnitIds`, which is the list of units the
 * published site is *allowed* to ask those engines about.
 *
 * That list is the reason a draft cannot leak through the booking widget
 * either. Adding a unit to a draft page does not add it to the published
 * snapshot, so the live site will refuse to quote it — the public availability
 * path checks membership of `bookableUnitIds` before it asks the engine
 * anything.
 *
 * ── Why building can fail ─────────────────────────────────────────────────
 *
 * `buildSnapshot` refuses when any claim is unsourced. Not "warns" — refuses,
 * by returning a failure the publish operation turns into a `BusinessRuleError`
 * naming every offending claim. That is the moment the module's one rule is
 * actually enforced, and it is enforced at the only moment that matters: the
 * transition from something a person is editing to something a stranger reads.
 */

import { publishBlockers, type UnsourcedClaim } from './facts'
import type {
  Site,
  SiteMedia,
  SitePage,
  SiteSection,
  SiteSnapshot,
  SiteSnapshotPage,
} from './types'

export type SnapshotInput = {
  site: Site
  organizationName: string
  pages: readonly SitePage[]
  /** Every section for every page. Grouped here rather than by the caller. */
  sections: readonly SiteSection[]
  media: readonly SiteMedia[]
  /**
   * The units the bound properties actually have, from `public.units`. The
   * caller reads them; this file does not invent one. A unit absent from here
   * is a unit the published site will not quote.
   */
  units: readonly { id: string; propertyId: string; status: string }[]
  now: Date
}

export type SnapshotResult =
  | { ok: true; snapshot: SiteSnapshot }
  | { ok: false; blockers: readonly UnsourcedClaim[] }

/**
 * Build the document a visitor will be served, or refuse and say why.
 *
 * Inactive pages and inactive sections are omitted entirely rather than
 * carried with a flag. A visitor cannot be shown something that is not in the
 * document they were sent, and a renderer that has to remember to check
 * `isActive` is a renderer that will one day not.
 */
export function buildSnapshot(input: SnapshotInput): SnapshotResult {
  const livePages = input.pages
    .filter((page) => page.isActive)
    .slice()
    .sort(byOrderThenSlug)

  const sectionsByPage = new Map<string, SiteSection[]>()
  for (const section of input.sections) {
    if (!section.isActive) continue
    const bucket = sectionsByPage.get(section.pageId)
    if (bucket) bucket.push(section)
    else sectionsByPage.set(section.pageId, [section])
  }

  const pages: SiteSnapshotPage[] = livePages.map((page) => {
    const sections = (sectionsByPage.get(page.id) ?? [])
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)

    return {
      slug: page.slug,
      kind: page.kind,
      title: page.title,
      navLabel: page.navLabel,
      showInNav: page.showInNav,
      sortOrder: page.sortOrder,
      seo: page.seo,
      sections,
    }
  })

  // THE GATE. Only the sections that will actually be served are checked —
  // a half-written section a person deactivated is not a reason to refuse a
  // publish, because it is not being published.
  const included = pages.flatMap((page) => page.sections)
  const blockers = publishBlockers(included)
  if (blockers.length > 0) return { ok: false, blockers }

  // Only media a section or a page actually references travels in the
  // snapshot. An image somebody uploaded and never used is not part of the
  // site and does not need to be served.
  const referenced = referencedMediaIds(pages, input.site.design.logoMediaId)
  const media = input.media.filter((item) => referenced.has(item.id))

  return {
    ok: true,
    snapshot: {
      siteId: input.site.id,
      slug: input.site.slug,
      name: input.site.name,
      locale: input.site.locale,
      design: input.site.design,
      organizationName: input.organizationName,
      pages,
      media,
      bookableUnitIds: bookableUnits(input),
      factManifest: included.flatMap((section) => section.claims),
      builtAt: input.now.toISOString(),
    },
  }
}

function byOrderThenSlug(a: SitePage, b: SitePage): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
  return a.slug.localeCompare(b.slug)
}

/**
 * Which units this published site may be asked about.
 *
 * Two filters, and both matter. A unit must be `active` — an archived unit is
 * not for sale and a public site that quotes one is selling something that
 * does not exist. And a unit must belong to a property this site is actually
 * bound to: a site scoped to one property may not quote the other property's
 * rooms, which is what stops a two-property business publishing a site that
 * accidentally sells the wrong house.
 */
function bookableUnits(input: SnapshotInput): readonly string[] {
  const boundProperties = new Set<string>()

  if (input.site.propertyId) boundProperties.add(input.site.propertyId)

  for (const section of input.sections) {
    if (!section.isActive) continue
    if (section.boundTo?.source === 'property') {
      boundProperties.add(section.boundTo.id)
    }
  }

  // A site bound to nothing is an organization-wide site and may quote every
  // active unit the organization has. That is the ordinary single-property
  // case and it is not a widening: `units` was already read under the actor's
  // own row level security.
  const unrestricted = boundProperties.size === 0

  const ids = input.units
    .filter(
      (unit) =>
        unit.status === 'active' &&
        (unrestricted || boundProperties.has(unit.propertyId)),
    )
    .map((unit) => unit.id)

  return Array.from(new Set(ids)).sort()
}

function referencedMediaIds(
  pages: readonly SiteSnapshotPage[],
  logoMediaId: string | null,
): ReadonlySet<string> {
  const ids = new Set<string>()
  if (logoMediaId) ids.add(logoMediaId)

  for (const page of pages) {
    if (page.seo?.ogMediaId) ids.add(page.seo.ogMediaId)

    for (const section of page.sections) {
      if (section.boundTo?.source === 'media') ids.add(section.boundTo.id)
      for (const claim of section.claims) {
        if (claim.source === 'media' && claim.sourceId) ids.add(claim.sourceId)
      }
    }
  }

  return ids
}

/* --------------------------------------------------------------- reading -- */

/**
 * Find one page inside a snapshot.
 *
 * `''` is the home page. A slug that is not in the document returns `null` and
 * the route renders a 404 — never a fallback to the first page, which would
 * mean a mistyped URL silently served somebody a different page than the one
 * the link promised.
 */
export function pageOf(
  snapshot: SiteSnapshot,
  slug: string,
): SiteSnapshotPage | null {
  const wanted = slug.trim().replace(/^\/+|\/+$/g, '')
  return snapshot.pages.find((page) => page.slug === wanted) ?? null
}

/** The navigation a visitor sees. Ordered, and only what asked to be there. */
export function navigationOf(
  snapshot: SiteSnapshot,
): readonly { slug: string; label: string }[] {
  return snapshot.pages
    .filter((page) => page.showInNav)
    .map((page) => ({ slug: page.slug, label: page.navLabel ?? page.title }))
}

/** One claim of a section, by key. `null` when the section does not make it. */
export function claimText(section: SiteSection, key: string): string | null {
  return section.claims.find((claim) => claim.key === key)?.text ?? null
}

/** Every claim of a section under one key. Used by lists — amenities, units. */
export function claimTexts(
  section: SiteSection,
  keyPrefix: string,
): readonly string[] {
  return section.claims
    .filter((claim) => claim.key.startsWith(`${keyPrefix}.`))
    .map((claim) => claim.text)
}

/** A media row from the snapshot, by id. `null` rather than a broken image. */
export function mediaOf(
  snapshot: SiteSnapshot,
  id: string | null,
): SiteMedia | null {
  if (!id) return null
  return snapshot.media.find((item) => item.id === id) ?? null
}
