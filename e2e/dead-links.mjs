/**
 * Does the menu offer anything the route then refuses?
 *
 * The menu is derived from `can()` and the route is guarded by `requireGrant`,
 * and those are two independent decisions over the same question. When they
 * disagree the product shows a person a door that closes in their face — the
 * defect class the brief says has already shipped three times.
 *
 * The menu is read from the rendered HTML rather than from `menu.ts`, because
 * what is on the screen is the claim being tested. Locked and planned items
 * render as inert spans with no `href`, so scraping anchors inside the nav
 * yields exactly the set the product invites a person to click.
 *
 *   node e2e/dead-links.mjs
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { PERSONAS, visit } from './lib/http.mjs'
import { classify } from './lib/classify.mjs'

const PLAN = process.env.ESTIA_PLAN ?? 'pro'
const matrix = JSON.parse(
  await readFile(
    join(process.cwd(), 'e2e', 'results', `matrix-${PLAN}.json`),
    'utf8',
  ),
)

const NAV_MARK = 'aria-label="ניווט ראשי"'

/** The main navigation region, and the links inside it. */
export function menuLinks(html) {
  const start = html.indexOf(NAV_MARK)
  if (start === -1) return null
  const end = html.indexOf('</nav>', start)
  const region = html.slice(start, end === -1 ? html.length : end)
  return [
    ...new Set([...region.matchAll(/href="(\/[^"?#]*)"/g)].map((m) => m[1])),
  ]
}

/** Inert items, with the note the product gives for each. */
export function inertItems(html) {
  const start = html.indexOf(NAV_MARK)
  if (start === -1) return []
  const end = html.indexOf('</nav>', start)
  const region = html.slice(start, end === -1 ? html.length : end)
  return [...region.matchAll(/<li[^>]*>((?:(?!<\/li>)[\s\S])*)<\/li>/g)]
    .map((m) => m[1])
    .filter((li) => !li.includes('href='))
    .map((li) =>
      li
        .replace(/<[^>]+>/g, '|')
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean)
        .join(' · '),
    )
}

const findings = []
const summary = []

for (const persona of PERSONAS) {
  const page = await visit('/dashboard', { persona, plan: PLAN })
  const links = menuLinks(page.body)
  if (links === null) {
    findings.push({
      persona,
      kind: 'NO_MENU',
      detail: '/dashboard rendered no main nav',
    })
    continue
  }

  const dead = []
  for (const href of links) {
    const known = matrix.find((r) => r.persona === persona && r.url === href)
    let verdict = known?.verdict
    let why = known?.why
    let denied = known?.denied

    if (!known) {
      const result = classify(await visit(href, { persona, plan: PLAN }))
      verdict = result.verdict
      why = result.why
      denied = result.denied ?? null
    }

    if (verdict === 'REFUSED' || verdict === 'BROKEN' || verdict === 'ABSENT') {
      dead.push({ href, verdict, why, denied })
    }
  }

  summary.push({
    persona,
    offered: links.length,
    inert: inertItems(page.body).length,
    dead: dead.length,
  })
  if (dead.length) findings.push({ persona, kind: 'DEAD_LINK', dead })
}

console.log(`plan=${PLAN}`)
console.table(summary)
console.log(JSON.stringify(findings, null, 1))
