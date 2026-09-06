/**
 * EXECUTION CONTEXT — SERVER ONLY. The command centre's read.
 *
 * Composition, not a second read layer. Every query lives in `reads.ts` with
 * its own grant check, its own scope narrowing and its own `can()` re-check;
 * what is here is which of them today's screen asks for, and the counting that
 * turns their rows into the four figures across the top.
 *
 * ── The header strip counts rows and computes nothing else ───────────────
 *
 * Arrivals and departures are the length of a list the action centre already
 * produces, under `booking.view`, with `can()` per row. Properties at risk is
 * the number of DISTINCT properties named by exceptions the detector already
 * marked `at_risk` or `critical` — not a threshold applied here. The open
 * balance is `outstandingTotalAgorot`, the domain's own sum, or `null` when
 * the reader may not see money.
 *
 * `null` and `0` are different claims and the screen prints them differently.
 * "כל האורחים שילמו" and "אינך רשאי לראות חובות" must never share a cell, which
 * is the distinction `listOpenBalances` makes by returning `null` rather than
 * an empty array — and the reason this type carries `number | null` rather
 * than defaulting to zero.
 *
 * ── Why it borrows the action centre's reads instead of re-writing them ──
 *
 * `listStaysToday` and `listOpenBalances` are the same two questions, already
 * written, already tested, already carrying the property-local date
 * conversion, the `redact()` of the guest name and the separation of
 * `unknownAgorot` from what is owed. A second implementation here would be a
 * second answer to "who arrives today", and the two would disagree the first
 * time somebody changed the same-day-turnaround boundary. The cross-group
 * import is the same shape `action-center/_lib/queries.ts` itself uses when it
 * imports `scopeNarrowings` from the preparation board.
 *
 * The cost is stated rather than hidden: this screen inherits that module's
 * `ACTION_PANEL_SIZE` ceiling on stays, so a property with more than
 * twenty-five arrivals in one day would under-count the header figure. The
 * ceiling is reported on screen where it bites.
 */

import {
  listOpenBalances,
  listStaysToday,
  outstandingTotalAgorot,
  propertyToday,
  type ActionCenterArgs,
  type DayStay,
  type OpenBalance,
} from '@/app/(app)/action-center/_lib/queries'
import type { ExceptionView } from '@/components/autopilot/views'

import type { AutopilotReadArgs } from './reads'

export { propertyToday }

/** The four figures across the top of the command centre. */
export type HeaderStrip = {
  arrivals: number
  departures: number
  /** Distinct properties named by an at-risk or critical open exception. */
  propertiesAtRisk: number
  /**
   * What today's stays still owe, in agorot, or `null` when withheld.
   *
   * Never zero-as-unknown. See the header.
   */
  outstandingAgorot: number | null
}

export function headerStrip(
  stays: readonly DayStay[],
  balances: readonly OpenBalance[] | null,
  exceptions: readonly ExceptionView[],
): HeaderStrip {
  const atRisk = new Set<string>()
  for (const row of exceptions) {
    if (row.risk !== 'at_risk' && row.risk !== 'critical') continue
    // An organization-wide exception names no property, so it cannot be
    // counted as one. It is on the screen below; it is not a property.
    if (row.propertyId === null) continue
    atRisk.add(row.propertyId)
  }

  return {
    arrivals: stays.filter((stay) => stay.role === 'arriving').length,
    departures: stays.filter((stay) => stay.role === 'departing').length,
    propertiesAtRisk: atRisk.size,
    outstandingAgorot:
      balances === null ? null : outstandingTotalAgorot(balances),
  }
}

/** The action centre's argument shape, from ours. */
export function stayArgs(
  args: AutopilotReadArgs,
  today: string,
): ActionCenterArgs {
  return {
    db: args.db,
    actor: args.actor,
    organizationId: args.organizationId,
    propertyId: args.propertyId,
    today,
  }
}

export { listOpenBalances, listStaysToday }
export type { DayStay, OpenBalance }
