/**
 * What actually happened, traceable back to the operator's own spreadsheet.
 *
 * ── The promise, with its evidence under it ───────────────────────────────
 *
 * The first thing on this screen is the sentence about the guests: how many
 * automatic processes were blocked, and which. An operator who has just moved
 * three years of stays needs to know — on the same screen, not in
 * documentation — that nobody was messaged, no task was created for a stay in
 * 2023 and no preparation was calculated for last March. A claim with a list
 * under it is the only kind they can check.
 *
 * ── Failures by cause, never by count ─────────────────────────────────────
 *
 * Forty failures with one cause is a two-minute fix. Forty with forty causes
 * is a bad file. Those are different afternoons, and "40 נכשלו" describes both.
 */

import { Badge } from '@/components/ui/badge'
import {
  failureGroups,
  summarise,
  suppressionSentence,
} from '@/lib/migration/report'
import {
  IMPORT_ENTITY_LABEL,
  RECORD_OUTCOME_LABEL,
  type CompletionReport,
} from '@/lib/migration/types'

const VISIBLE_ROWS = 30

export function CompletionReportView({
  report,
}: {
  report: CompletionReport
}) {
  const groups = failureGroups(report)
  const manual = report.results.filter(
    (result) => result.outcome === 'needs_manual_update',
  )

  return (
    <div className="flex flex-col gap-6" dir="rtl">
      <section className="rounded-xl border border-border bg-surface p-5 shadow-soft">
        <h2 className="font-display text-lg font-bold text-foreground">
          הייבוא הסתיים
        </h2>
        <p className="mt-2 text-sm text-foreground">{summarise(report)}</p>
        <p className="mt-3 rounded-lg border border-accent bg-muted px-4 py-3 text-sm text-foreground">
          {suppressionSentence(report)}
        </p>
      </section>

      <section className="overflow-x-auto rounded-xl border border-border bg-surface p-5">
        <h3 className="font-display text-base font-bold text-foreground">
          לפי גוף
        </h3>
        <table className="mt-3 w-full min-w-md text-sm">
          <thead>
            <tr className="text-right text-muted-foreground">
              <th scope="col" className="py-2 font-medium">
                גוף
              </th>
              <th scope="col" className="py-2 font-medium">
                נכתב
              </th>
              <th scope="col" className="py-2 font-medium">
                כבר קיים
              </th>
              <th scope="col" className="py-2 font-medium">
                נכשל
              </th>
            </tr>
          </thead>
          <tbody>
            {report.byEntity.map((row) => (
              <tr key={row.entity} className="border-t border-border">
                <th scope="row" className="py-2 text-right font-medium">
                  {IMPORT_ENTITY_LABEL[row.entity]}
                </th>
                <td className="py-2">{row.valid}</td>
                <td className="py-2">{row.unchanged}</td>
                <td className="py-2">{row.invalid}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {groups.length > 0 && (
        <section className="flex flex-col gap-3 rounded-xl border border-danger bg-surface p-5">
          <h3 className="font-display text-base font-bold text-foreground">
            מה נכשל, לפי סיבה
          </h3>
          <ul className="flex flex-col gap-2">
            {groups.map((group) => (
              <li
                key={group.message}
                className="rounded-lg border border-border bg-muted px-4 py-3 text-sm"
              >
                <p className="text-foreground">{group.message}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  שורות: {group.rowNumbers.slice(0, 40).join(', ')}
                  {group.rowNumbers.length > 40
                    ? ` ועוד ${group.rowNumbers.length - 40}`
                    : ''}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {manual.length > 0 && (
        <section className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-5">
          <h3 className="font-display text-base font-bold text-foreground">
            רשומות שהשתנו במערכת המקור ({manual.length})
          </h3>
          <p className="text-sm text-muted-foreground">
            הן כבר יובאו בעבר והשתנו מאז. לא נוצרה כפילות, ועדכון אוטומטי עדיין
            אינו נתמך לגוף הזה — פתח את הרשומה הקיימת ועדכן אותה ידנית.
          </p>
          <p className="text-xs text-muted-foreground">
            שורות: {manual.map((result) => result.rowNumber).join(', ')}
          </p>
        </section>
      )}

      <section className="overflow-x-auto rounded-xl border border-border bg-surface p-5">
        <h3 className="font-display text-base font-bold text-foreground">
          שורה אחר שורה
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          מספרי השורות הם אלה שבקובץ שלך, כולל שורת הכותרת — כך שאפשר לפתוח את
          הגיליון ולמצוא כל אחת מהן.
        </p>
        <table className="mt-3 w-full min-w-md text-sm">
          <thead>
            <tr className="text-right text-muted-foreground">
              <th scope="col" className="py-2 font-medium">
                שורה
              </th>
              <th scope="col" className="py-2 font-medium">
                גוף
              </th>
              <th scope="col" className="py-2 font-medium">
                תוצאה
              </th>
              <th scope="col" className="py-2 font-medium">
                הערה
              </th>
            </tr>
          </thead>
          <tbody>
            {report.results.slice(0, VISIBLE_ROWS).map((result) => (
              <tr
                key={`${result.entity}-${result.rowNumber}`}
                className="border-t border-border align-top"
              >
                <th scope="row" className="py-2 text-right font-medium">
                  {result.rowNumber}
                </th>
                <td className="py-2">
                  {IMPORT_ENTITY_LABEL[result.entity]}
                </td>
                <td className="py-2">
                  <Badge
                    tone={result.outcome === 'failed' ? 'accent' : 'neutral'}
                  >
                    {RECORD_OUTCOME_LABEL[result.outcome]}
                  </Badge>
                </td>
                <td className="py-2 text-muted-foreground">
                  {result.message ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {report.results.length > VISIBLE_ROWS && (
          <p className="mt-3 text-sm text-muted-foreground">
            מוצגות {VISIBLE_ROWS} מתוך {report.results.length} שורות.
          </p>
        )}
      </section>
    </div>
  )
}
