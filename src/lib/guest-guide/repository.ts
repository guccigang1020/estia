/**
 * EXECUTION CONTEXT — SERVER ONLY. Rows in, domain objects out.
 *
 * ══ THIS ADAPTER CANNOT READ A SECRET ══════════════════════════════════════
 *
 * There is no method here that returns a `GuideSecret`. `secretEntryIds`
 * selects `entry_id` and nothing else, which is exactly what the settings
 * screen needs — it draws "withheld until the deposit is paid" and must never
 * draw the code — and exactly what `completeness.ts` needs to report a
 * sensitive entry with nothing behind it.
 *
 * That is not squeamishness. An operator's screen is rendered on a server,
 * cached by Next, and its props are serialised into the HTML that reaches a
 * browser. A door code that is read here is a door code in a page's payload,
 * and no amount of `{withheld && …}` in a component undoes that. The only
 * reader of `guide_entry_secrets.value` is the seam function described in this
 * module's report — SECURITY DEFINER, one row at a time, after a release
 * decision — and it is not in this file.
 *
 * ══ THE TABLES MAY NOT EXIST YET, AND THAT IS A STATE ══════════════════════
 *
 * This module is written against a schema that has been proposed and not
 * applied; the migration is the coordinator's to write. `readGuide` therefore
 * answers `not_provisioned` for exactly two error codes — `42P01` from
 * Postgres and `PGRST205` from PostgREST — and rethrows everything else, which
 * is the discipline `src/app/(app)/channels/_lib/manager.ts` sets out. A
 * `catch` that swallowed the rest would turn a row-level-security refusal into
 * "this feature is not built", which is the most misleading sentence a screen
 * can produce.
 *
 * `readProvisioned` is imported rather than re-implemented. It lives in
 * `src/lib/fiscal/provisioning.ts`, whose own header says it is one copy for
 * every capability waiting on a migration, and it imports nothing — so it is
 * safe for the bundle checker. The report asks for it to be moved to a neutral
 * home now that a third module depends on it.
 *
 * ── Flat queries, stitched here ───────────────────────────────────────────
 *
 * The same choice `src/lib/website/repository.ts` makes: an embedded select
 * ties the response shape to the foreign keys, and the demo client resolves
 * embeds through `DEMO_RELATIONS`, which belongs to another owner.
 *
 * ── Tenant scope in the query as well as in the policy ────────────────────
 *
 * Every read filters `organization_id` explicitly even though row level
 * security already does, so a missing scope is a visible line rather than a
 * silent dependence on a policy in a file this module does not own.
 */

import { readProvisioned, type Provisioned } from '../fiscal/provisioning'
import {
  asBoolean,
  asEnum,
  asNumber,
  asNumberOrNull,
  asString,
  asStringOrNull,
  asTimestampOrNull,
  toRows,
  type Db,
  type Row,
} from '../persistence'
import {
  DEFAULT_RELEASE_RULE,
  GUIDE_ICONS,
  GUIDE_LANGUAGES,
  GUIDE_MEDIA_KINDS,
  GUIDE_RELEASE_MODES,
  GUIDE_STAGES,
  GUIDE_STATUSES,
  GUIDE_TOPICS,
  RECOMMENDATION_CATEGORIES,
  isSafeUrl,
  readLocalizedText,
  type Guide,
  type GuideEntry,
  type GuideIcon,
  type GuideLanguage,
  type GuideLink,
  type GuideMediaRef,
  type GuideRecommendation,
  type GuideReleaseRule,
  type RecommendationSource,
} from './types'

/** The storage this module needs, named as a migration would create it. */
export const GUIDE_TABLES = [
  'property_guides',
  'guide_entries',
  'guide_entry_secrets',
  'guide_media',
  'guide_recommendations',
  'guide_versions',
] as const

/** A ceiling. A guide longer than this is a manual, not a guide. */
export const MAX_ENTRIES = 200

/* ---------------------------------------------------------- primitives -- */

function readIcon(value: string | null): GuideIcon | null {
  if (value === null) return null
  return (GUIDE_ICONS as readonly string[]).includes(value)
    ? (value as GuideIcon)
    : null
}

/**
 * A release rule off two columns.
 *
 * An unknown mode falls back to `manual`, not to `immediate`. A row written by
 * a future migration this code does not know about must fail closed: showing a
 * door code because a value did not parse is the one outcome this module
 * exists to prevent.
 */
function readRelease(row: Row): GuideReleaseRule {
  const mode = asStringOrNull(row, 'release_mode')
  const hours = asNumberOrNull(row, 'release_hours')

  if (
    mode === null ||
    !(GUIDE_RELEASE_MODES as readonly string[]).includes(mode)
  ) {
    return { mode: 'manual', hours: DEFAULT_RELEASE_RULE.hours }
  }

  return {
    mode: mode as GuideReleaseRule['mode'],
    hours: hours === null ? DEFAULT_RELEASE_RULE.hours : hours,
  }
}

/**
 * A link off two columns, dropped when the URL is not one this module accepts.
 *
 * Dropped rather than thrown for the reason `readClaims` in the website
 * repository gives: one malformed row must not take a whole screen down, and a
 * row that predates the CHECK should be visible as a missing link rather than
 * as a broken guide. The CHECK refuses these on write, so this should never
 * fire.
 */
function readLink(row: Row): GuideLink | null {
  const url = asStringOrNull(row, 'link_url')
  if (url === null || !isSafeUrl(url)) return null

  const label = readLocalizedText((row as Record<string, unknown>).link_label)
  if (label === null) return null

  return { url, label }
}

function readLanguages(value: unknown): readonly GuideLanguage[] {
  if (!Array.isArray(value)) return ['he']
  const languages = GUIDE_LANGUAGES.filter((language) =>
    value.includes(language),
  )
  // Hebrew is not optional — `LocalizedText` guarantees it exists on every
  // entry, so a property that somehow declared otherwise still offers it.
  return languages.includes('he') ? languages : ['he', ...languages]
}

/* -------------------------------------------------------------- mapping -- */

function toGuide(row: Row): Guide {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asString(row, 'property_id'),
    status: asEnum(row, 'status', GUIDE_STATUSES),
    languages: readLanguages((row as Record<string, unknown>).languages),
    publishedVersionId: asStringOrNull(row, 'published_version_id'),
    publishedAt: asTimestampOrNull(row, 'published_at'),
    publishedBy: asStringOrNull(row, 'published_by'),
    version: asNumber(row, 'version'),
  }
}

/**
 * A row to an entry, or `null` when it has no Hebrew title.
 *
 * `null` rather than a thrown `RowShapeError`: `LocalizedText` promises a
 * non-blank Hebrew string to everything downstream, and the honest way to keep
 * that promise against a row that does not have one is to leave it out. The
 * completeness report then says the topic is missing, which is true.
 */
function toEntry(row: Row, media: readonly GuideMediaRef[]): GuideEntry | null {
  const title = readLocalizedText((row as Record<string, unknown>).title)
  if (title === null) return null

  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asString(row, 'property_id'),
    stage: asEnum(row, 'stage', GUIDE_STAGES),
    topic: asEnum(row, 'topic', GUIDE_TOPICS),
    title,
    body: readLocalizedText((row as Record<string, unknown>).body),
    icon: readIcon(asStringOrNull(row, 'icon')),
    link: readLink(row),
    media,
    sortOrder: asNumber(row, 'sort_order'),
    isActive: asBoolean(row, 'is_active'),
    hasSecret: asBoolean(row, 'has_secret'),
    release: readRelease(row),
    version: asNumber(row, 'version'),
  }
}

function toMedia(row: Row): GuideMediaRef | null {
  const url = asString(row, 'url')
  if (!isSafeUrl(url)) return null

  return {
    id: asString(row, 'id'),
    entryId: asString(row, 'entry_id'),
    kind: asEnum(row, 'kind', GUIDE_MEDIA_KINDS),
    url,
    altText: readLocalizedText((row as Record<string, unknown>).alt_text),
    sortOrder: asNumber(row, 'sort_order'),
  }
}

/**
 * A recommendation's source off three columns.
 *
 * `null` when neither shape is complete, and a recommendation whose source is
 * `null` is dropped by `toRecommendation`. That is §44 re-asserted on read:
 * the CHECK refuses an unsourced row on write, and if one ever reached the
 * table it would not be shown to a guest.
 */
function readSourceRow(row: Row): RecommendationSource | null {
  const kind = asStringOrNull(row, 'source_kind')

  if (kind === 'business') {
    const userId = asStringOrNull(row, 'source_user_id')
    return userId === null
      ? null
      : { kind: 'business', enteredByUserId: userId }
  }

  if (kind === 'named') {
    const name = asStringOrNull(row, 'source_name')
    if (name === null || name.trim().length === 0) return null
    const url = asStringOrNull(row, 'source_url')
    return {
      kind: 'named',
      name,
      url: url !== null && isSafeUrl(url) ? url : null,
    }
  }

  return null
}

function toRecommendation(row: Row): GuideRecommendation | null {
  const name = readLocalizedText((row as Record<string, unknown>).name)
  if (name === null) return null

  const source = readSourceRow(row)
  if (source === null) return null

  const url = asStringOrNull(row, 'url')

  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asString(row, 'property_id'),
    category: asEnum(row, 'category', RECOMMENDATION_CATEGORIES),
    name,
    description: readLocalizedText(
      (row as Record<string, unknown>).description,
    ),
    address: readLocalizedText((row as Record<string, unknown>).address),
    phone: asStringOrNull(row, 'phone'),
    url: url !== null && isSafeUrl(url) ? url : null,
    minutesAway: asNumberOrNull(row, 'minutes_away'),
    source,
    sortOrder: asNumber(row, 'sort_order'),
    isActive: asBoolean(row, 'is_active'),
    version: asNumber(row, 'version'),
  }
}

/* ------------------------------------------------------------ the reads -- */

const ENTRY_COLUMNS =
  'id, organization_id, property_id, stage, topic, title, body, icon, ' +
  'link_url, link_label, sort_order, is_active, has_secret, release_mode, ' +
  'release_hours, version'

const RECOMMENDATION_COLUMNS =
  'id, organization_id, property_id, category, name, description, address, ' +
  'phone, url, minutes_away, source_kind, source_user_id, source_name, ' +
  'source_url, sort_order, is_active, version'

export class GuestGuideRepository {
  constructor(private readonly db: Db) {}

  /** The property's guide row, or `null` before anybody has opened the screen. */
  async guide(
    organizationId: string,
    propertyId: string,
  ): Promise<Guide | null> {
    const { data, error } = await this.db
      .from('property_guides')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('property_id', propertyId)
      .maybeSingle()

    if (error) throw error
    return data ? toGuide(data as Row) : null
  }

  /** Every entry, with its media stitched on. Two flat queries. */
  async entries(
    organizationId: string,
    propertyId: string,
  ): Promise<readonly GuideEntry[]> {
    const [entryResult, mediaResult] = await Promise.all([
      this.db
        .from('guide_entries')
        .select(ENTRY_COLUMNS)
        .eq('organization_id', organizationId)
        .eq('property_id', propertyId)
        .order('sort_order', { ascending: true })
        .limit(MAX_ENTRIES),
      this.db
        .from('guide_media')
        .select('id, entry_id, kind, url, alt_text, sort_order')
        .eq('organization_id', organizationId)
        .eq('property_id', propertyId)
        .order('sort_order', { ascending: true }),
    ])

    if (entryResult.error) throw entryResult.error
    if (mediaResult.error) throw mediaResult.error

    const byEntry = new Map<string, GuideMediaRef[]>()
    for (const row of toRows(mediaResult.data)) {
      const media = toMedia(row)
      if (media === null) continue
      const bucket = byEntry.get(media.entryId)
      if (bucket) bucket.push(media)
      else byEntry.set(media.entryId, [media])
    }

    const entries: GuideEntry[] = []
    for (const row of toRows(entryResult.data)) {
      const entry = toEntry(row, byEntry.get(asString(row, 'id')) ?? [])
      if (entry !== null) entries.push(entry)
    }
    return entries
  }

  /**
   * WHICH ENTRIES HAVE A SECRET. Not what the secrets are.
   *
   * `select('entry_id')` and no second column, deliberately and permanently.
   * Read the header before widening it.
   */
  async secretEntryIds(
    organizationId: string,
    propertyId: string,
  ): Promise<readonly string[]> {
    const { data, error } = await this.db
      .from('guide_entry_secrets')
      .select('entry_id')
      .eq('organization_id', organizationId)
      .eq('property_id', propertyId)

    // A reader without the grant gets an empty list rather than a broken
    // screen. `has_secret` on the entry already tells the operator one exists;
    // this read only says whether it has been filled in.
    if (error) return []
    return toRows(data).map((row) => asString(row, 'entry_id'))
  }

  async recommendations(
    organizationId: string,
    propertyId: string,
  ): Promise<readonly GuideRecommendation[]> {
    const { data, error } = await this.db
      .from('guide_recommendations')
      .select(RECOMMENDATION_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('property_id', propertyId)
      .order('sort_order', { ascending: true })

    if (error) throw error

    const items: GuideRecommendation[] = []
    for (const row of toRows(data)) {
      const item = toRecommendation(row)
      if (item !== null) items.push(item)
    }
    return items
  }

  /** Publication history, newest first. What the versions panel lists. */
  async versions(
    organizationId: string,
    guideId: string,
    limit = 20,
  ): Promise<
    readonly {
      id: string
      versionNumber: number
      label: string | null
      publishedAt: string | null
      publishedBy: string | null
      entryCount: number
    }[]
  > {
    const { data, error } = await this.db
      .from('guide_versions')
      .select(
        'id, version_number, label, published_at, published_by, entry_count',
      )
      .eq('organization_id', organizationId)
      .eq('guide_id', guideId)
      .order('published_at', { ascending: false })
      .limit(limit)

    if (error) throw error
    return toRows(data).map((row) => ({
      id: asString(row, 'id'),
      versionNumber: asNumber(row, 'version_number'),
      label: asStringOrNull(row, 'label'),
      publishedAt: asTimestampOrNull(row, 'published_at'),
      publishedBy: asStringOrNull(row, 'published_by'),
      entryCount: asNumber(row, 'entry_count'),
    }))
  }

  /** The property's own name, for the screen's heading and the snapshot. */
  async propertyName(
    organizationId: string,
    propertyId: string,
  ): Promise<string | null> {
    const { data, error } = await this.db
      .from('properties')
      .select('id, name')
      .eq('organization_id', organizationId)
      .eq('id', propertyId)
      .maybeSingle()

    if (error) return null
    return data ? asStringOrNull(data as Row, 'name') : null
  }
}

/* ------------------------------------------------------- the whole read -- */

export type GuideReadout = {
  guide: Guide | null
  propertyName: string | null
  entries: readonly GuideEntry[]
  entryIdsWithSecret: readonly string[]
  recommendations: readonly GuideRecommendation[]
  versions: Awaited<ReturnType<GuestGuideRepository['versions']>>
}

/**
 * Everything one property's settings screen needs, or the statement that the
 * storage is absent.
 *
 * One entry point so a screen has one thing to call and one state to branch
 * on. The versions read is skipped when there is no guide row yet, because
 * there is nothing to have published.
 */
export async function readGuide(
  db: Db,
  organizationId: string,
  propertyId: string,
): Promise<Provisioned<GuideReadout>> {
  const repository = new GuestGuideRepository(db)

  return readProvisioned(GUIDE_TABLES, async () => {
    const [guide, propertyName, entries, entryIdsWithSecret, recommendations] =
      await Promise.all([
        repository.guide(organizationId, propertyId),
        repository.propertyName(organizationId, propertyId),
        repository.entries(organizationId, propertyId),
        repository.secretEntryIds(organizationId, propertyId),
        repository.recommendations(organizationId, propertyId),
      ])

    const versions =
      guide === null ? [] : await repository.versions(organizationId, guide.id)

    return {
      guide,
      propertyName,
      entries,
      entryIdsWithSecret,
      recommendations,
      versions,
    }
  })
}

export type { Provisioned }
