import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * Test configuration, stated explicitly.
 *
 * The suite is deliberately database-free: every test here is a pure unit test
 * over domain logic, so it runs in CI with no Supabase project, no secrets and
 * no network. Anything that genuinely needs a database belongs in a separate
 * integration project, not in this one.
 */
export default defineConfig({
  test: {
    // Domain logic only. Nothing here touches the DOM, so jsdom would be a
    // cost with no benefit.
    environment: 'node',

    include: ['src/**/*.test.ts'],

    exclude: ['node_modules/**', '.next/**', '_reference/**', 'coverage/**'],

    // A test that hangs should fail the gate, not stall it.
    testTimeout: 10_000,

    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: './coverage',

      // Measure the code we actually own and test. Config, type-only barrels
      // and the not-yet-tested UI layer would otherwise dilute the number
      // into something that means nothing.
      include: ['src/lib/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/lib/env.ts'],

      // Measured on 2026-08-27, not guessed. Whole tree at the time:
      // statements 86.21 / branches 87.09 / functions 86.76 / lines 86.96.
      //
      // Two instruments, because one global average would hide the thing that
      // matters. Every domain module is tested between 91% and 100%; the only
      // module at 0% is src/lib/supabase, the adapter layer that constructs
      // clients and talks to the database — which this deliberately
      // database-free suite cannot cover. A single global number would let a
      // well-tested module rot quietly while the average stayed respectable.
      //
      //   1. Per-module floors, set two to four points under what each module
      //      actually measures. These are the real gate: a regression in authz
      //      or errors fails the build on the commit that causes it.
      //
      //   2. A global floor a little under the current whole-tree number, to
      //      catch a collapse — a deleted suite, a broken collector.
      //
      // Ratchet upward only. Raise a floor as tests land, and add an entry
      // when a new module matures. Never lower one to turn a red build green:
      // a threshold failure means tests were lost, which is the one thing
      // these numbers exist to report.
      //
      // Deliberately absent: a floor for src/lib/supabase. Adding one at 0%
      // would formally bless leaving it untested. Its pure-logic parts —
      // auth-errors.ts in particular — should get unit tests and then a floor.
      thresholds: {
        statements: 78,
        branches: 78,
        functions: 78,
        lines: 78,

        'src/lib/actor/**': {
          statements: 93,
          branches: 85,
          functions: 95,
          lines: 93,
        },
        'src/lib/audit/**': {
          statements: 90,
          branches: 85,
          functions: 95,
          lines: 92,
        },
        'src/lib/authz/**': {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        'src/lib/errors/**': {
          statements: 97,
          branches: 94,
          functions: 97,
          lines: 97,
        },
        'src/lib/plans/**': {
          statements: 88,
          branches: 95,
          functions: 85,
          lines: 90,
        },
        'src/lib/service/**': {
          statements: 91,
          branches: 86,
          functions: 93,
          lines: 92,
        },
      },
    },
  },

  resolve: {
    // Mirrors the `@/*` path alias in tsconfig.json, so a test can import the
    // same way the application does.
    //
    // fileURLToPath, not URL.pathname: on Windows the latter yields
    // "/C:/Users/..." with a leading slash. Vite happens to normalise that
    // today, so this is correctness rather than a fix for a live bug — but
    // the raw pathname is not a filesystem path and should not be used as one.
    alias: {
      '@': fileURLToPath(new URL('./src/', import.meta.url)),
    },
  },
})
