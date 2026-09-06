/**
 * LOCAL RECOMMENDATIONS, EACH BESIDE THE NAME OF WHOEVER IS VOUCHING FOR IT.
 *
 * §44's rule is not only about what may be stored. A recommendation whose
 * source lives in a column nobody renders is a recommendation whose source
 * nobody checks, so the source is printed on every row — "המלצת בית האירוח" or
 * "לפי עיריית צפת" — and it is printed to the guest too when the portal comes
 * to render this.
 *
 * `sourceLabel` is imported rather than re-worded here, so the operator's
 * screen and the guest's page say the same sentence about the same row.
 *
 * ── Distance is repeated, never computed ──────────────────────────────────
 *
 * `minutesAway` is what the business typed. This component does not know where
 * the property is and does not call a routing service. See the note in
 * `recommendations.ts` about why a number from a map presented as the house's
 * own advice is the fabrication §44 exists to prevent.
 *
 * No `"use client"`: it renders text and links.
 */

import { Badge } from '@/components/ui/badge'
import { PanelNote } from '@/components/shell-screens/screen'
import { CATEGORY_LABEL } from '@/lib/guest-guide/labels'
import { sourceLabel } from '@/lib/guest-guide/recommendations'
import type {
  GuideRecommendation,
  RecommendationCategory,
} from '@/lib/guest-guide/types'

export type RecommendationGroup = {
  category: RecommendationCategory
  items: readonly GuideRecommendation[]
}

export function RecommendationList({
  groups,
  citedSources,
}: {
  groups: readonly RecommendationGroup[]
  /** The third parties this guide is repeating. Empty when it repeats none. */
  citedSources: readonly string[]
}) {
  if (groups.length === 0) {
    return (
      <PanelNote>
        אין המלצות מקומיות. כל המלצה נכתבת על ידי בית האירוח או מצטטת גורם ששמו
        מופיע לצידה — אין כאן ייצור אוטומטי של המלצות.
      </PanelNote>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <section key={group.category} className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-foreground">
            {CATEGORY_LABEL[group.category]}
          </h3>
          <ul className="flex flex-col divide-y divide-border">
            {group.items.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {item.name.he}
                  </span>
                  {/* Printed on every row. See the header. */}
                  <Badge
                    tone={item.source.kind === 'business' ? 'brand' : 'neutral'}
                  >
                    {sourceLabel(item.source)}
                  </Badge>
                </div>

                {item.description !== null && (
                  <p className="max-w-prose text-sm text-muted-foreground">
                    {item.description.he}
                  </p>
                )}

                <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                  {item.address !== null && (
                    <div className="flex gap-1.5">
                      <dt>כתובת</dt>
                      <dd>{item.address.he}</dd>
                    </div>
                  )}
                  {item.phone !== null && (
                    <div className="flex gap-1.5">
                      <dt>טלפון</dt>
                      <dd dir="ltr">{item.phone}</dd>
                    </div>
                  )}
                  {item.minutesAway !== null && (
                    <div className="flex gap-1.5">
                      <dt>מרחק</dt>
                      <dd>{item.minutesAway} דקות, לפי בית האירוח</dd>
                    </div>
                  )}
                  {item.url !== null && (
                    <div className="flex gap-1.5">
                      <dt>קישור</dt>
                      <dd>
                        <a
                          dir="ltr"
                          href={item.url}
                          rel="noreferrer noopener"
                          target="_blank"
                          className="underline"
                        >
                          {item.url}
                        </a>
                      </dd>
                    </div>
                  )}
                </dl>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {citedSources.length > 0 && (
        <p className="text-sm text-muted-foreground">
          המדריך הזה מצטט: {citedSources.join(', ')}. אם אחד מהם מתיישן, ההמלצות
          שמסתמכות עליו מתיישנות איתו.
        </p>
      )}
    </div>
  )
}
