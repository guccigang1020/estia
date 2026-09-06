/**
 * A readiness figure with the arithmetic that produced it, never without.
 *
 * ── The number is not computed here ──────────────────────────────────────
 *
 * `percent`, `met` and `applicable` all arrive on the `Readiness` object. This
 * component divides nothing, counts nothing and rounds nothing — it draws what
 * the domain decided. A percentage recomputed in a component is a second
 * opinion that will disagree with the first one the day somebody changes how
 * `not_applicable` is handled, and the customer would be looking at the wrong
 * one of the two.
 *
 * ── Every score decomposes, and that is the whole feature ────────────────
 *
 * There is no private denominator: `met` over `applicable` is the entire
 * calculation, both numbers are printed, and every requirement is listed with
 * its own status and its own evidence. A manager who disagrees with 78% can
 * see which line they disagree with. A score nobody can decompose is a score
 * people learn to ignore, and an ignored readiness score is worse than none —
 * it looks like coverage.
 *
 * ── `not_applicable` is shown, not hidden ────────────────────────────────
 *
 * A business with laundry switched off has no laundry requirement, and
 * counting it as unmet would tell every one of those customers they are
 * permanently 87% ready. So it is dropped from the denominator by the domain
 * and listed here under a heading that says it was dropped — because a
 * requirement that silently disappeared is indistinguishable from one that was
 * forgotten.
 *
 * ── `percent === null` is a real state ───────────────────────────────────
 *
 * Nothing applies, so there is no fraction. It renders as a sentence and not
 * as 0%, 100% or an empty bar. Each of those three is a claim, and none of
 * them is true.
 *
 * No `'use client'`: values in, markup out.
 */

import type { Readiness, ReadinessRequirement } from '@/lib/autopilot/types'
import { cn } from '@/components/ui/cn'

import { EvidenceList } from './evidence-list'
import { RISK_LABEL } from './labels'

const STATUS_LABEL: Record<ReadinessRequirement['status'], string> = {
  met: 'הושלם',
  unmet: 'חסר',
  at_risk: 'בסיכון',
  not_applicable: 'לא רלוונטי',
}

const STATUS_DOT: Record<ReadinessRequirement['status'], string> = {
  met: 'bg-primary',
  unmet: 'bg-danger',
  at_risk: 'bg-accent',
  not_applicable: 'bg-muted-foreground/40',
}

export type ReadinessBarProps = {
  readiness: Readiness
  /** What the score is about, in the reader's words — a unit name, a booking. */
  subjectLabel: string
  /** Collapsed by default on a list; open on a detail screen. */
  defaultOpen?: boolean
}

export function ReadinessBar({
  readiness,
  subjectLabel,
  defaultOpen = false,
}: ReadinessBarProps) {
  const { percent, met, applicable, requirements, risk } = readiness

  const counted = requirements.filter(
    (requirement) => requirement.status !== 'not_applicable',
  )
  const excluded = requirements.filter(
    (requirement) => requirement.status === 'not_applicable',
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm font-medium text-foreground">
          {subjectLabel}
        </span>
        <span className="text-sm text-muted-foreground">
          {percent === null ? (
            'אין דרישות שחלות כאן'
          ) : (
            <>
              <span className="font-semibold tabular-nums text-foreground">
                {percent}%
              </span>{' '}
              <span className="tabular-nums">
                ({met} מתוך {applicable})
              </span>{' '}
              · {RISK_LABEL[risk]}
            </>
          )}
        </span>
      </div>

      {percent !== null && (
        <div
          // The accessible value is the same fraction the label prints, so a
          // screen reader and a sighted reader hear the same claim.
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${met} מתוך ${applicable} דרישות`}
          aria-label={`מוכנות ${subjectLabel}`}
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn(
              'h-full rounded-full',
              risk === 'critical'
                ? 'bg-danger'
                : risk === 'at_risk'
                  ? 'bg-accent'
                  : 'bg-primary',
            )}
            style={{ inlineSize: `${percent}%` }}
          />
        </div>
      )}

      <details open={defaultOpen} className="group">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
          ממה מורכב המספר הזה
        </summary>

        <div className="mt-3 flex flex-col gap-4">
          <ul className="flex flex-col gap-3">
            {counted.map((requirement) => (
              <RequirementRow key={requirement.key} requirement={requirement} />
            ))}
          </ul>

          {excluded.length > 0 && (
            <div className="flex flex-col gap-2 border-t border-border pt-3">
              <p className="text-xs text-muted-foreground">
                לא נספרו במכנה, כי הן אינן חלות על העסק הזה:
              </p>
              <ul className="flex flex-col gap-1">
                {excluded.map((requirement) => (
                  <li
                    key={requirement.key}
                    className="text-xs text-muted-foreground"
                  >
                    {requirement.label}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </details>
    </div>
  )
}

function RequirementRow({
  requirement,
}: {
  requirement: ReadinessRequirement
}) {
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          aria-hidden="true"
          className={cn(
            'mt-1.5 size-1.5 shrink-0 rounded-full',
            STATUS_DOT[requirement.status],
          )}
        />
        <span className="text-sm text-foreground">{requirement.label}</span>
        <span className="text-xs text-muted-foreground">
          {STATUS_LABEL[requirement.status]}
        </span>
        {requirement.blocksArrival === true && (
          <span className="text-xs font-medium text-danger">חוסם הגעה</span>
        )}
      </div>

      {/* Evidence is present even when met — "המקדמה התקבלה ב־4 בספטמבר" is
          what makes a green line checkable rather than merely reassuring. */}
      <div className="ps-4">
        <EvidenceList items={requirement.evidence} />
      </div>
    </li>
  )
}
