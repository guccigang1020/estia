/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Where the metrics domain meets the request.
 *
 * `src/lib/metrics` has been complete, tested and completely unreachable:
 * fifteen definitions, a scope resolver, a comparison engine and a Supabase
 * source that no screen imported. This file is the missing sentence, and it is
 * deliberately the same shape as `bookings/_lib/wiring.ts` — take the
 * request-scoped client, the one that runs as the signed-in person under row
 * level security, and hand it to the adapter.
 *
 * ── There is no unit of work here, and there should not be ────────────────
 *
 * Reporting is read-only. Nothing it does is idempotent-keyed, versioned or
 * audited, so there is no transaction to run, no audit writer to inject and no
 * `OperationServices` to build. `bookingWiring` carries all three because
 * booking screens write; this one would be carrying them so that a future
 * reader could not tell that reports never do.
 *
 * Built per call rather than cached at module scope: the client carries the
 * caller's session, and one shared instance would be one shared identity.
 */

import { SupabaseMetricSource, type Db } from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

export type MetricsWiring = {
  db: Db
  source: SupabaseMetricSource
}

export async function metricsWiring(): Promise<MetricsWiring> {
  const db = await createClient()
  return { db, source: new SupabaseMetricSource(db) }
}
