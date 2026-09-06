/**
 * What is this file, actually?
 *
 * ── The extension is not evidence ─────────────────────────────────────────
 *
 * Half of what an operator uploads is misnamed, and every one of the ways is
 * ordinary rather than careless. A previous product told them to rename an
 * `.xlsx` to `.csv`. An Airbnb calendar downloads as `listing.ics` on one
 * browser and `download` with no extension on another. A "CSV" exported from a
 * European system is semicolon-delimited. Trusting the name means telling a
 * paying customer their file is corrupt when the product simply looked at the
 * wrong thing.
 *
 * So the format is decided by looking at the content, and the file name is used
 * for exactly one thing: breaking a tie the content leaves open. That ordering
 * — content first, name as a hint — is the whole design.
 *
 * ── Detection is allowed to answer "I do not know" ────────────────────────
 *
 * `unknown` is a real outcome and not a failure to try harder. A detector that
 * always produces an answer parses a PDF as a one-column CSV and reports four
 * hundred invalid rows, which is the least useful thing this module could do
 * with a person's afternoon.
 */

import { parseDelimitedFile } from './csv'
import {
  isBinaryWorkbook,
  parseSpreadsheet,
  refuseBinaryWorkbook,
} from './excel'
import { parseIcal } from './ical'
import type { ImportEntity, ParsedFile, SourceFormat } from '../types'

export { parseDelimitedFile } from './csv'
export {
  isBinaryWorkbook,
  parseSpreadsheet,
  refuseBinaryWorkbook,
} from './excel'
export {
  ICAL_COLUMNS,
  guestNameFrom,
  icalDate,
  marksUnavailable,
  parseIcal,
  unescapeText,
  unfold,
} from './ical'

/** How many lines to look at before deciding. Enough for any real header. */
const SAMPLE_LINES = 40

/**
 * Decide what the bytes are.
 *
 * `fileName` is a hint of last resort and never overrides the content: a file
 * that begins `BEGIN:VCALENDAR` is a calendar whatever it is called, and one
 * that begins `PK` is a zip whatever it is called.
 */
export function detectFormat(
  text: string,
  fileName?: string,
): SourceFormat {
  const head = text.replace(/^﻿/, '').trimStart()

  if (isBinaryWorkbook(head)) return 'excel_binary'
  if (/^BEGIN:VCALENDAR/i.test(head)) return 'ical'

  const lines = head
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim().length > 0)
    .slice(0, SAMPLE_LINES)

  if (lines.length === 0) return 'unknown'

  // Counted over several lines rather than the header alone. A header of one
  // word and a body of tab-separated cells is a real tab-separated file, and
  // looking only at line one would call it a single-column CSV.
  const tabs = lines.filter((line) => line.includes('\t')).length
  const commas = lines.filter((line) => line.includes(',')).length

  if (tabs > 0 && tabs >= commas) {
    return nameSuggestsExcel(fileName) ? 'excel' : 'tsv'
  }
  if (commas > 0) return 'csv'

  // A single column is a legitimate file — a list of telephone numbers, a list
  // of unit names — and it has no delimiter at all. Accepted as CSV only when
  // the name says the operator meant a table; otherwise the honest answer is
  // that this could be anything.
  return nameSuggestsDelimited(fileName) ? 'csv' : 'unknown'
}

function extensionOf(fileName?: string): string {
  if (fileName === undefined) return ''
  const dot = fileName.lastIndexOf('.')
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase()
}

function nameSuggestsExcel(fileName?: string): boolean {
  const extension = extensionOf(fileName)
  return extension === 'xls' || extension === 'xlsx' || extension === 'txt'
}

function nameSuggestsDelimited(fileName?: string): boolean {
  const extension = extensionOf(fileName)
  return extension === 'csv' || extension === 'tsv' || extension === 'txt'
}

/**
 * Detect, then parse.
 *
 * The single entry point every screen uses, so no caller has to remember the
 * pairing between a format and the function that reads it. Never throws: an
 * unreadable file comes back as a `ParsedFile` with no rows and a Hebrew issue,
 * which a screen can render and a person can act on.
 */
export function parseSource(
  text: string,
  options: {
    entity: ImportEntity
    fileName?: string
    /** For a calendar, which unit it is the calendar *of*. */
    unitName?: string
  },
): ParsedFile {
  const format = detectFormat(text, options.fileName)

  switch (format) {
    case 'ical':
      return parseIcal(text, {
        entity: options.entity,
        unitName: options.unitName,
      })
    case 'excel_binary':
      return refuseBinaryWorkbook(options.entity)
    case 'excel':
      return parseSpreadsheet(text, { entity: options.entity })
    case 'csv':
    case 'tsv':
      return parseDelimitedFile(text, {
        entity: options.entity,
        format,
      })
    case 'unknown':
      return {
        format: 'unknown',
        columns: [],
        rows: [],
        issues: [
          {
            rowNumber: 0,
            entity: options.entity,
            severity: 'error',
            code: 'unknown_format',
            field: null,
            column: null,
            value: null,
            message:
              'לא זוהה מבנה מוכר בקובץ. המערכת קוראת CSV, טבלה מופרדת ' +
              'בטאבים ויומן iCal. אם זה גיליון — שמור אותו כ־CSV UTF-8 ' +
              'ונסה שוב.',
          },
        ],
      }
  }
}
