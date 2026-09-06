/**
 * The rows behind a number.
 *
 * ── No count on these screens is allowed to stand alone ───────────────────
 *
 * "1,847 ייכתבו" is a claim. A person moving three years of their business
 * checks a claim against the spreadsheet open on their other monitor, and a
 * total whose members cannot be listed is a total they cannot check. So every
 * figure on the dry run and the completion report has one of these under it,
 * and the row number in the first column is the number their editor shows.
 *
 * ── It renders what the domain understood, not what the file said ─────────
 *
 * The telephone number here is the normalised one, the dates are the ISO ones,
 * the guest count is the parsed integer. That is the whole value of the
 * drill-down: seeing the file back would be pointless, and seeing what ESTIA
 * made of the file is what catches a day-first/month-first misread before it
 * becomes three years of stays on plausible wrong days.
 *
 * A `<details>` per row, so it works with no JavaScript and this file carries
 * no client boundary.
 */

import { type ImportRecord } from '@/lib/migration/types'

import { entityLabel, recordFacts, recordLabel } from './record-summary'

/** Rows shown before the tail is summarised. */
const VISIBLE = 50

export function RecordTable({
  records,
  caption,
  mixedEntities = false,
}: {
  records: readonly ImportRecord[]
  caption: string
  /** True when the list spans several entities, so the column earns its place. */
  mixedEntities?: boolean
}) {
  if (records.length === 0) {
    return <p className="text-sm text-muted-foreground">אין שורות להציג כאן.</p>
  }

  const shown = records.slice(0, VISIBLE)

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">{caption}</p>

      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
        {shown.map((record) => (
          <li key={`${record.entity}-${record.rowNumber}`}>
            <details className="px-4 py-3">
              <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                <span className="font-mono text-xs text-muted-foreground">
                  שורה {record.rowNumber}
                </span>
                <span className="font-medium text-foreground">
                  {recordLabel(record)}
                </span>
                {mixedEntities && (
                  <span className="text-xs text-muted-foreground">
                    {entityLabel(record)}
                  </span>
                )}
              </summary>

              <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {recordFacts(record.values).map((fact) => (
                  <div key={fact.label} className="flex justify-between gap-3">
                    <dt className="text-xs text-muted-foreground">
                      {fact.label}
                    </dt>
                    <dd className="text-xs font-medium text-foreground">
                      {fact.value}
                    </dd>
                  </div>
                ))}
                {record.sourceId !== null && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-xs text-muted-foreground">
                      מזהה במערכת המקור
                    </dt>
                    <dd dir="ltr" className="text-xs font-mono text-foreground">
                      {record.sourceId}
                    </dd>
                  </div>
                )}
              </dl>
            </details>
          </li>
        ))}
      </ul>

      {records.length > VISIBLE && (
        <p className="text-xs text-muted-foreground">
          מוצגות {VISIBLE} מתוך {records.length} שורות. השאר זהות במבנה — הרשימה
          קטועה כדי לא להאט את הדף, לא כדי להסתיר משהו.
        </p>
      )}
    </div>
  )
}
