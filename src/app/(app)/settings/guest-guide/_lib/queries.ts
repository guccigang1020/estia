/**
 * EXECUTION CONTEXT — SERVER ONLY. What the guide settings screen reads.
 *
 * ══ NO SECRET IS READ HERE, AND THAT IS THE POINT OF THE FILE ══════════════
 *
 * This screen renders on a server and its props are serialised into the HTML
 * that reaches a browser. A door code read here would be a door code in the
 * page payload, and no amount of `{withheld && …}` in a component undoes that.
 *
 * So `GuestGuideRepository` has no method that returns one. What this reads is
 * `entryIdsWithSecret` — which entries have a value behind them — which is
 * exactly what the screen needs to draw "withheld until the deposit is paid"
 * and what `guideCompleteness` needs to report a sensitive entry with nothing
 * in it. The only reader of the values is the seam function named in this
 * module's report, and it is not in this codebase yet.
 *
 * ══ THE TABLES MAY NOT EXIST YET ═══════════════════════════════════════════
 *
 * They are created by a migration this worker does not write. `readGuide`
 * turns the two codes that mean "no such relation" into a state the page
 * renders as `DomainGap` naming the tables — never an empty list, which would
 * tell a business the guide works and has nothing in it. Every other failure
 * is rethrown untouched.
 *
 * ── Three floors ──────────────────────────────────────────────────────────
 *
 *   1. `requireGrant('property.view')` refuses the route.
 *   2. The selected property is checked again with `can()` against the grant
 *      that governs writing it, so a reader scoped to one property cannot open
 *      another's guide by changing a query parameter.
 *   3. Row level security refuses regardless of both.
 */

import { can, type Actor, type Resource } from '@/lib/authz/can'
import {
  guideCompleteness,
  type GuideCompleteness,
} from '@/lib/guest-guide/completeness'
import { byCategory, citedSources } from '@/lib/guest-guide/recommendations'
import { GUIDE_GRANTS } from '@/lib/guest-guide/operations'
import {
  GUIDE_TABLES,
  readGuide,
  type GuideReadout,
} from '@/lib/guest-guide/repository'
import {
  GUIDE_STAGES,
  type Guide,
  type GuideEntry,
  type GuideStage,
  type GuideTopic,
} from '@/lib/guest-guide/types'
import type { Provisioned } from '@/lib/fiscal/provisioning'
import type { Db } from '@/lib/persistence'

export { GUIDE_TABLES }

/**
 * The guide is property configuration, so it is scoped in the `inventory`
 * family — the one `RESOURCE_FAMILIES` documents as "properties, units,
 * availability". A membership narrowed to one property by that family is
 * narrowed here too, without this file knowing how the narrowing works.
 */
function guideResource(organizationId: string, propertyId: string): Resource {
  return { organizationId, propertyId, family: 'inventory' }
}

export type StageView = {
  stage: GuideStage
  entries: readonly GuideEntry[]
}

export type GuideScreenView = {
  guide: Guide | null
  propertyId: string
  propertyName: string | null
  stages: readonly StageView[]
  /** Which entries actually have a value behind them. Ids, never values. */
  entryIdsWithSecret: readonly string[]
  completeness: GuideCompleteness
  recommendations: ReturnType<typeof byCategory>
  citedSources: readonly string[]
  versions: GuideReadout['versions']
  /** False when this reader may look and not touch. */
  canEdit: boolean
}

/**
 * Everything the screen shows for one property, or the statement that the
 * storage is absent.
 *
 * Takes the client rather than constructing one, the way
 * `settings/fiscal/_lib/queries.ts` does: a read that builds its own Supabase
 * client cannot be driven by a fake, and an untestable read is where a wrong
 * column name lives until production.
 */
export async function loadGuideScreen(
  db: Db,
  actor: Actor,
  organizationId: string,
  propertyId: string,
): Promise<Provisioned<GuideScreenView>> {
  const readout = await readGuide(db, organizationId, propertyId)
  if (readout.state === 'not_provisioned') return readout

  const data = readout.data
  const resource = guideResource(organizationId, propertyId)

  // The completeness report is told which amenity topics to consider by the
  // entries the operator has already created. It never guesses that a property
  // has a pool — see `completeness.ts` for why a finding nobody can close is
  // worse than no finding.
  const amenityTopics = data.entries.map((entry) => entry.topic)

  return {
    state: 'ready',
    data: {
      guide: data.guide,
      propertyId,
      propertyName: data.propertyName,
      stages: GUIDE_STAGES.map((stage) => ({
        stage,
        entries: data.entries
          .filter((entry) => entry.stage === stage)
          .sort(
            (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
          ),
      })),
      entryIdsWithSecret: data.entryIdsWithSecret,
      completeness: guideCompleteness({
        entries: data.entries,
        recommendations: data.recommendations,
        entryIdsWithSecret: data.entryIdsWithSecret,
        amenityTopics: amenityTopics as readonly GuideTopic[],
        languages: data.guide?.languages ?? ['he'],
      }),
      recommendations: byCategory(data.recommendations),
      citedSources: citedSources(data.recommendations),
      versions: data.versions,
      canEdit: can(actor, GUIDE_GRANTS.edit, resource),
    },
  }
}

/**
 * May this reader open this property's guide at all?
 *
 * Asked before the read rather than after it, so a person scoped to the Carmel
 * flat who types the Galilee villa's id gets a refusal instead of a screen
 * that happens to be empty because row level security returned nothing.
 */
export function mayReadGuide(
  actor: Actor,
  organizationId: string,
  propertyId: string,
): boolean {
  return can(
    actor,
    GUIDE_GRANTS.view,
    guideResource(organizationId, propertyId),
  )
}
