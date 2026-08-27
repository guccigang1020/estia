#!/usr/bin/env node
/**
 * Security invariant guard.
 *
 * Deliberately small: a handful of regular expressions over the files git
 * knows about. It is not a secret scanner and does not pretend to be one — it
 * exists to make four specific mistakes impossible to commit quietly, and it
 * runs in CI with no database, no secrets and no network.
 *
 *   1. A Supabase project URL hardcoded into source instead of read from env.
 *   2. Key material of any shape committed to the repository.
 *   3. SUPABASE_SERVICE_ROLE_KEY read anywhere except src/lib/env.ts — the one
 *      module allowed to touch it. The key bypasses row level security
 *      completely, so every additional reader is another way to leak every
 *      tenant's data at once.
 *   4. An .env file tracked by git. Only .env.example may ever be committed.
 *
 * Exit code 0 = clean, 1 = at least one violation.
 *
 * Run locally with `npm run security:check`.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'

/** The single module permitted to read the service role key from the env. */
const ENV_MODULE = 'src/lib/env.ts'

/** The only .env file that may be committed. */
const ENV_TEMPLATE = '.env.example'

/** Never scanned: generated, vendored or binary. */
const SKIP = [
  /^node_modules\//,
  /^\.next\//,
  /^coverage\//,
  /^_reference\//,
  /^package-lock\.json$/,
  /\.(png|jpe?g|gif|ico|svg|webp|avif|woff2?|ttf|eot|pdf|mp4|zip)$/i,
]

const rules = [
  {
    id: 'hardcoded-supabase-url',
    // Only source. The template is allowed to show a placeholder.
    appliesTo: (f) => f.startsWith('src/'),
    pattern: /https:\/\/[a-z0-9-]{8,}\.supabase\.(?:co|in)\b/gi,
    message:
      'Hardcoded Supabase project URL. Read it from env (src/lib/env.ts) instead.',
  },
  {
    id: 'committed-key-material',
    appliesTo: (f) => f !== ENV_TEMPLATE,
    // Legacy JWT-shaped anon/service keys, and the current sb_* key format.
    pattern:
      /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|\bsb_(?:publishable|secret)_[A-Za-z0-9]{12,}/g,
    message:
      'What looks like a Supabase key is committed here. Keys belong in the secret store, never in the repository.',
  },
  {
    id: 'service-role-key-outside-env-module',
    appliesTo: (f) =>
      f.startsWith('src/') && f !== ENV_MODULE && !f.endsWith('.test.ts'),
    pattern: /SUPABASE_SERVICE_ROLE_KEY/g,
    message: `SUPABASE_SERVICE_ROLE_KEY is read outside ${ENV_MODULE}. It bypasses row level security entirely — import serviceRoleKey() from '@/lib/env' instead of reading the variable again.`,
  },
  {
    id: 'service-role-key-exposed-to-browser',
    // NEXT_PUBLIC_ is inlined into the client bundle at build time. Applying
    // that prefix to the service role key would publish it to every visitor.
    appliesTo: () => true,
    pattern: /NEXT_PUBLIC_[A-Z0-9_]*SERVICE_ROLE/g,
    message:
      'A service role key must never carry the NEXT_PUBLIC_ prefix — Next.js would inline it into the browser bundle.',
  },
]

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

const violations = []

// ── Rule 4: no .env file may be tracked by git ──────────────────────────────
// Checked against the index, not the working tree: an untracked .env.local on
// a developer's machine is normal and correct.
for (const file of git(['ls-files', '--cached'])) {
  const name = file.split('/').pop()
  if (name.startsWith('.env') && file !== ENV_TEMPLATE) {
    violations.push({
      file,
      line: 0,
      id: 'committed-env-file',
      message: `${file} is tracked by git. Only ${ENV_TEMPLATE} may be committed; remove it from the index and add real values to the secret store.`,
    })
  }
}

// ── Rules 1-3: content scan over tracked and new-but-not-ignored files ──────
const files = git([
  'ls-files',
  '--cached',
  '--others',
  '--exclude-standard',
]).filter((f) => !SKIP.some((re) => re.test(f)))

for (const file of files) {
  let text
  try {
    if (statSync(file).size > 2_000_000) continue
    text = readFileSync(file, 'utf8')
  } catch {
    continue // deleted between listing and reading, or unreadable
  }

  if (text.includes(String.fromCharCode(0))) continue // binary

  for (const rule of rules) {
    if (!rule.appliesTo(file)) continue
    rule.pattern.lastIndex = 0
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      rule.pattern.lastIndex = 0
      if (rule.pattern.test(line)) {
        violations.push({
          file,
          line: index + 1,
          id: rule.id,
          message: rule.message,
        })
      }
    })
  }
}

if (violations.length === 0) {
  console.log(
    `security:check — ${files.length} files scanned, no violations found.`,
  )
  process.exit(0)
}

console.error(`\nsecurity:check FAILED — ${violations.length} violation(s):\n`)
for (const v of violations) {
  const where = v.line ? `${v.file}:${v.line}` : v.file
  console.error(`  [${v.id}] ${where}`)
  console.error(`      ${v.message}\n`)
}
process.exit(1)
