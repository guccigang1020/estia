/**
 * A delimited file, turned into rows keyed by the source's own headers.
 *
 * ── The splitting is not written twice ────────────────────────────────────
 *
 * `parseDelimited` in `src/lib/inventory/import.ts` already solves the hard
 * half — quoted commas, quoted newlines, doubled quotes, a UTF-8 BOM, and tabs
 * as well as commas so that a grid pasted out of Excel behaves like a file. It
 * is imported rather than reimplemented. A second CSV splitter in the same
 * codebase is two definitions of what a quote means, and the day they disagree
 * one screen accepts a file the other refuses.
 *
 * One caveat it is worth being explicit about, because it is inherited rather
 * than chosen: that splitter treats comma *and* tab as delimiters in the same
 * pass. A tab-separated file with an unquoted comma inside a cell therefore
 * splits at the comma too. In practice that shows up as a row with more cells
 * than the header, which is exactly what `too_many_columns` reports below with
 * the row number attached — so the failure is visible and locatable rather
 * than silent. Fixing it properly means a delimiter-aware splitter in
 * `inventory/import.ts`, which is another worker's file.
 *
 * ── Headers are kept as the source wrote them ─────────────────────────────
 *
 * Not normalised, not translated, not mapped. `mapping.ts` does that, later and
 * reversibly. A parser that mapped as it read would make a saved mapping
 * impossible to apply to a second file, because the columns it was saved
 * against would no longer exist by the time anybody looked.
 */

import { parseDelimited } from '../../inventory/import'
import type {
  ImportEntity,
  ParsedFile,
  SourceRow,
  ValidationIssue,
} from '../types'

/**
 * A header cell that is blank, or that repeats one already seen.
 *
 * Both happen in real exports — a trailing delimiter produces the first, and a
 * sheet with two columns called "Notes" produces the second. Neither is worth
 * refusing a file over, so each gets a generated, stable name and the operator
 * sees it in the mapping step under the name the product invented.
 */
function uniqueColumns(header: readonly string[]): readonly string[] {
  const seen = new Map<string, number>()
  const columns: string[] = []

  for (let index = 0; index < header.length; index += 1) {
    const raw = (header[index] ?? '').trim()
    const base = raw.length > 0 ? raw : `עמודה ${index + 1}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    columns.push(count === 0 ? base : `${base} (${count + 1})`)
  }

  return columns
}

/**
 * Parse delimited text.
 *
 * Never throws. A file that is not delimited text at all comes back as a
 * `ParsedFile` with issues and no rows, which is something a screen can render;
 * an exception is something an operator emails support about.
 */
export function parseDelimitedFile(
  text: string,
  options: { entity: ImportEntity; format?: 'csv' | 'tsv' | 'excel' },
): ParsedFile {
  const table = parseDelimited(text).filter((row) =>
    row.some((cell) => cell.trim().length > 0),
  )

  const issues: ValidationIssue[] = []
  const entity = options.entity
  const format = options.format ?? 'csv'

  if (table.length === 0) {
    return {
      format,
      columns: [],
      rows: [],
      issues: [
        {
          rowNumber: 0,
          entity,
          severity: 'error',
          code: 'empty_file',
          field: null,
          column: null,
          value: null,
          message: 'הקובץ ריק. לא נמצאה בו אף שורה עם תוכן.',
        },
      ],
    }
  }

  const columns = uniqueColumns(table[0] ?? [])
  const rows: SourceRow[] = []

  for (let index = 1; index < table.length; index += 1) {
    const cells = table[index] ?? []
    // 1-based and counting the header, so the number matches the left margin
    // of the operator's own spreadsheet rather than an internal offset.
    const rowNumber = index + 1

    if (cells.length > columns.length) {
      issues.push({
        rowNumber,
        entity,
        severity: 'warning',
        code: 'unknown_column',
        field: null,
        column: null,
        value: cells.slice(columns.length).join(' | '),
        message:
          `בשורה ${rowNumber} יש ${cells.length} תאים ובכותרת ` +
          `${columns.length}. התאים העודפים נשמטו והשאר נקרא.`,
      })
    }

    const record: Record<string, string> = {}
    for (let column = 0; column < columns.length; column += 1) {
      const name = columns[column]
      if (name === undefined) continue
      record[name] = (cells[column] ?? '').trim()
    }

    rows.push({ rowNumber, cells: record })
  }

  return { format, columns, rows, issues }
}
