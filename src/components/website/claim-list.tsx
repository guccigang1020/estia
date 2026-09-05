/**
 * WHERE EVERY SENTENCE CAME FROM, ON SCREEN.
 *
 * The module's rule is not only enforced — it is visible. Every claim is shown
 * with its source beside it, so somebody editing a page can see at a glance
 * that "עד 6 אורחים" came from the unit record and "אחוזה שקטה בגליל" was
 * written by a person.
 *
 * That visibility is the point. A system that silently guarantees provenance
 * is a system nobody trusts, because there is no way to check it. A system
 * that shows the source next to the sentence teaches the rule by using it, and
 * makes a wrong binding obvious rather than latent.
 *
 * ── Drift ────────────────────────────────────────────────────────────────
 *
 * A claim whose row has moved is marked, with what the row says now. Not an
 * error and not red: the published page is still honest about what it was
 * published from, and the fix is a republish rather than an emergency.
 */

import { Badge } from '@/components/ui/badge'
import {
  FACT_SOURCE_LABEL,
  type DriftedClaim,
  type SiteClaim,
} from '@/lib/website'

export function ClaimList({
  claims,
  drift = [],
}: {
  claims: readonly SiteClaim[]
  drift?: readonly DriftedClaim[]
}) {
  if (claims.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        אין כאן טקסט עדיין. מקטע שמשויך לנכס מתמלא מהנתונים שלכם; מקטע חופשי
        ממתין שתכתבו בו.
      </p>
    )
  }

  const drifted = new Map(
    drift.map((entry) => [entry.claim.key, entry.currentValue]),
  )

  return (
    <ul className="flex flex-col divide-y divide-border">
      {claims.map((claim) => {
        const current = drifted.get(claim.key)
        const hasDrifted = drifted.has(claim.key)

        return (
          <li key={claim.key} className="flex flex-col gap-1.5 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm text-foreground">{claim.text}</p>
              <Badge tone={claim.source === 'authored' ? 'neutral' : 'brand'}>
                {FACT_SOURCE_LABEL[claim.source]}
              </Badge>
            </div>

            <p className="text-xs text-muted-foreground">
              {claim.key}
              {claim.sourceField ? ` · ${claim.sourceField}` : null}
            </p>

            {hasDrifted ? (
              <p className="text-xs text-muted-foreground">
                {current === null
                  ? 'השדה במקור נמחק מאז שהטקסט נשמר. פרסום מחדש יסיר את המשפט.'
                  : `הנתון במערכת השתנה מאז ל־״${current}״. פרסום מחדש יעדכן את האתר.`}
              </p>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The one-line summary a list screen shows.
 *
 * Counts by source, because "8 facts from your data, 2 written by you" is the
 * sentence that tells somebody whether the page is grounded — which is a
 * different question from whether it is good.
 */
export function ClaimSummary({ claims }: { claims: readonly SiteClaim[] }) {
  const authored = claims.filter((claim) => claim.source === 'authored').length
  const canonical = claims.length - authored

  if (claims.length === 0) return <span>ללא תוכן</span>

  return (
    <span>
      {canonical > 0 ? `${canonical} מהנתונים` : null}
      {canonical > 0 && authored > 0 ? ' · ' : null}
      {authored > 0 ? `${authored} שנכתבו` : null}
    </span>
  )
}
