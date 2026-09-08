#!/usr/bin/env node
/**
 * The Product Reality Inventory.
 *
 * Green tests do not mean a product. A domain module can be complete, correct
 * and covered by three hundred tests while nothing a customer can reach ever
 * calls it — and the test count makes that state look like progress.
 *
 * So this measures reachability rather than quality. For every module under
 * `src/lib` it asks: is there a real persistence adapter, does an API route
 * touch it, and does any screen import it. A module nothing imports is
 * DOMAIN_ONLY however good it is.
 *
 * Dependency-free, matching `security.yml` and `run-db-proofs.mjs`.
 *
 *   node scripts/product-reality.mjs          markdown table
 *   node scripts/product-reality.mjs --json   machine-readable
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const LIB = join(ROOT, 'src', 'lib')
const APP = join(ROOT, 'src', 'app')
const COMPONENTS = join(ROOT, 'src', 'components')
const PERSISTENCE = join(LIB, 'persistence')
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')

/** Infrastructure, not product surface. Reported but never expected in a screen. */
const INFRASTRUCTURE = new Set([
  'contracts',
  'errors',
  'service',
  'actor',
  'audit',
  'persistence',
  'supabase',
])

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

const isSource = (p) =>
  (p.endsWith('.ts') || p.endsWith('.tsx')) && !p.includes('.test.')

const read = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

// ── What exists ────────────────────────────────────────────────────────────

const modules = readdirSync(LIB)
  .filter((name) => {
    try {
      return statSync(join(LIB, name)).isDirectory()
    } catch {
      return false
    }
  })
  .sort()

const appFiles = walk(APP).filter(isSource)
const componentFiles = walk(COMPONENTS).filter(isSource)
const surfaceFiles = [...appFiles, ...componentFiles]
const surfaceText = surfaceFiles.map(read).join('\n')

const persistenceText = walk(PERSISTENCE).filter(isSource).map(read).join('\n')

const routeFiles = appFiles.filter(
  (p) => p.endsWith('route.ts') || p.endsWith('actions.ts'),
)
const pageFiles = appFiles.filter((p) => p.endsWith('page.tsx'))

/** Tables the migrations create, so "referenced" can be checked against real ones. */
const migrationText = walk(MIGRATIONS)
  .filter((p) => p.endsWith('.sql'))
  .map(read)
  .join('\n')
const tables = new Set(
  [
    ...migrationText.matchAll(
      /create table(?: if not exists)?\s+public\.(\w+)/gi,
    ),
  ].map((m) => m[1]),
)

// ── Per module ─────────────────────────────────────────────────────────────

function inspect(name) {
  const files = walk(join(LIB, name))
  const sources = files.filter(isSource)
  const tests = files.filter((p) => p.includes('.test.'))
  const text = sources.map(read).join('\n')

  const importPattern = new RegExp(
    `from ['"](?:@/lib/${name}|\\.\\./${name}|\\./${name})(?:/[\\w./-]*)?['"]`,
  )

  // A real adapter, as opposed to a port with only an in-memory double.
  const hasPort = /interface \w*(Repository|Store|Source|Ports|Gateway)\b/.test(
    text,
  )
  const adapterPattern = new RegExp(`${name}|${name.replace(/s$/, '')}`, 'i')
  // An adapter counts wherever it lives.
  //
  // This used to look only under `src/lib/persistence`, which was a guess
  // about layout rather than a fact about the product. `laundry` and
  // `payments` each keep a `repository.ts` inside their own module — a
  // perfectly ordinary choice — and both therefore read as PARTIAL forever,
  // under a heading that said they had no screen. What the matrix is asking is
  // "does this module talk to the database", and a repository beside the
  // domain answers that just as well as one in the shared directory.
  //
  // And a third way, because the second was still a guess. `guest-journey`
  // reads `bookings`, `guest_requests` and seven other tables directly and
  // calls `guest_portal_journey` by RPC — it talks to the database as much as
  // anything here does — and reported "no persistence adapter" forever because
  // none of its files is *named* one. That is the same mistake as looking only
  // in `src/lib/persistence`, made one level further in: a fact about naming
  // standing in for a fact about behaviour.
  //
  // A module that selects from a named table or calls a named function is
  // talking to the database, so that is what is asked. A pure-vocabulary
  // module — `plans`, `hebrew-calendar`, `contracts` — has no such call and
  // still answers no, which is what keeps the column worth reading.
  const callsDatabase = sources
    .filter((p) => !/\.test\.tsx?$/.test(p))
    .some((p) => /\.from\(['"`]|\.rpc\(['"`]/.test(read(p)))

  const hasAdapter =
    (persistenceText.length > 0 &&
      walk(PERSISTENCE)
        .filter(isSource)
        .some((p) => adapterPattern.test(relative(PERSISTENCE, p)))) ||
    sources.some((p) => /(repository|adapter|persistence)\.tsx?$/.test(p)) ||
    callsDatabase

  // Anything still refusing for want of a table is not wired, whatever exists.
  const blocked = (persistenceText.match(/SchemaNotProvisionedError/g) ?? [])
    .length

  const usedBySurface = importPattern.test(surfaceText)
  const usedByRoute = routeFiles.map(read).some((t) => importPattern.test(t))

  const referencedTables = [...text.matchAll(/from\(['"](\w+)['"]\)/g)]
    .map((m) => m[1])
    .filter((t) => tables.has(t))

  return {
    module: name,
    infrastructure: INFRASTRUCTURE.has(name),
    sourceFiles: sources.length,
    testFiles: tests.length,
    hasPort,
    hasAdapter,
    usedByRoute,
    usedBySurface,
    tables: [...new Set(referencedTables)].length,
    blocked,
    status: statusOf({
      hasPort,
      hasAdapter,
      usedBySurface,
      usedByRoute,
      tests,
    }),
  }
}

function statusOf({ hasPort, hasAdapter, usedBySurface, usedByRoute, tests }) {
  if (usedBySurface || usedByRoute) {
    return hasAdapter || !hasPort ? 'INTEGRATED' : 'PARTIAL'
  }
  if (hasAdapter) return 'PERSISTED_UNREACHED'
  if (tests.length > 0) return 'DOMAIN_ONLY'
  return 'NOT_IMPLEMENTED'
}

const rows = modules.map(inspect)

// ── Output ─────────────────────────────────────────────────────────────────

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ modules: rows }, null, 2))
  process.exit(0)
}

const yes = (b) => (b ? '✓' : '—')

console.log(
  '| module | src | tests | port | adapter | route | screen | tables | status |',
)
console.log('| --- | --: | --: | :-: | :-: | :-: | :-: | --: | --- |')
for (const r of rows) {
  console.log(
    `| ${r.module}${r.infrastructure ? ' *' : ''} | ${r.sourceFiles} | ${r.testFiles} | ${yes(r.hasPort)} | ${yes(r.hasAdapter)} | ${yes(r.usedByRoute)} | ${yes(r.usedBySurface)} | ${r.tables} | ${r.status} |`,
  )
}

const product = rows.filter((r) => !r.infrastructure)
const count = (s) => product.filter((r) => r.status === s).length

console.log('\n* infrastructure — not expected on a screen\n')
console.log(`product modules      ${product.length}`)
console.log(`INTEGRATED           ${count('INTEGRATED')}`)
console.log(`PERSISTED_UNREACHED  ${count('PERSISTED_UNREACHED')}`)
console.log(`DOMAIN_ONLY          ${count('DOMAIN_ONLY')}`)
console.log(`PARTIAL              ${count('PARTIAL')}`)
console.log(
  `\npages ${pageFiles.length} · route/action files ${routeFiles.length} · tables in migrations ${tables.size}`,
)

// Name the missing layer, per module.
//
// This used to print every non-INTEGRATED module under the heading "not
// reachable from any screen", which was simply a false sentence: `laundry` had
// seven screens and `payments` had two, and both were reported as having none.
// They were PARTIAL for an entirely different reason — their repository lives
// beside the domain rather than in `src/lib/persistence`.
//
// A matrix that mislabels is worse than no matrix, because it is the thing
// completion gets certified against. So each row now says what it actually
// lacks.
// ── Screens with no domain module ──────────────────────────────────────────
//
// `G-027`. Six top-level screens ask canonical tables straight out of their own
// `_lib/queries.ts` with no `src/lib/<name>` behind them, and for a read-only
// report that is a legitimate choice rather than a debt: a revenue table over
// canonical rows does not need a domain.
//
// The gap was never the thinness. It was that NOTHING COULD TELL "thin on
// purpose" FROM "stopped halfway", so this checker could not hold the
// distinction and neither could a reader — which meant a screen that genuinely
// stalled would look exactly like a deliberate one, for ever.
//
// So the intent is declared where it is made. A screen that means to be thin
// carries `@thin-by-design` in its `_lib` or its page, with the reason on the
// same line, and this prints the reason. A screen without a module and without
// a declaration is listed as UNDECLARED — not failed, because a new screen
// mid-build is a normal state, but named, so it cannot sit there unnoticed.
const MARKER = '@thin-by-design'

// Plumbing every screen imports, so importing one proves nothing about
// whether the screen has a domain behind it. `authz` is on every screen by
// construction — `can()` is the second floor — and `plans` is read wherever a
// feature can be locked.
//
// `audit` is deliberately NOT here even though it is infrastructure elsewhere
// in this file: a screen that imports it is a screen whose subject matter has
// a module, which is the only question being asked.
const PLUMBING = new Set([
  'errors',
  'persistence',
  'supabase',
  'service',
  'contracts',
  'actor',
  'authz',
  'plans',
  'demo',
])

const productModules = rows.map((r) => r.module).filter((m) => !PLUMBING.has(m))

const screens = readdirSync(join(APP, '(app)'))
  .filter((entry) => {
    try {
      return statSync(join(APP, '(app)', entry)).isDirectory()
    } catch {
      return false
    }
  })
  .filter((entry) => !entry.startsWith('_'))
  .map((name) => {
    const files = walk(join(APP, '(app)', name)).filter(isSource)
    const declared = files.map(read).flatMap((text) =>
      text
        .split('\n')
        .filter((line) => line.includes(MARKER))
        .map((line) =>
          line
            .replace(/^[\s*/-]*/, '')
            .replace(MARKER, '')
            .replace(/^[\s:—-]*/, '')
            .trim(),
        ),
    )
    // Behaviour, not naming. A directory called `/bookings` is backed by
    // `src/lib/booking`, `/listings` by `listing-quality`, `/dashboard` by
    // `metrics` — so asking whether `src/lib/<name>` exists would answer a
    // question about spelling, which is the exact mistake the adapter check
    // above already had to be talked out of twice.
    //
    // The real question is whether the screen reaches a domain at all. A
    // screen that imports a product module has one; a screen that imports
    // none and selects from canonical tables in its own `_lib` is thin.
    const text = files.map(read).join('\n')
    const importsDomain = productModules.some((m) =>
      new RegExp(`@/lib/${m}(/|['"\`])`).test(text),
    )
    const queriesTables = /\.from\(['"`]\w+['"`]\)/.test(text)

    return {
      name,
      thin: queriesTables && !importsDomain,
      reason: declared[0] ?? null,
    }
  })
  .filter((s) => s.thin)

if (screens.length > 0) {
  console.log('\nscreens with no domain module:')
  for (const s of screens.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(
      `  /${s.name.padEnd(15)} ${s.reason ? `thin by design — ${s.reason}` : 'UNDECLARED'}`,
    )
  }
  const undeclared = screens.filter((s) => s.reason === null)
  if (undeclared.length > 0) {
    console.log(
      `\n  ${undeclared.length} undeclared. A screen that means to be thin says so with ` +
        `${MARKER}; one that does not is either mid-build or forgotten, and this ` +
        `checker cannot tell which.`,
    )
  }
}

const incomplete = product.filter((r) => r.status !== 'INTEGRATED')
if (incomplete.length > 0) {
  console.log('\nincomplete modules, and what each one lacks:')
  for (const row of incomplete) {
    const missing = [
      row.hasAdapter ? null : 'no persistence adapter',
      row.usedBySurface || row.usedByRoute ? null : 'no screen or route',
      // `testFiles` is a count, not an array. Reading `.length` off a number
      // is `undefined`, so this reported "no tests" for every incomplete
      // module including one with seven of them — a checker lying in the
      // first five minutes of its life.
      row.testFiles > 0 ? null : 'no tests',
    ].filter(Boolean)
    console.log(
      `  ${row.module.padEnd(16)} ${row.status.padEnd(20)} ` +
        `${missing.join(' · ') || 'see the table above'}`,
    )
  }
}
