/**
 * EXECUTION CONTEXT — SERVER ONLY. Everything the home screen shows.
 *
 * ── Not one number is computed in this file ───────────────────────────────
 *
 * Every figure comes from somewhere that already owns it. Today's board is
 * `listStaysToday`; what today's guests still owe is `listOpenBalances`, which
 * subtracts a payment ledger from a booking total through the finance domain's
 * own `sumAgorot`; blocked and late work is `listStuckTasks`; the month's
 * occupancy, revenue, outstanding balance and booking pace are
 * `computeDashboard` over `SupabaseMetricSource`, refused metric by metric
 * against `METRICS[id].requires`. This module chooses *which* questions to ask
 * and hands back what came home. A dashboard that did its own arithmetic would
 * be a second definition of every number on it, and
 * `src/lib/metrics/types.ts` opens by explaining what that costs.
 *
 * ── Why this reuses the action centre's reads rather than replacing them ──
 *
 * `/action-center` answers "what needs a person today" as five lists of rows
 * somebody can open and work. The decision taken here — stated in
 * `page.tsx` and repeated because it is the one a reader will question — is
 * that the home screen *summarises* those questions and links into them, and
 * the action centre keeps the rows. So the same query functions are called
 * from both, and there is exactly one definition of "stuck work" in the
 * product. Writing a second set of queries for the home screen would have
 * produced two screens that disagree about the same morning.
 *
 * ── One failure does not blank the screen ─────────────────────────────────
 *
 * The six reads are settled independently. A tile whose read failed says so
 * and carries no figure; the rest of the screen stands. A home screen that
 * disappears because one table was briefly unreachable is worse than a home
 * screen with one tile explaining itself — and a tile that rendered a zero
 * because a query threw is worse than both, because a zero is a claim.
 *
 * ── Grants are asked before the query, not after ──────────────────────────
 *
 * Each read is skipped entirely when the reader does not hold what it needs.
 * That is not an optimisation: `createDemoClient` has no policy engine behind
 * its arrays — it says so in its own header — so a query issued and then
 * filtered is a query that hands the demo's cleaner rows she must never see.
 * The query modules below already refuse on their own; this is the second
 * floor, and row level security is the third.
 */

import {
  listOpenBalances,
  listPaymentsNeedingAttention,
  listStaysToday,
  listStuckTasks,
  listWaitingApprovals,
  outstandingTotalAgorot,
  propertyToday,
  type ActionCenterArgs,
  type DayStay,
  type StayRole,
} from '@/app/(app)/action-center/_lib/queries'
import {
  listPreparationTasks,
  type PreparationTask,
} from '@/app/(app)/preparation/_lib/queries'
import { monthContaining } from '@/app/(app)/reports/_lib/period'
import { loadReport } from '@/app/(app)/reports/_lib/queries'
import { HOME_METRIC_IDS } from '@/components/dashboard/tiles'
import { holdsGrant, type Actor } from '@/lib/authz/can'
import { addDays } from '@/lib/booking/dates'
import { toSafeResponse } from '@/lib/errors'
import {
  METRICS,
  type MetricId,
  type MetricResult,
  type MetricSource,
} from '@/lib/metrics'
import type { Db } from '@/lib/persistence'

/* --------------------------------------------------------------- shared -- */

/**
 * A read that either worked or did not, kept apart from its value.
 *
 * `null` inside `ok` is the query modules' own "you may not see this", and it
 * is deliberately not the same as `ok: false`. The screen prints them
 * differently: one is a permission, the other is an outage.
 */
export type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: ReturnType<typeof toSafeResponse>['error'] }

async function settle<T>(read: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read() }
  } catch (cause) {
    return {
      ok: false,
      error: toSafeResponse(cause, crypto.randomUUID()).error,
    }
  }
}

/* ---------------------------------------------------------------- shape -- */

/** How many stays fall into each of today's three jobs. */
export type TodayCounts = Record<StayRole, number>

export type HomeData = {
  /** The property-local day every figure on the screen is about. */
  today: string
  stays: Settled<TodayCounts>
  /** `null` when the reader may not see what anybody owes. */
  balances: Settled<{ count: number; totalAgorot: number } | null>
  /** `null` when the reader may not see tasks. */
  stuckTasks: Settled<number | null>
  /** `null` when the reader may not see payments. */
  stalledPayments: Settled<number | null>
  /** `null` when the reader may not decide approvals. */
  approvals: Settled<number | null>
  /** The readiness jobs due today that this person is here to do. */
  myJobs: Settled<readonly PreparationTask[]>
  /** Keyed by metric id. A metric the reader may not see is simply absent. */
  metrics: Settled<ReadonlyMap<MetricId, MetricResult>>
}

/* ----------------------------------------------------------------- load -- */

export type HomeArgs = {
  /**
   * The request-scoped client, the one running as the signed-in person under
   * row level security. Passed in rather than built here for the mundane
   * reason with a real consequence that `action-center/_lib/queries.ts`
   * records: `@/lib/supabase/server` reads `@/lib/env` at module load, so a
   * module that imports it needs a Supabase project to exist before a test can
   * import it at all. The wiring lives in `page.tsx`; this module is reachable
   * from the deliberately database-free suite.
   */
  db: Db
  /** `SupabaseMetricSource` over the same client. */
  source: MetricSource
  actor: Actor
  organizationId: string
  /** One property from the shell switcher, or null for everything in scope. */
  propertyId: string | null
  /** Injected so a test needs no clock. */
  now?: Date
}

/**
 * Everything on the home screen, in as few round trips as the reads allow.
 *
 * `listOpenBalances` genuinely depends on today's stays — it is the balance of
 * *those* bookings — so it waits for them. Everything else is independent and
 * runs together.
 */
export async function loadHome(args: HomeArgs): Promise<HomeData> {
  const { db, source, actor, organizationId, propertyId } = args
  const now = args.now ?? new Date()
  const today = propertyToday(now)

  const queryArgs: ActionCenterArgs = {
    db,
    actor,
    organizationId,
    propertyId,
    today,
  }

  const stays = await settle(() => listStaysToday(queryArgs))

  const [balances, stuckTasks, stalledPayments, approvals, myJobs, metrics] =
    await Promise.all([
      settle(async () => {
        const rows = await listOpenBalances(
          queryArgs,
          stays.ok ? stays.value : [],
        )
        if (rows === null) return null
        return {
          count: rows.length,
          totalAgorot: outstandingTotalAgorot(rows),
        }
      }),
      settle(async () => {
        const rows = await listStuckTasks(queryArgs)
        return rows === null ? null : rows.length
      }),
      settle(async () => {
        const rows = await listPaymentsNeedingAttention(queryArgs)
        return rows === null ? null : rows.length
      }),
      settle(async () => {
        const rows = await listWaitingApprovals(queryArgs)
        return rows === null ? null : rows.length
      }),
      settle(() => loadMyJobs(db, actor, propertyId, today)),
      settle(() => loadMetrics(source, actor, propertyId, now)),
    ])

  return {
    today,
    stays: stays.ok
      ? { ok: true, value: countStays(stays.value) }
      : { ok: false, error: stays.error },
    balances,
    stuckTasks,
    stalledPayments,
    approvals,
    myJobs,
    metrics,
  }
}

/* ---------------------------------------------------------------- parts -- */

/** Today's stays, tallied by the job each of them is. */
export function countStays(stays: readonly DayStay[]): TodayCounts {
  const counts: TodayCounts = { departing: 0, arriving: 0, in_house: 0 }
  for (const stay of stays) counts[stay.role] += 1
  return counts
}

/**
 * The readiness jobs due today for somebody who actually does them.
 *
 * Gated on `task.complete` rather than `task.view`: this list answers "what am
 * I holding a mop for", and a general manager who may watch the board is not
 * holding one. They get the operational count instead.
 *
 * `PreparationTask` carries a unit name, a due time, a status and a blocked
 * reason — and no guest, no rate and no booking total. That is not a filter
 * applied here; it is the shape the preparation board reads, and it is why a
 * cleaner's home screen can be built from it without a single redaction on
 * this side.
 */
async function loadMyJobs(
  db: Db,
  actor: Actor,
  propertyId: string | null,
  today: string,
): Promise<readonly PreparationTask[]> {
  if (!holdsGrant(actor, 'task.complete')) return []

  return listPreparationTasks(db, {
    actor,
    propertyId,
    horizon: { from: today, to: addDays(today, 1) },
    limit: MY_JOBS_LIMIT,
  })
}

/**
 * The ceiling on the personal list.
 *
 * A home screen is a glance. Eight rows is a morning's work for one person;
 * more than that and the honest answer is the preparation board, which the
 * panel links to and which pages properly.
 */
export const MY_JOBS_LIMIT = 8

/**
 * This month's figures, refused metric by metric by the domain.
 *
 * The window is the calendar month containing today, at the property's own
 * timezone, and the comparison is the previous period — the same choice
 * `/reports` defaults to, so the home screen and the report cannot disagree
 * about what "this month" means.
 *
 * A reader holding none of the four grants makes `computeDashboard` return no
 * metrics and read no rows at all, which is why this is safe to call for a
 * cleaner: the band it feeds simply has nothing in it and disappears.
 */
async function loadMetrics(
  source: MetricSource,
  actor: Actor,
  propertyId: string | null,
  now: Date,
): Promise<ReadonlyMap<MetricId, MetricResult>> {
  // Asked before the request, so a reader entitled to nothing costs no round
  // trip. `METRICS[id].requires` is the dictionary's own gate and the very
  // question `computeDashboard` asks again inside; this is the same rule read
  // early, never a second copy of it.
  const wanted = HOME_METRIC_IDS.filter((id) =>
    holdsGrant(actor, METRICS[id].requires),
  )
  if (wanted.length === 0) return new Map()

  const response = await loadReport({
    actor,
    source,
    range: monthContaining(now),
    comparison: 'previous_period',
    metrics: wanted,
    propertyId,
    now,
  })

  return new Map(response.metrics.map((metric) => [metric.id, metric]))
}
