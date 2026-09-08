/**
 * EXECUTION CONTEXT — PURE. Which kinds this person may search.
 *
 * ══ A GLOBAL SEARCH IS A PERMISSION LEAK UNLESS EVERY KIND IS GATED ═════════
 *
 * One box that reaches nine tables is the most efficient way ever invented to
 * hand somebody rows they may not read. The whole product is deny-by-default,
 * asked per resource — and a search that asked once, at the box, would be a
 * hole straight through that.
 *
 * So each kind carries its own grant and is dropped from the plan before a
 * query is built. A cleaner searching a guest's name reaches `tasks` and
 * nothing else, and no row from `guests` is fetched and filtered afterwards:
 * **the query is never issued.** Fetch-then-filter is how a `count` leaks what
 * a list withholds.
 *
 * Row level security refuses underneath regardless. This is the first floor,
 * not the only one — but it is the floor that decides how many round trips a
 * search costs, which is why it is here rather than left to the database.
 *
 * ══ WHAT A CLOSED KIND IS TOLD, AND WHY IT IS TOLD AT ALL ═══════════════════
 *
 * The screen says which kinds were searched and which were closed. That is a
 * deliberate choice against the tempting alternative — silently searching less
 * — because silence here produces the specific failure this codebase keeps
 * naming: a receptionist searches a guest's phone, finds nothing, and concludes
 * the guest is not in the system. The truth is that the system did not look.
 *
 * Naming the closed kind leaks only the SHAPE of the product, which every user
 * already sees in the menu. It does not leak a row, a count, or whether
 * anything matched.
 */

import { holdsGrant, type Actor } from '../authz/can'
import type { Grant } from '../authz/permissions'

import type { SearchKind } from './query'

/**
 * The grant each kind needs.
 *
 * `unit` rides on `property.view` because a unit is not separately gated
 * anywhere in the catalogue — the permission model treats inventory as one
 * family, and inventing a second answer here would be a rule that exists only
 * in search.
 */
export const GRANT_FOR_KIND: Readonly<Record<SearchKind, Grant>> = {
  guest: 'guest.view',
  booking: 'booking.view',
  property: 'property.view',
  unit: 'property.view',
  task: 'task.view',
  owner: 'owner.view',
  agent: 'agent.view',
}

/** Hebrew, for the sentence that says what was and was not searched. */
export const KIND_LABEL: Readonly<Record<SearchKind, string>> = {
  guest: 'אורחים',
  booking: 'הזמנות',
  property: 'נכסים',
  unit: 'יחידות',
  task: 'משימות',
  owner: 'בעלים',
  agent: 'סוכנים',
}

export interface SearchPlan {
  /** Kinds that will actually be queried. */
  readonly searchable: readonly SearchKind[]
  /** Kinds the string could have matched, and this person may not read. */
  readonly closed: readonly SearchKind[]
}

/**
 * Narrow the candidate kinds to the ones this actor may read.
 *
 * `holdsGrant` rather than a bare grant check, because it asks permission and
 * plan together: a business whose package does not include the agent network
 * gets `agent` closed for the same reason a receptionist does, and the screen
 * does not have to know which of the two it was.
 */
export function planSearch(
  actor: Actor,
  candidates: readonly SearchKind[],
): SearchPlan {
  const searchable: SearchKind[] = []
  const closed: SearchKind[] = []

  for (const kind of candidates) {
    if (holdsGrant(actor, GRANT_FOR_KIND[kind])) searchable.push(kind)
    else closed.push(kind)
  }

  return { searchable, closed }
}
