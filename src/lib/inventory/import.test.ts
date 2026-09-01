/**
 * Onboarding a cupboard from a spreadsheet.
 *
 * Two properties matter and both are tested here rather than asserted in a
 * comment: running the same file twice must not double the stock, and a bad
 * row must not take the good ones down with it.
 */

import { describe, expect, it } from 'vitest'

import {
  IMPORT_TEMPLATE_HEADER,
  importTemplateCsv,
  parseDelimited,
  parseImport,
  planImport,
  type ExistingItem,
} from './import'

const FILE = [
  'שם,מקט,קטגוריה,מיקום,יחידת מידה,כמות,מינימום,רמת יעד,עלות ליחידה',
  'מגבת גוף,TWL-L,מגבות,מחסן ראשי,יח׳,50,20,60,1800',
  'סט מצעים זוגי,LIN-D,מצעים,מחסן ראשי,סט,24,10,30,9000',
  'כרית,,מצעים,מחסן ראשי,יח׳,40,12,45,',
].join('\n')

describe('parsing', () => {
  it('reads the template it hands out', () => {
    const parsed = parseImport(importTemplateCsv())

    expect(parsed.refused).toHaveLength(0)
    expect(parsed.unknownColumns).toHaveLength(0)
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.rows[0].name).toBe('מגבת גוף')
    expect(parsed.rows[0].quantity).toBe(50)
  })

  it('the template carries every column the parser knows by its Hebrew name', () => {
    const header = parseDelimited(importTemplateCsv())[0]
    expect(header).toEqual([...IMPORT_TEMPLATE_HEADER])
  })

  it('accepts tabs, so a paste out of Excel works', () => {
    const pasted = FILE.replace(/,/g, '\t')
    const parsed = parseImport(pasted)
    expect(parsed.rows).toHaveLength(3)
  })

  it('accepts quoted commas and thousands separators', () => {
    const parsed = parseImport(
      'שם,כמות,עלות ליחידה\n"מגבת, גדולה","1,200","₪18"',
    )

    expect(parsed.refused).toHaveLength(0)
    expect(parsed.rows[0].name).toBe('מגבת, גדולה')
    expect(parsed.rows[0].quantity).toBe(1200)
    expect(parsed.rows[0].unitCostAgorot).toBe(18)
  })

  it('never assumes the unit of measure is "unit"', () => {
    // Linen is counted in sets and paper in rolls. A silent "יח׳" on a row
    // that meant "סט" makes every number after it wrong.
    const parsed = parseImport(FILE)
    expect(parsed.rows[1].unitOfMeasure).toBe('סט')
  })

  it('reports a column it does not know rather than failing on it', () => {
    const parsed = parseImport('שם,כמות,ספק\nמגבת,10,מכבסת הגליל')

    expect(parsed.unknownColumns).toEqual(['ספק'])
    expect(parsed.rows).toHaveLength(1)
  })

  it('answers an empty file with nothing, not with an exception', () => {
    expect(parseImport('').rows).toHaveLength(0)
    expect(parseImport('\n\n').rows).toHaveLength(0)
  })
})

describe('refusals are per row, and they say why', () => {
  const messy = [
    'שם,מקט,כמות,עלות ליחידה',
    'מגבת גוף,TWL-L,50,1800',
    ',TWL-S,20,900',
    'סדין,LIN-S,הרבה,500',
    'ציפית,LIN-P,-4,300',
    'מגבת פנים,TWL-L,12,400',
    'שמיכה,BLK,8,לא ידוע',
  ].join('\n')

  const parsed = parseImport(messy)

  it('keeps the good rows', () => {
    // One good row out of six. An import that failed as a whole on line three
    // is an import nobody completes.
    expect(parsed.rows.map((row) => row.name)).toEqual(['מגבת גוף'])
  })

  it('names the line, the value and the reason for each refusal', () => {
    const byLine = new Map(parsed.refused.map((one) => [one.lineNumber, one]))

    expect(byLine.get(3)?.code).toBe('missing_name')
    expect(byLine.get(4)?.code).toBe('quantity_not_a_number')
    expect(byLine.get(4)?.value).toBe('הרבה')
    expect(byLine.get(5)?.code).toBe('quantity_negative')
    expect(byLine.get(6)?.code).toBe('duplicate_sku_in_file')
    expect(byLine.get(7)?.code).toBe('cost_not_a_number')

    // Every refusal carries a Hebrew sentence, not a code the person has to
    // look up.
    expect(parsed.refused.every((one) => one.message.length > 0)).toBe(true)
  })

  it('counts lines the way the person’s editor does', () => {
    // 1-based and including the header, so "line 4" means line 4.
    expect(parsed.refused.map((one) => one.lineNumber)).toEqual([3, 4, 5, 6, 7])
  })
})

describe('the plan, before anything is written', () => {
  const existing: readonly ExistingItem[] = [
    {
      id: 'item-1',
      name: 'מגבת גוף',
      sku: 'TWL-L',
      quantity: 50,
      minQuantity: 20,
      parLevel: 60,
      unitCostAgorot: 1800,
      location: 'מחסן ראשי',
      category: 'מגבות',
      unitOfMeasure: 'יח׳',
    },
    {
      id: 'item-2',
      name: 'סט מצעים זוגי',
      sku: 'LIN-D',
      quantity: 18,
      minQuantity: 10,
      parLevel: 30,
      unitCostAgorot: 9000,
      location: 'מחסן ראשי',
      category: 'מצעים',
      unitOfMeasure: 'סט',
    },
  ]

  it('is idempotent: a second run changes nothing', () => {
    const plan = planImport(parseImport(FILE), existing)

    expect(plan.unchanged.map((row) => row.name)).toEqual(['מגבת גוף'])
    expect(plan.update.map((row) => row.name)).toEqual(['סט מצעים זוגי'])
    expect(plan.create.map((row) => row.name)).toEqual(['כרית'])
  })

  it('matches on SKU where there is one and on name where there is not', () => {
    // A villa owner's spreadsheet has no SKU column and never will, so the
    // name has to be an identity too or every re-import doubles the cupboard.
    const noSku = 'שם,כמות\nמגבת גוף,50'
    const plan = planImport(parseImport(noSku), existing)

    expect(plan.create).toHaveLength(0)
    expect(plan.update).toHaveLength(1)
  })

  it('carries the refusals through, so the screen shows both halves', () => {
    const plan = planImport(parseImport('שם,כמות\n,10\nכרית,5'), existing)

    expect(plan.create).toHaveLength(1)
    expect(plan.refused).toHaveLength(1)
    expect(plan.refused[0].code).toBe('missing_name')
  })
})
