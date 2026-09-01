/**
 * The guest journey's database functions, reproduced for the demo.
 *
 * ── Why this is its own file ──────────────────────────────────────────────
 *
 * `client.ts` holds the demo's own machinery — the query builder, the row
 * shapes, the two triggers it reproduces — and it belongs to the coordinator
 * because every screen reaches it. The guest journey's functions are a
 * different kind of thing: each one mirrors a specific `SECURITY DEFINER`
 * function in migration 0034, and getting one subtly wrong means a demo that
 * teaches the wrong behaviour to whoever reads it next.
 *
 * The person who wrote those functions knows what each refusal means and in
 * what order it fires. So the map lives here, in a file that worker owns, and
 * `client.ts` merges it into `FUNCTIONS`. One writer per file, and the
 * knowledge stays where it was earned.
 *
 * ── What a function in here must get right ────────────────────────────────
 *
 * Not the privilege — the demo has no row level security, and reproducing
 * `anon` would be theatre. Two things instead:
 *
 *   · **the projection.** Return exactly the keys the real function returns.
 *     A demo that hands back a whole row lets a screen read fields production
 *     withholds, and nobody finds out until it is live.
 *   · **the refusals, and their order.** Throw `DemoRpcError` with the same
 *     machine code and the same Hebrew hint the migration raises. A refusal
 *     path that cannot be reached in the demo is a refusal path nobody looks
 *     at, and these are the ones a guest meets: the revoked link, the expired
 *     one, the stale confirmation.
 *
 * ── Empty is a real state ─────────────────────────────────────────────────
 *
 * The map starts empty on purpose rather than being absent. `client.ts`
 * imports it today, so the seam is proven to work before anything depends on
 * it — the alternative is a worker landing an import of a module nobody has
 * written, which broke every page of this application once already.
 *
 * An unimplemented function is not silently absent either: `DemoClient.rpc`
 * throws `UnsupportedQuery` naming the function and this file, so a portal
 * screen that needs one says so instead of rendering something plausible.
 */

import type { DemoDatabase, DemoRpcFunction } from './client'

/**
 * `guest_portal_journey`, `guest_portal_confirm`, `guest_portal_sign_contract`,
 * `guest_portal_save_details`, `guest_portal_submit_request` and
 * `guest_portal_declare_checkout` belong here.
 *
 * `guest_portal_session` and `guest_portal_opened` deliberately do not: they
 * are 0033's, they gate the portal's frame rather than any one journey step,
 * and they live beside the demo's other core machinery in `client.ts`.
 */
export const GUEST_JOURNEY_FUNCTIONS: Record<string, DemoRpcFunction> = {}

// Re-exported so an implementation in this file can name the type it receives
// without reaching back into `client.ts` for it twice.
export type { DemoDatabase }
