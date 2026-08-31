/**
 * Every link the product renders *inside a page*, followed as that persona.
 *
 * `dead-links.mjs` only asks about the sidebar. But most of the doors in this
 * product are not in the sidebar — they are cards on the dashboard, row links
 * on a list, "add one" buttons on an empty state. Those are offered by the
 * screen a persona is already standing on, and each one is the same promise
 * the menu makes: click this and you arrive.
 *
 * So: for each persona, take every route that rendered, strip the shared
 * chrome (sidebar nav, top bar, persona switcher — those are not the page's
 * claim), collect the internal links that remain, and follow them.
 *
 *   node e2e/crawl-links.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { PERSONAS, visit } from './lib/http.mjs'
import { classify } from './lib/classify.mjs'

const PLAN = process.env.ESTIA_PLAN ?? 'pro'
const RESULTS = join(process.cwd(), 'e2e', 'results')
const matrix = JSON.parse(
  await readFile(join(RESULTS, `matrix-${PLAN}.json`), 'utf8'),
)

const NAV_MARK = 'aria-label="ניווט ראשי"'

/**
 * The document with the shared chrome removed.
 *
 * The nav regions repeat on every screen; counting their links per-page would
 * report the same finding fifty times and bury the one that belongs to a page.
 */
function pageRegion(html) {
  let out = html
  for (;;) {
    const start = out.indexOf(NAV_MARK)
    if (start === -1) break
    const open = out.lastIndexOf('<nav', start)
    const end = out.indexOf('</nav>', start)
    if (open === -1 || end === -1) break
    out = out.slice(0, open) + out.slice(end + 6)
  }
  return out
}

function internalLinks(html) {
  return [
    ...new Set(
      [...pageRegion(html).matchAll(/href="(\/[^"#]*)"/g)].map((m) =>
        m[1].replace(/&amp;/g, '&'),
      ),
    ),
  ].filter(
    (h) =>
      !h.startsWith('/_next') &&
      !h.startsWith('/api') &&
      !h.startsWith('/favicon') &&
      h !== '/',
  )
}

const findings = []
const perPersona = []

for (const persona of PERSONAS) {
  const reachable = matrix.filter(
    (r) =>
      r.persona === persona &&
      (r.verdict === 'OK' || r.verdict === 'EMPTY_HONEST'),
  )

  // link -> the pages that offered it
  const offers = new Map()
  for (const row of reachable) {
    const page = await visit(row.url, { persona, plan: PLAN })
    for (const href of internalLinks(page.body)) {
      if (!offers.has(href)) offers.set(href, [])
      offers.get(href).push(row.route)
    }
  }

  const dead = []
  const cache = new Map()
  for (const [href, sources] of offers) {
    const bare = href.split('?')[0]
    const known = matrix.find((r) => r.persona === persona && r.url === bare)
    let verdict = known?.verdict
    let why = known?.why
    let denied = known?.denied ?? null

    if (!known) {
      if (!cache.has(href)) {
        cache.set(href, classify(await visit(href, { persona, plan: PLAN })))
      }
      const result = cache.get(href)
      verdict = result.verdict
      why = result.why
      denied = result.denied ?? null
    }

    if (verdict === 'REFUSED' || verdict === 'BROKEN' || verdict === 'ABSENT') {
      dead.push({ href, verdict, why, denied, offeredBy: sources })
    }
  }

  perPersona.push({
    persona,
    pages: reachable.length,
    links: offers.size,
    dead: dead.length,
  })
  if (dead.length) findings.push({ persona, dead })
  process.stdout.write(`${persona} `)
}

process.stdout.write('\n')
console.log(`plan=${PLAN}`)
console.table(perPersona)
await mkdir(RESULTS, { recursive: true })
await writeFile(
  join(RESULTS, `in-page-dead-links-${PLAN}.json`),
  JSON.stringify(findings, null, 1),
)
console.log(JSON.stringify(findings, null, 1))
