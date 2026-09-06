/**
 * LOCAL RECOMMENDATIONS, AND WHERE EACH ONE CAME FROM. §44.
 *
 * §44 is explicit: a recommendation must never be produced by a model without
 * a verified source. This file is that rule made structural rather than
 * promised, using the same move `src/lib/website/facts.ts` makes about
 * published sentences.
 *
 *   ══════════════════════════════════════════════════════════════════════
 *   THERE IS NO WAY TO CONSTRUCT A RECOMMENDATION WITHOUT A SOURCE.
 *   ══════════════════════════════════════════════════════════════════════
 *
 * `recommendationFrom` is the only constructor and its second argument is the
 * source. `readSource` is the only way to obtain one from a form's `unknown`,
 * and it refuses anything that is not a business entry with a real user id or
 * a named third party with a real name. `RecommendationSource` has two members
 * and no `generated`, so "a model wrote this" cannot be represented — the
 * same absence, for the same reason, as `SITE_FACT_SOURCES`.
 *
 * ── What is deliberately absent from this file ────────────────────────────
 *
 * A generator. There is no model client in this codebase, this module adds
 * none, and there is no function here that takes a property and returns
 * suggestions. That is not an omission to be filled in later: the moment such
 * a function exists, `source` becomes something the caller passes rather than
 * something a person stands behind, and §44 is gone.
 *
 * If a model is ever wired, the door already exists and it is `groundDraft`'s
 * shape in `facts.ts`: a model's output is a proposal, not a recommendation,
 * and it becomes one at the moment a person with the grant accepts it — at
 * which point its source is that person and `kind: 'business'` is the honest
 * answer. Nothing in this file needs to change for that; something would need
 * to be added, and it would be reviewed.
 *
 * ── Distance is stated, never computed ────────────────────────────────────
 *
 * `minutesAway` is what the business said. This module does not know where the
 * property is, does not call a routing service, and will not turn a straight
 * line into a walking time. "Twelve minutes on foot" from a person who has
 * walked it is worth more than a number from a map, and a number from a map
 * presented as the property's own advice is exactly the fabrication §44 is
 * about.
 */

import {
  RECOMMENDATION_CATEGORIES,
  isSafeUrl,
  readLocalizedText,
  type GuideRecommendation,
  type RecommendationCategory,
  type RecommendationSource,
} from './types'

/* -------------------------------------------------------------- refusal -- */

/** Why a recommendation was not created. */
export const RECOMMENDATION_REFUSALS = [
  'no_source',
  'no_name',
  'unsafe_url',
  'unknown_category',
  'implausible_distance',
] as const
export type RecommendationRefusal = (typeof RECOMMENDATION_REFUSALS)[number]

/**
 * A refused draft, as a value rather than a throw.
 *
 * The caller is a form and a refusal is something a person reads and fixes, so
 * it travels as data. `operations.ts` turns it into a `BusinessRuleError` at
 * the one point where an exception is the right shape.
 */
export type RecommendationResult =
  | { ok: true; recommendation: GuideRecommendation }
  | { ok: false; refusal: RecommendationRefusal }

/* --------------------------------------------------------- the source -- */

/**
 * A source off a form, or `null`.
 *
 * `null` is the whole enforcement, so it is worth reading what produces one:
 * a missing `kind`, a `business` entry with no user id, a `named` source with
 * a blank name, an unsafe URL on a named source, or any third `kind` somebody
 * invents — `generated` included, which is why the default branch is a plain
 * `null` and not a thrown error naming what it saw.
 */
export function readSource(value: unknown): RecommendationSource | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }

  const record = value as Record<string, unknown>

  if (record.kind === 'business') {
    const userId = record.enteredByUserId
    if (typeof userId !== 'string' || userId.trim().length === 0) return null
    return { kind: 'business', enteredByUserId: userId }
  }

  if (record.kind === 'named') {
    const name = record.name
    if (typeof name !== 'string' || name.trim().length === 0) return null

    const url = record.url
    if (url === null || url === undefined) {
      return { kind: 'named', name: name.trim(), url: null }
    }
    if (!isSafeUrl(url)) return null
    return { kind: 'named', name: name.trim(), url }
  }

  return null
}

/**
 * How a source is shown to a guest.
 *
 * A named source is named, in the guest's face, beside the recommendation.
 * That is what makes "verified source" mean something to the person reading
 * it rather than only to the database. A business's own recommendation says so
 * plainly — a guest reading "המלצת בית האירוח" knows who is vouching.
 */
export function sourceLabel(source: RecommendationSource): string {
  return source.kind === 'business' ? 'המלצת בית האירוח' : `לפי ${source.name}`
}

/* --------------------------------------------------- the one constructor -- */

/** Everything a person types. No source, no id, no ordering. */
export type RecommendationDraft = {
  organizationId: string
  propertyId: string
  category: string
  name: unknown
  description?: unknown
  address?: unknown
  phone?: string | null
  url?: string | null
  minutesAway?: number | null
  sortOrder?: number
}

/** Walking or driving. Beyond this the number is a typo, not a journey. */
export const MAX_MINUTES_AWAY = 600

/**
 * THE ONLY WAY TO MAKE A `GuideRecommendation`.
 *
 * The signature is the rule: there is no overload without `source`, and
 * `source` is a `RecommendationSource`, which `readSource` is the only public
 * producer of. A caller holding raw form data cannot skip that step, because
 * the type it would have to invent has no `generated` member to reach for.
 *
 * `id` is passed in rather than generated here so the function stays pure and
 * the database's `gen_random_uuid()` stays the one identity authority.
 */
export function recommendationFrom(
  id: string,
  draft: RecommendationDraft,
  source: RecommendationSource,
): RecommendationResult {
  if (!isCategory(draft.category)) {
    return { ok: false, refusal: 'unknown_category' }
  }

  const name = readLocalizedText(draft.name)
  if (name === null) return { ok: false, refusal: 'no_name' }

  const url = draft.url ?? null
  if (url !== null && !isSafeUrl(url)) {
    return { ok: false, refusal: 'unsafe_url' }
  }

  const minutesAway = draft.minutesAway ?? null
  if (
    minutesAway !== null &&
    (!Number.isInteger(minutesAway) ||
      minutesAway < 0 ||
      minutesAway > MAX_MINUTES_AWAY)
  ) {
    return { ok: false, refusal: 'implausible_distance' }
  }

  return {
    ok: true,
    recommendation: {
      id,
      organizationId: draft.organizationId,
      propertyId: draft.propertyId,
      category: draft.category,
      name,
      description: readLocalizedText(draft.description),
      address: readLocalizedText(draft.address),
      phone: normalizePhone(draft.phone),
      url,
      minutesAway,
      source,
      sortOrder: draft.sortOrder ?? 0,
      isActive: true,
      version: 1,
    },
  }
}

/**
 * A draft and a raw source together, which is what a form actually posts.
 *
 * Refuses with `no_source` before it looks at anything else. A caller that
 * validated the name first would report "the name is missing" about a
 * submission whose real problem is that nobody is standing behind it.
 */
export function recommendationFromForm(
  id: string,
  draft: RecommendationDraft,
  rawSource: unknown,
): RecommendationResult {
  const source = readSource(rawSource)
  if (source === null) return { ok: false, refusal: 'no_source' }
  return recommendationFrom(id, draft, source)
}

function isCategory(value: string): value is RecommendationCategory {
  return (RECOMMENDATION_CATEGORIES as readonly string[]).includes(value)
}

/**
 * A telephone number as the business typed it, or `null`.
 *
 * Not normalised to E.164 and not validated against a country: a guide lists
 * a restaurant's number, and a restaurant that answers on a four-digit short
 * code is a restaurant whose number this must not refuse. Blank becomes
 * `null`, which is the only transformation here.
 */
function normalizePhone(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/* --------------------------------------------------------------- views -- */

/** Active recommendations, grouped by category in catalogue order. */
export function byCategory(
  recommendations: readonly GuideRecommendation[],
): readonly {
  category: RecommendationCategory
  items: readonly GuideRecommendation[]
}[] {
  return RECOMMENDATION_CATEGORIES.map((category) => ({
    category,
    items: recommendations
      .filter((item) => item.isActive && item.category === category)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)),
  })).filter((group) => group.items.length > 0)
}

/**
 * The named third parties this property is relying on.
 *
 * Shown on the settings screen so an operator can see at a glance whose word
 * their guide is repeating. A guide that leans entirely on one tourism board's
 * list is a guide that goes stale when that board does.
 */
export function citedSources(
  recommendations: readonly GuideRecommendation[],
): readonly string[] {
  const names = new Set<string>()
  for (const item of recommendations) {
    if (item.source.kind === 'named') names.add(item.source.name)
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'he'))
}
