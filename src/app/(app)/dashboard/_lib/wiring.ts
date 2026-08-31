/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Where the home screen meets the request.
 *
 * The same shape as `reports/_lib/wiring.ts` and `preparation/_lib/wiring.ts`,
 * and it exists for the same two reasons. First, the client carries the
 * caller's session, so it is built per call rather than cached at module
 * scope — one shared instance would be one shared identity. Second, and the
 * reason this is a file rather than two lines inside `page.tsx`: importing
 * `@/lib/supabase/server` reads `@/lib/env` at module load, so anything
 * importing it needs a Supabase project to exist before a test can import it
 * at all. Keeping that import here leaves `_lib/home.ts` reachable from the
 * deliberately database-free suite, which is where the per-persona proofs run.
 *
 * There is no unit of work and there should not be: the home screen reads and
 * writes nothing.
 */

import { SupabaseMetricSource, type Db } from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

export type HomeWiring = {
  db: Db
  source: SupabaseMetricSource
}

export async function homeWiring(): Promise<HomeWiring> {
  const db = await createClient()
  return { db, source: new SupabaseMetricSource(db) }
}
