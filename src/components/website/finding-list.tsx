/**
 * The quality findings, as something a person reads and decides about.
 *
 * ── `not_assessed` is rendered, not hidden ───────────────────────────────
 *
 * The temptation is to drop the checks that could not be measured, because
 * they make the list longer without making it better. That would be exactly
 * the dishonesty the rule exists to prevent: a report showing only what it
 * could measure implies it measured everything. So they are shown, in their
 * own group, saying plainly what was not assessed and why.
 *
 * ── Only a blocker is coloured ───────────────────────────────────────────
 *
 * Three severities and one of them stops a publish. If warnings were red too,
 * nothing would read as urgent and the blockers would be lost among them.
 */

import { Badge } from '@/components/ui/badge'
import {
  FINDING_SEVERITY_LABEL,
  QUALITY_KIND_LABEL,
  type Finding,
} from '@/lib/website'

export function FindingList({ findings }: { findings: readonly Finding[] }) {
  const assessed = findings.filter(
    (finding) => finding.status !== 'not_assessed',
  )
  const notAssessed = findings.filter(
    (finding) => finding.status === 'not_assessed',
  )

  const order = { blocker: 0, warning: 1, advice: 2 } as const
  const sorted = assessed
    .slice()
    .sort((a, b) => order[a.severity] - order[b.severity])

  return (
    <div className="flex flex-col gap-6">
      {sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          לא נמצאו ממצאים. זה לא אומר שהאתר מושלם — זה אומר שכל מה שאפשר לבדוק
          מהנתונים שלכם עבר.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {sorted.map((finding) => (
            <li
              key={`${finding.checkCode}-${finding.pageSlug ?? ''}-${finding.sectionId ?? ''}`}
              className="flex flex-col gap-1.5 py-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p
                  className={
                    finding.severity === 'blocker'
                      ? 'text-sm font-medium text-destructive'
                      : 'text-sm font-medium text-foreground'
                  }
                >
                  {finding.title}
                </p>
                <div className="flex items-center gap-2">
                  <Badge
                    tone={finding.severity === 'blocker' ? 'accent' : 'neutral'}
                  >
                    {FINDING_SEVERITY_LABEL[finding.severity]}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {QUALITY_KIND_LABEL[finding.kind]}
                  </span>
                </div>
              </div>

              <p className="text-sm text-muted-foreground">{finding.detail}</p>

              {finding.pageSlug !== null ? (
                <p className="text-xs text-muted-foreground">
                  בעמוד /{finding.pageSlug}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {notAssessed.length > 0 ? (
        <section className="rounded-lg border border-dashed border-border p-4">
          <h3 className="text-sm font-medium text-foreground">
            מה לא נבדק, ולמה
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            הבדיקות האלה דורשות נתונים שאין במוצר. במקום לתת להן ציון מומצא, הן
            מדווחות שלא נבדקו.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {notAssessed.map((finding) => (
              <li key={finding.checkCode} className="text-sm">
                <span className="text-foreground">{finding.title}</span>
                <span className="text-muted-foreground">
                  {' '}
                  — {finding.detail}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

/** Counts, never a score. Shown in the studio header. */
export function FindingSummary({
  counts,
}: {
  counts: {
    blockers: number
    warnings: number
    advice: number
    notAssessed: number
  }
}) {
  const parts: string[] = []
  if (counts.blockers > 0) parts.push(`${counts.blockers} חוסמים פרסום`)
  if (counts.warnings > 0) parts.push(`${counts.warnings} שווה לתקן`)
  if (counts.advice > 0) parts.push(`${counts.advice} הצעות`)
  if (counts.notAssessed > 0) parts.push(`${counts.notAssessed} לא נבדקו`)

  return <>{parts.length > 0 ? parts.join(' · ') : 'אין ממצאים'}</>
}
