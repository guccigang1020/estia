/**
 * EXECUTION CONTEXT — SERVER ONLY. Who may run a migration.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE PERMISSIONS THIS SCREEN ACTUALLY WANTS DO NOT EXIST YET
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Three are needed, and they are three different amounts of authority:
 *
 *   `migration.view`   — read a session, its dry run and its report.
 *   `migration.run`    — upload, map, validate and dry run. Writes nothing.
 *   `migration.apply`  — perform the import. Belongs in `SENSITIVE_ACTIONS`:
 *                        it writes three years of another system's history
 *                        into this one in a single act.
 *
 * `src/lib/authz/permissions.ts` is owned by another worker for the duration
 * of this work, so those three are requested rather than added, and this file
 * uses the closest existing grant in the meantime.
 *
 * The stand-in is `integration.manage`, and it is a deliberate choice rather
 * than the first thing on the list. It already means "connect this business to
 * another system", it is already in `SENSITIVE_ACTIONS` — so it already demands
 * a stated reason — and in every built-in role it is held by exactly the people
 * who would hold `migration.apply`. It is *wider* than what this screen needs,
 * which is the honest direction for a stand-in to be wrong in: nobody gains
 * access they would not have had.
 *
 * When the three grants land, replace `MIGRATION_VIEW` / `MIGRATION_APPLY`
 * below and nothing else changes.
 *
 * ── The grants the write path genuinely checks ────────────────────────────
 *
 * Separate from the route gate and not replaceable by it. `guest.create`,
 * `property.create` and `booking.create` are asserted by the domain operations
 * themselves, and `booking.override_availability` is asserted by
 * `booking.create` when a historic stay is written over the live calendar. A
 * person who reaches this screen without them gets a per-row refusal naming the
 * grant, which is the correct outcome: the route decides who may *start* a
 * migration, and the domain decides what each record may do.
 */

import { holdsGrant } from '@/lib/authz/can'
import type { Actor } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'

import { requireGrant } from '../../_lib/guard'

/** Stand-in for `migration.view` / `migration.run`. See the header. */
export const MIGRATION_VIEW: Grant = 'integration.manage'

/** Stand-in for `migration.apply`. See the header. */
export const MIGRATION_APPLY: Grant = 'integration.manage'

/** The grants each record's write will be refused without. */
export const WRITE_GRANTS: readonly Grant[] = [
  'guest.create',
  'property.create',
  'booking.create',
  'booking.override_availability',
]

export function requireMigrationAccess(): Promise<Actor> {
  return requireGrant(MIGRATION_VIEW)
}

/**
 * Which of the write grants this person is missing.
 *
 * Shown on the screen *before* anything is uploaded, because discovering after
 * a forty-minute mapping session that you were never allowed to write bookings
 * is the worst possible moment to find out.
 */
export function missingWriteGrants(actor: Actor): readonly Grant[] {
  return WRITE_GRANTS.filter((grant) => !holdsGrant(actor, grant))
}

export const WRITE_GRANT_LABEL: Readonly<Record<string, string>> = {
  'guest.create': 'יצירת אורחים',
  'property.create': 'יצירת נכסים',
  'booking.create': 'יצירת הזמנות',
  'booking.override_availability': 'רישום שהות על תאריכים תפוסים',
}
