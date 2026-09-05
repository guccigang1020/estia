/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Where the metrics domain meets this request.
 *
 * Deliberately the same shape as `reports/_lib/wiring.ts`: take the
 * request-scoped Supabase client — the one that runs as the signed-in person
 * under row level security — and hand it to the adapter. There is no unit of
 * work, no audit writer and no `OperationServices`, because this screen writes
 * nothing; carrying them would only make a future reader wonder whether it did.
 *
 * ── The one thing this wiring adds ────────────────────────────────────────
 *
 * The source is wrapped in `CachedMetricSource`. This screen reads each window
 * twice — once through `computeDashboard`, which is the only thing allowed to
 * produce a value, and once through `aggregateFacts`, which supplies the
 * operands printed under it. Two independent reads would be six queries where
 * three will do, and would leave a gap in which a booking written between them
 * could make the arithmetic disagree with the figure above it.
 *
 * Built per call, never cached at module scope. The client carries the
 * caller's session and the cache is keyed by resolved scope, so one shared
 * instance would be one shared identity holding one shared set of rows.
 */

import { CachedMetricSource } from '@/lib/insights'
import { SupabaseMetricSource, type Db } from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

export type InsightsWiring = {
  db: Db
  source: CachedMetricSource
}

export async function insightsWiring(): Promise<InsightsWiring> {
  const db = await createClient()
  return { db, source: new CachedMetricSource(new SupabaseMetricSource(db)) }
}
