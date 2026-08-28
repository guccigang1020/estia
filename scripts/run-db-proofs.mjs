#!/usr/bin/env node
// ============================================================================
// run-db-proofs.mjs — ESTIA · runs every SQL proof in supabase/tests/
//
// Why this exists
//   supabase/tests/ holds the SQL proofs, and the tenant-isolation one is the
//   floor the whole security model stands on. OPEN_GAPS.md recorded G-007 as
//   closed on the strength of one manual run. A guarantee that is checked once
//   by hand is a guarantee that can break on any Tuesday with nobody noticing.
//
//   This script is what a gate runs. It is also what a person runs, with one
//   command, which is the other half of the problem: a proof nobody can run
//   easily is a proof nobody runs.
//
//   The directory is scanned at run time rather than listed here, so a proof
//   written tomorrow is guarded the moment it lands. That is not theoretical:
//   agents.sql and finance.sql appeared while this file was being written and
//   were picked up with no change.
//
// What counts as a pass
//   Every file in supabase/tests/ ends the same way: one result row per
//   assertion, then a TOTAL row, then ROLLBACK. This script does not trust the
//   TOTAL row on its own — it reads every row and requires `passed` to be true
//   on all of them, requires the TOTAL row to be present, and requires the
//   file to have made at least one assertion. A file that silently asserted
//   nothing would otherwise report a clean zero-failure run, which is the one
//   failure mode a proof harness must never have.
//
// Usage
//   node scripts/run-db-proofs.mjs [options]
//
//     --url <conn>       Connection string. Defaults to $DATABASE_URL, then
//                        $SUPABASE_DB_URL. Never printed, never logged.
//     --migrate          Apply the Supabase shim (only onto a database that
//                        has no `auth` schema) and then every file in
//                        supabase/migrations/, in order, before the proofs.
//     --require-empty    Refuse to run unless the target holds no tenant data.
//                        The interlock for any run against a hosted project.
//     --tests <dir>      Directory of proofs. Default supabase/tests.
//     --only <name,…>    Run only these proofs, by file stem.
//     --list             Print what would run and exit.
//
//   The connection string is parsed here and handed to psql as PG* environment
//   variables, so the password never appears in argv and cannot be read out of
//   the process list or a crash dump.
//
// Exit codes
//   0  every assertion in every file passed
//   1  an assertion failed, a file asserted nothing, or psql failed
//   2  the harness could not run at all (no psql, no connection string, the
//      safety interlock refused)
// ============================================================================

import { spawnSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, basename } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_CANNOT_RUN = 2

// Tables whose emptiness is the evidence that a database holds no customer.
// `organizations` is the load-bearing one — no organization means no tenant,
// and no tenant means nothing of anybody's to lose. The rest are there so a
// database seeded through some other door still trips the interlock.
const TENANT_TABLES = [
  'public.organizations',
  'public.bookings',
  'public.guests',
  'public.payments',
  'public.invoices',
]

// ── Arguments ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    url: process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '',
    migrate: false,
    requireEmpty: false,
    testsDir: join(REPO, 'supabase', 'tests'),
    only: null,
    list: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--migrate') opts.migrate = true
    else if (arg === '--require-empty') opts.requireEmpty = true
    else if (arg === '--list') opts.list = true
    else if (arg === '--url') opts.url = argv[++i] ?? ''
    else if (arg === '--tests') opts.testsDir = resolve(argv[++i] ?? '')
    else if (arg === '--only')
      opts.only = (argv[++i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    else if (arg === '--help' || arg === '-h') opts.list = true
    else {
      console.error(`unknown argument: ${arg}`)
      process.exit(EXIT_CANNOT_RUN)
    }
  }
  return opts
}

// ── Connecting ──────────────────────────────────────────────────────────────

// psql is told where to connect through the environment rather than through a
// command line. Two reasons, and the second is the real one: argv is world
// readable on a shared host, and a connection string that lands in a CI log
// once is a credential that has to be rotated.
function environmentFor(connectionString) {
  let url
  try {
    url = new URL(connectionString)
  } catch {
    return null
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) return null

  const env = { ...process.env }
  if (url.hostname) env.PGHOST = decodeURIComponent(url.hostname)
  if (url.port) env.PGPORT = url.port
  if (url.username) env.PGUSER = decodeURIComponent(url.username)
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password)

  const database = url.pathname.replace(/^\//, '')
  if (database) env.PGDATABASE = decodeURIComponent(database)

  const sslmode = url.searchParams.get('sslmode')
  if (sslmode) env.PGSSLMODE = sslmode

  // A hosted Supabase project refuses a plaintext connection anyway, but
  // saying so here means a missing sslmode is not a silent downgrade.
  if (
    !env.PGSSLMODE &&
    !/^(localhost|127\.0\.0\.1|::1)$/.test(env.PGHOST ?? '')
  ) {
    env.PGSSLMODE = 'require'
  }

  // Never inherit a psqlrc or a service file from whoever is running this.
  env.PGCLIENTENCODING = 'UTF8'
  return env
}

function psql(env, args) {
  const result = spawnSync(
    'psql',
    ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off', ...args],
    { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (result.error && result.error.code === 'ENOENT') {
    console.error(
      'psql was not found on PATH.\n' +
        '  Ubuntu/Debian: sudo apt-get install -y postgresql-client\n' +
        '  macOS:         brew install libpq && brew link --force libpq\n' +
        '  Windows:       install PostgreSQL, or run this through the workflow.',
    )
    process.exit(EXIT_CANNOT_RUN)
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

// ── Reading what psql said ──────────────────────────────────────────────────

// psql --csv is used rather than the aligned table because an assertion name
// or a sqlerrm can contain a comma, a quote or a newline, and CSV quoting
// survives all three. Line-splitting the pretty output would not.
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let started = false

  const endField = () => {
    row.push(field)
    field = ''
    started = false
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
  }

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && !started) {
      quoted = true
      started = true
    } else if (ch === ',') endField()
    else if (ch === '\r') continue
    else if (ch === '\n') endRow()
    else {
      field += ch
      started = true
    }
  }
  if (field !== '' || row.length > 0) endRow()
  return rows.filter((r) => r.length > 1 || r[0] !== '')
}

const HEADER = ['seq', 'area', 'name', 'expected', 'actual', 'passed']

export function readAssertions(stdout) {
  const rows = parseCsv(stdout)
  const headerAt = rows.findIndex(
    (r) => r.length === HEADER.length && HEADER.every((h, i) => r[i] === h),
  )
  if (headerAt === -1) return null

  return rows
    .slice(headerAt + 1)
    .filter((r) => r.length === HEADER.length)
    .map((r) => ({
      seq: r[0],
      area: r[1],
      name: r[2],
      expected: r[3],
      actual: r[4],
      passed: r[5] === 't' || r[5] === 'true',
    }))
}

// ── The safety interlock ────────────────────────────────────────────────────

// The proofs roll back, so they do not destroy anything. That is not the same
// as being safe to point at a live tenant: they impersonate `authenticated`,
// they write, and a proof that runs where real people's bookings live is one
// dropped ROLLBACK away from being an incident. So the runner asks the
// database to demonstrate that it has no customer in it, and refuses if it
// cannot.
function assertNoTenantData(env) {
  const offenders = []
  for (const table of TENANT_TABLES) {
    const exists = psql(env, [
      '-t',
      '-A',
      '-c',
      `select to_regclass('${table}') is not null`,
    ])
    if (exists.status !== 0) {
      console.error(`could not inspect ${table}:\n${exists.stderr.trim()}`)
      process.exit(EXIT_CANNOT_RUN)
    }
    if (exists.stdout.trim() !== 't') continue

    const count = psql(env, ['-t', '-A', '-c', `select count(*) from ${table}`])
    if (count.status !== 0) {
      console.error(`could not count ${table}:\n${count.stderr.trim()}`)
      process.exit(EXIT_CANNOT_RUN)
    }
    const n = Number.parseInt(count.stdout.trim(), 10)
    if (Number.isFinite(n) && n > 0) offenders.push(`${table} has ${n} row(s)`)
  }

  if (offenders.length > 0) {
    console.error(
      'REFUSING TO RUN. The target database holds tenant data:\n' +
        offenders.map((o) => `  · ${o}`).join('\n') +
        '\n\nThese proofs impersonate authenticated sessions and write rows.\n' +
        'They belong on a database with no customer in it. Point this at the\n' +
        'CI project, not at production.',
    )
    process.exit(EXIT_CANNOT_RUN)
  }
  console.log(
    'interlock: no tenant data in the target database — safe to proceed.',
  )
}

// ── Applying the schema ─────────────────────────────────────────────────────

function applySchema(env) {
  // The shim recreates objects that a real Supabase project already owns, so
  // it is applied only where there is demonstrably no Supabase underneath.
  const hasAuth = psql(env, [
    '-t',
    '-A',
    '-c',
    "select exists (select 1 from pg_namespace where nspname = 'auth')",
  ])
  if (hasAuth.status !== 0) {
    console.error(
      `could not inspect the target database:\n${hasAuth.stderr.trim()}`,
    )
    process.exit(EXIT_CANNOT_RUN)
  }

  if (hasAuth.stdout.trim() === 't') {
    console.log('schema `auth` already exists — skipping the shim.')
  } else {
    const shim = join(HERE, 'db-proofs', 'supabase-shim.sql')
    console.log(`applying ${relative(shim)}`)
    const applied = psql(env, ['-f', shim])
    if (applied.status !== 0) {
      console.error(applied.stderr.trim())
      process.exit(EXIT_CANNOT_RUN)
    }
  }

  const dir = join(REPO, 'supabase', 'migrations')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  if (files.length === 0) {
    console.error(`no migrations found in ${relative(dir)}`)
    process.exit(EXIT_CANNOT_RUN)
  }

  // One psql invocation, so the ordering is psql's own and a failure in file
  // seven stops file eight. ON_ERROR_STOP is already set above.
  const args = files.flatMap((f) => ['-f', join(dir, f)])
  console.log(`applying ${files.length} migrations: ${files.join(', ')}`)
  const migrated = psql(env, args)
  if (migrated.status !== 0) {
    console.error(migrated.stderr.trim())
    process.exit(EXIT_CANNOT_RUN)
  }
  console.log('migrations applied.\n')
}

function relative(p) {
  return p.startsWith(REPO) ? p.slice(REPO.length + 1).replaceAll('\\', '/') : p
}

// ── Running one proof ───────────────────────────────────────────────────────

function runProof(env, file) {
  const label = basename(file)
  const run = psql(env, ['--csv', '-f', file])

  if (run.status !== 0) {
    return {
      label,
      ok: false,
      total: 0,
      failures: [],
      note: run.stderr.trim() || `psql exited ${run.status}`,
    }
  }

  const rows = readAssertions(run.stdout)
  if (rows === null) {
    return {
      label,
      ok: false,
      total: 0,
      failures: [],
      note: 'no result set — the file printed no assertion table',
    }
  }

  const assertions = rows.filter((r) => r.area !== 'TOTAL')
  const totalRow = rows.find((r) => r.area === 'TOTAL')

  if (assertions.length === 0) {
    return {
      label,
      ok: false,
      total: 0,
      failures: [],
      note: 'the file asserted nothing',
    }
  }
  if (!totalRow) {
    return {
      label,
      ok: false,
      total: assertions.length,
      failures: [],
      note: 'no TOTAL row — the run did not reach the end of the file',
    }
  }

  const failures = assertions.filter((r) => !r.passed)
  // The TOTAL row is checked as well as the individual rows. If the two ever
  // disagree, something is wrong with the file itself and that is also a red.
  const disagrees = totalRow.passed !== (failures.length === 0)

  return {
    label,
    ok: failures.length === 0 && !disagrees,
    total: assertions.length,
    failures,
    note: disagrees ? 'the TOTAL row disagrees with the assertion rows' : '',
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (!existsSync(opts.testsDir)) {
    console.error(`no such directory: ${relative(opts.testsDir)}`)
    process.exit(EXIT_CANNOT_RUN)
  }

  let files = readdirSync(opts.testsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => join(opts.testsDir, f))

  if (opts.only) {
    const wanted = new Set(opts.only.map((s) => s.replace(/\.sql$/, '')))
    files = files.filter((f) => wanted.has(basename(f, '.sql')))
  }

  if (files.length === 0) {
    console.error(`no proofs to run in ${relative(opts.testsDir)}`)
    process.exit(EXIT_CANNOT_RUN)
  }

  if (opts.list) {
    console.log(`${files.length} proof(s) in ${relative(opts.testsDir)}:`)
    for (const f of files) console.log(`  ${basename(f)}`)
    process.exit(EXIT_OK)
  }

  if (!opts.url) {
    console.error(
      'No connection string. Pass --url, or set DATABASE_URL / SUPABASE_DB_URL.\n' +
        'Never put one in a file in this repository — see .env.example.',
    )
    process.exit(EXIT_CANNOT_RUN)
  }

  const env = environmentFor(opts.url)
  if (!env) {
    console.error('The connection string is not a postgres:// URL.')
    process.exit(EXIT_CANNOT_RUN)
  }

  const reachable = psql(env, ['-t', '-A', '-c', 'select 1'])
  if (reachable.status !== 0) {
    console.error(`cannot reach the database:\n${reachable.stderr.trim()}`)
    process.exit(EXIT_CANNOT_RUN)
  }

  if (opts.requireEmpty) assertNoTenantData(env)
  if (opts.migrate) applySchema(env)

  const results = files.map((f) => runProof(env, f))

  console.log('─'.repeat(72))
  let assertions = 0
  let red = 0
  for (const r of results) {
    assertions += r.total
    const mark = r.ok ? 'PASS' : 'FAIL'
    const detail = r.ok
      ? `${r.total} assertions`
      : r.note || `${r.failures.length} of ${r.total} assertions failed`
    console.log(`${mark}  ${r.label.padEnd(24)} ${detail}`)
    if (!r.ok) {
      red += 1
      for (const f of r.failures) {
        console.log(`        #${f.seq} [${f.area}] ${f.name}`)
        console.log(`           expected: ${f.expected}`)
        console.log(`           actual:   ${f.actual}`)
      }
    }
  }
  console.log('─'.repeat(72))
  console.log(
    `${results.length} file(s), ${assertions} assertions, ${red} file(s) failed.`,
  )

  process.exit(red === 0 ? EXIT_OK : EXIT_FAILED)
}

// Guarded so the pure helpers above can be imported and exercised without the
// script trying to reach a database.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main()
}
