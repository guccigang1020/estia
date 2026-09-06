/**
 * EXECUTION CONTEXT — ROUTE HANDLER, SERVER ONLY, AND PRIVILEGED. The sweep
 * that finally drains the two deferral queues.
 *
 * ══ WHAT WAS OPEN, AND WHAT THIS CLOSES ═════════════════════════════════════
 *
 * `notifications/release.ts` and `messaging/release.ts` are correct, tested,
 * and — until this file existed — dead code. Nothing called them. A business
 * that switched quiet hours on to avoid being paged at midnight did not get
 * its alerts an hour late; it stopped getting them at all. A guesthouse that
 * held its arrival instructions until seven never sent them, and nothing said
 * so. The defect was closed in the domain and open in production, which is a
 * distinction only the code can see and no customer can.
 *
 * This handler is the caller. It decides nothing: it authorises, bounds the
 * work, picks the tenants, hands each one to the release runners, and reports
 * numbers.
 *
 * ══ IT RUNS WITH NO USER, WHICH SETS EVERY OTHER RULE HERE ══════════════════
 *
 * There is nobody signed in at 07:00. `notification_deliveries`'s update
 * policy asks for `organization.settings.edit` and `guest_messages`'s asks for
 * `message.send`, and a sweep holds neither, so the session client cannot do
 * this work at all. It therefore uses the ADMIN client, which
 * `persistence/client.ts` sanctions in exactly these words — "correct only
 * where there is genuinely no user to act as: a payment provider's webhook, a
 * nightly sweep" — and warns about in the same breath.
 *
 * Three consequences follow, and all three are load-bearing:
 *
 *   1. **`organization_id` is the only tenant boundary.** Row level security
 *      is bypassed completely. Every query in `release-store.ts`,
 *      `release-store.ts` on the messaging side, and `guests.ts` filters the
 *      organization explicitly, and this handler passes one to every call it
 *      makes. There is no query in this feature that runs without it.
 *   2. **The tenants are iterated, never swept globally.** Even the query that
 *      works out which tenants have due work reads one column,
 *      `organization_id`, and is immediately turned into a list of per-tenant
 *      passes. A global `update … where scheduled_for <= now()` would be
 *      shorter, faster, and one typo away from settling every customer's
 *      queue against one customer's quiet hours.
 *   3. **The privileged module is not even imported until the caller has been
 *      authorised.** `createAdminClient` is loaded with a dynamic import
 *      inside the handler, after the guard. A refused request never
 *      constructs a service-role client, and — because `@/lib/env` validates
 *      at module load — a deployment that has not configured Supabase still
 *      answers 401 rather than crashing with a stack trace.
 *
 * ══ THE GUARD ══════════════════════════════════════════════════════════════
 *
 * An unauthenticated endpoint that sends messages on a customer's behalf is
 * the worst thing this repository could leave open, so:
 *
 *   · `SWEEP_RELEASE_SECRET` must be set. **If it is unset the handler refuses
 *     every request** — 503, no work, no fallback to open. The alternative,
 *     "unguarded when unconfigured", is the exact shape of the mistake where a
 *     staging default reaches production and nobody notices until a stranger
 *     is draining a tenant's queue.
 *   · The caller presents it as `Authorization: Bearer …`. A header and not a
 *     query parameter: query strings reach access logs, browser history and
 *     `Referer`, and a secret that sends messages must not be in any of them.
 *   · The comparison is constant time. Both sides are hashed to a 32-byte
 *     digest and compared with `timingSafeEqual`, which also removes the
 *     length check that would otherwise leak the secret's length and would
 *     throw on a mismatch.
 *   · A wrong secret and a missing one answer 401 identically, and the body
 *     names neither.
 *
 * `src/lib/env.ts` is the one module that reads configuration, and it is not
 * writable by this session — so the variable is read here, once, in one
 * function, and adding it to `env.ts` is the first request in the module
 * report. It is deliberately not `NEXT_PUBLIC_`: that prefix would inline the
 * sweep secret into every visitor's browser bundle.
 *
 * ══ BOUNDED, AND RESUMABLE ═════════════════════════════════════════════════
 *
 * Each tenant's pass takes at most `limit` rows, oldest first, and every
 * summary reports `scanned`. A caller that sees `more: true` — some pass came
 * back full — should call again IMMEDIATELY rather than wait for the next
 * tick, which is what stops a backlog from taking a day per hour of it to
 * clear. An unbounded sweep would instead hold the table while not finishing.
 *
 * ══ THE ANSWER IS NUMBERS ═══════════════════════════════════════════════════
 *
 * The body carries counts, statuses and organization ids. It never carries a
 * message body, a subject, a guest's name, a telephone number or an e-mail
 * address — and it never will, because the release summaries have no field
 * that could hold one. A failing tenant reports the database's own error code
 * and never the message: an error string is the one place a row's contents can
 * escape into a response.
 *
 * English, deliberately, in a codebase whose rule is Hebrew for anything a
 * person reads. Nobody reads this: the only caller is a scheduler and the only
 * reader is its log, the same argument `guest_messages.outcome_detail` makes
 * about diagnostics. There is no Hebrew surface behind this route.
 *
 * ══ POST, NOT GET ══════════════════════════════════════════════════════════
 *
 * This sends messages. A GET that sends is prefetchable, cacheable, and
 * link-shaped — it would eventually be triggered by a crawler, a proxy warmer
 * or somebody pasting a URL that carries a secret. Schedulers that can only
 * issue GET need a one-line wrapper; the deployment notes in the module report
 * say so.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

import {
  defaultMessageProviderRegistry,
  releaseDueMessages,
  type GuestMessageReleaseSummary,
} from '@/lib/messaging'
import { SupabaseGuestMessageReleaseStore } from '@/lib/messaging/release-store'
import {
  defaultTransportRegistry,
  PreferenceSet,
  releaseDueDeliveries,
  settingsOrDefaults,
  type DeliveryReleaseSummary,
} from '@/lib/notifications'
import { SupabaseDeliveryReleaseStore } from '@/lib/notifications/release-store'
import { SupabaseNotificationRepository } from '@/lib/notifications/repository'
import { isMissingSchema } from '@/lib/messaging/repository'
import { asString, toRows, type Db } from '@/lib/persistence'

import { SweepGuestSource } from './guests'

/** A sweep reads and writes rows that changed a second ago. Never cached. */
export const dynamic = 'force-dynamic'

/** `node:crypto`, the Supabase admin client and PostgREST. Not the edge. */
export const runtime = 'nodejs'

/* ----------------------------------------------------------------- bounds -- */

/**
 * How many rows one tenant's pass may take, per queue.
 *
 * A hundred is small enough that a pass finishes inside any scheduler's
 * timeout with a hundred tenants behind it, and large enough that the ordinary
 * morning — a handful of deferrals per business — clears in one call. A caller
 * with a backlog raises it, or reads `more` and calls again.
 */
const DEFAULT_LIMIT = 100

/**
 * The ceiling a caller cannot argue past.
 *
 * `limit` arrives in a query string, and an unbounded one would let whoever
 * holds the secret ask for a single pass that never returns — a denial of
 * service written as a URL.
 */
const MAX_LIMIT = 500

/**
 * How late is too late, when the caller does not say.
 *
 * Neither release module defaults this, deliberately: a default there would be
 * a domain module deciding on behalf of a business it knows nothing about. The
 * decision belongs to the caller, and this handler is the caller, so it makes
 * it here in the open.
 *
 * Twelve hours. A quiet-hours deferral is at most one night — 23:40 held until
 * 07:00 is seven — so twelve absorbs a missed tick, a scheduler outage over
 * breakfast, and a deploy, and still sends. Past twelve the message is a
 * payment reminder arriving after the guest has checked out, or an alert about
 * a stay that ended, and `release.ts` abandons it with a stated reason rather
 * than sending it. Both halves of that are better than the silence this
 * feature exists to end.
 */
const DEFAULT_STALE_AFTER_MINUTES = 12 * 60

/* ------------------------------------------------------------------ guard -- */

/** The one variable this route reads. See the header. */
const SECRET_VARIABLE = 'SWEEP_RELEASE_SECRET'

/**
 * Equal, without saying how far it got.
 *
 * Hashing first is what makes this total: `timingSafeEqual` throws when the
 * two buffers differ in length, so comparing raw secrets would need a length
 * check that both leaks the length and reintroduces an early exit. Two SHA-256
 * digests are always 32 bytes, so the comparison is the same work every time.
 */
function sameSecret(presented: string, expected: string): boolean {
  const left = createHash('sha256').update(presented, 'utf8').digest()
  const right = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(left, right)
}

/** The token from `Authorization: Bearer …`, or `null`. */
function bearerToken(header: string | null): string | null {
  if (header === null) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match === null ? null : match[1].trim()
}

/**
 * Why this request may not run the sweep, or `null` when it may.
 *
 * Exported so the tests can hold the guard to its two promises without a
 * database, a Supabase project or a live secret anywhere near them.
 *
 * The configuration check comes FIRST and on purpose: an unconfigured
 * deployment must not be able to reach the comparison at all, because a
 * comparison against `undefined` is precisely where a "well, allow it then"
 * gets added one day by somebody debugging a 401.
 */
export function refuseSweep(
  request: Request,
  secret: string | undefined,
): Response | null {
  if (secret === undefined || secret.trim() === '') {
    return json(
      {
        ok: false,
        error: 'sweep_not_configured',
        detail:
          `${SECRET_VARIABLE} is not set, so this deployment cannot ` +
          'authorise a release sweep. It refuses to run rather than run open.',
      },
      503,
    )
  }

  const presented = bearerToken(request.headers.get('authorization'))

  // One answer for "no credential" and "wrong credential". Distinguishing them
  // tells a stranger whether the header shape was right, which is the first
  // thing they would want to know.
  if (presented === null || !sameSecret(presented, secret)) {
    return json({ ok: false, error: 'unauthorized' }, 401)
  }

  return null
}

/* ---------------------------------------------------------------- options -- */

export interface SweepOptions {
  limit: number
  staleAfterMinutes: number
  /** One tenant instead of every tenant with due work. `null` means all. */
  organizationId: string | null
}

/**
 * What the caller asked for, clamped to what this route will do.
 *
 * Every value is clamped rather than rejected. A scheduler is a piece of
 * configuration somebody edits once a year, and a sweep that refuses the whole
 * pass over a mistyped `limit` is a sweep that silently stops running — which
 * is the failure this entire feature exists to end. A nonsense value therefore
 * becomes the default, and the response says what was actually used.
 */
export function parseSweepOptions(url: URL): SweepOptions {
  const limit = positiveInteger(url.searchParams.get('limit'), DEFAULT_LIMIT)
  const stale = positiveInteger(
    url.searchParams.get('staleAfterMinutes'),
    DEFAULT_STALE_AFTER_MINUTES,
  )

  return {
    limit: Math.min(limit, MAX_LIMIT),
    staleAfterMinutes: stale,
    organizationId: url.searchParams.get('organizationId'),
  }
}

function positiveInteger(raw: string | null, fallback: number): number {
  if (raw === null) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/* ---------------------------------------------------------------- reports -- */

export type OrganizationReport =
  | {
      organizationId: string
      status: 'swept'
      deliveries: DeliveryReleaseSummary
      messages: GuestMessageReleaseSummary
    }
  | {
      organizationId: string
      status: 'failed'
      /** PostgREST's own code, when it gave one. Never a message. */
      errorCode: string | null
    }

/* ------------------------------------------------------------------ tenants */

/**
 * Which tenants have work, learned from the work itself.
 *
 * The alternative — list every organization and sweep each — asks the database
 * about hundreds of businesses that have nothing due, and grows with the
 * customer base rather than with the backlog. This reads one column from the
 * two queues, through the same partial indexes the sweep itself uses, and the
 * tenants come back in the order their oldest row is due. So a deployment with
 * more due work than one pass can take serves the tenant that has waited
 * longest first, rather than whichever was created first.
 *
 * It is the one cross-tenant read in the feature, it reads a uuid and nothing
 * else, and everything downstream of it is per organization.
 */
type Provisioning = 'ready' | 'not_provisioned'

async function tenantsWithDueWork(
  db: Db,
  dueBefore: Date,
  limit: number,
): Promise<{ organizationIds: string[]; guestMessages: Provisioning }> {
  const ids: string[] = []

  const deliveries = await db
    .from('notification_deliveries')
    .select('organization_id')
    .eq('status', 'deferred')
    .lte('scheduled_for', dueBefore.toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(limit)

  if (deliveries.error) throw deliveries.error
  for (const row of toRows(deliveries.data)) {
    ids.push(asString(row, 'organization_id'))
  }

  const messages = await db
    .from('guest_messages')
    .select('organization_id')
    .eq('outcome', 'deferred')
    .lte('scheduled_for', dueBefore.toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(limit)

  // 0053 may not have been applied. That is a state of the deployment and not
  // a failure of the sweep: the delivery half still runs, and the report says
  // which half did not.
  if (messages.error && !isMissingSchema(messages.error)) throw messages.error

  if (!messages.error) {
    for (const row of toRows(messages.data)) {
      ids.push(asString(row, 'organization_id'))
    }
  }

  return {
    organizationIds: [...new Set(ids)],
    guestMessages: messages.error ? 'not_provisioned' : 'ready',
  }
}

/* ------------------------------------------------------------------- sweep -- */

/**
 * One tenant, both queues, in that order.
 *
 * Sequential rather than concurrent, and the runners underneath are sequential
 * too, for the reason both release files state: a `Promise.all` here would
 * open one transport connection per held message at 07:00 sharp, which is the
 * shape of load that gets an account rate-limited on the morning it finally
 * starts working.
 *
 * The settings and the preferences are read fresh, per tenant, and handed in.
 * Neither release module reads its own configuration, and that is what makes a
 * business that widened its quiet hours at midnight get the widened window at
 * dawn rather than the one that was in force when the row was written.
 */
async function sweepOrganization(args: {
  db: Db
  organizationId: string
  now: Date
  options: SweepOptions
}): Promise<OrganizationReport> {
  const { db, organizationId, now, options } = args

  const repository = new SupabaseNotificationRepository(db)
  const settings = settingsOrDefaults(
    organizationId,
    await repository.loadSettings(organizationId),
  )

  const deliveries = await releaseDueDeliveries({
    organizationId,
    store: new SupabaseDeliveryReleaseStore(db),
    transports: defaultTransportRegistry(),
    settings,
    // Resolved per recipient by the runner, which asks once per distinct
    // person rather than once per row. An empty list is the right answer for
    // somebody who has never expressed an opinion — `PreferenceSet` builds the
    // organization's own defaults from the settings it is given.
    loadPreferences: async (userId) =>
      new PreferenceSet(
        await repository.listPreferences(organizationId, userId),
        settings,
      ),
    now,
    limit: options.limit,
    staleAfterMinutes: options.staleAfterMinutes,
  })

  const messages = await releaseDueMessages({
    organizationId,
    store: new SupabaseGuestMessageReleaseStore(db),
    // Nothing is connected in any deployment today, so a released guest
    // message records `not_configured` and no delivery is invented. That is
    // still the point: the row leaves `deferred`, the business can see what it
    // is not sending, and the queue stops growing in silence.
    providers: defaultMessageProviderRegistry(),
    guests: new SweepGuestSource(db),
    settings,
    now,
    limit: options.limit,
    staleAfterMinutes: options.staleAfterMinutes,
  })

  return { organizationId, status: 'swept', deliveries, messages }
}

/* ----------------------------------------------------------------- handler -- */

export async function POST(request: Request): Promise<Response> {
  const refusal = refuseSweep(request, process.env[SECRET_VARIABLE])
  if (refusal) return refusal

  const options = parseSweepOptions(new URL(request.url))

  // After the guard, never before. See the header: a refused request must not
  // construct a service-role client, and must not need one to exist.
  const { createAdminClient } = await import('@/lib/supabase/admin')
  const db: Db = createAdminClient()

  const now = new Date()

  let tenants: { organizationIds: string[]; guestMessages: Provisioning }
  try {
    tenants =
      options.organizationId === null
        ? await tenantsWithDueWork(db, now, options.limit)
        : { organizationIds: [options.organizationId], guestMessages: 'ready' }
  } catch (cause) {
    console.error('[sweep/release] could not list tenants with due work', cause)
    return json({ ok: false, error: 'sweep_failed' }, 500)
  }

  const organizations: OrganizationReport[] = []

  for (const organizationId of tenants.organizationIds) {
    try {
      organizations.push(
        await sweepOrganization({ db, organizationId, now, options }),
      )
    } catch (cause) {
      // One tenant's broken row must not abandon every tenant behind it in the
      // list — the same argument `release.ts` makes about a transport that
      // throws. The failure is reported per organization and the pass carries
      // on; the rows stay `deferred` and the next call tries again.
      console.error(`[sweep/release] ${organizationId} failed`, cause)
      organizations.push({
        organizationId,
        status: 'failed',
        errorCode: errorCodeOf(cause),
      })
    }
  }

  return json(
    {
      ok: true,
      ranAt: now.toISOString(),
      limit: options.limit,
      staleAfterMinutes: options.staleAfterMinutes,
      guestMessages: tenants.guestMessages,
      organizations,
      totals: totalsOf(organizations),
      // `scanned === limit` anywhere means the queue was longer than one pass.
      // The caller should come straight back rather than wait for the tick.
      more: organizations.some(
        (report) =>
          report.status === 'swept' &&
          (report.deliveries.scanned >= options.limit ||
            report.messages.scanned >= options.limit),
      ),
    },
    200,
  )
}

/* ------------------------------------------------------------------ output -- */

function totalsOf(organizations: readonly OrganizationReport[]) {
  const totals = {
    organizations: organizations.length,
    failed: 0,
    scanned: 0,
    released: 0,
    lost: 0,
    left: 0,
    unsettled: 0,
  }

  for (const report of organizations) {
    if (report.status === 'failed') {
      totals.failed += 1
      continue
    }
    for (const summary of [report.deliveries, report.messages]) {
      totals.scanned += summary.scanned
      totals.released += summary.released
      totals.lost += summary.lost
      totals.left += summary.left
      totals.unsettled += summary.unsettled
    }
  }

  return totals
}

/**
 * The database's own code, and never the message.
 *
 * A PostgREST error message can quote the value that offended a constraint,
 * and a value from `guest_messages` is a Hebrew message body. The code —
 * `42501`, `23514`, `PGRST205` — says what happened and quotes nothing.
 */
function errorCodeOf(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null) return null
  const code = (cause as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Nothing about a sweep may be kept by a proxy: the response reports
      // work that has already happened and will never be true twice.
      'cache-control': 'no-store',
    },
  })
}

/**
 * The same handler, reachable by GET, because a scheduler is not a browser.
 *
 * ══ WHY A GET THAT HAS EFFECTS IS THE RIGHT CALL HERE ═══════════════════════
 *
 * It is normally the wrong one. A GET is supposed to be safe, and a link
 * preview, a crawler or a prefetch can follow one without a human deciding to.
 *
 * Two facts make this the exception. Vercel Cron issues GET and only GET —
 * there is no configuration that makes it POST — so a scheduler-shaped
 * deployment has no other door. And `refuseSweep` runs first on both verbs:
 * without `Authorization: Bearer <SWEEP_RELEASE_SECRET>` nothing executes, so
 * the crawler that follows this URL gets a 401 and the sweep does not run.
 * The safety a GET is supposed to have is provided by the guard rather than
 * by the verb.
 *
 * ══ THE SECRET AND `CRON_SECRET` MUST BE THE SAME VALUE ═════════════════════
 *
 * Vercel sends `Authorization: Bearer ${CRON_SECRET}` and nothing else, and
 * this route reads `SWEEP_RELEASE_SECRET`. Set both environment variables to
 * one value. `docs/DEPLOYMENT.md` says so where an operator will look for it;
 * this comment says so where somebody debugging a 401 will.
 */
export const GET = POST
