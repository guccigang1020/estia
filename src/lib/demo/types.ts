/**
 * The demo contract.
 *
 * ── What the demo is, and what it is not ──────────────────────────────────
 *
 * It is the real product. Every screen, every `can()` check, every menu
 * derivation, every plan lock and every domain rule runs exactly as it does
 * for a paying customer. One thing is replaced: the rows come from memory
 * instead of from Postgres, and the signed-in person comes from a cookie
 * instead of from Supabase auth.
 *
 * It is **not** a mock of the UI. Nothing here may special-case a screen, and
 * no screen may ever import from this directory. If a screen is broken, the
 * demo must show it broken — a demo that papers over a defect is worse than
 * no demo, because it converts an open bug into a false reassurance.
 *
 * ── Why a cookie decides who you are ──────────────────────────────────────
 *
 * The whole point of the demo is to walk the same organization as an owner,
 * then as a cleaner, then as an external agent, and watch the product change
 * shape. Authorization is derived from grants, so switching persona means
 * switching which grants the `Actor` carries — not which screens exist.
 *
 * The plan is a second, independent axis for the same reason: `Basic` and
 * `Pro` differ by entitlements alone, and the difference must be visible as
 * locks and upsells on the same screens rather than as a different build.
 */

import type { SystemRole } from '../authz/roles'
import type { Entitlement } from '../plans/entitlements'

/** One row, as PostgREST would render it: snake_case keys, JSON-safe values. */
export type DemoRow = Record<string, unknown>

/** Table name → rows, keyed exactly as `public.<name>` in the migrations. */
export type DemoTables = Record<string, DemoRow[]>

/**
 * A person the demo can act as.
 *
 * `userId` must match a `memberships.user_id` in the dataset, because the
 * demo resolves an actor through the ordinary path — membership, roles,
 * scope — rather than by handing the engine a grant set directly. A persona
 * whose membership is missing is a broken demo, and should fail loudly.
 */
export type DemoPersona = {
  id: string
  /** Shown in the switcher. Hebrew, because the switcher is user-facing. */
  label: string
  /** One line on what this person is allowed to see. */
  summary: string
  role: SystemRole
  userId: string
  /** Display name and e-mail, so the shell has something honest to show. */
  fullName: string
  email: string
}

/** A package the demo can run the same organization on. */
export type DemoPlan = {
  /** Matches a `code` in `SEED_PLANS`. */
  code: string
  label: string
  entitlements: readonly Entitlement[]
}

/**
 * Everything the demo serves.
 *
 * One organization, seen from many angles. A second organization would only
 * prove the tenant boundary, which the isolation proofs already do against a
 * real database — and it would make every screen ambiguous about which rows
 * it should be showing.
 */
export type DemoDataset = {
  organizationId: string
  tables: DemoTables
}
