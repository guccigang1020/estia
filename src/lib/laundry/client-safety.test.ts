/**
 * The guard: nothing in this module can drag a database driver into a browser.
 *
 * ── The outage this was written after ─────────────────────────────────────
 *
 * While the laundry screens were being verified over HTTP, every page in the
 * application began returning 500. The message was:
 *
 *     ./node_modules/postgres/src/index.js:2:1
 *     Module not found: Can't resolve 'fs'
 *
 * with an import trace ending in a `"use client"` form. The chain was five
 * links long and every individual link was reasonable:
 *
 *     a client form
 *       → a domain barrel  (`index.ts`, re-exporting everything)
 *       → the module's operations file
 *       → `@/lib/persistence`
 *       → the `postgres` driver
 *       → `fs`
 *
 * Nobody imported a driver into the browser. Somebody imported a *barrel* into
 * the browser, and the barrel re-exported an operations file, and operations
 * files talk to databases. The bundler followed it because that is its job.
 *
 * It was not a broken page. It was every page, for every worker on the shared
 * dev server, from one import in a module none of them owned.
 *
 * ── Why a test rather than a rule ─────────────────────────────────────────
 *
 * The rule is easy to state — "a client component imports types from the
 * barrel, never values" — and it is invisible at the call site. `import {
 * sectionsFor } from '@/lib/laundry'` and `import type { LaundryMode } from
 * '@/lib/laundry'` are one keyword apart, one is fine and one is an outage, and
 * TypeScript is happy with both. That is precisely the shape of thing that
 * needs a machine to check it.
 *
 * So this walks the module's own client components and asserts that none of
 * them reaches a driver, by following the import graph the way a bundler
 * would rather than by matching a list of forbidden names.
 *
 * ── What is checked ───────────────────────────────────────────────────────
 *
 *   1. Every `"use client"` file under `src/components/laundry` and
 *      `src/app/(app)/laundry` — its transitive value imports inside this
 *      repository must never reach `src/lib/persistence`.
 *   2. `src/lib/laundry/mode.ts` and `types.ts` stay driver-free, because they
 *      are what a client component is told to import instead of the barrel.
 *   3. The barrel genuinely IS unsafe, so the test is guarding something real.
 *      If `index.ts` ever stops reaching persistence this assertion fails and
 *      tells whoever changed it that the advice above is now stale.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '..', '..')
const REPO = resolve(SRC, '..')

/** The directories whose client components must stay driver-free. */
const CLIENT_ROOTS = [
  join(SRC, 'components', 'laundry'),
  join(SRC, 'app', '(app)', 'laundry'),
]

/** Reaching this from a browser bundle is the outage. */
const FORBIDDEN = join(SRC, 'lib', 'persistence')

/* ---------------------------------------------------------------- files -- */

function walk(directory: string): string[] {
  if (!existsSync(directory)) return []

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) return walk(full)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')
      ? [full]
      : []
  })
}

function read(file: string): string {
  return readFileSync(file, 'utf8')
}

/** Comments removed, so a `"use client"` inside prose is not a directive. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

function isClientComponent(text: string): boolean {
  // The directive must be the first statement, so only the head matters.
  const head = withoutComments(text).trimStart()
  return head.startsWith("'use client'") || head.startsWith('"use client"')
}

/* -------------------------------------------------------------- imports -- */

/**
 * The specifiers this file imports for their VALUES.
 *
 * `import type { X } from 'y'` is erased before bundling and cannot pull
 * anything in, so it is excluded — that is the whole distinction the rule
 * rests on. An inline `import { type X }` is likewise erased, but a mixed
 * `import { type X, y }` is not, and is therefore treated as a value import.
 */
function valueImports(text: string): string[] {
  const source = withoutComments(text)
  const found: string[] = []

  const pattern = /(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)from\s+'([^']+)'/g

  for (const match of source.matchAll(pattern)) {
    const clause = match[1] ?? ''
    const specifier = match[2] ?? ''

    // `import type { ... } from` / `export type { ... } from` — erased.
    if (/^\s*type\s/.test(clause)) continue

    // Every named binding individually marked `type` — also fully erased.
    const named = /^\s*\{([\s\S]*)\}\s*$/.exec(clause)
    if (named) {
      const bindings = (named[1] ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)

      if (bindings.length > 0 && bindings.every((b) => /^type\s/.test(b))) {
        continue
      }
    }

    found.push(specifier)
  }

  return found
}

/** Resolve a repo-relative specifier to a file on disk, or `null`. */
function resolveSpecifier(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? join(SRC, specifier.slice('@/'.length))
    : specifier.startsWith('.')
      ? resolve(dirname(from), specifier)
      : null

  // A bare specifier is a package. `postgres` itself is only ever reached
  // through `src/lib/persistence`, which is what this test tracks.
  if (base === null) return null

  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate)) return candidate
  }

  return null
}

/**
 * Does this file reach `src/lib/persistence` through value imports.
 *
 * Returns the chain rather than a boolean, because the useful failure message
 * is the trace — exactly what the Next.js error printed, and the reason it was
 * diagnosable in one reading.
 */
function pathToDriver(entry: string): string[] | null {
  const seen = new Set<string>()

  function walkFrom(file: string, chain: string[]): string[] | null {
    if (seen.has(file)) return null
    seen.add(file)

    if (file.startsWith(FORBIDDEN)) return chain

    for (const specifier of valueImports(read(file))) {
      const next = resolveSpecifier(file, specifier)
      if (next === null) continue

      const found = walkFrom(next, [...chain, relative(next)])
      if (found !== null) return found
    }

    return null
  }

  return walkFrom(entry, [relative(entry)])
}

function relative(file: string): string {
  return file
    .slice(REPO.length + 1)
    .split('\\')
    .join('/')
}

/* ----------------------------------------------------------------- test -- */

const clientComponents = CLIENT_ROOTS.flatMap(walk).filter((file) =>
  isClientComponent(read(file)),
)

describe('the laundry client components', () => {
  it('are actually found, so the sweep is not vacuous', () => {
    // This deliberately does NOT require a minimum count: a module with no
    // client components at all is a correct state, and asserting otherwise
    // would fail the honest case. What it checks is that the roots exist, so
    // a renamed directory cannot make the sweep silently empty.
    for (const root of CLIENT_ROOTS) {
      expect(existsSync(root), `${relative(root)} is missing`).toBe(true)
    }
  })

  it.each(
    clientComponents.length > 0
      ? clientComponents.map((file) => relative(file))
      : ['(no client components in this module)'],
  )('%s does not reach a database driver', (name) => {
    if (name.startsWith('(')) {
      expect(clientComponents).toEqual([])
      return
    }

    const file = clientComponents.find((entry) => relative(entry) === name)
    const chain = file === undefined ? null : pathToDriver(file)

    expect(
      chain,
      chain === null
        ? ''
        : `${name} reaches src/lib/persistence — and therefore the postgres ` +
            `driver and 'fs' — in a browser bundle. Every page in the app will ` +
            `500. Import the leaf module (e.g. '@/lib/laundry/mode') or use ` +
            `'import type', never the '@/lib/laundry' barrel.\n\n  ` +
            chain.join('\n  → '),
    ).toBeNull()
  })
})

describe('the modules a client component is told to import instead', () => {
  it.each(['mode.ts', 'types.ts', 'dates.ts'])(
    '%s is safe to import from the browser',
    (name) => {
      expect(pathToDriver(join(HERE, name))).toBeNull()
    },
  )
})

describe('the barrel', () => {
  it('IS unsafe, which is why the advice above exists', () => {
    // Guarding nothing is the failure mode of a guard. If this ever passes,
    // the barrel has stopped reaching persistence and every comment in this
    // module telling people to avoid it has become misleading.
    const chain = pathToDriver(join(HERE, 'index.ts'))

    expect(
      chain,
      'src/lib/laundry/index.ts no longer reaches persistence — the advice ' +
        'to import leaf modules from client components is now stale and the ' +
        'comments saying so should be corrected.',
    ).not.toBeNull()
  })
})
