/**
 * Four alarms into one incident.
 *
 * ── The failure ──────────────────────────────────────────────────────────
 *
 * The laundry van is late, so the linen is short, so the preparation will not
 * finish, so the 15:00 arrival is at risk. That is four rows in
 * `autopilot_exceptions`, every one of them true, and at 06:00 a manager
 * reading four unrelated-looking alarms will start at the top of the list —
 * which is the arrival risk, the last link, the one thing they cannot fix. The
 * van is the answer and it is the row they never reach.
 *
 * `caused_by` in 0046 exists for this and points at the ROOT rather than at
 * the previous alert. This module follows it.
 *
 * ── Pure, and therefore testable without a database ──────────────────────
 *
 * It takes rows and returns rows. No query, no clock, no authorization: the
 * set handed in has already been narrowed by scope and re-checked with
 * `can()`, and grouping must not be able to reintroduce a row that was
 * filtered out.
 *
 * ── Three cases the naive version gets wrong ─────────────────────────────
 *
 *   · **The root is not in the set.** It was resolved this morning, or it
 *     belongs to a property outside this reader's scope. Its consequences are
 *     still open and must still be shown, so each becomes its own incident
 *     rather than vanishing into a parent nobody can see.
 *   · **The chain is longer than one link.** The arrival risk names the
 *     preparation risk, which names the shortage, which names the delay. Only
 *     the delay is a root; walking one level would produce three incidents.
 *   · **The chain loops.** The schema forbids a row causing itself and
 *     forbids nothing else, so a two-cycle is possible. A walk with no bound
 *     is an infinite loop in a Server Component, which is a page that never
 *     responds rather than a page with a bug on it.
 *
 * ── Ordering is preserved, never recomputed ──────────────────────────────
 *
 * The incidents come back in the order their roots arrived, and the
 * consequences in the order they arrived. The query already ordered by the
 * domain enum — which IS the triage priority, declared once in
 * `AUTOPILOT_DOMAINS` — and a second sort here would be a second opinion about
 * what matters most.
 */

import type { ExceptionView, IncidentView } from '@/components/autopilot/views'

/**
 * How far up a `caused_by` chain to walk before giving up.
 *
 * Generous — the longest real chain in the brief is four — and finite, which
 * is the part that matters. A row that has not resolved to a root within this
 * many hops is treated as its own root: shown, on its own, rather than hung
 * from a parent this function could not find.
 */
const MAX_DEPTH = 8

export function groupByRootCause(
  exceptions: readonly ExceptionView[],
): readonly IncidentView[] {
  const byId = new Map(exceptions.map((row) => [row.id, row]))

  /** The root this row hangs from, or itself. */
  function rootOf(row: ExceptionView): ExceptionView {
    let current = row
    const seen = new Set<string>([row.id])

    for (let hop = 0; hop < MAX_DEPTH; hop += 1) {
      const parentId = current.causedBy
      if (parentId === null) return current

      const parent = byId.get(parentId)
      // The root is resolved, or out of this reader's scope. This row is the
      // most upstream thing they can see, so it is the one they act on.
      if (parent === undefined) return current

      // A cycle. Stop where we are rather than spin.
      if (seen.has(parent.id)) return current

      seen.add(parent.id)
      current = parent
    }

    return current
  }

  const incidents: IncidentView[] = []
  const index = new Map<string, IncidentView>()

  // Two passes. The first establishes every root in arrival order, so an
  // incident's position is its root's position even when a consequence was
  // read first; the second hangs the rest.
  for (const row of exceptions) {
    if (rootOf(row).id !== row.id) continue
    const incident: IncidentView = { root: row, consequences: [] }
    incidents.push(incident)
    index.set(row.id, incident)
  }

  for (const row of exceptions) {
    const root = rootOf(row)
    if (root.id === row.id) continue

    const incident = index.get(root.id)
    // Cannot happen — a root reached by `rootOf` is a root by the same
    // function in the first pass — but a silently dropped exception is the one
    // outcome this module must not have, so it becomes its own incident.
    if (incident === undefined) {
      incidents.push({ root: row, consequences: [] })
      continue
    }

    incident.consequences = [...incident.consequences, row]
  }

  return incidents
}

/** How many rows an incident accounts for, root included. */
export function incidentSize(incident: IncidentView): number {
  return 1 + incident.consequences.length
}
