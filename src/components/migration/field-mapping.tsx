/**
 * Which column is which.
 *
 * ── The step where a migration is won or silently ruined ──────────────────
 *
 * Everything else in this wizard is arithmetic. Here a person looks at
 * twenty-four columns out of a product they are leaving and says what each one
 * means. Put the departure date in the arrival column and three years of stays
 * land on plausible wrong days — a mistake nobody notices until a guest turns
 * up.
 *
 * So the screen is built around two refusals:
 *
 *   · **An unrecognised column shows an empty select, never a guess.** A
 *     plausible wrong answer is confirmed without being re-read; an empty one
 *     is not.
 *   · **A field already taken by an earlier column is not offered again.** Two
 *     columns feeding one field is a coin toss.
 *
 * The first three rows of the file are shown beside each select, because "is
 * this the arrival or the booking date" is a question the *data* answers and
 * the header often does not.
 */

'use client'

import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/input'
import { IMPORT_FIELD_LABEL } from '@/lib/migration/mapping'
import type {
  FieldMapping,
  ImportField,
  SourceRow,
} from '@/lib/migration/types'

export function FieldMappingTable({
  columns,
  mappings,
  available,
  rows,
  onChange,
}: {
  columns: readonly string[]
  mappings: readonly FieldMapping[]
  /** The fields this entity may be mapped to. */
  available: readonly ImportField[]
  rows: readonly SourceRow[]
  onChange: (column: string, field: ImportField | null) => void
}) {
  const taken = new Map<ImportField, string>()
  for (const mapping of mappings) {
    if (mapping.field !== null) taken.set(mapping.field, mapping.column)
  }

  return (
    <div className="flex flex-col gap-4" dir="rtl">
      <p className="text-sm text-muted-foreground">
        עמודה שלא זוהתה נשארת ריקה במכוון — ניחוש סביר הוא הדבר שאף אחד לא קורא
        שוב. שדה שכבר נתפס על ידי עמודה קודמת אינו מוצע שנית.
      </p>

      <ul className="flex flex-col gap-3">
        {columns.map((column) => {
          const current =
            mappings.find((mapping) => mapping.column === column)?.field ?? null

          return (
            <li
              key={column}
              className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium text-foreground">{column}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {sample(rows, column)}
                </p>
              </div>

              <div className="sm:w-64">
                <Field label="שדה ב-ESTIA">
                  <Select
                    value={current ?? ''}
                    onChange={(event) =>
                      onChange(
                        column,
                        event.target.value === ''
                          ? null
                          : (event.target.value as ImportField),
                      )
                    }
                  >
                    <option value="">— התעלם מהעמודה —</option>
                    {available.map((field) => {
                      const owner = taken.get(field)
                      const claimedElsewhere =
                        owner !== undefined && owner !== column
                      return (
                        <option
                          key={field}
                          value={field}
                          disabled={claimedElsewhere}
                        >
                          {IMPORT_FIELD_LABEL[field]}
                          {claimedElsewhere ? ` (כבר ממופה מ״${owner}״)` : ''}
                        </option>
                      )
                    })}
                  </Select>
                </Field>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * The first few values in this column.
 *
 * Three, because one is not enough to tell a date from a date and four does not
 * fit beside a select on a telephone.
 */
function sample(rows: readonly SourceRow[], column: string): string {
  const values = rows
    .slice(0, 3)
    .map((row) => row.cells[column] ?? '')
    .filter((value) => value.length > 0)

  return values.length === 0
    ? 'אין ערכים בשלוש השורות הראשונות'
    : values.join(' · ')
}
