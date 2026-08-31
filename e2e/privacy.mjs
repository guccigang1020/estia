/**
 * What a status code cannot see.
 *
 * The sweep proves a cleaner is *refused* thirty screens. It proves nothing
 * about the six screens a cleaner is *allowed*, and those are where a leak
 * would actually live: a task card that names the guest it is for, a unit row
 * that carries the nightly rate, a dashboard tile that totals the month.
 *
 * So this reads the rendered HTML of every screen a persona can reach and
 * greps it for values taken from the dataset itself — the actual guest names,
 * the actual shekel amounts. Absence is proved against the real strings rather
 * than asserted by reading the component.
 *
 *   node e2e/privacy.mjs
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { visit } from './lib/http.mjs'
import { visibleText } from './lib/classify.mjs'

const PLAN = process.env.ESTIA_PLAN ?? 'pro'
const RESULTS = join(process.cwd(), 'e2e', 'results')
const matrix = JSON.parse(
  await readFile(join(RESULTS, `matrix-${PLAN}.json`), 'utf8'),
)

/**
 * Guest names, read out of `dataset-bookings.ts` rather than retyped.
 *
 * A hand-copied list goes stale the moment the dataset gains a guest, and a
 * privacy proof that silently stops checking the newest row is worse than no
 * proof at all.
 */
async function guestNames() {
  const source = await readFile(
    join(process.cwd(), 'src', 'lib', 'demo', 'dataset-bookings.ts'),
    'utf8',
  )
  const block = source.slice(
    source.indexOf('const GUEST_SEEDS'),
    source.indexOf('const ALL_GUESTS'),
  )
  return [
    ...new Set([...block.matchAll(/^\s*name: '([^']+)'/gm)].map((m) => m[1])),
  ]
}

/** Money as the product renders it, plus the bare digit runs behind it. */
function moneyMentions(text) {
  return [
    ...new Set([
      ...[...text.matchAll(/₪\s?[\d,]+(?:\.\d+)?/g)].map((m) => m[0]),
      ...[...text.matchAll(/[\d,]+(?:\.\d+)?\s?₪/g)].map((m) => m[0]),
      ...[...text.matchAll(/[\d,]+(?:\.\d+)?\s?ש["״']ח/g)].map((m) => m[0]),
    ]),
  ]
}

const NAMES = await guestNames()

/** Personas whose contract forbids a class of value, and what it forbids. */
const CONTRACTS = [
  {
    persona: 'housekeeping',
    forbids: ['guest names', 'money'],
    why: 'משק בית — "לא רואה שם אורח, לא מחיר ולא כסף"',
  },
  {
    persona: 'sales-agent',
    forbids: ['guest names'],
    why: 'external seller — availability, own commissions, not the bookings behind them',
  },
]

const report = []

for (const contract of CONTRACTS) {
  const reachable = matrix.filter(
    (r) =>
      r.persona === contract.persona &&
      (r.verdict === 'OK' || r.verdict === 'EMPTY_HONEST'),
  )

  for (const row of reachable) {
    const page = await visit(row.url, { persona: contract.persona, plan: PLAN })
    // The demo banner names every persona and explains the dataset; it is
    // chrome, not the screen's own claim, and it is the same on all 49 pages.
    const text = visibleText(page.body)
    const body = text.slice(text.indexOf('דילוג לתוכן הראשי'))

    const leakedNames = contract.forbids.includes('guest names')
      ? NAMES.filter((n) => body.includes(n))
      : []
    const leakedMoney = contract.forbids.includes('money')
      ? moneyMentions(body)
      : []

    if (leakedNames.length || leakedMoney.length) {
      report.push({
        persona: contract.persona,
        route: row.route,
        url: row.url,
        leakedNames,
        leakedMoney: leakedMoney.slice(0, 12),
      })
    }
  }
}

console.log(`plan=${PLAN}  guest names checked: ${NAMES.length}`)
console.log(`pages with a leak: ${report.length}`)
for (const r of report) {
  console.log(
    `  ${r.persona}  ${r.route}\n    names: ${r.leakedNames.join(', ') || '—'}` +
      `\n    money: ${r.leakedMoney.join(', ') || '—'}`,
  )
}
await writeFile(
  join(RESULTS, `privacy-${PLAN}.json`),
  JSON.stringify({ names: NAMES, report }, null, 1),
)
