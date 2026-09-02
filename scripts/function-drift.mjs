#!/usr/bin/env node
/**
 * Does the database's copy of a function still say what the repository says?
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Migrations here are applied through an API that takes SQL as a string, not
 * a file. Somebody — a person or an agent — has to reproduce the file into
 * that call, and the large ones do not fit in one, so comments get shortened
 * to make them fit. That happened this session: five function bodies in the
 * live database are shorter than the files they came from.
 *
 * The compression turned out to be harmless. That is exactly the problem.
 * Nobody could *tell* it was harmless without going and looking at each one,
 * and "the deployed function differs from the file and we believe it is only
 * prose" is not a thing a schema should ever be left saying. A predicate
 * quietly dropped from a SECURITY DEFINER function is a tenant-isolation bug
 * that no test in this repository would catch, because every test runs against
 * the demo client or a fake.
 *
 * ── Three states, not two ─────────────────────────────────────────────────
 *
 * `identical` · `comments-only` · `EXECUTABLE DIFFERENCE`
 *
 * Collapsing the middle one into "differs" is what makes a checker ignorable.
 * If every applied migration reports drift, the report is noise within a day
 * and somebody turns it off. Only the third state fails the run.
 *
 * ── The trap, which cost a full false-positive pass ───────────────────────
 *
 * JavaScript's `\s` matches more characters than Postgres's does. Normalising
 * whitespace with `\s` on the JS side and `\s` in a SQL `regexp_replace` on
 * the other produces two different strings for the same input, and every
 * function comes back as differing — including a 78-character one with no
 * comments in it at all, which is what gave the game away. Both sides here use
 * an explicit `[ \t\r\n]+` and both sides trim.
 *
 * ── What it compares ──────────────────────────────────────────────────────
 *
 * The LAST definition of each function name across the migration files in
 * order, because a later migration replacing a function is what is deployed —
 * comparing against the first would report drift on every function that was
 * ever revised.
 *
 * Usage:
 *   node scripts/function-drift.mjs            # report, exit 1 on real drift
 *   node scripts/function-drift.mjs --json     # machine-readable
 *
 * It needs the live bodies. Without a way to reach the database it says so and
 * exits 0 rather than passing silently — an unrunnable check must not look
 * like a clean one. Pipe them in with `--bodies <file>`, where the file is the
 * JSON result of:
 *
 *   select p.proname, p.prosrc
 *   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 *   where n.nspname = 'public' and p.prokind = 'f';
 */

import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const bodiesAt = args.includes('--bodies')
  ? args[args.indexOf('--bodies') + 1]
  : null
/**
 * Hashes instead of bodies, which is the mode to prefer.
 *
 * Postgres computes `md5(btrim(regexp_replace(prosrc, '[ \t\r\n]+', ' ', 'g')))`
 * and returns one line per function, so eighty-two functions cost two kilobytes
 * instead of half a megabyte. It answers "identical or not" on its own; only
 * the functions that disagree need their bodies fetched, and this tells you
 * which those are.
 */
const hashesAt = args.includes('--hashes')
  ? args[args.indexOf('--hashes') + 1]
  : null

/* ---------------------------------------------------------- normalising -- */

const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex')

/**
 * Whitespace collapsed with an explicit class, never `\s`.
 *
 * See the header: `\s` differs between JavaScript and Postgres, and using it
 * on both sides of this comparison reports every function as broken.
 *
 * Spaces adjacent to brackets and commas go too, and that second rule was
 * learned the same way as the first. Without it, `property_in_scope` and
 * `unit_in_scope` reported an executable difference — two functions every RLS
 * policy in the schema leans on, which is as alarming as this checker can get.
 * The entire divergence was `or ( s.kind` in the file against `or (s.kind` in
 * the database: the file had been reformatted onto more lines after it was
 * applied. Six characters, in two of the most security-sensitive functions
 * here, and a checker that shouts about that is a checker somebody switches
 * off before it ever catches anything real.
 *
 * It transforms both sides identically, so the worst it can do is miss a
 * difference that lives *only* in spacing around punctuation inside a string
 * literal. That is a trade worth making.
 */
const squeeze = (text) =>
  text
    .replace(/[ \t\r\n]+/g, ' ')
    .replace(/ *([(),]) */g, '$1')
    .trim()

/** The body with `--` comments removed, so prose changes stop being drift. */
function stripComments(text) {
  return text
    .split('\n')
    .map((line) => {
      // Only a `--` that is not inside a string literal. Counting quotes is
      // enough here because these bodies contain no escaped quotes outside
      // dollar-quoting, which this never sees — `prosrc` is the body alone.
      let inString = false
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] === "'") inString = !inString
        if (!inString && line[i] === '-' && line[i + 1] === '-') {
          return line.slice(0, i)
        }
      }
      return line
    })
    .join('\n')
}

/* ------------------------------------------------------------- the file -- */

/**
 * Every `create [or replace] function` body in the migrations, last one wins.
 *
 * Dollar-quoted with any tag, because the house style uses `$$` and a tagged
 * form would still be legal.
 */
function bodiesFromMigrations() {
  const found = new Map()

  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
    const pattern =
      /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\([\s\S]*?\bas\s+(\$[a-z_]*\$)([\s\S]*?)\2/gi

    for (const match of sql.matchAll(pattern)) {
      // Last definition wins: a later migration replacing a function is what
      // is deployed, so comparing an earlier one reports drift on every
      // function that was ever revised.
      found.set(match[1].toLowerCase(), { body: match[3], file })
    }
  }
  return found
}

/* ------------------------------------------------------------ the report -- */

const fileBodies = bodiesFromMigrations()

/* ------------------------------------------------------- the hashes mode -- */

if (hashesAt) {
  const liveHashes = new Map(
    JSON.parse(readFileSync(hashesAt, 'utf8')).map((row) => [
      String(row.proname).toLowerCase(),
      String(row.code ?? row.raw),
    ]),
  )

  const checked = []
  for (const [name, { body, file }] of fileBodies) {
    const deployed = liveHashes.get(name)
    if (deployed === undefined) continue // Not in this sample; say nothing.
    checked.push({
      name,
      file,
      same:
        md5(squeeze(body)) === deployed ||
        md5(squeeze(stripComments(body))) === deployed,
    })
  }

  const drifted = checked.filter((row) => !row.same)
  console.log(
    `function-drift — ${checked.length} of ${fileBodies.size} functions ` +
      `compared by hash · ${checked.length - drifted.length} byte-identical · ` +
      `${drifted.length} differ`,
  )

  for (const row of drifted) {
    console.log(
      `  ${row.name}  (${row.file})  differs — fetch its body with ` +
        '--bodies to tell comments from code',
    )
  }

  // A hash difference alone is not a failure: the comments-only case is the
  // common one and is harmless. This mode narrows the list; `--bodies` judges
  // it. Exiting 1 here would fail the gate on prose.
  process.exit(0)
}

if (!bodiesAt) {
  console.log(
    `function-drift — ${fileBodies.size} functions found in migrations, and no ` +
      'live bodies to compare them against.\n' +
      '  Pass --hashes <file.json> (cheap, from md5 computed in Postgres) or\n' +
      '  --bodies <file.json> (`select proname, prosrc from pg_proc`).\n' +
      '  Reporting rather than passing: a check that cannot run must not look ' +
      'like one that found nothing.',
  )
  process.exit(0)
}

const live = new Map(
  JSON.parse(readFileSync(bodiesAt, 'utf8')).map((row) => [
    String(row.proname).toLowerCase(),
    String(row.prosrc ?? ''),
  ]),
)

const rows = []
for (const [name, { body, file }] of fileBodies) {
  const deployed = live.get(name)
  if (deployed === undefined) {
    rows.push({ name, file, state: 'not-deployed' })
    continue
  }

  const rawSame = md5(squeeze(body)) === md5(squeeze(deployed))
  const codeSame =
    md5(squeeze(stripComments(body))) === md5(squeeze(stripComments(deployed)))

  rows.push({
    name,
    file,
    state: rawSame ? 'identical' : codeSame ? 'comments-only' : 'differs',
    fileChars: squeeze(body).length,
    dbChars: squeeze(deployed).length,
  })
}

const differing = rows.filter((row) => row.state === 'differs')
const missing = rows.filter((row) => row.state === 'not-deployed')

if (asJson) {
  console.log(JSON.stringify({ rows, differing, missing }, null, 2))
} else {
  const counts = rows.reduce((all, row) => {
    all[row.state] = (all[row.state] ?? 0) + 1
    return all
  }, {})

  console.log(
    `function-drift — ${rows.length} functions · ` +
      `${counts.identical ?? 0} identical · ` +
      `${counts['comments-only'] ?? 0} comments only · ` +
      `${differing.length} with an executable difference · ` +
      `${missing.length} not deployed`,
  )

  for (const row of [...differing, ...missing]) {
    console.error(
      `\n  ${row.name}  (${row.file})  ${row.state}` +
        (row.state === 'differs'
          ? `\n    file ${row.fileChars} chars · database ${row.dbChars} chars` +
            '\n    The deployed body does something the file does not say, or ' +
            'the other way round.'
          : '\n    In a migration file and absent from the database.'),
    )
  }
}

// Comments-only never fails. Only a predicate that moved, or a function the
// repository declares and the database has never heard of.
if (differing.length > 0 || missing.length > 0) process.exit(1)
