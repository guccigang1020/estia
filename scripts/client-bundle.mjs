#!/usr/bin/env node
/**
 * No Client Component may reach a server-only module.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * This was the most expensive recurring failure of the day. It took the whole
 * application down three times, in three different modules, for three
 * different workers — and each time the error named a file nobody had
 * touched:
 *
 *     "use client" component
 *       → @/lib/<module>            (the barrel)
 *         → repository.ts
 *           → @/lib/persistence
 *             → the `postgres` driver
 *               → Error: Can't resolve 'fs'
 *
 * Every route 500s, including `/dashboard`. The trace points into
 * `node_modules/postgres` rather than at the one-line import that caused it,
 * so a worker verifying an unrelated screen sees the entire product broken and
 * has no reason to suspect a barrel three files away.
 *
 * The fix was the same single line every time: import the leaf module,
 * `@/lib/store/mode` rather than `@/lib/store`. A convention that careful
 * people have broken three times in one day is not a convention.
 *
 * ── Why this is not an ESLint rule ────────────────────────────────────────
 *
 * Two reasons, and the second is the one that matters.
 *
 * `no-restricted-imports` cannot see `'use client'` — ESLint selects files by
 * glob, and "is this a Client Component" is a fact about the first line of the
 * file. Restricting barrels everywhere would break every Server Component that
 * imports one perfectly legitimately, which is most of them.
 *
 * More importantly, a lint rule only sees the *direct* import. The failure is
 * transitive: the component imports a barrel, and it is four hops later that
 * something reaches `postgres`. Banning barrels would be banning the symptom
 * — and would still miss a client component that imports a leaf module which
 * happens to import the driver itself. What is actually true is "no client
 * component may reach a server-only module", and only a graph walk can say
 * that.
 *
 * ── What counts as server-only ────────────────────────────────────────────
 *
 * A module is server-only if it imports a Node builtin or a package that does
 * — `postgres` being the one that has actually bitten. That is deliberately
 * narrow: `server-only` the package is not used here, and inferring intent
 * from a filename would make this a style checker rather than a bundle
 * checker. What is reported is a real reachability fact, and the trace names
 * every hop, because the whole point is that the last hop is not where anybody
 * would look.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')

/**
 * Node builtins a browser bundle cannot have.
 *
 * `fs` and `net` are the ones the real failures reported. The rest are here
 * because they fail identically and there is no reason to learn each one from
 * a broken deployment.
 */
const NODE_BUILTINS = new Set([
  'fs',
  'net',
  'tls',
  'dns',
  'child_process',
  'perf_hooks',
  'worker_threads',
  'crypto',
  'os',
  'path',
  'stream',
  'zlib',
  'http',
  'https',
])

/** Packages that pull a Node builtin in themselves. */
const SERVER_ONLY_PACKAGES = new Set(['postgres', 'server-only'])

function isServerOnlySpecifier(specifier) {
  const bare = specifier.replace(/^node:/, '')
  return NODE_BUILTINS.has(bare) || SERVER_ONLY_PACKAGES.has(bare)
}

/* ------------------------------------------------------------- the files -- */

function walk(directory, found = []) {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry)
    if (statSync(full).isDirectory()) {
      walk(full, found)
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      found.push(full)
    }
  }
  return found
}

/**
 * Every import specifier in a file.
 *
 * A regular expression rather than a parser, and that is a real limitation
 * worth stating: it reads `import … from '…'`, `export … from '…'` and
 * `import('…')`, and it does not understand a specifier built at runtime. That
 * is enough, because the failure this exists to catch is always a literal
 * import written by hand — but a dynamic import that reached the driver would
 * pass this check, so nobody should read a green run as proof of more than it
 * says.
 */
function importsOf(source) {
  const specifiers = []
  const patterns = [
    // `import type … from` and `export type … from` are deliberately excluded
    // by the `(?!type\s)` guard, and it is not a nicety — it was the
    // difference between six findings and none.
    //
    // A type import is erased by the compiler and never reaches the bundle, so
    // a Client Component importing a *type* from a module that touches
    // `postgres` is completely safe. All six of this checker's first real
    // findings were exactly that: `import type { BookableUnit } from
    // '…/queries'`. Reporting them would have sent six people to fix six
    // things that were already right, which is how a checker earns the right
    // to be ignored.
    /(?:^|\n)\s*import\s+(?!type\s)[^'"]*from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+(?!type\s)[^'"]*from\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1])
  }
  return specifiers
}

/** `@/x` and `./x` to a file on disk, or `null` for a package. */
function resolveSpecifier(specifier, fromFile) {
  let base
  if (specifier.startsWith('@/')) {
    base = join(SRC, specifier.slice(2))
  } else if (specifier.startsWith('.')) {
    base = resolve(dirname(fromFile), specifier)
  } else {
    return null
  }

  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not this one. A specifier that resolves to nothing is a broken import
      // and `tsc` is the thing that says so; this checker is not that.
    }
  }
  return null
}

/* -------------------------------------------------------------- the walk -- */

const sources = new Map()
function read(file) {
  if (!sources.has(file)) sources.set(file, readFileSync(file, 'utf8'))
  return sources.get(file)
}

const isClientComponent = (source) =>
  /^\s*(['"])use client\1/m.test(source.slice(0, 400))

/**
 * A Server Action module, where the walk stops.
 *
 * This is the correction that makes the checker trustworthy rather than merely
 * loud. Its first run reported thirty-nine of sixty-two client components as
 * unsafe, and most were fine: a Client Component importing a `'use server'`
 * actions file is the ordinary, intended shape. Next cuts the graph there —
 * the action runs on the server, and what crosses to the browser is a
 * reference to it rather than its imports.
 *
 * Walking through that boundary would have condemned every form in the product
 * and buried the three real failures among them. A checker that cries wolf
 * about the normal case is worse than no checker: somebody silences it, and
 * the next outage arrives unannounced.
 */
const isServerAction = (source) =>
  /^\s*(['"])use server\1/m.test(source.slice(0, 400))

/**
 * The first path from `entry` to a server-only import, or `null`.
 *
 * Breadth-first, so the trace it reports is the shortest one — which is the
 * one a person can act on. `seen` is global to the walk rather than per-entry:
 * a module proven safe for one component is safe for every other.
 */
function pathToServerOnly(entry) {
  const queue = [[entry]]
  const seen = new Set([entry])

  while (queue.length > 0) {
    const trail = queue.shift()
    const file = trail[trail.length - 1]

    for (const specifier of importsOf(read(file))) {
      if (isServerOnlySpecifier(specifier)) return [...trail, specifier]

      const next = resolveSpecifier(specifier, file)
      if (!next || seen.has(next)) continue
      seen.add(next)

      // The boundary. Everything a Server Action imports stays on the server,
      // so the browser bundle never sees it and neither does this walk.
      if (isServerAction(read(next))) continue

      queue.push([...trail, next])
    }
  }
  return null
}

/* ------------------------------------------------------------- reporting -- */

const short = (file) => relative(ROOT, file).replaceAll('\\', '/')

const clients = walk(SRC).filter((file) => isClientComponent(read(file)))
const failures = []

for (const client of clients) {
  const trail = pathToServerOnly(client)
  if (trail) failures.push({ client, trail })
}

console.log(
  `client-bundle — ${clients.length} client components checked, ` +
    `${failures.length} reaching a server-only module.`,
)

if (failures.length > 0) {
  for (const { client, trail } of failures) {
    console.error(`\n  ${short(client)}`)
    for (const [index, hop] of trail.entries()) {
      const label = index === trail.length - 1 ? hop : short(hop)
      console.error(`${'    '.repeat(1)}${index === 0 ? '' : '→ '}${label}`)
    }
  }
  console.error(
    '\n  A Client Component reaching a Node builtin takes every route down' +
      "\n  with `Can't resolve 'fs'`, from a file nobody touched. Import the" +
      '\n  leaf module rather than the barrel — `@/lib/store/mode`, not' +
      '\n  `@/lib/store`.\n',
  )
  process.exit(1)
}
