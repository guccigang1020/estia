/**
 * What a difference means, and what the product is allowed to call it.
 *
 * ── Why one of these tests greps source ───────────────────────────────────
 *
 * Because the promise is about *text*. An unexplained variance is unexplained,
 * and the risk is not a function returning the wrong value — it is a Hebrew
 * label, a comment, a helpful sentence somebody adds in six months meaning
 * well, turning "we cannot account for eleven towels" into an accusation
 * against the person who cleans the house. There is no assertion about a
 * return value that constrains that. A review catches it once; a test catches
 * it on every commit.
 *
 * The guest-book module set the precedent for compliance claims in
 * `src/lib/guest-book/honesty.test.ts`, and the instrument is the same one.
 * This file is excluded from its own scan, because it necessarily contains
 * every word it forbids.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { BusinessRuleError } from '../errors'

import {
  LOSS_CLASSES,
  LOSS_CLASS_HELP,
  LOSS_CLASS_LABEL,
  ReplacementExposure,
  classificationsFor,
  estimateExposure,
  isUnexplained,
  lossEffect,
  type LossClass,
} from './loss'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')

/* ------------------------------------------------- the word that is not -- */

/** Everything this capability is made of, screens included. */
const SCANNED = [
  'src/lib/inventory/counts.ts',
  'src/lib/inventory/counts.test.ts',
  'src/lib/inventory/loss.ts',
  'src/app/(app)/inventory/counts',
]

/** This file, which necessarily contains every phrase below. */
const SELF = 'loss.test.ts'

/**
 * Words that would turn a variance into an accusation.
 *
 * Hebrew first, because that is what a customer and a cleaner read. Each one
 * asserts a *crime*, which is a claim this product cannot support from a
 * counted difference and must never make on a screen. Ordinary loss
 * vocabulary — ״לא אותר״, ״נגרע״, `lost`, `written off` — is deliberately
 * absent from this list: naming stock as gone is honest, and naming a person
 * as the reason is not.
 */
const FORBIDDEN = [
  // Hebrew
  'גניבה',
  'גנבה',
  'גנב',
  'גונב',
  'נגנב',
  'מעילה',
  // English
  'theft',
  'thief',
  'stolen',
  'steal',
  'pilfer',
  'shrinkage',
  'embezzl',
  'larceny',
  'misappropriat',
]

function sourceFiles(target: string): string[] {
  const absolute = join(ROOT, target)
  if (!statSync(absolute).isDirectory()) return [absolute]

  const found: string[] = []
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry)
      if (statSync(child).isDirectory()) {
        walk(child)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue
      if (entry === SELF) continue
      found.push(child)
    }
  }

  walk(absolute)
  return found
}

describe('an unexplained variance is never named as a crime', () => {
  const files = SCANNED.flatMap(sourceFiles)

  it('has source to scan at all', () => {
    // A grep over nothing passes trivially. This is the guard against a
    // renamed directory turning the whole file into a no-op.
    expect(files.length).toBeGreaterThan(5)
  })

  it.each(FORBIDDEN)('never says "%s"', (phrase) => {
    const offenders = files
      .filter((file) =>
        readFileSync(file, 'utf8').toLowerCase().includes(phrase.toLowerCase()),
      )
      .map((file) => relative(ROOT, file))

    expect(offenders).toEqual([])
  })

  it('says instead, in Hebrew, that it has no explanation', () => {
    // The other half of the promise: refusing the accusation is only honest
    // if the product also says plainly what it does know.
    expect(LOSS_CLASS_LABEL.unknown).toBe('לא הוסבר')
    expect(LOSS_CLASS_HELP.unknown).toContain('לא נמצא לו הסבר')
    expect(LOSS_CLASS_HELP.unknown).toContain('לגיטימית')
  })
})

/* ----------------------------------------------------------- vocabulary -- */

describe('the vocabulary', () => {
  it('is exactly the seven the brief names, in order', () => {
    expect(LOSS_CLASSES).toEqual([
      'count_error',
      'in_laundry',
      'found_at_property',
      'damaged',
      'disposed',
      'lost',
      'unknown',
    ])
  })

  it('separates "nobody has looked" from "somebody looked and found nothing"', () => {
    expect(isUnexplained(null)).toBe(true)
    expect(isUnexplained('unknown')).toBe(true)
    expect(isUnexplained('damaged')).toBe(false)
    expect(isUnexplained('count_error')).toBe(false)
  })
})

/* --------------------------------------------------------------- effects -- */

const MISSING = { label: 'מגבת רחצה', variance: 3, circulating: 42 }
const SURPLUS = { label: 'מגבת רחצה', variance: -3, circulating: 42 }
const CONSUMABLE = { label: 'סבון גוף', variance: 3, circulating: 0 }

function effect(
  base: { label: string; variance: number; circulating: number },
  classification: LossClass,
  note: string | null = 'נבדקו כל הארונות.',
) {
  return lossEffect({ ...base, classification, note })
}

describe('lossEffect', () => {
  it('refuses a variance of zero', () => {
    expect(() => effect({ ...MISSING, variance: 0 }, 'count_error')).toThrow(
      BusinessRuleError,
    )
  })

  it('writes nothing for an unexplained difference', () => {
    const result = effect(MISSING, 'unknown', null)
    expect(result.movementKind).toBeNull()
    expect(result.quantityDelta).toBe(0)
    expect(result.toState).toBeNull()
  })

  it('lets the shelf beat the ledger on a count error', () => {
    const result = effect(MISSING, 'count_error')
    // `expected − counted` is 3, so the ledger is three too high and the
    // correcting movement is minus three.
    expect(result.movementKind).toBe('count')
    expect(result.quantityDelta).toBe(-3)
    expect(result.correctsLedger).toBe(true)
  })

  it('corrects a surplus upward through the same branch', () => {
    const result = effect(SURPLUS, 'count_error')
    expect(result.quantityDelta).toBe(3)
  })

  it('writes nothing when the units were found elsewhere on the property', () => {
    // Deliberately the opposite of `count_error`: there the record was wrong,
    // here the count was, and the ledger needs no change.
    const result = effect(MISSING, 'found_at_property')
    expect(result.movementKind).toBeNull()
    expect(result.correctsLedger).toBe(false)
  })

  it('moves laundry into the state it was actually in, writing nothing off', () => {
    const result = effect(MISSING, 'in_laundry')
    expect(result.movementKind).toBe('adjustment')
    expect(result.toState).toBe('laundry')
    expect(result.quantityDelta).toBe(-3)
  })

  it('refuses laundry for an item the ledger shows no circulation for', () => {
    // A consumable. Offering "it is in the wash" for a bottle of shampoo is
    // how a classification list stops being read.
    expect(() => effect(CONSUMABLE, 'in_laundry')).toThrow(BusinessRuleError)
  })

  it('takes damaged units out of use without calling them gone', () => {
    const result = effect(MISSING, 'damaged')
    expect(result.movementKind).toBe('adjustment')
    expect(result.toState).toBe('damaged')
  })

  it('records disposal and non-location as losses against the ledger', () => {
    expect(effect(MISSING, 'disposed').movementKind).toBe('loss')
    expect(effect(MISSING, 'disposed').toState).toBe('lost')
    expect(effect(MISSING, 'lost').movementKind).toBe('loss')
  })

  it('demands a note before any stock leaves the count', () => {
    for (const classification of ['damaged', 'disposed', 'lost'] as const) {
      expect(() => effect(MISSING, classification, '  ')).toThrow(
        BusinessRuleError,
      )
    }
  })

  it('needs no note for the explanations that remove nothing', () => {
    for (const classification of [
      'count_error',
      'found_at_property',
      'in_laundry',
      'unknown',
    ] as const) {
      expect(() => effect(MISSING, classification, null)).not.toThrow()
    }
  })

  it('refuses to explain a surplus as anything that removes stock', () => {
    for (const classification of [
      'damaged',
      'disposed',
      'lost',
      'in_laundry',
      'found_at_property',
    ] as const) {
      expect(() => effect(SURPLUS, classification)).toThrow(BusinessRuleError)
    }
  })
})

describe('classificationsFor', () => {
  it('offers exactly what lossEffect will accept, and nothing else', () => {
    for (const base of [MISSING, SURPLUS, CONSUMABLE]) {
      const offered = classificationsFor(base)

      for (const classification of LOSS_CLASSES) {
        const allowed = offered.includes(classification)
        const attempt = () => effect(base, classification)

        if (allowed) expect(attempt).not.toThrow()
        else expect(attempt).toThrow(BusinessRuleError)
      }
    }
  })

  it('offers nothing at all for a variance of zero', () => {
    expect(classificationsFor({ variance: 0, circulating: 5 })).toEqual([])
  })

  it('drops laundry for an item with nothing in circulation', () => {
    expect(classificationsFor(CONSUMABLE)).not.toContain('in_laundry')
    expect(classificationsFor(MISSING)).toContain('in_laundry')
  })
})

/* -------------------------------------------------------------- exposure -- */

const UNEXPLAINED = {
  itemId: 'item-towel',
  label: 'מגבת רחצה',
  variance: 3,
  classification: null,
  replacementCostAgorot: 1800,
}

describe('the exposure figure cannot be produced without its method', () => {
  it('carries no bare amount on the instance', () => {
    const exposure = estimateExposure([UNEXPLAINED])

    expect(Object.keys(exposure)).toEqual(['method', 'formatted'])
    expect('agorot' in exposure).toBe(false)
    expect('totalAgorot' in exposure).toBe(false)
    // The figure is reachable only through the object that explains it.
    expect(exposure.method.totalAgorot).toBe(5400)
  })

  it('cannot be constructed except through `from`', () => {
    // A private constructor is a compile-time guarantee; this is the runtime
    // half of it — the class is not callable as a plain factory.
    expect(() => {
      const callable = ReplacementExposure as unknown as () => void
      callable()
    }).toThrow(TypeError)
  })

  it('always renders with the qualifier, even coerced carelessly', () => {
    const exposure = estimateExposure([UNEXPLAINED])

    expect(exposure.formatted).toContain('הערכת חשיפה')
    expect(`${exposure}`).toContain('הערכת חשיפה')
    expect(String(exposure)).toContain('הערכת חשיפה')
  })

  it('says what the number is not', () => {
    const method = estimateExposure([UNEXPLAINED]).method

    expect(method.disclaimer).toContain('הערכה ולא אובדן מאומת')
    expect(method.basis).toContain('העלות שנרשמה')
    // Serialising the estimate carries the disclaimer with it, so a figure
    // that crosses a boundary does not arrive naked.
    expect(JSON.stringify(exposureOf(UNEXPLAINED))).toContain('אובדן מאומת')
  })

  it('shows the table the reader would use to disagree', () => {
    const method = estimateExposure([UNEXPLAINED]).method

    expect(method.table).toEqual([
      {
        itemId: 'item-towel',
        label: 'מגבת רחצה',
        units: 3,
        replacementCostAgorot: 1800,
        agorot: 5400,
      },
    ])
  })
})

function exposureOf(...inputs: (typeof UNEXPLAINED)[]) {
  return estimateExposure(inputs)
}

describe('what counts as exposure', () => {
  it('counts an explicitly unknown variance as well as an unclassified one', () => {
    const both = estimateExposure([
      UNEXPLAINED,
      { ...UNEXPLAINED, itemId: 'item-sheet', classification: 'unknown' },
    ])

    expect(both.method.totalAgorot).toBe(10_800)
    expect(both.method.table).toHaveLength(2)
  })

  it('excludes every explained variance', () => {
    for (const classification of [
      'count_error',
      'in_laundry',
      'found_at_property',
      'damaged',
      'disposed',
      'lost',
    ] as const) {
      const exposure = estimateExposure([{ ...UNEXPLAINED, classification }])
      expect(exposure.method.totalAgorot).toBe(0)
    }
  })

  it('excludes a surplus, which costs nothing to replace', () => {
    const exposure = estimateExposure([{ ...UNEXPLAINED, variance: -3 }])
    expect(exposure.method.totalAgorot).toBe(0)
    expect(exposure.method.table).toHaveLength(0)
  })

  it('never silently understates an item with no recorded cost', () => {
    const exposure = estimateExposure([
      UNEXPLAINED,
      {
        ...UNEXPLAINED,
        itemId: 'item-sheet',
        label: 'סדין',
        variance: 4,
        replacementCostAgorot: null,
      },
    ])

    expect(exposure.method.totalAgorot).toBe(5400)
    expect(exposure.method.unpricedUnits).toBe(4)
    expect(exposure.method.unpricedItems).toBe(1)
    // And the omission is on the face of the figure, not buried in the method.
    expect(exposure.formatted).toContain('4 יחידות ללא עלות רשומה')
  })

  it('is an integer number of agorot and divides by nothing', () => {
    const exposure = estimateExposure([
      { ...UNEXPLAINED, variance: 7, replacementCostAgorot: 1999 },
    ])

    expect(exposure.method.totalAgorot).toBe(13_993)
    expect(Number.isInteger(exposure.method.totalAgorot)).toBe(true)
  })

  it('reports nothing rather than zero-with-a-table when there is nothing', () => {
    const exposure = estimateExposure([])

    expect(exposure.method.totalAgorot).toBe(0)
    expect(exposure.method.table).toEqual([])
    expect(exposure.formatted).toContain('הערכת חשיפה')
  })
})
