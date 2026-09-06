/**
 * The register claims no compliance, anywhere, in any language.
 *
 * ── Why a test greps source ───────────────────────────────────────────────
 *
 * Because the promise is about *text*, not about behaviour. The brief that
 * commissioned this module says the exact fields a business must record have
 * not been externally verified, and therefore that ESTIA must not claim
 * regulatory compliance. There is no function whose return value that
 * constrains — the risk is a comment, a Hebrew label, a panel description,
 * a helpful sentence somebody adds in six months meaning well.
 *
 * A review catches that once. A test catches it on every commit, which is what
 * the promise needs, so grepping this module's own source is the correct
 * instrument here rather than a substitute for one.
 *
 * ── What is scanned ───────────────────────────────────────────────────────
 *
 * The whole capability: both domain modules and both screens, including their
 * Hebrew UI strings, because a claim on a panel heading is worth more to a
 * reader than a claim in a comment and is therefore worse. This file itself is
 * excluded — it necessarily contains every phrase it forbids — and nothing
 * else is.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')

const SCANNED = [
  'src/lib/guest-book',
  'src/lib/fiscal',
  'src/app/(app)/guest-book',
  'src/app/(app)/settings/fiscal',
  'src/components/fiscal',
]

/** This file, which necessarily contains every phrase below. */
const SELF = 'honesty.test.ts'

/**
 * Sentences that would assert what this product has not established.
 *
 * Hebrew first, because that is what a customer reads. Each is a *claim* about
 * a requirement or about satisfying one — not a mere mention of law. "מסמך
 * חשבונאי" and "legal document" are descriptions of what a thing is and are
 * deliberately absent: the fiscal module has to be able to say that a tax
 * invoice is a legal instrument, which is a fact about the document, not a
 * promise about the customer.
 */
const FORBIDDEN = [
  // Hebrew
  'על פי חוק',
  'לפי חוק',
  'כנדרש בחוק',
  'כפי שמחייב החוק',
  'החוק מחייב',
  'חובה חוקית',
  'דרישות החוק',
  'עומד בדרישות',
  'עומד בתקן',
  'תואם רגולציה',
  'עמידה ברגולציה',
  'רשות המסים מחייבת',
  // English
  'the law requires',
  'required by law',
  'legally required',
  'legal requirement',
  'regulatory compliance',
  'regulatorily',
  'legally compliant',
  'fully compliant',
  'complies with',
  'compliant with',
  'in compliance with',
  'ensures compliance',
  'guarantees compliance',
  'meets the requirements of',
]

function sourceFiles(directory: string): string[] {
  const absolute = join(ROOT, directory)
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

describe('no compliance claim anywhere in the capability', () => {
  const files = SCANNED.flatMap(sourceFiles)

  it('has source to scan at all', () => {
    // A grep over nothing passes trivially. This is the guard against a
    // renamed directory turning the whole file into a no-op.
    expect(files.length).toBeGreaterThan(10)
  })

  it.each(FORBIDDEN)('never says "%s"', (phrase) => {
    const offenders = files
      .filter((file) =>
        readFileSync(file, 'utf8').toLowerCase().includes(phrase.toLowerCase()),
      )
      .map((file) => relative(ROOT, file))

    expect(offenders).toEqual([])
  })

  it('the guest book module says whose responsibility the fields are', () => {
    // The other half of the promise: not claiming compliance is only honest if
    // the product also says who does have to work it out.
    const header = readFileSync(
      join(ROOT, 'src/lib/guest-book/types.ts'),
      'utf8',
    )
    expect(header).toContain('operator')
    expect(header).toContain('configuration')
  })
})
