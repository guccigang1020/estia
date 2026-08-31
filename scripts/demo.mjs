/**
 * `npm run demo` — the whole product, on rows that live in memory.
 *
 * ── Why this is a script and not one line in package.json ─────────────────
 *
 * All this does is set an environment variable and start the dev server, which
 * is `NEXT_PUBLIC_ESTIA_DEMO=1 next dev` on a Unix shell and is not that
 * anywhere else. npm runs scripts through `cmd.exe` on Windows, where the
 * inline form fails twice over: `VAR=value command` is not a thing cmd
 * understands, and `node -e "…"` loses its quoting on the way through and dies
 * with a message about NODE_OPTIONS that has nothing to do with the actual
 * problem. `cross-env` solves it and is a dependency and a lockfile change for
 * one line of shell. This is that line, in a file, and it behaves the same on
 * every machine.
 *
 * The port is deliberately not 3000: a demo is something you open *beside* the
 * real dev server, to compare a screen as an owner with the same screen as a
 * cleaner, and a demo that takes the port the ordinary `npm run dev` wants is a
 * demo that gets in the way of the work it is supposed to illustrate.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const PORT = '3200'

// A separate build directory, so this can run beside an ordinary `next dev`
// out of the same checkout. Without it Next refuses to start a second server,
// and the demo's whole point is to be opened next to the real one.
process.env.NEXT_DIST_DIR = '.next-demo'

// Set before Next is started, because `NEXT_PUBLIC_` variables are substituted
// into the bundle at compile time rather than read at runtime. `@next/env` does
// not overwrite a variable that is already set, so a `.env.local` cannot
// countermand this.
process.env.NEXT_PUBLIC_ESTIA_DEMO = '1'

const require = createRequire(import.meta.url)

console.log(
  `\nESTIA demo on http://localhost:${PORT}\n` +
    `  · the rows come from src/lib/demo/dataset.ts, in memory, and reset ` +
    `when this process does\n` +
    `  · the signed-in person comes from a cookie, so there is no sign-in\n` +
    `  · row level security is NOT enforced; can() is, and it is what the ` +
    `screens exercise\n`,
)

const child = spawn(
  process.execPath,
  [require.resolve('next/dist/bin/next'), 'dev', '--port', PORT],
  { stdio: 'inherit', env: process.env },
)

child.on('exit', (code, signal) => {
  // Pass the child's fate through, so Ctrl-C reads as Ctrl-C and a crash reads
  // as a crash rather than as a clean exit.
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
