/**
 * A spreadsheet, and an honest refusal when it is a binary one.
 *
 * ── What this file deliberately does not do ───────────────────────────────
 *
 * It does not read `.xlsx`. An `.xlsx` is a zip archive of XML parts, this
 * product carries no zip reader and adding one is a dependency decision that
 * belongs to whoever owns the lockfile, not to a parser. Writing three hundred
 * lines of inflate here to half-read a workbook would be worse than not
 * reading it at all: it would fail on the first file with a shared string
 * table, and it would fail as a parse error rather than as advice.
 *
 * So a binary workbook is *recognised* and refused with the one sentence that
 * actually unblocks the operator — save it as CSV, here is which menu item.
 * A refusal a person can act on in ten seconds is a better product than a
 * feature that works for half of them and produces mojibake for the rest.
 *
 * ── What it does do ───────────────────────────────────────────────────────
 *
 * Everything Excel produces that is *text*: `Save as → CSV UTF-8`, `Save as →
 * Text (tab delimited)`, and a range copied out of a sheet and pasted into the
 * box on the upload screen. Those three cover the real path, because the
 * operator being migrated has one spreadsheet and is standing at their own
 * computer with Excel open.
 */

import { parseDelimitedFile } from './csv'
import type { ImportEntity, ParsedFile } from '../types'

/** `PK\x03\x04` — every `.xlsx`, `.ods` and `.numbers` starts with it. */
const ZIP_MAGIC = 'PK'

/** The OLE2 compound-document header of a pre-2007 `.xls`. */
const OLE2_MAGIC = 'ÐÏà'

/**
 * Is this a binary workbook rather than text?
 *
 * Decided on the first bytes, never on the file name. An operator who renamed
 * `bookings.xlsx` to `bookings.csv` because a previous product told them to is
 * a real person, and reading their file as text would produce four hundred rows
 * of zip noise with row numbers attached — the least actionable error this
 * module could possibly produce.
 */
export function isBinaryWorkbook(text: string): boolean {
  const head = text.slice(0, 8)
  return head.startsWith(ZIP_MAGIC) || head.startsWith(OLE2_MAGIC)
}

/** The refusal, as a parsed file with no rows. Never an exception. */
export function refuseBinaryWorkbook(entity: ImportEntity): ParsedFile {
  return {
    format: 'excel_binary',
    columns: [],
    rows: [],
    issues: [
      {
        rowNumber: 0,
        entity,
        severity: 'error',
        code: 'binary_spreadsheet',
        field: null,
        column: null,
        value: null,
        message:
          'זהו קובץ אקסל בינארי, והמערכת קוראת קבצי טקסט. פתח אותו באקסל, ' +
          'בחר ״קובץ ← שמירה בשם״ ושמור כ־CSV UTF-8. אפשר גם לסמן את הטבלה, ' +
          'להעתיק, ולהדביק אותה כאן ישירות.',
      },
    ],
  }
}

/**
 * Parse a text export from a spreadsheet.
 *
 * Delegates to the delimited parser, which already handles the tab delimiter
 * Excel writes and the BOM it insists on. The separate entry point exists so
 * the detected format on the report says "גיליון שיוצא מאקסל" rather than
 * "CSV" — an operator who exported from Excel and is shown "CSV" reasonably
 * wonders whether the product read the right thing.
 */
export function parseSpreadsheet(
  text: string,
  options: { entity: ImportEntity },
): ParsedFile {
  if (isBinaryWorkbook(text)) return refuseBinaryWorkbook(options.entity)
  return parseDelimitedFile(text, { entity: options.entity, format: 'excel' })
}
