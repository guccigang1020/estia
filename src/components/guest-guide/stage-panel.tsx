/**
 * ONE STAGE OF THE GUIDE, AS THE OPERATOR ARRANGED IT.
 *
 * ══ WHAT THIS COMPONENT CANNOT RENDER ══════════════════════════════════════
 *
 * A door code. Its props are `GuideEntry[]`, and `GuideEntry` has no field a
 * secret fits in — see `src/lib/guest-guide/types.ts`. So the "withheld" mark
 * below is not a component being careful; it is the only thing this component
 * COULD draw, because the value was never read on the server and is not in the
 * page's payload.
 *
 * That distinction matters. A screen that received the code and chose not to
 * print it would still have shipped it to the browser inside the serialised
 * props, where View Source finds it. This one received a boolean.
 *
 * ── What an operator needs to see beside a sensitive entry ────────────────
 *
 * Two facts, and they are different: whether a value has been entered, and
 * when a guest will get it. An entry marked as carrying a code with no code
 * behind it is the failure nothing else in the product would notice — a guest
 * pays a deposit and is shown a heading — so it is called out here in red as
 * well as in the completeness report.
 *
 * No `"use client"`: it renders text and one link per entry.
 */

import { SecretForm } from '@/components/guest-guide/secret-form'
import { Badge } from '@/components/ui/badge'
import { PanelNote, Withheld } from '@/components/shell-screens/screen'
import {
  LANGUAGE_LABEL,
  MEDIA_KIND_LABEL,
  RELEASE_MODE_LABEL,
  STAGE_LABEL,
  STAGE_SUMMARY,
  TOPIC_LABEL,
} from '@/lib/guest-guide/labels'
import {
  languagesOf,
  type GuideEntry,
  type GuideStage,
} from '@/lib/guest-guide/types'

export function StagePanel({
  stage,
  entries,
  entryIdsWithSecret,
  propertyId,
  canEdit,
}: {
  stage: GuideStage
  entries: readonly GuideEntry[]
  /** Which entries have a value behind them. Ids, never values. */
  entryIdsWithSecret: readonly string[]
  propertyId: string
  /** False for a reader who may look and not touch. */
  canEdit: boolean
}) {
  if (entries.length === 0) {
    return <PanelNote>{STAGE_SUMMARY[stage]} עדיין אין כאן ערכים.</PanelNote>
  }

  const filled = new Set(entryIdsWithSecret)

  return (
    <ul className="flex flex-col divide-y divide-border">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0"
        >
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              {entry.title.he}
            </h3>
            <Badge>{TOPIC_LABEL[entry.topic]}</Badge>
            {!entry.isActive && <Badge tone="neutral">כבוי</Badge>}
          </div>

          {entry.body !== null ? (
            <p className="max-w-prose text-sm text-muted-foreground">
              {entry.body.he}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              אין טקסט. אורח יראה כותרת בלבד.
            </p>
          )}

          {entry.hasSecret && (
            <div className="flex flex-wrap items-baseline gap-2 rounded-lg bg-muted px-3 py-2 text-sm">
              <span className="font-medium text-foreground">קוד או סוד</span>
              {/* Never a value, in either branch. See the header. */}
              <Withheld />
              <span className="text-muted-foreground">
                · ייחשף: {RELEASE_MODE_LABEL[entry.release.mode]}
                {entry.release.mode === 'hours_before'
                  ? ` (${entry.release.hours} שעות)`
                  : ''}
              </span>
              {!filled.has(entry.id) && (
                <Badge tone="accent">לא הוזן ערך — אורח יראה כותרת ריקה</Badge>
              )}
            </div>
          )}

          {entry.hasSecret && canEdit && (
            <SecretForm
              propertyId={propertyId}
              entryId={entry.id}
              entryTitle={entry.title.he}
              release={entry.release}
              isSet={filled.has(entry.id)}
            />
          )}

          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            {!entry.hasSecret && (
              <div className="flex gap-1.5">
                <dt>נחשף</dt>
                <dd>{RELEASE_MODE_LABEL[entry.release.mode]}</dd>
              </div>
            )}
            <div className="flex gap-1.5">
              <dt>שפות</dt>
              <dd>
                {languagesOf(entry.title)
                  .map((language) => LANGUAGE_LABEL[language])
                  .join(', ')}
              </dd>
            </div>
            {entry.media.length > 0 && (
              <div className="flex gap-1.5">
                <dt>מדיה</dt>
                <dd>
                  {entry.media
                    .map((item) => MEDIA_KIND_LABEL[item.kind])
                    .join(', ')}
                </dd>
              </div>
            )}
            {entry.link !== null && (
              <div className="flex gap-1.5">
                <dt>קישור</dt>
                <dd>
                  {/* The stored URL, rendered LTR because it is not Hebrew.
                      `isSafeUrl` refused anything but https or a relative
                      path before it reached the table. */}
                  <a
                    dir="ltr"
                    href={entry.link.url}
                    rel="noreferrer noopener"
                    target="_blank"
                    className="underline"
                  >
                    {entry.link.label.he}
                  </a>
                </dd>
              </div>
            )}
          </dl>
        </li>
      ))}
    </ul>
  )
}

export function stageHeading(stage: GuideStage): string {
  return STAGE_LABEL[stage]
}
