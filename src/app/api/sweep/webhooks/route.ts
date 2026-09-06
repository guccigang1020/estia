/**
 * EXECUTION CONTEXT — ROUTE HANDLER, SERVER ONLY, AND PRIVILEGED. The sweep
 * that actually sends the queued webhooks.
 *
 * ══ WHAT WAS OPEN, AND WHAT THIS CLOSES ═════════════════════════════════════
 *
 * `src/lib/webhooks` decides everything and sends nothing. Rows arrive in
 * `webhook_deliveries` — `enqueue_webhook_deliveries` puts them there the
 * moment a subscribed event happens — and until this file existed they sat in
 * `pending` forever. A customer would configure an endpoint, see it accepted,
 * and receive nothing, with no error anywhere to explain it.
 *
 * That is the same shape as the release sweep this route is modelled on: a
 * correct, tested domain with nobody to call it. It is worth naming twice
 * because it has now happened three times in this repository.
 *
 * ══ IT LIVES UNDER /api/sweep, AND THAT IS NOT COSMETIC ════════════════════
 *
 * `PUBLIC_PREFIXES` in `src/lib/supabase/proxy.ts` lists `/api/sweep` and
 * deliberately not `/api` — its own comment says so, and says why: a route
 * called on a schedule has no session, so a redirect to /sign-in means the
 * endpoint never executes.
 *
 * This route first sat at `/api/webhooks/deliver`, which is not under that
 * prefix, and would therefore have been redirected for exactly that reason.
 * Moving here reuses an exemption that already exists and was already argued
 * for, rather than widening the list of paths a signed-out visitor may
 * reach — a change that should stay rare. It is also simply true: this is a
 * sweep, with the same guard, the same secret and the same scheduler.
 *
 * NOT VERIFIED against a running server. The attempt to do so started a dev
 * server for a different project in this workspace entirely, so the 404 it
 * produced proved nothing about either path. The claim above rests on
 * reading `PUBLIC_PREFIXES`, which is worth stating plainly rather than
 * leaving a reader to assume somebody watched it work.
 *
 * ══ THE GUARD IS THE RELEASE SWEEP'S, DELIBERATELY ══════════════════════════
 *
 * `refuseSweep` is imported rather than reimplemented, and the same
 * `SWEEP_RELEASE_SECRET` authorises both. Two sweeps with two hand-written
 * guards is how one of them ends up with the weaker check — and the one that
 * drifts is always the newer one, because the older one is the one people
 * remember to audit. One credential for the deployment's schedulers is also
 * one thing to rotate.
 *
 * Its refusals carry over exactly: **unset means refuse**, 503 and no work,
 * never "unguarded when unconfigured". An endpoint that POSTs a customer's
 * booking data to arbitrary URLs is not a thing to leave open because an
 * environment variable was forgotten.
 *
 * ══ IT RUNS WITH NO USER, SO THE TENANT BOUNDARY IS EXPLICIT ════════════════
 *
 * There is nobody signed in when the scheduler fires. The admin client is
 * therefore used — the sanctioned case `persistence/client.ts` names — and row
 * level security is bypassed for every query it makes. `WebhookSenderStore` is
 * the only reader of `webhook_endpoint_secrets` in the codebase for that
 * reason, and `runner.ts` iterates tenants one at a time with an explicit
 * `organization_id` rather than sweeping globally. Signing one customer's
 * event with another customer's secret is the failure that shape prevents.
 *
 * The privileged module is imported dynamically, after the guard. A refused
 * request never constructs a service-role client.
 */

import { refuseSweep } from '@/app/api/sweep/release/route'
import { runWebhookSweep } from '@/lib/webhooks/runner'
import { nodeWebhookTransport } from '@/lib/webhooks/transport'
import { WebhookSenderStore } from '@/lib/webhooks/repository'
import type { Db } from '@/lib/persistence'

/** A sweep reads and writes rows that changed a second ago. Never cached. */
export const dynamic = 'force-dynamic'

/** `node:dns`, `node:crypto`, the admin client. Not the edge. */
export const runtime = 'nodejs'

/**
 * How many deliveries one tenant may take in a single pass.
 *
 * Fifty. A pass sends them one at a time and each may take up to ten seconds,
 * so this is also the worst case for how long one tenant can hold the sweep:
 * the bound exists so a customer with a backlog cannot starve everybody else,
 * and the next call picks up exactly where this one stopped.
 */
const DEFAULT_PER_TENANT = 50

/** A caller cannot argue past this. `perTenant` arrives in a query string, and
 *  an unbounded one is a denial of service written as a URL. */
const MAX_PER_TENANT = 200

const SECRET_VARIABLE = 'SWEEP_RELEASE_SECRET'

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function perTenantFrom(url: URL): number {
  const raw = url.searchParams.get('perTenant')
  if (raw === null) return DEFAULT_PER_TENANT
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PER_TENANT
  return Math.min(parsed, MAX_PER_TENANT)
}

export async function POST(request: Request): Promise<Response> {
  const refusal = refuseSweep(request, process.env[SECRET_VARIABLE])
  if (refusal) return refusal

  const perTenant = perTenantFrom(new URL(request.url))

  // After the guard, never before.
  const { createAdminClient } = await import('@/lib/supabase/admin')
  const db: Db = createAdminClient()

  try {
    const report = await runWebhookSweep(
      new WebhookSenderStore(db),
      nodeWebhookTransport(),
      new Date(),
      perTenant,
    )

    // `failedTenants` is in the body rather than only in a log. A sweep that
    // answers 200 while quietly failing for one customer every night is the
    // outage nobody opens a ticket about.
    return json({ ok: true, ...report }, 200)
  } catch (cause) {
    console.error('[webhooks/deliver] the sweep failed', cause)
    return json({ ok: false, error: 'sweep_failed' }, 500)
  }
}

/**
 * Reachable by GET for the scheduler, on exactly the argument made at the foot
 * of `/api/sweep/release/route.ts`: Vercel Cron issues GET and only GET, and
 * `refuseSweep` runs before anything else on both verbs, so an unauthenticated
 * GET executes nothing. `CRON_SECRET` and `SWEEP_RELEASE_SECRET` must hold the
 * same value.
 */
export const GET = POST
