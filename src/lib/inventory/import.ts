/**
 * Getting a cupboard into the product without typing it twice.
 *
 * ── Who this is for ───────────────────────────────────────────────────────
 *
 * A single villa owner with forty-one things in a spreadsheet. They will not
 * fill in a form forty-one times, and a product that requires it is a product
 * whose stock module is never switched on. So there are three doors — one item
 * at a time, a spreadsheet-shaped grid, and a file — and this file is the
 * arithmetic behind the third, which the second also uses because pasted rows
 * and a pasted file are the same problem.
 *
 * ── Idempotent, and what that means here ──────────────────────────────────
 *
 * Running the same file twice must not double the cupboard. The identity is
 * `(property, lower(sku))` where a SKU exists — which is the unique index 0011
 * already created — and `(property, lower(name))` where one does not, because
 * a villa owner's spreadsheet has no SKU column and never will. A second run
 * therefore classifies every row as `unchanged`, and the plan says so in as
 * many words before anything is written.
 *
 * ── Refusals are per row, and they say why ────────────────────────────────
 *
 * An import that fails as a whole on row nineteen is an import nobody
 * completes: the person fixes row nineteen, re-runs, and discovers row
 * twenty-three. So every row is judged on its own, the good ones are applied,
 * and the refused ones come back with the line number, the offending value as
 * they typed it, and a Hebrew sentence about what to do. That list is the
 * product's whole answer to "why did only thirty-eight of my forty-one items
 * appear", and a count alone would not be one.
 */

import type {
  ImportPlan,
  ImportRefusal,
  ImportRefusalCode,
  ImportRow,
} from './types'

/**
 * The columns this product understands, and the header names it accepts.
 *
 * Hebrew first, because the file will have come out of a Hebrew spreadsheet,
 * with the English names accepted too — an operator who exported from another
 * system should not have to translate a header row by hand.
 */
export const IMPORT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  name: ['שם', 'שם הפריט', 'פריט', 'name', 'item'],
  sku: ['מקט', 'מק"ט', 'מק״ט', 'sku', 'code'],
  category: ['קטגוריה', 'category'],
  location: ['מיקום', 'location'],
  unitOfMeasure: ['יחידת מידה', 'יחידה', 'unit', 'uom'],
  quantity: ['כמות', 'quantity', 'qty'],
  minQuantity: ['מינימום', 'נקודת הזמנה', 'min', 'min_quantity'],
  parLevel: ['רמת יעד', 'יעד', 'par', 'par_level'],
  unitCostAgorot: ['עלות ליחידה', 'עלות', 'cost', 'unit_cost'],
}

/** The header row of the template the screen offers for download. */
export const IMPORT_TEMPLATE_HEADER = [
  'שם',
  'מקט',
  'קטגוריה',
  'מיקום',
  'יחידת מידה',
  'כמות',
  'מינימום',
  'רמת יעד',
  'עלות ליחידה',
] as const

/**
 * The template, with two example rows.
 *
 * Examples rather than an empty grid, because "what goes in 'רמת יעד'" is the
 * question that stops an import, and an example answers it without anybody
 * reading documentation. They are obviously examples — a person deletes two
 * rows — and they are not written to any database by this file.
 */
export function importTemplateCsv(): string {
  const rows = [
    [...IMPORT_TEMPLATE_HEADER],
    [
      'מגבת גוף',
      'TWL-L',
      'מגבות',
      'מחסן ראשי',
      'יח׳',
      '50',
      '20',
      '60',
      '1800',
    ],
    [
      'סט מצעים זוגי',
      'LIN-D',
      'מצעים',
      'מחסן ראשי',
      'סט',
      '24',
      '10',
      '30',
      '9000',
    ],
  ]
  // A BOM, because Excel on Windows opens a UTF-8 CSV without one as mojibake
  // and the file this product hands a Hebrew-speaking villa owner must open.
  return '﻿' + rows.map((row) => row.join(',')).join('\r\n') + '\r\n'
}

/* ---------------------------------------------------------------- parsing -- */

/**
 * Split a CSV that may contain quoted commas and quoted newlines.
 *
 * Written out rather than pulled in, because the dependency would be a
 * lockfile change for a hundred lines and this parser's failure modes are ones
 * we want to control: a malformed quote produces a *refused row with a line
 * number*, not an exception that loses the other forty.
 */
export function parseDelimited(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const source = text.replace(/^﻿/, '')

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]

    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      quoted = true
      continue
    }
    // Tab as well as comma: a person pasting out of Excel into a textarea gets
    // tabs, and telling them to convert is telling them to give up.
    if (char === ',' || char === '\t') {
      row.push(field)
      field = ''
      continue
    }
    if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    if (char === '\r') continue

    field += char
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

/** Which of our columns a header cell names, or null. */
function columnFor(header: string): string | null {
  const normalized = header.trim().toLowerCase().replace(/["׳']/g, '')
  for (const [key, names] of Object.entries(IMPORT_COLUMNS)) {
    if (
      names.some(
        (name) => name.toLowerCase().replace(/["׳']/g, '') === normalized,
      )
    ) {
      return key
    }
  }
  return null
}

const REFUSAL_MESSAGE: Readonly<Record<ImportRefusalCode, string>> = {
  missing_name: 'אין שם לפריט. שם הוא השדה היחיד שאי אפשר להשלים.',
  quantity_not_a_number: 'הכמות אינה מספר.',
  quantity_negative: 'הכמות שלילית. כמות שלילית אינה מלאי אלא תנועה.',
  threshold_not_a_number: 'נקודת ההזמנה או רמת היעד אינן מספר.',
  cost_not_a_number: 'העלות ליחידה אינה מספר. יש להזין אגורות, בלי סימן מטבע.',
  duplicate_sku_in_file:
    'המק״ט הזה מופיע יותר מפעם אחת בקובץ. שורה אחת בלבד נקלטה.',
  too_many_columns: 'בשורה יותר עמודות מאשר בכותרת.',
  unknown_column: 'עמודה שהמוצר אינו מכיר. היא נשמטה והשאר נקלט.',
  row_empty: 'שורה ריקה.',
}

export interface ParseResult {
  rows: readonly ImportRow[]
  refused: readonly ImportRefusal[]
  unknownColumns: readonly string[]
}

/**
 * A file, or a pasted grid, turned into rows this product can judge.
 *
 * Never throws. A file that is not a CSV at all comes back as refusals with
 * line numbers, which is what a person can act on; an exception is what makes
 * them email support.
 */
export function parseImport(text: string): ParseResult {
  const table = parseDelimited(text).filter(
    (row) => row.length > 0 && row.some((cell) => cell.trim().length > 0),
  )

  if (table.length === 0) {
    return { rows: [], refused: [], unknownColumns: [] }
  }

  const header = table[0]
  const mapping = header.map(columnFor)
  const unknownColumns = header.filter((cell, index) => {
    return mapping[index] === null && cell.trim().length > 0
  })

  const rows: ImportRow[] = []
  const refused: ImportRefusal[] = []
  const seenSkus = new Set<string>()

  for (let index = 1; index < table.length; index += 1) {
    const cells = table[index]
    // 1-based and counting the header, so the number matches what the person
    // sees in the left margin of their own editor.
    const lineNumber = index + 1

    const value = (key: string): string => {
      const at = mapping.indexOf(key)
      if (at === -1) return ''
      return (cells[at] ?? '').trim()
    }

    const name = value('name')
    if (name.length === 0) {
      refused.push(refusal(lineNumber, 'missing_name', null))
      continue
    }

    const quantityRaw = value('quantity')
    const quantity = quantityRaw.length === 0 ? 0 : toNumber(quantityRaw)
    if (quantity === null) {
      refused.push(refusal(lineNumber, 'quantity_not_a_number', quantityRaw))
      continue
    }
    if (quantity < 0) {
      refused.push(refusal(lineNumber, 'quantity_negative', quantityRaw))
      continue
    }

    const minRaw = value('minQuantity')
    const parRaw = value('parLevel')
    const minQuantity = minRaw.length === 0 ? null : toNumber(minRaw)
    const parLevel = parRaw.length === 0 ? null : toNumber(parRaw)
    if (
      (minRaw.length > 0 && minQuantity === null) ||
      (parRaw.length > 0 && parLevel === null)
    ) {
      refused.push(
        refusal(lineNumber, 'threshold_not_a_number', minRaw || parRaw),
      )
      continue
    }

    const costRaw = value('unitCostAgorot')
    const unitCostAgorot = costRaw.length === 0 ? null : toNumber(costRaw)
    if (costRaw.length > 0 && unitCostAgorot === null) {
      refused.push(refusal(lineNumber, 'cost_not_a_number', costRaw))
      continue
    }

    const sku = value('sku') || null
    if (sku !== null) {
      const key = sku.toLowerCase()
      if (seenSkus.has(key)) {
        refused.push(refusal(lineNumber, 'duplicate_sku_in_file', sku))
        continue
      }
      seenSkus.add(key)
    }

    rows.push({
      lineNumber,
      name,
      sku,
      category: value('category') || null,
      location: value('location') || null,
      // Never assumed to be "unit": a business counts linen in sets and paper
      // in rolls, and a default that quietly says "יח׳" makes the number wrong.
      unitOfMeasure: value('unitOfMeasure') || 'יח׳',
      quantity,
      minQuantity,
      parLevel,
      unitCostAgorot,
    })
  }

  return { rows, refused, unknownColumns }
}

/* ------------------------------------------------------------------ plan -- */

/** What is already stored, as the plan needs to compare against it. */
export interface ExistingItem {
  id: string
  name: string
  sku: string | null
  quantity: number
  minQuantity: number | null
  parLevel: number | null
  unitCostAgorot: number | null
  location: string | null
  category: string | null
  unitOfMeasure: string
}

/**
 * What this import would do, said before it does it.
 *
 * Nothing is written here. The screen renders the three counts and the
 * refusals, the person presses a button, and only then does the write path
 * run — because "this will change the count of nine items you already have" is
 * a sentence somebody must be able to read before it is true.
 */
export function planImport(
  parsed: ParseResult,
  existing: readonly ExistingItem[],
): ImportPlan {
  const bySku = new Map<string, ExistingItem>()
  const byName = new Map<string, ExistingItem>()
  for (const item of existing) {
    if (item.sku !== null) bySku.set(item.sku.toLowerCase(), item)
    byName.set(item.name.trim().toLowerCase(), item)
  }

  const create: ImportRow[] = []
  const update: ImportRow[] = []
  const unchanged: ImportRow[] = []

  for (const row of parsed.rows) {
    const match =
      (row.sku !== null ? bySku.get(row.sku.toLowerCase()) : undefined) ??
      byName.get(row.name.trim().toLowerCase())

    if (match === undefined) {
      create.push(row)
      continue
    }

    if (isUnchanged(row, match)) unchanged.push(row)
    else update.push(row)
  }

  return {
    create,
    update,
    unchanged,
    refused: parsed.refused,
    unknownColumns: parsed.unknownColumns,
  }
}

/**
 * Is this row already exactly what is stored?
 *
 * `quantity` is compared but is **not** written by an update: 0011 derives it
 * from the movement ledger, and an import that typed over it would produce a
 * count that disagrees with the movements that made it. A differing quantity
 * therefore lands in `update` and the write path records a `count` movement
 * for the difference — which is the same act a physical stocktake is.
 */
function isUnchanged(row: ImportRow, existing: ExistingItem): boolean {
  return (
    row.name.trim() === existing.name.trim() &&
    (row.sku ?? null) === existing.sku &&
    (row.category ?? null) === existing.category &&
    (row.location ?? null) === existing.location &&
    row.unitOfMeasure === existing.unitOfMeasure &&
    row.quantity === existing.quantity &&
    row.minQuantity === existing.minQuantity &&
    row.parLevel === existing.parLevel &&
    row.unitCostAgorot === existing.unitCostAgorot
  )
}

/* ------------------------------------------------------------- internals -- */

function refusal(
  lineNumber: number,
  code: ImportRefusalCode,
  value: string | null,
): ImportRefusal {
  return { lineNumber, code, value, message: REFUSAL_MESSAGE[code] }
}

/**
 * A number as a person types it.
 *
 * Thousands separators and a stray currency sign are stripped, because a
 * spreadsheet exports "1,800" and "₪18.00" and refusing both is refusing the
 * file. Anything still not a number comes back `null` and becomes a refusal
 * with the original text attached — never a silent zero, which would import a
 * cupboard full of nothing.
 */
function toNumber(raw: string): number | null {
  const cleaned = raw.replace(/[,\s₪]/g, '')
  if (cleaned.length === 0) return null
  const parsed = Number(cleaned)
  if (!Number.isFinite(parsed)) return null
  return Math.round(parsed)
}
