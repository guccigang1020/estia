/**
 * The screen that earns the migration.
 *
 * ── Why this is the most prominent state of the wizard ────────────────────
 *
 * A person is about to move three years of their business into a product they
 * have used for twenty minutes. Nothing on the upload step or the mapping step
 * makes that reasonable; this does. It says, in their own numbers and before
 * anything is written, exactly what will happen — and it leads with what will
 * *not*, because the refusals and the decisions are the only parts they can
 * still act on.
 *
 * ── The order of the sections is the argument ─────────────────────────────
 *
 *   1. What will not be imported, and why — the part they can fix.
 *   2. The decisions they owe — the part only they can settle.
 *   3. The guests who may already be here — offered, never merged.
 *   4. What will be written — the reassuring part, and last on purpose.
 *
 * A report that opened with "1,847 ✓" would be read as a success message and
 * the forty problems under it would not be read at all.
 *
 * ── Every number has its rows under it ────────────────────────────────────
 *
 * No figure on this screen is a bare count. A total whose members cannot be
 * listed is a total nobody can check against their own spreadsheet, and an
 * operator who cannot check it will not press the button.
 */

import { Badge } from '@/components/ui/badge'
// Leaf modules, never `@/lib/migration`. The barrel reaches `repository.ts` and
// through it the `postgres` driver, and a Client Component that touches it
// takes the whole application down with `Can't resolve 'fs'` — the failure
// `scripts/client-bundle.mjs` exists to catch.
import { entityRows, summariseDryRun } from '@/lib/migration/report'
import {
  CONFLICT_KIND_LABEL,
  IMPORT_ENTITY_LABEL,
  ISSUE_SEVERITY_LABEL,
  type Conflict,
  type DryRunReport,
  type ValidationIssue,
} from '@/lib/migration/types'

/** How many rows of a long list to show before saying how many are left. */
const VISIBLE = 12

export function DryRunReportView({
  report,
  onDecide,
}: {
  report: DryRunReport
  onDecide?: (conflictId: string, decision: Conflict['decision']) => void
}) {
  const errors = report.issues.filter((issue) => issue.severity === 'error')
  const warnings = report.issues.filter((issue) => issue.severity === 'warning')
  const notices = report.issues.filter((issue) => issue.severity === 'info')
  const undecided = report.conflicts.filter(
    (conflict) => conflict.decision === 'undecided',
  )

  return (
    <div className="flex flex-col gap-6" dir="rtl">
      <section className="rounded-xl border border-border bg-surface p-5 shadow-soft">
        <h2 className="font-display text-lg font-bold text-foreground">
          מה יקרה כשתלחץ על ״ייבוא״
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {summariseDryRun(report)}
        </p>
        <p className="mt-3 text-sm text-foreground">
          עד הרגע הזה לא נכתב שום דבר. ההרצה היבשה קוראת בלבד.
        </p>
      </section>

      {notices.length > 0 && (
        <ul className="flex flex-col gap-2">
          {notices.map((notice, index) => (
            <li
              key={`${notice.code}-${index}`}
              className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
            >
              {notice.message}
            </li>
          ))}
        </ul>
      )}

      <IssueList
        title="שורות שלא ייובאו"
        description="כל שורה כאן נדחתה לבדה. השאר ייובא."
        issues={errors}
      />

      {undecided.length > 0 && (
        <section className="flex flex-col gap-3 rounded-xl border border-danger bg-surface p-5">
          <header>
            <h3 className="font-display text-base font-bold text-foreground">
              החלטות שממתינות לך ({undecided.length})
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              המערכת לא מוחקת שורה בגלל התנגשות. כל אחת מהן היא עובדה על העסק
              שלך, ורק אתה יודע איזו קריאה נכונה. שורה שלא הוכרעה לא תיובא.
            </p>
          </header>

          <ul className="flex flex-col gap-3">
            {undecided.slice(0, VISIBLE).map((conflict) => (
              <li
                key={conflict.id}
                className="rounded-lg border border-border bg-muted p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="accent">
                    {CONFLICT_KIND_LABEL[conflict.kind]}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    שורה {conflict.rowNumber}
                  </span>
                </div>

                <p className="mt-2 text-sm text-foreground">
                  {conflict.question}
                </p>

                <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Side heading="מהקובץ" side={conflict.left} />
                  <Side heading="ב-ESTIA" side={conflict.right} />
                </dl>

                {onDecide && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <DecisionButton
                      label="ייבא בכל זאת"
                      onClick={() => onDecide(conflict.id, 'import_anyway')}
                    />
                    <DecisionButton
                      label="השאר את הקיים"
                      onClick={() => onDecide(conflict.id, 'keep_existing')}
                    />
                    <DecisionButton
                      label="דלג על השורה"
                      onClick={() => onDecide(conflict.id, 'skip_record')}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>

          {undecided.length > VISIBLE && (
            <p className="text-sm text-muted-foreground">
              ועוד {undecided.length - VISIBLE} התנגשויות.
            </p>
          )}
        </section>
      )}

      {report.duplicates.length > 0 && (
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
          <header>
            <h3 className="font-display text-base font-bold text-foreground">
              אורחים שייתכן שכבר קיימים ({report.duplicates.length})
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              ההתאמה נעשתה לפי מספר טלפון מנורמל או אימייל מאומת בלבד — לעולם
              לא לפי שם. איחוד שגוי מדביק שתי היסטוריות של שתי משפחות זו לזו,
              וכמעט בלתי אפשרי לפרק אותו אחר כך. לכן שום דבר כאן לא אוחד.
            </p>
          </header>

          <ul className="flex flex-col gap-2">
            {report.duplicates.slice(0, VISIBLE).map((duplicate) => (
              <li
                key={`${duplicate.rowNumber}-${duplicate.existingId}`}
                className="rounded-lg border border-border bg-muted px-4 py-3 text-sm"
              >
                <span className="text-muted-foreground">
                  שורה {duplicate.rowNumber}:
                </span>{' '}
                <span className="font-medium text-foreground">
                  {duplicate.incomingLabel}
                </span>{' '}
                <span className="text-muted-foreground">
                  נראה כמו {duplicate.existingLabel}, לפי{' '}
                  {duplicate.matchedOn === 'phone' ? 'טלפון' : 'אימייל'}{' '}
                </span>
                <span dir="ltr" className="text-muted-foreground">
                  {duplicate.matchedValue}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <IssueList
        title="אזהרות"
        description="השורות האלה ייובאו. שדה אחד בכל אחת מהן לא נקרא."
        issues={warnings}
      />

      <section className="overflow-x-auto rounded-xl border border-border bg-surface p-5">
        <h3 className="font-display text-base font-bold text-foreground">
          מה ייכתב
        </h3>
        <table className="mt-3 w-full min-w-md text-sm">
          <thead>
            <tr className="text-right text-muted-foreground">
              <th scope="col" className="py-2 font-medium">
                גוף
              </th>
              <th scope="col" className="py-2 font-medium">
                ייכתב
              </th>
              <th scope="col" className="py-2 font-medium">
                כבר קיים
              </th>
              <th scope="col" className="py-2 font-medium">
                לא ייובא
              </th>
              <th scope="col" className="py-2 font-medium">
                דורש החלטה
              </th>
            </tr>
          </thead>
          <tbody>
            {entityRows(report).map((row) => (
              <tr key={row.entity} className="border-t border-border">
                <th scope="row" className="py-2 text-right font-medium">
                  {row.label}
                </th>
                <td className="py-2">{row.valid}</td>
                <td className="py-2">{row.unchanged}</td>
                <td className="py-2">{row.invalid}</td>
                <td className="py-2">{row.conflicts}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {report.unsupported.length > 0 && (
          <p className="mt-3 text-sm text-muted-foreground">
            {report.unsupported.length} שורות נקראו ונבדקו, ואינן נכתבות: לגוף
            שלהן עדיין אין פעולת יצירה במוצר. הקובץ תקין — אפשר יהיה להריץ אותו
            שוב כשהיא תתווסף, בלי ליצור כפילות.
          </p>
        )}
      </section>
    </div>
  )
}

function Side({
  heading,
  side,
}: {
  heading: string
  side: Conflict['left']
}) {
  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <dt className="text-xs font-semibold text-muted-foreground">{heading}</dt>
      <dd className="mt-1 text-sm font-medium text-foreground">{side.label}</dd>
      <dd className="text-xs text-muted-foreground">{side.detail}</dd>
    </div>
  )
}

function DecisionButton({
  label,
  onClick,
}: {
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
    >
      {label}
    </button>
  )
}

/**
 * A list of findings, each naming its row, its column and the value as typed.
 *
 * The three together are what make an issue actionable. "שורה 412 אינה תקינה"
 * is the sentence that ends migrations: the operator opens their spreadsheet,
 * looks at 412, sees nothing wrong, and stops.
 */
function IssueList({
  title,
  description,
  issues,
}: {
  title: string
  description: string
  issues: readonly ValidationIssue[]
}) {
  if (issues.length === 0) return null

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
      <header>
        <h3 className="font-display text-base font-bold text-foreground">
          {title} ({issues.length})
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </header>

      <ul className="flex flex-col gap-2">
        {issues.slice(0, VISIBLE).map((issue, index) => (
          <li
            key={`${issue.rowNumber}-${issue.code}-${index}`}
            className="rounded-lg border border-border bg-muted px-4 py-3 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {issue.rowNumber > 0 && <span>שורה {issue.rowNumber}</span>}
              {issue.column !== null && <span>עמודה ״{issue.column}״</span>}
              <span>{ISSUE_SEVERITY_LABEL[issue.severity]}</span>
              <span>{IMPORT_ENTITY_LABEL[issue.entity]}</span>
            </div>
            <p className="mt-1 text-foreground">{issue.message}</p>
          </li>
        ))}
      </ul>

      {issues.length > VISIBLE && (
        <p className="text-sm text-muted-foreground">
          ועוד {issues.length - VISIBLE} שורות מאותו סוג.
        </p>
      )}
    </section>
  )
}
