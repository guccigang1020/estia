'use client'

/**
 * Step two: what the file turned out to be.
 *
 * ── Why detection gets a screen of its own ────────────────────────────────
 *
 * Half of what an operator uploads is misnamed, and every one of the ways is
 * ordinary rather than careless: a previous product told them to rename an
 * `.xlsx` to `.csv`, an Airbnb calendar downloads as `listing.ics` on one
 * browser and `download` on another, a "CSV" out of a European system is
 * semicolon-delimited. `detectFormat` therefore reads the content and uses the
 * name only to break a tie — and this screen exists so that the answer is
 * shown to a person before they spend twenty minutes mapping a file that was
 * read as one column.
 *
 * `unknown` and `excel_binary` are real answers here, not errors. The second in
 * particular comes with the one sentence that unblocks somebody: save it as
 * CSV.
 */

import { StepHeader, StepBlocked } from '@/components/migration/step-header'
import { StepNav } from '@/components/migration/step-nav'
import { useMigration } from '@/components/migration/wizard-state'
import { blockedReason } from '@/app/(app)/migration/_lib/steps'
import { SOURCE_FORMAT_LABEL } from '@/lib/migration/types'

/** How many of the file's own rows to show as evidence. */
const PREVIEW_ROWS = 5

export function DetectStep() {
  const { parsed, fileName, progress } = useMigration()
  const blocked = blockedReason('detect', progress)

  if (blocked !== null || parsed === null) {
    return (
      <StepBlocked step="detect" reason={blocked ?? 'עדיין לא נבחר קובץ.'} />
    )
  }

  return (
    <section className="flex flex-col gap-5">
      <StepHeader step="detect" />

      <dl className="grid gap-4 rounded-xl border border-border bg-surface p-5 shadow-soft sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">הקובץ</dt>
          <dd className="mt-1 font-medium text-foreground">{fileName}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">זוהה כ</dt>
          <dd className="mt-1 font-medium text-foreground">
            {SOURCE_FORMAT_LABEL[parsed.format]}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">שורות</dt>
          <dd className="mt-1 font-medium text-foreground">
            {parsed.rows.length}
          </dd>
        </div>
      </dl>

      <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
        הזיהוי נעשה לפי תוכן הקובץ, לא לפי שמו. שם קובץ שגוי הוא הדבר הכי שכיח
        בייצוא ממערכת אחרת, וקובץ שנפתח בכל זאת עדיף על הודעה שהקובץ פגום.
      </p>

      {parsed.issues.length > 0 && (
        <ul className="flex flex-col gap-2">
          {parsed.issues.map((issue, index) => (
            <li
              key={`${issue.code}-${index}`}
              className="rounded-lg border border-warning bg-surface px-4 py-3 text-sm text-foreground"
            >
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
        <h3 className="font-display text-base font-bold text-foreground">
          העמודות שנמצאו ({parsed.columns.length})
        </h3>
        <p className="text-sm text-muted-foreground">
          בסדר שבו הופיעו בקובץ שלכם, בשמות שלכם. אף אחת מהן עוד לא הפכה לשום
          דבר.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full min-w-md text-sm">
            <caption className="sr-only">
              {PREVIEW_ROWS} השורות הראשונות בקובץ
            </caption>
            <thead>
              <tr className="text-right text-muted-foreground">
                <th scope="col" className="py-2 font-medium">
                  שורה
                </th>
                {parsed.columns.map((column) => (
                  <th key={column} scope="col" className="py-2 font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {parsed.rows.slice(0, PREVIEW_ROWS).map((row) => (
                <tr key={row.rowNumber} className="border-t border-border">
                  <th scope="row" className="py-2 text-right font-mono text-xs">
                    {row.rowNumber}
                  </th>
                  {parsed.columns.map((column) => (
                    <td
                      key={column}
                      className="max-w-40 truncate py-2 text-foreground"
                    >
                      {row.cells[column] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <StepNav
        back="upload"
        forward="map"
        forwardBlocked={blockedReason('map', progress)}
      />
    </section>
  )
}
