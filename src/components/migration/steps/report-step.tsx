'use client'

/**
 * Step eight: what actually happened, traceable back to the operator's own spreadsheet.
 *
 * ── The promise comes first, with its evidence under it ───────────────────
 *
 * The first thing on this screen is the sentence about the guests: how many
 * automatic processes the import produced and deliberately did not deliver, and
 * which. Somebody who has just moved three years of stays needs to know — here,
 * not in documentation — that nobody was messaged, no cleaning task was opened
 * for a stay in 2023 and no preparation was calculated for last March. A claim
 * with a list under it is the only kind they can check.
 *
 * ── Failures by cause, never by count ─────────────────────────────────────
 *
 * Forty failures with one cause is a two-minute fix. Forty with forty causes is
 * a bad file. Those are different afternoons, and "40 נכשלו" describes both.
 * `failureGroups` is the domain's grouping and this screen renders it.
 *
 * ── One row, six months later ─────────────────────────────────────────────
 *
 * "Which of my 1,847 rows became this booking" is the question asked when
 * something looks wrong long after the migration. `traceRow` answers it, and
 * the lookup at the bottom of this screen is the reason `RecordResult` carries
 * a row number on its successes as well as its failures.
 */

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { StepBlocked, StepHeader } from '@/components/migration/step-header'
import { OutcomeBadge } from '@/components/migration/outcome-badge'
import { OUTCOME_MEANING, OUTCOME_ORDER } from '@/components/migration/outcomes'
import { useMigration } from '@/components/migration/wizard-state'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { TextInput } from '@/components/ui/input'
import { STEP_PATH, blockedReason } from '@/app/(app)/migration/_lib/steps'
import {
  drillDown,
  failureGroups,
  summarise,
  suppressionSentence,
  traceRow,
} from '@/lib/migration/report'
import {
  IMPORT_ENTITY_LABEL,
  RECORD_OUTCOME_LABEL,
  type CompletionReport,
  type ImportEntity,
} from '@/lib/migration/types'

export function ReportStep() {
  const router = useRouter()
  const { completion, progress, startOver } = useMigration()
  const blocked = blockedReason('report', progress)

  if (blocked !== null || completion === null) {
    return (
      <StepBlocked step="report" reason={blocked ?? 'עדיין לא רץ ייבוא.'} />
    )
  }

  const groups = failureGroups(completion)
  const entities = [
    ...new Set(completion.results.map((result) => result.entity)),
  ]

  return (
    <section className="flex flex-col gap-5">
      <StepHeader step="report" />

      <section className="flex flex-col gap-3 rounded-xl border border-primary bg-surface-raised p-5 shadow-lift">
        <h2 className="font-display text-lg font-bold text-foreground">
          {completion.interrupted ? 'הייבוא נעצר באמצע' : 'הייבוא הסתיים'}
        </h2>
        <p className="text-sm text-foreground">{summarise(completion)}</p>
        {completion.interrupted && (
          <p className="text-sm text-foreground">
            אפשר להריץ את אותו קובץ שוב. מה שכבר נכתב יזוהה ולא ייכתב פעמיים.
          </p>
        )}
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground">
          {suppressionSentence(completion)}
        </p>
      </section>

      {completion.suppressedEvents.length > 0 && (
        <section className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-5">
          <h3 className="font-display text-base font-bold text-foreground">
            מה נחסם, בשמו ({completion.suppressedEvents.length})
          </h3>
          <p className="text-sm text-muted-foreground">
            הבטחה עם רשימה מתחתיה היא היחידה שאפשר לבדוק. כל שורה כאן היא אירוע
            שהייבוא הפיק ולא נשלח לאיש.
          </p>
          <ul className="flex flex-col gap-1 text-sm">
            {completion.suppressedEvents.map((event, index) => (
              <li
                key={`${event.name}-${event.rowNumber}-${index}`}
                className="flex flex-wrap gap-2 text-muted-foreground"
              >
                <span className="font-mono text-xs">
                  שורה {event.rowNumber}
                </span>
                <span className="font-medium text-foreground">
                  {event.name}
                </span>
                <span>{event.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {groups.length > 0 && (
        <section className="flex flex-col gap-3 rounded-xl border border-danger bg-surface p-5">
          <h3 className="font-display text-base font-bold text-foreground">
            מה נכשל, לפי סיבה
          </h3>
          <p className="text-sm text-muted-foreground">
            מקובצות לפי מה שהן אומרות, הגדולה קודם. סיבה אחת ארבעים פעם היא
            תיקון של שתי דקות; ארבעים סיבות שונות הן קובץ אחר.
          </p>
          <ul className="flex flex-col gap-2">
            {groups.map((group) => (
              <li
                key={group.message}
                className="rounded-lg border border-border bg-muted px-4 py-3 text-sm"
              >
                <p className="text-foreground">{group.message}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {group.rowNumbers.length} שורות: {group.rowNumbers.join(', ')}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5">
        <header>
          <h3 className="font-display text-base font-bold text-foreground">
            לפי גוף, ולפי תוצאה
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            כל מספר כאן נפתח למספרי השורות שמאחוריו — אלה שבגיליון שלכם, כולל
            שורת הכותרת, כך שאפשר לפתוח אותו ולמצוא כל אחת מהן.
          </p>
        </header>

        {entities.map((entity) => (
          <EntityDrillDown key={entity} entity={entity} report={completion} />
        ))}
      </section>

      <RowLookup report={completion} />

      <div className="border-t border-border pt-5">
        <Button
          variant="secondary"
          onClick={() => {
            startOver()
            router.push(STEP_PATH.upload)
          }}
        >
          ייבוא נוסף
        </Button>
      </div>
    </section>
  )
}

/**
 * One entity, every outcome it produced, and the rows behind each.
 *
 * Outcomes with no rows are omitted rather than shown as zero: a list of six
 * lines of which four say "0" is a list nobody reads to the bottom, and the
 * bottom is where the failures are.
 */
function EntityDrillDown({
  entity,
  report,
}: {
  entity: ImportEntity
  report: CompletionReport
}) {
  const rows = OUTCOME_ORDER.map((outcome) => ({
    outcome,
    drill: drillDown(report, outcome, entity),
  })).filter((row) => row.drill.rowNumbers.length > 0)

  if (rows.length === 0) return null

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border bg-muted p-4">
      <h4 className="font-display text-sm font-bold text-foreground">
        {IMPORT_ENTITY_LABEL[entity]}
      </h4>

      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.outcome}>
            <details className="rounded-md border border-border bg-surface px-3 py-2">
              <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                <OutcomeBadge outcome={row.outcome} />
                <span className="font-semibold text-foreground">
                  {row.drill.rowNumbers.length}
                </span>
                <span className="text-muted-foreground">
                  {RECORD_OUTCOME_LABEL[row.outcome]}
                </span>
              </summary>
              <p className="mt-2 text-xs text-muted-foreground">
                {OUTCOME_MEANING[row.outcome]}
              </p>
              <p className="mt-2 text-xs text-foreground">
                שורות: {row.drill.rowNumbers.join(', ')}
              </p>
            </details>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * "What happened to row 412."
 *
 * The whole story of one row: its outcome, the id it became, every issue that
 * named it and every conflict it was part of. `traceRow` is the domain's, and
 * this is a text box in front of it.
 */
function RowLookup({ report }: { report: CompletionReport }) {
  const [query, setQuery] = useState('')
  const rowNumber = Number.parseInt(query, 10)
  const trace = Number.isFinite(rowNumber) ? traceRow(report, rowNumber) : null

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
      <h3 className="font-display text-base font-bold text-foreground">
        מה קרה לשורה מסוימת
      </h3>
      <p className="text-sm text-muted-foreground">
        הקלידו מספר שורה מהגיליון שלכם. זו השאלה שנשאלת חצי שנה אחרי הייבוא,
        כשמשהו נראה מוזר, וייבוא שאינו יודע לענות עליה הוא ייבוא שאי אפשר לבקר.
      </p>

      <div className="sm:w-48">
        <Field label="מספר שורה">
          <TextInput
            inputMode="numeric"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="412"
          />
        </Field>
      </div>

      {trace !== null && (
        <div className="rounded-lg border border-border bg-muted px-4 py-3 text-sm">
          {trace.result === null ? (
            <p className="text-muted-foreground">
              השורה הזו לא הגיעה לייבוא. אם היא נדחתה בבדיקה, היא מופיעה ברשימת
              השורות שלא ייובאו בהרצה היבשה.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <OutcomeBadge outcome={trace.result.outcome} />
                <span className="text-foreground">
                  {IMPORT_ENTITY_LABEL[trace.result.entity]}
                </span>
                {trace.result.createdId !== null && (
                  <span
                    dir="ltr"
                    className="font-mono text-xs text-muted-foreground"
                  >
                    {trace.result.createdId}
                  </span>
                )}
              </div>
              {trace.result.message !== null && (
                <p className="text-foreground">{trace.result.message}</p>
              )}
            </div>
          )}

          {trace.issues.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
              {trace.issues.map((issue, index) => (
                <li key={`${issue.code}-${index}`}>{issue.message}</li>
              ))}
            </ul>
          )}

          {trace.conflicts.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
              {trace.conflicts.map((question, index) => (
                <li key={index}>{question}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
