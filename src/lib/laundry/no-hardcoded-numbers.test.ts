/**
 * The guard: no business number lives in this engine either.
 *
 * `src/lib/preparation/no-hardcoded-numbers.test.ts` made this argument first
 * and made it well, and this is the same test pointed at this directory. The
 * reason it has to exist twice rather than being shared is that the two
 * modules have different structural allowances and different worked examples,
 * and a shared scanner parameterised over both would be a scanner nobody reads
 * before adding an exception to it.
 *
 * ── Why the laundry module needs its own copy of this argument ────────────
 *
 * Preparation's risk is that somebody writes `guests * 1` and calls it a towel
 * rule. Laundry's risk is worse, because it is more plausible: this module
 * ALREADY HAS the right answer in its hands — the canonical preparation
 * requirement — and the tempting shortcut is not to invent a number but to
 * *re-derive* one. "The booking has 25 guests, so 25 towels" produces exactly
 * the right answer for exactly this customer, passes every functional test in
 * this directory, and is wrong the moment somebody edits a preparation rule.
 *
 * A scan cannot tell a copied number from a derived one. So there are two
 * tests, and they check different things:
 *
 *   · this one, that no business figure is written down here
 *   · `requirements.test.ts`, that CHANGING the preparation requirement
 *     changes the laundry requirement — which is the only way to prove the
 *     number is genuinely flowing through rather than being recomputed
 *
 * Neither is sufficient alone.
 *
 * ── What is scanned, and the two files that are not ───────────────────────
 *
 * Every `.ts` directly under `src/lib/laundry/` that is not a test.
 *
 * `testing/example-configuration.ts` is excluded because it is fixture data,
 * it is the one place business numbers belong, and an assertion below proves
 * no shipped module imports it.
 *
 * `operations.ts` is excluded from the LITERAL scan and given a stricter test
 * of its own instead. It is service wiring rather than arithmetic: its only
 * numbers are field-length bounds on validation schemas, which mirror the check
 * constraints in `0029_laundry.sql` and belong beside the input they validate.
 * Rather than wave that through, the assertion below requires that every
 * non-structural literal in that file sits on a line declaring a schema, AND
 * that the file contains no multiplication, division or rounding at all —
 * which is the property that actually matters. A file that cannot multiply
 * cannot compute a quantity.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildForecast } from './forecast'
import { PROFILES, SETTINGS } from './testing/example-configuration'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIRECTORY = 'testing'
const WIRING_FILE = 'operations.ts'

/**
 * The only numeric literals this engine is allowed to contain.
 *
 *   0, 1     indices, counters, empty totals, the identity multiplier
 *   60       minutes in an hour, and seconds in a minute
 *   1000     milliseconds in a second
 *   100      per cent is per hundred
 *   10000    basis points in a whole
 *
 * Identical to preparation's list, deliberately: this module needed no new
 * allowance to be written, which is itself worth knowing. In particular there
 * is no 24 and no 7 — see the note at the foot of `dates.ts` for why the
 * weekday helper that would have needed one does not exist.
 */
const STRUCTURAL_LITERALS = new Set([0, 1, 60, 100, 1000, 10000])

/**
 * The worked example, in full: its inputs and its outputs together.
 *
 * The party of twenty-five and the party of twelve, the thirteen hand towels,
 * the buffers of two and three, the bundle of five, the 28 and the 30 that
 * come out, the 44 and the 74 the two houses consolidate to, the 112 the week
 * forecasts, the 15 mattresses that are not laundry, the 24 and 48 hour
 * turnarounds and the provider's minimum of twenty.
 */
const WORKED_EXAMPLE_FIGURES = [
  2, 3, 5, 12, 13, 15, 20, 24, 25, 28, 30, 44, 48, 74, 112,
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

/** Everything the literal scan covers: the module, less the wiring file. */
function scannedSources(): readonly SourceFile[] {
  return moduleSources().filter((file) => file.name !== WIRING_FILE)
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

describe('the laundry engine holds no business numbers', () => {
  const sources = scannedSources()

  it('finds the module source to scan', () => {
    // A scan that silently found nothing would pass every assertion below.
    expect(sources.length).toBeGreaterThan(5)
    expect(sources.map((file) => file.name)).toContain('requirements.ts')
    expect(sources.map((file) => file.name)).toContain('forecast.ts')
    expect(sources.map((file) => file.name)).toContain('consolidation.ts')
  })

  it.each(scannedSources().map((file) => file.name))(
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

  it.each(scannedSources().map((file) => file.name))(
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

// ── The wiring file, held to a different and stricter promise ─────────────

describe('operations.ts', () => {
  const wiring =
    moduleSources().find((file) => file.name === WIRING_FILE)?.text ?? ''

  it('is actually there', () => {
    expect(wiring.length).toBeGreaterThan(0)
  })

  it('performs no arithmetic at all, so it cannot compute a quantity', () => {
    const code = executableCode(wiring)

    // Multiplication, division, and the rounding a quantity calculation needs.
    // `+` is deliberately not here: string concatenation and `index += 1` are
    // both ordinary, and neither can turn a guest count into a towel count on
    // its own.
    const arithmetic = [
      /(?<![*/])\*(?!\*)/,
      /(?<![*/:])\/(?![/*])/,
      /Math\.(ceil|floor|round|max|min)\b/,
    ]

    const found = arithmetic
      .map((pattern) => pattern.exec(code)?.[0])
      .filter((match): match is string => match !== undefined)

    expect(
      found,
      `operations.ts performs arithmetic (${found.join(', ')}) — quantities must come from requirements.ts, never be computed at the persistence boundary`,
    ).toEqual([])
  })

  it('has non-structural numbers only where a schema declares a bound', () => {
    const lines = withoutComments(wiring).split('\n')
    const offenders: string[] = []

    lines.forEach((line, index) => {
      const literals = numericLiterals(executableCode(line))
      const nonStructural = literals.filter(
        (value) => !STRUCTURAL_LITERALS.has(value),
      )
      if (nonStructural.length === 0) return

      // A schema bound mirrors a check constraint in 0029_laundry.sql and
      // belongs beside the input it validates. Anything else does not.
      if (/\bs\.\w+\(/.test(line)) return

      offenders.push(`line ${index + 1}: ${line.trim()}`)
    })

    expect(
      offenders,
      `operations.ts holds numbers outside a schema declaration:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})

// ── The horizon is genuinely a parameter ──────────────────────────────────

describe('the forecast horizon', () => {
  /**
   * The product offers 3, 7, 14 and 30 days, and neither this file nor
   * `forecast.ts` may contain any of those numbers. The offer lives in the
   * check constraint in `0029_laundry.sql` and in the screen's own labels,
   * which are the two places a business number belongs.
   *
   * What has to be proved here is that the engine did not quietly bake one in
   * anyway — so the horizon is chosen at random and the window is asserted to
   * be exactly that long. A hardcoded seven would fail this on almost every
   * run, which is a great deal more convincing than a fixed assertion at a
   * value somebody chose.
   */
  it('is whatever the caller asks for, not a value in the code', () => {
    for (let attempt = 0; attempt < STRUCTURAL_SAMPLE_SIZE; attempt += 1) {
      const horizonDays = 1 + Math.floor(Math.random() * MAX_RANDOM_HORIZON)

      const forecast = buildForecast({
        settings: SETTINGS,
        profiles: PROFILES,
        entries: [],
        from: '2026-09-01',
        horizonDays,
      })

      expect(forecast.horizonDays).toBe(horizonDays)
      expect(forecast.days).toHaveLength(horizonDays)
      expect(forecast.headline).toContain(String(horizonDays))
    }
  })
})

/** How many random horizons to try. A test parameter, not a business number. */
const STRUCTURAL_SAMPLE_SIZE = 25

/** The largest horizon the random draw will ask for. Also a test parameter. */
const MAX_RANDOM_HORIZON = 90

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
    for (const figure of [2, 3, 5, 12, 13, 15, 24, 25, 28, 48]) {
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
