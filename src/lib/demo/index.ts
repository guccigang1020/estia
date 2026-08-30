/**
 * The demo, as the rest of the application sees it.
 *
 * Three things are exported and nothing else needs to be: the flag, the client
 * that serves the rows, and the session that decides who you are and what
 * package you are on. Two files import from here — `src/lib/supabase/server.ts`
 * and `src/app/(app)/_lib/context.ts` — and they are the whole of the wiring.
 *
 * **No screen may import from this directory.** That is the rule that makes the
 * demo worth having: if a page could ask "am I in the demo?", somebody would
 * eventually answer a broken query with a friendlier fixture, and the demo
 * would stop being evidence about the product and start being a brochure. The
 * substitution happens underneath the product — at the client and at the
 * identity — or it does not happen at all.
 */

export { isDemoMode } from './flag'

export {
  DemoClient,
  DemoDatabase,
  DEMO_RELATIONS,
  MissingDemoTable,
  createDemoClient,
  type DemoResponse,
} from './client'

export {
  DEFAULT_DEMO_PLAN,
  DEMO_PERSONA_COOKIE,
  DEMO_PLAN_COOKIE,
  DemoActorSource,
  currentDemoPersona,
  currentDemoPlan,
  demoUser,
  resolvePersona,
  resolvePlan,
} from './session'

import { DEMO_DATASET } from './dataset'
import { DemoDatabase } from './client'

/**
 * One set of rows, for the life of the process.
 *
 * The demo has to be walkable: a booking created on the calendar is on the
 * bookings list a moment later, and a rate edited in settings is the rate the
 * next quote uses. That only holds if every request in this process is looking
 * at the same arrays, so the database is built once here rather than per
 * request — the opposite of the rule for the Supabase client, which must never
 * be hoisted because it carries a session. This carries no session; the persona
 * does, and it is resolved per request from a cookie.
 *
 * It resets when the process does, which is the honest behaviour for a demo:
 * restart the dev server and the organization is back to the dataset as
 * written. Nothing here is durable and nothing here pretends to be.
 */
let shared: DemoDatabase | null = null

export function sharedDemoDatabase(): DemoDatabase {
  shared ??= new DemoDatabase(DEMO_DATASET)
  return shared
}
