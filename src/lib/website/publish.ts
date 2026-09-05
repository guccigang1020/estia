/**
 * PUBLISHING, AND UNDOING IT.
 *
 * ── Publishing is a distinct act from editing ─────────────────────────────
 *
 * Not a flag on a page. A separate grant (`site.publish`), a separate
 * operation, a separate row in `site_versions`, and a separate moment. The
 * roles genuinely differ: a marketing employee writes copy all week and never
 * publishes, a manager approves, and only somebody holding `site.publish` puts
 * a sentence in front of a customer. Collapsing that into "save" would make
 * every typo live.
 *
 * ── Rollback restores without destroying ──────────────────────────────────
 *
 *   ROLLING BACK TO v3 CREATES v7. IT DOES NOT DELETE v4, v5 OR v6.
 *
 * This is the whole design of the version table and it is not a convenience.
 * A business that rolls back at 21:00 because a price was wrong must be able
 * to roll forward at 09:00 once it is fixed, and a rollback that deleted the
 * intervening versions would have thrown away the work. So a rollback is a
 * publish: it copies an old snapshot into a NEW version, records
 * `restored_from_version_id`, and leaves everything after it exactly where it
 * was. `tg_site_versions_immutable` in 0042 makes that true at the database
 * rather than here — a version row cannot be updated or deleted by anybody,
 * `service_role` included.
 *
 * The consequence worth stating: version numbers only ever go up, and the
 * highest number is not necessarily the newest content. That is correct. The
 * history of what was live is a sequence of publishes, and a rollback is one
 * of them.
 *
 * ── Unpublishing ──────────────────────────────────────────────────────────
 *
 * Taking a site down clears the pointer and leaves every version standing.
 * `unpublished` is a distinct status from `draft` for that reason: a business
 * that took its site down still has its site.
 */

import { BusinessRuleError } from '../errors'
import type { UnsourcedClaim } from './facts'
import type { Site, SiteStatus, SiteVersion } from './types'

/* ------------------------------------------------------- the transitions -- */

export type SiteAction = 'publish' | 'unpublish' | 'rollback'

/**
 * What each act requires of the site's current state.
 *
 * Written as data rather than as `if` statements so that the studio can ask
 * "may I offer this button?" and the operation can ask "may I do this?" and
 * both get the same answer from the same table.
 */
export const SITE_TRANSITIONS: Readonly<
  Record<SiteAction, { from: readonly SiteStatus[]; to: SiteStatus }>
> = Object.freeze({
  // A draft becomes published; a published site publishes again; an
  // unpublished site comes back. Every state can publish, which is correct —
  // publishing is how a site enters every one of them.
  publish: { from: ['draft', 'published', 'unpublished'], to: 'published' },
  // Only a live site can be taken down. Taking down a draft is a no-op that
  // would leave somebody believing they had done something.
  unpublish: { from: ['published'], to: 'unpublished' },
  // Rolling back needs something to roll back to, which is a version — and a
  // site with no version has never been published. The version check is
  // separate and is below.
  rollback: { from: ['published', 'unpublished'], to: 'published' },
})

export class SitePublishRefusedError extends BusinessRuleError {
  constructor(code: string, userMessage: string) {
    super({
      code,
      userMessage,
      status: 422,
      message: `Site publish refused: ${code}`,
    })
  }
}

/**
 * The unsourced-claim refusal, with every offending claim named.
 *
 * Named individually and not counted. "3 claims cannot be sourced" sends
 * somebody hunting; "the heading of the hero section on the home page says the
 * property has a heated pool and no property row says so" is a thing they can
 * fix in a minute.
 */
export class SiteClaimsUnsourcedError extends BusinessRuleError {
  readonly blockers: readonly UnsourcedClaim[]

  constructor(blockers: readonly UnsourcedClaim[]) {
    const listed = blockers
      .slice(0, 5)
      .map((blocker) => `״${blocker.claim.key}״ (${REASON_HE[blocker.reason]})`)
      .join('; ')

    super({
      code: 'site_claims_unsourced',
      status: 422,
      message: `Site publish refused: ${blockers.length} unsourced claims`,
      userMessage:
        `לא ניתן לפרסם: ${blockers.length} טענות באתר אינן ניתנות לאימות מול הנתונים שלכם — ${listed}` +
        (blockers.length > 5 ? ' ועוד.' : '.'),
    })
    this.blockers = blockers
  }
}

const REASON_HE: Readonly<Record<UnsourcedClaim['reason'], string>> =
  Object.freeze({
    canonical_source_without_row:
      'מצהירה שהיא מגיעה מנתוני הנכס ואינה מפנה לשורה',
    authored_without_author: 'אין מי שחתום עליה',
    empty_text: 'ריקה',
  })

/** May this act be performed on a site in this state? A reason, or `null`. */
export function transitionRefusal(
  action: SiteAction,
  site: Pick<Site, 'status' | 'publishedVersionId'>,
): string | null {
  const transition = SITE_TRANSITIONS[action]

  if (!transition.from.includes(site.status)) {
    return REFUSALS[action][site.status] ?? 'הפעולה אינה אפשרית במצב הנוכחי.'
  }

  if (action === 'rollback' && site.publishedVersionId === null) {
    return 'האתר מעולם לא פורסם, ולכן אין גרסה לחזור אליה.'
  }

  return null
}

const REFUSALS: Readonly<
  Record<SiteAction, Partial<Record<SiteStatus, string>>>
> = Object.freeze({
  publish: {},
  unpublish: {
    draft: 'האתר עדיין לא פורסם, ולכן אין מה להוריד מהאוויר.',
    unpublished: 'האתר כבר אינו באוויר.',
  },
  rollback: {
    draft: 'האתר מעולם לא פורסם, ולכן אין גרסה לחזור אליה.',
  },
})

export function assertTransition(
  action: SiteAction,
  site: Pick<Site, 'status' | 'publishedVersionId'>,
): void {
  const refusal = transitionRefusal(action, site)
  if (refusal) {
    throw new SitePublishRefusedError(`site_${action}_not_allowed`, refusal)
  }
}

/* ------------------------------------------------------------ versioning -- */

/**
 * The number the next version gets.
 *
 * Highest plus one, over every existing version — never `count + 1`. Counting
 * would reuse a number after a version was somehow removed, and two rows
 * claiming to be v5 makes the history unreadable exactly when somebody is
 * trying to work out what was live on the day a guest complained.
 */
export function nextVersionNumber(
  versions: readonly Pick<SiteVersion, 'versionNumber'>[],
): number {
  return (
    versions.reduce((highest, version) => {
      return version.versionNumber > highest ? version.versionNumber : highest
    }, 0) + 1
  )
}

/** Which version is live, if any. */
export function liveVersion(
  site: Pick<Site, 'publishedVersionId' | 'status'>,
  versions: readonly SiteVersion[],
): SiteVersion | null {
  if (site.status !== 'published' || !site.publishedVersionId) return null
  return versions.find((v) => v.id === site.publishedVersionId) ?? null
}

/**
 * The versions a person may roll back to, newest publish first.
 *
 * The live one is excluded — rolling back to what is already live is a
 * no-op dressed as an action, and offering it is how somebody ends up
 * publishing a version they did not mean to touch.
 */
export function rollbackTargets(
  site: Pick<Site, 'publishedVersionId' | 'status'>,
  versions: readonly SiteVersion[],
): readonly SiteVersion[] {
  return versions
    .filter((version) => version.id !== site.publishedVersionId)
    .slice()
    .sort((a, b) => b.versionNumber - a.versionNumber)
}

/**
 * Is the draft ahead of what is live?
 *
 * What the studio's "you have unpublished changes" banner asks. Compares the
 * draft's own `updated_at` against the moment of the live publish rather than
 * diffing documents: a diff would be prettier and would also be a second
 * definition of "changed" that could disagree with the one the publish
 * operation uses.
 */
export function hasUnpublishedChanges(input: {
  site: Pick<Site, 'status' | 'publishedAt'>
  draftUpdatedAt: string | null
}): boolean {
  if (input.site.status === 'draft') return true
  if (!input.site.publishedAt) return true
  if (!input.draftUpdatedAt) return false

  return Date.parse(input.draftUpdatedAt) > Date.parse(input.site.publishedAt)
}
