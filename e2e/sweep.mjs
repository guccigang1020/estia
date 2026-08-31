/**
 * The route × persona sweep.
 *
 * Walks every route discovered under `src/app/(app)` as each of the eight
 * personas, classifies the response from its body, and writes the whole matrix
 * to `e2e/results/matrix.json` for the checks that come after it.
 *
 *   node e2e/sweep.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { PERSONAS, visitTwice } from './lib/http.mjs'
import { discoverRoutes, resolveDynamic } from './lib/routes.mjs'
import { classify } from './lib/classify.mjs'

const ROOT = process.cwd()
const OUT = join(ROOT, 'e2e', 'results')
const PLAN = process.env.ESTIA_PLAN ?? 'pro'

const routes = await discoverRoutes(ROOT)
const { resolved, unresolved } = await resolveDynamic(routes)
if (unresolved.length) {
  console.error('could not resolve dynamic routes:', unresolved)
}

const rows = []
for (const { route, url } of resolved) {
  for (const persona of PERSONAS) {
    // `visitTwice` re-requests anything 5xx after a pause: the demo is a dev
    // server serving a tree two other agents are writing into, and a request
    // caught mid-recompile fails for reasons that are not the product's.
    const response = await visitTwice(url, { persona, plan: PLAN })
    const result = classify(response)
    rows.push({
      route,
      url,
      persona,
      plan: PLAN,
      verdict: result.verdict,
      why: result.why,
      denied: result.denied ?? null,
      reason: result.reason ?? null,
      status: response.status,
      rechecked: response.rechecked ?? false,
      firstStatus: response.firstStatus ?? null,
      textLength: result.evidence.text.length,
    })
    process.stdout.write(`${result.verdict === 'OK' ? '.' : result.verdict[0]}`)
  }
}
process.stdout.write('\n')

await mkdir(OUT, { recursive: true })
await writeFile(join(OUT, `matrix-${PLAN}.json`), JSON.stringify(rows, null, 1))

const counts = {}
for (const row of rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1
console.log(`\nplan=${PLAN}  ${rows.length} route/persona pairs`)
console.log(counts)

const exceptions = rows.filter(
  (r) => r.verdict === 'BROKEN' || r.verdict === 'ABSENT',
)
for (const e of exceptions) {
  console.log(
    `  ${e.verdict}  ${e.persona.padEnd(17)} ${e.route}  — ${e.why}` +
      (e.rechecked ? ` (rechecked, first ${e.firstStatus})` : ''),
  )
}
