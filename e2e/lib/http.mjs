/**
 * The one HTTP client the sweep uses.
 *
 * Everything here talks to the demo on :3200 with two cookies and never
 * follows a redirect automatically, because a redirect is the product's way of
 * refusing and swallowing it would turn a REFUSED into an OK that renders the
 * dashboard.
 */

export const BASE = process.env.ESTIA_DEMO_BASE ?? 'http://localhost:3200'

export const PERSONAS = [
  'owner',
  'administrator',
  'general-manager',
  'property-manager',
  'reception',
  'housekeeping',
  'accountant',
  'sales-agent',
]

export const PLANS = ['basic', 'direct', 'pro']

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One request. Never follows redirects; returns status, location and body.
 *
 * Retries on a *transport* failure, not on an HTTP status. The demo is a dev
 * server serving a working tree that other agents are writing into, and a
 * request in flight when Next recompiles dies as `ECONNRESET` — which is the
 * toolchain, not the product, and must not read as a finding.
 */
export async function visit(
  path,
  { persona, plan = 'pro', attempts = 4 } = {},
) {
  const cookie = [
    persona ? `estia.demo.persona=${persona}` : null,
    `estia.demo.plan=${plan}`,
  ]
    .filter(Boolean)
    .join('; ')

  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const started = Date.now()
    try {
      const response = await fetch(`${BASE}${path}`, {
        headers: { cookie, 'accept-language': 'he-IL,he;q=0.9' },
        redirect: 'manual',
      })
      const body = await response.text()
      return {
        path,
        persona,
        plan,
        status: response.status,
        location: response.headers.get('location'),
        body,
        ms: Date.now() - started,
        transportRetries: attempt - 1,
      }
    } catch (error) {
      lastError = error
      await sleep(1500 * attempt)
    }
  }
  throw new Error(`${path} as ${persona}: ${lastError?.message ?? 'unknown'}`, {
    cause: lastError,
  })
}

/** Retry a request that failed, to separate a real 5xx from a hot reload. */
export async function visitTwice(path, options) {
  const first = await visit(path, options)
  if (first.status < 500) return first
  await new Promise((resolve) => setTimeout(resolve, 4000))
  const second = await visit(path, options)
  second.firstStatus = first.status
  second.rechecked = true
  return second
}
