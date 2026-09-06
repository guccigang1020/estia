/**
 * A list of findings, each one naming the row, the column and the value as typed.
 *
 * ── The three together are the whole point ────────────────────────────────
 *
 * "שורה 412 אינה תקינה" is the sentence that ends migrations: the operator
 * opens their spreadsheet, looks at row 412, sees nothing obviously wrong, and
 * stops. `ValidationIssue` was designed to make that impossible — it carries
 * the row number counted the way their editor counts it, the source column
 * under its own name, and the offending text unnormalised so they recognise it
 * — and this component's only job is to not throw any of that away.
 *
 * ── Long lists collapse rather than truncate ──────────────────────────────
 *
 * A file with four hundred bad telephone numbers must not render four hundred
 * paragraphs, and must not silently show twelve either. It groups by code, says
 * how many are in each group, and opens on demand — a `<details>`, so it works
 * with no JavaScript and this file needs no client boundary.
 */

import {
  ISSUE_SEVERITY_LABEL,
  IMPORT_ENTITY_LABEL,
  type IssueCode,
  type IssueSeverity,
  type ValidationIssue,
} from '@/lib/migration/types'

/** How many rows of one group to show before the tail is summarised. */
const VISIBLE = 25

const SEVERITY_STYLE: Readonly<Record<IssueSeverity, string>> = {
  error: 'border-danger',
  warning: 'border-warning',
  info: 'border-border',
}

export function IssueList({
  title,
  description,
  issues,
  emptyNote,
}: {
  title: string
  description: string
  issues: readonly ValidationIssue[]
  /** Shown when there are none. Silence would read as "not checked". */
  emptyNote?: string
}) {
  if (issues.length === 0) {
    if (emptyNote === undefined) return null
    return (
      <section className="rounded-xl border border-border bg-surface p-5">
        <h3 className="font-display text-base font-bold text-foreground">
          {title}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{emptyNote}</p>
      </section>
    )
  }

  const groups = groupByCode(issues)

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
      <header>
        <h3 className="font-display text-base font-bold text-foreground">
          {title} ({issues.length})
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </header>

      <ul className="flex flex-col gap-3">
        {groups.map((group) => (
          <li key={group.code}>
            <details
              className={`rounded-lg border bg-muted px-4 py-3 ${
                SEVERITY_STYLE[group.severity]
              }`}
            >
              <summary className="cursor-pointer text-sm font-medium text-foreground">
                {group.headline}
                <span className="text-muted-foreground">
                  {' '}
                  — {group.issues.length} שורות
                </span>
              </summary>

              <ul className="mt-3 flex flex-col gap-2">
                {group.issues.slice(0, VISIBLE).map((issue, index) => (
                  <li
                    key={`${issue.rowNumber}-${index}`}
                    className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {issue.rowNumber > 0 && (
                        <span className="font-semibold text-foreground">
                          שורה {issue.rowNumber}
                        </span>
                      )}
                      {issue.column !== null && (
                        <span>עמודה ״{issue.column}״</span>
                      )}
                      <span>{ISSUE_SEVERITY_LABEL[issue.severity]}</span>
                      <span>{IMPORT_ENTITY_LABEL[issue.entity]}</span>
                    </div>
                    <p className="mt-1 text-foreground">{issue.message}</p>
                    {issue.value !== null && issue.value.length > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        הערך בקובץ:{' '}
                        <span className="font-mono text-foreground">
                          {issue.value}
                        </span>
                      </p>
                    )}
                  </li>
                ))}
              </ul>

              {group.issues.length > VISIBLE && (
                <p className="mt-2 text-xs text-muted-foreground">
                  מוצגות {VISIBLE} מתוך {group.issues.length}. שאר השורות:{' '}
                  {group.issues
                    .slice(VISIBLE)
                    .map((issue) => issue.rowNumber)
                    .join(', ')}
                </p>
              )}
            </details>
          </li>
        ))}
      </ul>
    </section>
  )
}

type IssueGroup = {
  code: IssueCode
  severity: IssueSeverity
  headline: string
  issues: readonly ValidationIssue[]
}

/**
 * Findings of the same kind, together, largest group first.
 *
 * One cause four hundred times is a find-and-replace in their spreadsheet.
 * Four hundred causes once each is a bad export. A flat list of four hundred
 * paragraphs describes both and helps with neither.
 *
 * The headline is the first message in the group verbatim rather than a
 * summary written here — the domain already phrased it, and rephrasing it in a
 * component is how two different sentences end up describing one rule.
 */
function groupByCode(
  issues: readonly ValidationIssue[],
): readonly IssueGroup[] {
  const groups = new Map<IssueCode, ValidationIssue[]>()

  for (const issue of issues) {
    const bucket = groups.get(issue.code)
    if (bucket) bucket.push(issue)
    else groups.set(issue.code, [issue])
  }

  return [...groups.entries()]
    .map(([code, members]) => ({
      code,
      severity: members[0]?.severity ?? 'info',
      headline: members[0]?.message ?? '',
      issues: members,
    }))
    .sort((a, b) => b.issues.length - a.issues.length)
}
