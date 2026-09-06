/**
 * The property guide domain, in one import.
 *
 * ── What a reader should look at first ────────────────────────────────────
 *
 * `release.ts`. Everything else is arranged around the property it enforces:
 * "everything this guest may see right now" returns `GuideEntry[]`, and
 * `GuideEntry` has no field a door code fits in. The rest — the topics, the
 * completeness report, the recommendations — is a content library, and content
 * libraries are not where the expensive mistakes live.
 *
 * Then `types.ts`, for the two absences that make the module work: no secret
 * field on `GuideEntry`, and no `generated` member on `RecommendationSource`.
 *
 * ── `repository.ts` is deliberately not exported here ─────────────────────
 *
 * Server code imports `@/lib/guest-guide/repository` by its own path. That is
 * a smaller point than it looks, and it is worth being precise about why:
 * `operations.ts` imports the repository, so this barrel reaches
 * `@/lib/persistence` and the `postgres` driver regardless, and it is a
 * SERVER-ONLY barrel. A Client Component importing it would take the whole
 * application down with `Can't resolve 'fs'` — the failure
 * `scripts/client-bundle.mjs` exists to catch, three times in one day.
 *
 * So the rule for a `"use client"` component is the leaf, not the barrel:
 * `@/lib/guest-guide/labels` and `@/lib/guest-guide/types` are pure data and
 * pure functions and import nothing. The screens in this module follow that,
 * and the bundle checker is what proves it rather than this paragraph.
 */

export * from './types'

export {
  PAST_ARGUMENT_STATUSES,
  WITHHOLD_REASONS,
  discloseSecrets,
  isJourneyMode,
  noEligibility,
  releaseCondition,
  releaseGuide,
  releaseMet,
  type DisclosedSecret,
  type GuideDisclosure,
  type GuideEligibility,
  type WithheldEntry,
  type WithholdReason,
} from './release'

export {
  MAX_MINUTES_AWAY,
  RECOMMENDATION_REFUSALS,
  byCategory,
  citedSources,
  readSource,
  recommendationFrom,
  recommendationFromForm,
  sourceLabel,
  type RecommendationDraft,
  type RecommendationRefusal,
  type RecommendationResult,
} from './recommendations'

export {
  AMENITY_TOPICS,
  ESSENTIAL_TOPICS,
  EXPECTED_TOPICS,
  GAP_KINDS,
  GAP_SEVERITIES,
  guideCompleteness,
  needsAttention,
  type GapKind,
  type GapSeverity,
  type GuideCompleteness,
  type GuideCompletenessInput,
  type GuideGap,
} from './completeness'

export {
  CATEGORY_LABEL,
  GAP_KIND_LABEL,
  GAP_SEVERITY_LABEL,
  GUIDE_STATUS_LABEL,
  LANGUAGE_LABEL,
  MEDIA_KIND_LABEL,
  RELEASE_MODE_LABEL,
  STAGE_LABEL,
  STAGE_SUMMARY,
  TOPIC_LABEL,
  WITHHOLD_REASON_LABEL,
} from './labels'

export {
  GUIDE_GRANTS,
  defineGuestGuideOperations,
  type EntryDraft,
  type GuestGuideOperations,
  type PublishInput,
  type PublishedGuide,
  type RecommendationInput,
  type SecretDraft,
} from './operations'
