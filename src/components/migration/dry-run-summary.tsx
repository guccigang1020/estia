/**
 * The headline of the dry run: what will happen, per entity, with nothing hidden.
 *
 * ── The order of the columns is an argument ───────────────────────────────
 *
 * Written, already here, not imported, waiting on you. The two on the right are
 * the reassuring ones and they come first because they are what the operator
 * looked for; the two on the left are the ones that need them. A table that
 * showed only "valid" would be a table that hides the forty rows that will not
 * come, and those forty are the entire reason to read this screen before
 * pressing the button rather than after.
 *
 * ── Every number here is the domain's ─────────────────────────────────────
 *
 * `entityRows` and `summariseDryRun` are `src/lib/migration/report.ts`. Nothing
 * in this file adds, filters or recomputes a tally — a screen that counted its
 * own "valid" would eventually disagree with the import, and the operator would
 * have no way to tell which of the two was lying.
 */

import { entityRows, summariseDryRun } from '@/lib/migration/report'
import type { DryRunReport } from '@/lib/migration/types'

export function DryRunSummary({ report }: { report: DryRunReport }) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-primary bg-surface-raised p-5 shadow-lift ring-1 ring-primary/25">
      <header className="flex flex-col gap-2">
        <h2 className="font-display text-lg font-bold text-foreground">
          מה יקרה כשתלחצו על ״ייבא״
        </h2>
        <p className="text-sm text-foreground">{summariseDryRun(report)}</p>
        <p className="text-xs text-muted-foreground">
          נכון ל-{report.computedOn}. עד הרגע הזה לא נכתב שום דבר, וזו לא הבטחה
          אלא תכונה של הקוד: הפונקציה שחישבה את המסך הזה אינה מקבלת שום דבר
          שאפשר לכתוב דרכו, ואינה יכולה להמתין לפעולה — כך שאין בה שום מסלול אל
          מסד הנתונים.
        </p>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full min-w-md text-sm">
          <caption className="sr-only">סיכום ההרצה היבשה לפי גוף</caption>
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
                אזהרות
              </th>
              <th scope="col" className="py-2 font-medium">
                כפילויות
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
                <td className="py-2">{row.warnings}</td>
                <td className="py-2">{row.duplicates}</td>
                <td className="py-2">{row.conflicts}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-border-strong font-semibold">
              <th scope="row" className="py-2 text-right">
                הכול
              </th>
              <td className="py-2">{report.totals.valid}</td>
              <td className="py-2">{report.totals.unchanged}</td>
              <td className="py-2">{report.totals.invalid}</td>
              <td className="py-2">{report.totals.warnings}</td>
              <td className="py-2">{report.totals.duplicates}</td>
              <td className="py-2">{report.totals.conflicts}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {report.historicBookings > 0 && (
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground">
          {report.historicBookings} מהשורות הן שהויות שכבר הסתיימו. הן ייכתבו
          כהיסטוריה: לא תיפתח משימת ניקיון, לא תחושב הכנה, ולא תישלח שום הודעה
          לאף אורח.
        </p>
      )}

      {report.unsupported.length > 0 && (
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          {report.unsupported.length} שורות נקראו ונבדקו ואינן נכתבות: לגוף שלהן
          עדיין אין פעולת יצירה במוצר. הקובץ שלכם תקין — אפשר יהיה להריץ אותו
          שוב כשהיא תתווסף, בלי ליצור כפילות.
        </p>
      )}
    </section>
  )
}
