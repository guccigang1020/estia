/**
 * The property guide's vocabulary and content model.
 *
 * ══ THE ONE RULE THE WHOLE MODULE TURNS ON ═══════════════════════════════
 *
 *   A DOOR CODE CANNOT BE A `GuideEntry`.
 *
 * `src/lib/website/types.ts` makes "a published sentence carries its source"
 * a property of the type rather than a promise: `SiteClaim` has no
 * representation for "we do not know where this came from", so an unsourced
 * claim cannot be stored and therefore cannot be published. This module
 * borrows the move and points it at a different failure.
 *
 * The failure here is disclosure. A guide holds the wi-fi password, the door
 * code, the alarm code and where the lock box is, and every one of them has to
 * reach a guest at some point — so "do not store secrets" is not available as
 * an answer. What is available is making the secret *unreachable from the type
 * the rest of the product handles*:
 *
 *   · `GuideEntry` has no field that can hold a secret. Not a nullable one,
 *     not an optional one, not a jsonb bag. `hasSecret` is a boolean — enough
 *     for an operator's screen to draw "withheld", and useless to anybody who
 *     wanted the value.
 *   · `GuideSecret` is a separate type, a separate table and a separate grant.
 *     The only function that turns one into output is `discloseSecrets` in
 *     `release.ts`, and it demands an eligibility decision to do it.
 *   · The published snapshot is typed `readonly GuideEntry[]`. A secret
 *     therefore cannot be published, cannot be versioned and cannot be cached
 *     — by construction, not by a filter somebody has to remember. That also
 *     settles the rotation problem the website module never had: a door code
 *     changed between two guests must not survive in an append-only version
 *     row forever, and here it cannot get into one.
 *
 * ── Where the tuples live ─────────────────────────────────────────────────
 *
 * They belong in `src/lib/contracts/states.ts` with every other vocabulary,
 * and that file belongs to the coordinator. So they are declared here, the
 * migration transcribes them from here in order — an enum's ordinal is what
 * `order by` sorts on — and the report asks for them to be moved. When they
 * move this file re-exports them; what must never happen is a second copy
 * appearing there while this one stays.
 *
 * ── Stages organize; release rules gate ───────────────────────────────────
 *
 * `GuideStage` is how an operator arranges the guide and how the portal groups
 * it on screen. It is NOT a gate. A guest reading the pool rules the week
 * before arrival is a guest who has read the pool rules; a guest reading the
 * door code the week before arrival is a break-in. Exactly one thing decides
 * disclosure and it is `GuideReleaseRule` — see `release.ts`. Two gates would
 * mean two places to get it wrong, and only one of them would be reviewed.
 */

/* -------------------------------------------------------------- stages -- */

/**
 * The three moments a guide speaks to.
 *
 * `after_checkout` is a real stage and not an afterthought: "I left my charger
 * in the drawer" and "how do I leave a review" are the two most common
 * messages a property gets after a stay, and both are answerable in advance.
 */
export const GUIDE_STAGES = [
  'before_arrival',
  'during_stay',
  'after_checkout',
] as const
export type GuideStage = (typeof GUIDE_STAGES)[number]

/* -------------------------------------------------------------- topics -- */

/**
 * What a guide entry is about.
 *
 * A closed list, because the completeness report in `completeness.ts` is only
 * possible against one: "this property has no wi-fi entry" cannot be said
 * about free-text headings. `custom` is the escape hatch every real property
 * needs, and an entry that uses it is deliberately invisible to the
 * completeness report — there is nothing to be missing.
 *
 * Ordered by stage, and the migration transcribes this order.
 */
export const GUIDE_TOPICS = [
  // Before arrival.
  'directions',
  'parking',
  'check_in_time',
  'what_to_bring',
  'arrival_contact',
  // During the stay.
  'wifi',
  'access',
  'pool',
  'jacuzzi',
  'air_conditioning',
  'tv',
  'barbecue',
  'hot_water',
  'kitchen',
  'shabbat_equipment',
  'quiet_hours',
  'waste',
  'emergency_contact',
  // After.
  'checkout',
  'forgotten_items',
  'feedback',
  // Anything a particular house needs and this list does not have.
  'custom',
] as const
export type GuideTopic = (typeof GUIDE_TOPICS)[number]

/** Where each topic belongs by default. An operator may move it. */
export const TOPIC_DEFAULT_STAGE: Readonly<Record<GuideTopic, GuideStage>> =
  Object.freeze({
    directions: 'before_arrival',
    parking: 'before_arrival',
    check_in_time: 'before_arrival',
    what_to_bring: 'before_arrival',
    arrival_contact: 'before_arrival',
    wifi: 'during_stay',
    access: 'during_stay',
    pool: 'during_stay',
    jacuzzi: 'during_stay',
    air_conditioning: 'during_stay',
    tv: 'during_stay',
    barbecue: 'during_stay',
    hot_water: 'during_stay',
    kitchen: 'during_stay',
    shabbat_equipment: 'during_stay',
    quiet_hours: 'during_stay',
    waste: 'during_stay',
    emergency_contact: 'during_stay',
    checkout: 'after_checkout',
    forgotten_items: 'after_checkout',
    feedback: 'after_checkout',
    custom: 'during_stay',
  })

/* ------------------------------------------------------------ languages -- */

/**
 * The languages an entry may carry.
 *
 * Hebrew is not one of five options — it is the one every entry must have, and
 * `LocalizedText` says so in the type. An Israeli guesthouse writes in Hebrew
 * and translates afterwards, so a model that treats all five symmetrically
 * would let somebody publish a guide with an English body and no Hebrew one,
 * which is the wrong way round for every guest this product has.
 *
 * Arabic and Russian are here because they are spoken by real guests in real
 * numbers, not because a list of five looked better than a list of three.
 */
export const GUIDE_LANGUAGES = ['he', 'en', 'ar', 'ru', 'fr'] as const
export type GuideLanguage = (typeof GUIDE_LANGUAGES)[number]

/** Which of them are written right to left. Used for `dir` on the portal. */
export const RTL_GUIDE_LANGUAGES: readonly GuideLanguage[] = ['he', 'ar']

/**
 * Text in one or more languages, Hebrew always present.
 *
 * The intersection is the whole point: `{ en: '…' }` is not a `LocalizedText`
 * and does not compile. There is no runtime path that produces one either —
 * `readLocalizedText` refuses a record with no Hebrew rather than inventing an
 * empty string, because an empty Hebrew body would satisfy the type and say
 * nothing to the guest it exists for.
 */
export type LocalizedText = { he: string } & Partial<
  Record<Exclude<GuideLanguage, 'he'>, string>
>

/**
 * The text in the language asked for, falling back to Hebrew.
 *
 * Falls back rather than returning empty: a French guest who is shown the
 * Hebrew paragraph can paste it into a translator, and a French guest who is
 * shown nothing concludes the barbecue has no instructions.
 */
export function textIn(text: LocalizedText, language: GuideLanguage): string {
  const value = text[language]
  return typeof value === 'string' && value.trim().length > 0 ? value : text.he
}

/** Which languages this text actually carries, in catalogue order. */
export function languagesOf(text: LocalizedText): readonly GuideLanguage[] {
  return GUIDE_LANGUAGES.filter((language) => {
    const value = text[language]
    return typeof value === 'string' && value.trim().length > 0
  })
}

/**
 * A record off the wire as `LocalizedText`, or `null`.
 *
 * `null` when there is no non-blank Hebrew. The refusal is load-bearing: every
 * consumer may then assume `.he` is a real sentence, and no screen needs a
 * branch for "the Hebrew is missing" that would render as a blank line.
 */
export function readLocalizedText(value: unknown): LocalizedText | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }

  const record = value as Record<string, unknown>
  const hebrew = record.he
  if (typeof hebrew !== 'string' || hebrew.trim().length === 0) return null

  const text: LocalizedText = { he: hebrew }
  for (const language of GUIDE_LANGUAGES) {
    if (language === 'he') continue
    const entry = record[language]
    if (typeof entry === 'string' && entry.trim().length > 0) {
      text[language] = entry
    }
  }
  return text
}

/* ------------------------------------------------------------------ URLs -- */

/**
 * WHAT MAY BE PUT IN AN `href` OR AN `img src`.
 *
 * `site_media_url_shape` in 0042 is `url ~ '^(https://|/)'` and its comment
 * gives the reason: a `data:` URI in an `<img src>` on a public page is an
 * unbounded blob served to every visitor, and `javascript:` in an `<a href>`
 * is script execution. Both are refused here for the same reasons.
 *
 * Two things this refuses that the site's CHECK does not, and the report asks
 * for that constraint to be tightened to match:
 *
 *   · `//evil.example` — a protocol-relative URL. It starts with `/` and
 *     passes `^(https://|/)`, and a browser resolves it to another origin.
 *     That is an off-site link wearing a relative path's clothes.
 *   · Anything containing whitespace or a control character. `java\nscript:`
 *     is a documented way past a naive prefix test, and a URL with a newline
 *     in it is not a URL anybody typed on purpose.
 *
 * `http://` is refused as well as the dangerous schemes. A guide is opened on
 * a phone on somebody else's wi-fi, and an insecure image request is how a
 * guest's stay becomes visible to the café's network.
 */
export function isSafeUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false

  const url = value.trim()
  if (url.length === 0 || url.length > 2000) return false
  if (url !== value) return false

  // No whitespace, no control characters, anywhere. Checked before the shape
  // so that a scheme smuggled across a newline never reaches the prefix test.
  for (const character of url) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f) return false
  }

  if (url.startsWith('https://')) return url.length > 'https://'.length
  // A deployment-relative path, and never a protocol-relative one.
  if (url.startsWith('/')) return !url.startsWith('//')

  return false
}

/* ------------------------------------------------------------------ icons -- */

/**
 * The icons an entry may carry.
 *
 * A closed list for the same reason `SiteDesign.headingFont` is one: an
 * arbitrary string here would eventually be an arbitrary URL, and an arbitrary
 * URL in a guest-facing page is a request to a third party from a guest's
 * phone. The interface maps these names onto its own glyphs.
 */
export const GUIDE_ICONS = [
  'map',
  'car',
  'key',
  'clock',
  'wifi',
  'pool',
  'hot_tub',
  'snowflake',
  'tv',
  'flame',
  'droplet',
  'kitchen',
  'candle',
  'moon',
  'trash',
  'phone',
  'suitcase',
  'star',
  'info',
] as const
export type GuideIcon = (typeof GUIDE_ICONS)[number]

/* ------------------------------------------------------------- release -- */

/**
 * WHEN AN ENTRY MAY BE SHOWN.
 *
 * The first seven members are `public.guest_arrival_release` from 0034, in its
 * order, deliberately and exactly. That enum already decides when a guest may
 * see the address and the access code, `public.guest_arrival_released` is the
 * function that evaluates it, and a second vocabulary meaning almost the same
 * thing is how two policies drift until an operator sets one and is surprised
 * by the other.
 *
 * `after_check_in` is the one addition, and it is not a new policy — it is a
 * condition 0034 already implements and does not name. `guest_journey_content`
 * comments that `wifi_password` is "released once the stay has begun", which
 * is this condition, expressed in a projection instead of in the vocabulary. A
 * guide with per-entry rules has to be able to say it.
 *
 * `JOURNEY_RELEASE_MODES` below pins the transcription: `release.test.ts`
 * asserts this tuple starts with those seven, in order, so a divergence is a
 * failing test rather than a security surprise.
 */
export const GUIDE_RELEASE_MODES = [
  'immediate',
  'after_confirmation',
  'after_contract',
  'after_deposit',
  'after_full_payment',
  'hours_before',
  'manual',
  'after_check_in',
] as const
export type GuideReleaseMode = (typeof GUIDE_RELEASE_MODES)[number]

/** `public.guest_arrival_release`, transcribed. Never edited to fit. */
export const JOURNEY_RELEASE_MODES = [
  'immediate',
  'after_confirmation',
  'after_contract',
  'after_deposit',
  'after_full_payment',
  'hours_before',
  'manual',
] as const

/**
 * One entry's disclosure rule.
 *
 * `hours` is read only for `hours_before`, matching
 * `guest_journey_settings.arrival_release_hours`, and is bounded the same way
 * — 0 to 720, thirty days.
 */
export type GuideReleaseRule = {
  mode: GuideReleaseMode
  hours: number
}

export const DEFAULT_RELEASE_RULE: GuideReleaseRule = Object.freeze({
  mode: 'immediate',
  hours: 24,
})

export const MAX_RELEASE_HOURS = 720

/* ------------------------------------------------------------- entries -- */

/**
 * A media REFERENCE. There are no bytes in this module.
 *
 * The same decision `site_media` documents: a row points at something already
 * stored — a Supabase Storage object, a property's `cover_image_url` — and
 * there is no `data` column here and no upload path. `altText` is nullable and
 * its absence is a completeness finding rather than a constraint, because a
 * business adding twelve photographs at 23:00 must be told, not stopped.
 */
export type GuideMediaRef = {
  id: string
  entryId: string
  kind: GuideMediaKind
  /** https, or a deployment-relative path. `isSafeUrl` is the floor. */
  url: string
  altText: LocalizedText | null
  sortOrder: number
}

export const GUIDE_MEDIA_KINDS = ['photo', 'video'] as const
export type GuideMediaKind = (typeof GUIDE_MEDIA_KINDS)[number]

/** An outward link — a map, a menu, a bus timetable. */
export type GuideLink = {
  url: string
  label: LocalizedText
}

/**
 * ONE PIECE OF THE GUIDE, AND IT CANNOT HOLD A SECRET.
 *
 * Read the module header before adding a field. There is no `secret`, no
 * `code`, no `password` and no `metadata: Record<string, unknown>` here, and
 * each of those absences is doing work: the published snapshot is an array of
 * these, so anything that can be put on this type can be published, versioned
 * and cached.
 *
 * `hasSecret` is the flag an operator's screen renders as "withheld until…".
 * It is a boolean rather than a `secretId` because an id is a handle, and a
 * handle is one careless join away from a value.
 */
export type GuideEntry = {
  id: string
  organizationId: string
  propertyId: string
  stage: GuideStage
  topic: GuideTopic
  /** Required. The heading a guest reads. */
  title: LocalizedText
  /** The words. `null` for an entry that is only a photograph and a link. */
  body: LocalizedText | null
  icon: GuideIcon | null
  link: GuideLink | null
  media: readonly GuideMediaRef[]
  sortOrder: number
  isActive: boolean
  /** True when a `GuideSecret` is attached. The value is not here. */
  hasSecret: boolean
  /** When this entry — and its secret, if it has one — may be shown. */
  release: GuideReleaseRule
  version: number
}

/**
 * THE VALUE A GUEST MUST NOT SEE EARLY.
 *
 * A door code, an alarm code, where the lock box is, the wi-fi password. Its
 * own type, its own table, its own grant, and no reference to it from
 * `GuideEntry` beyond a boolean.
 *
 * It carries no rule of its own. Its entry's `release` governs it, because two
 * rules for one thing is two answers to "when is this shown" and an operator
 * would have to reconcile them. `entryId` is the only link, and
 * `discloseSecrets` in `release.ts` is the only function that follows it.
 */
export type GuideSecret = {
  entryId: string
  organizationId: string
  propertyId: string
  /** Localised because "מתחת לעציץ" and "under the plant pot" are both needed. */
  value: LocalizedText
  version: number
}

/* --------------------------------------------------------------- guide -- */

/**
 * A property's guide as a whole, and its publication pointer.
 *
 * The website module's shape, for its reason: a draft edit must not reach a
 * reader mid-sentence. `publishedVersionId` is what the seam reads; the draft
 * tables are not reachable from it.
 */
export const GUIDE_STATUSES = ['draft', 'published', 'unpublished'] as const
export type GuideStatus = (typeof GUIDE_STATUSES)[number]

export type Guide = {
  id: string
  organizationId: string
  propertyId: string
  status: GuideStatus
  /** The languages this property intends to offer. Hebrew is always in it. */
  languages: readonly GuideLanguage[]
  publishedVersionId: string | null
  publishedAt: string | null
  publishedBy: string | null
  version: number
}

/**
 * WHAT THE SEAM SERVES, AND WHY IT IS TYPED THIS WAY.
 *
 * `entries` is `readonly GuideEntry[]`, so a snapshot cannot contain a secret.
 * That is the sentence to keep: a rotated door code does not survive in an
 * append-only version row, because it could never be written into one.
 *
 * Recommendations travel in the snapshot because they are stable, sourced and
 * public by nature — a restaurant's address is not a disclosure decision.
 */
export type GuideSnapshot = {
  guideId: string
  propertyId: string
  propertyName: string
  languages: readonly GuideLanguage[]
  entries: readonly GuideEntry[]
  recommendations: readonly GuideRecommendation[]
  builtAt: string
}

/**
 * THE ONLY WAY A SNAPSHOT IS BUILT.
 *
 * It takes `readonly GuideEntry[]` and there is no second parameter for
 * secrets, so a publish cannot carry one into an append-only version row. Read
 * the note on `GuideSnapshot` for why that matters more here than it does for
 * a website: a door code is rotated between guests, and a version table is
 * evidence that is never deleted.
 *
 * Inactive entries are dropped at build time rather than filtered at read
 * time. A snapshot is what was published; an entry switched off before the
 * publish was not published, and leaving it in with a flag would put the
 * decision back in the reader's hands.
 */
export function buildGuideSnapshot(input: {
  guide: Guide
  propertyName: string
  entries: readonly GuideEntry[]
  recommendations: readonly GuideRecommendation[]
  builtAt: Date
}): GuideSnapshot {
  return {
    guideId: input.guide.id,
    propertyId: input.guide.propertyId,
    propertyName: input.propertyName,
    languages: input.guide.languages,
    entries: input.entries
      .filter((entry) => entry.isActive)
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)),
    recommendations: input.recommendations.filter((item) => item.isActive),
    builtAt: input.builtAt.toISOString(),
  }
}

export type GuideVersion = {
  id: string
  organizationId: string
  guideId: string
  versionNumber: number
  label: string | null
  publishedAt: string
  publishedBy: string | null
  snapshot: GuideSnapshot
}

/* ----------------------------------------------------- recommendations -- */

/**
 * What a local recommendation is about.
 *
 * `religious_service` is here because a guesthouse in the north is asked where
 * the nearest synagogue is more often than it is asked about hiking, and a
 * category list written for a resort would not have thought of it.
 */
export const RECOMMENDATION_CATEGORIES = [
  'restaurant',
  'attraction',
  'supermarket',
  'pharmacy',
  'religious_service',
  'beach',
  'hike',
  'custom',
] as const
export type RecommendationCategory = (typeof RECOMMENDATION_CATEGORIES)[number]

/**
 * WHERE A RECOMMENDATION CAME FROM. §44's rule, as a type.
 *
 * Two members and no third:
 *
 *   `business` — somebody at the property typed it and stands behind it. The
 *                user id is required; "somebody typed it" is a provenance and
 *                "it appeared" is not.
 *   `named`    — a named third party said it, and the name travels with the
 *                recommendation to the guest. A tourism board, a municipality,
 *                the restaurant's own site.
 *
 * There is deliberately no `generated`, and the absence is the enforcement.
 * §44 says a recommendation must never be produced by a model without a
 * verified source; a value meaning "a model wrote this" does not exist here,
 * so such a recommendation cannot be represented, cannot be stored and cannot
 * be shown. This is `SITE_FACT_SOURCES` making the same argument about the
 * same class of mistake — see its comment about why it has no `generated`
 * member either.
 *
 * There is no model client in this codebase and this module adds none. If one
 * is ever wired, the door is the one `groundDraft` uses in `facts.ts`: a
 * proposal becomes a recommendation at the moment a person accepts it, and it
 * is then sourced to that person.
 */
export type RecommendationSource =
  | { kind: 'business'; enteredByUserId: string }
  | { kind: 'named'; name: string; url: string | null }

export type GuideRecommendation = {
  id: string
  organizationId: string
  propertyId: string
  category: RecommendationCategory
  name: LocalizedText
  description: LocalizedText | null
  /** Free text. Not a coordinate: a guide is read, not navigated by. */
  address: LocalizedText | null
  /** E.164 where a business gave one. Never derived. */
  phone: string | null
  /** The place's own site, or a map link. `isSafeUrl` is the floor. */
  url: string | null
  /** Walking or driving minutes, as the business stated them. Never computed. */
  minutesAway: number | null
  source: RecommendationSource
  sortOrder: number
  isActive: boolean
  version: number
}
