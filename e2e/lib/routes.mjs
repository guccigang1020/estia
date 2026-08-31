/**
 * The route list, discovered rather than assumed.
 *
 * Walks `src/app/(app)/**\/page.tsx` and turns each into a URL. Dynamic
 * segments are not guessed: the sweep asks the product for them by reading the
 * links an owner is actually offered on the list screen above, so a detail
 * route is exercised with an id the product itself produced.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { visit } from './http.mjs'

const APP = 'src/app/(app)'

async function pageFiles(dir, prefix = []) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(
        ...(await pageFiles(join(dir, entry.name), [...prefix, entry.name])),
      )
    } else if (entry.name === 'page.tsx') {
      found.push(prefix)
    }
  }
  return found
}

/** Route groups `(x)` and private folders `_x` are not URL segments. */
const isUrlSegment = (s) => !s.startsWith('(') && !s.startsWith('_')

export async function discoverRoutes(repoRoot) {
  const segments = await pageFiles(join(repoRoot, APP))
  return segments
    .map((parts) => '/' + parts.filter(isUrlSegment).join('/'))
    .sort()
}

/** Pull hrefs matching a prefix out of rendered HTML. */
export function hrefsUnder(html, prefix) {
  const re = new RegExp(`href="(${prefix}/[^"?#]+)"`, 'g')
  return [...new Set([...html.matchAll(re)].map((m) => m[1]))]
}

/**
 * Resolve `[param]` routes against ids the product itself linked to.
 *
 * Walked as `owner`, because the owner is the persona that sees every list; a
 * detail id gathered as a cleaner would only ever be an id a cleaner may see,
 * which is precisely the case the sweep must not restrict itself to.
 */
export async function resolveDynamic(routes) {
  const resolved = []
  const unresolved = []
  // `/guests/new` is a page in its own right and is linked from `/guests`,
  // so a naive href scrape hands the detail route a static sibling and the
  // sweep silently checks the wrong screen fifty times.
  const staticRoutes = new Set(routes.filter((r) => !r.includes('[')))

  for (const route of routes) {
    if (!route.includes('[')) {
      resolved.push({ route, url: route })
      continue
    }
    const listPath = route.slice(0, route.indexOf('/['))
    const page = await visit(listPath, { persona: 'owner' })
    const candidates = hrefsUnder(page.body, listPath).filter(
      (href) =>
        href.split('/').length === listPath.split('/').length + 1 &&
        !staticRoutes.has(href),
    )
    if (candidates.length === 0) {
      unresolved.push({ route, listPath, listStatus: page.status })
      continue
    }
    resolved.push({ route, url: candidates[0], sampledFrom: listPath })
  }

  return { resolved, unresolved }
}
