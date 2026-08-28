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
  const hasAdapter =
    persistenceText.length > 0 &&
    walk(PERSISTENCE)
      .filter(isSource)
      .some((p) => adapterPattern.test(relative(PERSISTENCE, p)))

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

const unreached = product.filter((r) => r.status !== 'INTEGRATED')
if (unreached.length > 0) {
  console.log(
    `\nnot reachable from any screen: ${unreached.map((r) => r.module).join(', ')}`,
  )
}
