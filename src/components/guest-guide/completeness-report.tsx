/**
 * WHAT THE GUIDE IS MISSING, IN FRONT OF THE OPERATOR.
 *
 * The reason this panel is at the top of the screen rather than at the bottom
 * is the whole argument for the feature: a guide with no wi-fi entry produces
 * a message at 22:00 tonight, and the only moment anybody can prevent it is
 * while they are already looking at the guide.
 *
 * ── There is no score, deliberately ───────────────────────────────────────
 *
 * No percentage, no ring, no "your guide is 74% complete". A number invites
 * somebody to raise the number; a sentence saying "אורחים ישאלו מה הסיסמה של
 * הוויי-פיי" gets the entry written. `completeness.ts` refuses to produce a
 * score and this component has none to render.
 *
 * The counts ARE shown, per severity, because "three things a guest will
 * certainly ask" is a size, not a grade — it goes to zero and stays there.
 *
 * No `"use client"`: it renders text. It imports `@/lib/guest-guide/labels`
 * and `.../completeness` by their own paths and never the barrel, which
 * reaches the database driver.
 */

import { Badge } from '@/components/ui/badge'
import { PanelNote } from '@/components/shell-screens/screen'
import type {
  GuideCompleteness,
  GapSeverity,
} from '@/lib/guest-guide/completeness'
import {
  GAP_KIND_LABEL,
  GAP_SEVERITY_LABEL,
  STAGE_LABEL,
  TOPIC_LABEL,
} from '@/lib/guest-guide/labels'

const SEVERITY_TONE: Record<GapSeverity, 'accent' | 'brand' | 'neutral'> = {
  essential: 'accent',
  expected: 'brand',
  optional: 'neutral',
}

export function CompletenessReport({ report }: { report: GuideCompleteness }) {
  if (report.gaps.length === 0) {
    return (
      <PanelNote>
        כל הנושאים שאורחים שואלים עליהם מכוסים. זה לא ציון — זו רשימה שנגמרה.
      </PanelNote>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
        {(['essential', 'expected', 'optional'] as const)
          .filter((severity) => report.counts[severity] > 0)
          .map((severity) => (
            <div key={severity} className="flex gap-2">
              <dt>{GAP_SEVERITY_LABEL[severity]}</dt>
              <dd className="tabular-nums">{report.counts[severity]}</dd>
            </div>
          ))}
      </dl>

      <ul className="flex flex-col divide-y divide-border">
        {report.gaps.map((gap, index) => (
          <li
            key={`${gap.kind}-${gap.topic ?? 'general'}-${index}`}
            className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0"
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <Badge tone={SEVERITY_TONE[gap.severity]}>
                {GAP_SEVERITY_LABEL[gap.severity]}
              </Badge>
              <span className="text-sm font-medium text-foreground">
                {gap.topic === null
                  ? GAP_KIND_LABEL[gap.kind]
                  : TOPIC_LABEL[gap.topic]}
              </span>
              {gap.stage !== null && (
                <span className="text-xs text-muted-foreground">
                  {STAGE_LABEL[gap.stage]}
                </span>
              )}
            </div>
            {/* The finding is the sentence, not the label. See the header. */}
            <p className="text-sm text-muted-foreground">{gap.detail}</p>
          </li>
        ))}
      </ul>

      {report.covered.length > 0 && (
        <p className="text-sm text-muted-foreground">
          מכוסה כבר:{' '}
          {report.covered.map((topic) => TOPIC_LABEL[topic]).join(', ')}
        </p>
      )}
    </div>
  )
}
