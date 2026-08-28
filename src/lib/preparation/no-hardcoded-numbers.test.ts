/**
 * The guard: no business number lives in this engine.
 *
 * Every other test in this directory asserts that the right answer comes out.
 * None of them can tell the difference between an engine that computed
 * twenty-five pillows and one that was told to say twenty-five, which is
 * precisely the failure that matters — it passes every test and then produces
 * the same twenty-five pillows for the next customer, who has four beds and
 * thirty guests.
 *
 * So this test reads the module's own source and asserts that the only numeric
 * literals in it are structural. It is deliberately strict: an allowlist of
 * six values, each of which is a unit conversion or a loop index, and a
 * failure message that names the offending file and value.
 *
 * ── What is scanned ───────────────────────────────────────────────────────
 *
 * Every `.ts` file directly under `src/lib/preparation/` that is not a test.
 * `testing/example-configuration.ts` is excluded — it is fixture data, it is
 * the one place business numbers belong, and a separate assertion below proves
 * that no shipped module imports it. Comments and string literals are stripped
 * before the scan, because prose that says "twenty-five" is documentation and
 * a Hebrew message is not arithmetic. A second pass then looks for the worked
 * example's own figures across the whole of the code, strings included, so
 * nothing can hide inside a template literal.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIRECTORY = 'testing'

/**
 * The only numeric literals this engine is allowed to contain.
 *
 *   0, 1     indices, counters, empty totals, the identity multiplier
 *   60       minutes in an hour, and seconds in a minute
 *   1000     milliseconds in a second
 *   100      per cent is per hundred
 *   10000    basis points in a whole
 *
 * Every one of them is a fact about arithmetic or about the calendar. None is
 * a fact about towels, beds, guests, cleaning rates or commission.
 */
const STRUCTURAL_LITERALS = new Set([0, 1, 60, 100, 1000, 10000])

/**
 * The worked example, in full.
 *
 * Its inputs and its outputs together: five beds, twenty-five guests, the
 * ten permanent places, the fifteen mattresses, the 25 / 25 / 13 / 25 towels,
 * the twenty-eight buffered ones, the twenty-two pillows in the cupboard and
 * the cleaning formula's own constants.
 */
const WORKED_EXAMPLE_FIGURES = [
  5, 10, 12, 13, 15, 20, 22, 25, 28, 30, 350, 400, 800, 1200, 1500, 2000, 35000,
]

// ── Source access ─────────────────────────────────────────────────────────

interface SourceFile {
  name: string
  text: string
}

function moduleSources(): readonly SourceFile[] {
  return readdirSync(HERE, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => ({
      name: entry.name,
      text: readFileSync(join(HERE, entry.name), 'utf8'),
    }))
}

/** Comments removed. Prose about twenty-five guests is not arithmetic. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

/** Comments and string literals removed. What is left is executable code. */
function executableCode(text: string): string {
  return withoutComments(text)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/** Numeric literals, underscore separators resolved. */
function numericLiterals(code: string): readonly number[] {
  const matches = code.match(/(?<![\w.$])\d[\d_]*(?:\.\d+)?/g) ?? []
  return matches.map((token) => Number(token.replace(/_/g, '')))
}

// ── The scan ──────────────────────────────────────────────────────────────

describe('the preparation engine holds no business numbers', () => {
  const sources = moduleSources()

  it('finds the module source to scan', () => {
    // A scan that silently found nothing would pass every assertion below.
    expect(sources.length).toBeGreaterThan(10)
    expect(sources.map((file) => file.name)).toContain('requirements.ts')
    expect(sources.map((file) => file.name)).toContain('costing.ts')
  })

  it.each(moduleSources().map((file) => file.name))(
    '%s contains only structural numeric literals',
    (name) => {
      const file = sources.find((entry) => entry.name === name)
      const literals = numericLiterals(executableCode(file?.text ?? ''))

      const offenders = [...new Set(literals)].filter(
        (value) => !STRUCTURAL_LITERALS.has(value),
      )

      expect(
        offenders,
        `${name} contains non-structural numeric literals: ${offenders.join(', ')}`,
      ).toEqual([])
    },
  )

  it.each(moduleSources().map((file) => file.name))(
    '%s contains none of the worked example figures, in code or in text',
    (name) => {
      const file = sources.find((entry) => entry.name === name)
      // Strings kept this time, so nothing can hide inside a template.
      const literals = new Set(
        numericLiterals(withoutComments(file?.text ?? '')),
      )

      const found = WORKED_EXAMPLE_FIGURES.filter((figure) =>
        literals.has(figure),
      )

      expect(
        found,
        `${name} hard-codes worked-example figures: ${found.join(', ')}`,
      ).toEqual([])
    },
  )
})

// ── The fixture stays a fixture ───────────────────────────────────────────

describe('the example configuration', () => {
  it('is where the business numbers actually are', () => {
    const fixture = readFileSync(
      join(HERE, FIXTURE_DIRECTORY, 'example-configuration.ts'),
      'utf8',
    )
    const literals = new Set(numericLiterals(executableCode(fixture)))

    // If this ever stops being true the fixture has stopped exercising the
    // example, and the assertions above are guarding nothing.
    for (const figure of [5, 25, 20, 2, 1200, 35000]) {
      expect(literals.has(figure), `fixture lost the figure ${figure}`).toBe(
        true,
      )
    }
  })

  it('is imported by no module that ships', () => {
    const importers = moduleSources().filter((file) =>
      /from\s+'\.\/testing\//.test(file.text),
    )

    expect(
      importers.map((file) => file.name),
      'a shipped module imports the test fixture',
    ).toEqual([])
  })
})
