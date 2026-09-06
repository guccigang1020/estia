/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the stocktake screens.
 *
 * ── Three floors, and the menu is none of them ────────────────────────────
 *
 *   1. `requireGrant('inventory.view')` refuses the route, and the counting
 *      screens additionally ask `holdsGrant('inventory.adjust')` before they
 *      offer a single button — a person who may look at stock is not thereby
 *      a person who may count it into the record.
 *   2. The shell's selected property narrows every query, and **every row
 *      that survives it is checked again** with `can()` against the property
 *      it names. A query built wrong then returns short rather than wide,
 *      which is the failure direction that matters.
 *   3. Row level security refuses regardless of both. The policies the
 *      migration must carry are stated in this module's report; every one of
 *      them checks `has_permission(organization_id, ...)` plus
 *      `property_in_scope`.
 *
 * ── Four states, and "not installed" is one of them ───────────────────────
 *
 * The tables are proposed and not yet applied, so a missing relation is
 * reported as `not_provisioned` rather than as an error page — see
 * `repository.ts`. It is distinct from `module_off`, which is a business's own
 * choice, and both are distinct from "there are no sessions yet". Three
 * different sentences, because they call for three different actions.
 *
 * ── The blind sheet is built here, and it is the object the page receives ──
 *
 * `buildCountSheet` is called with `blind: true` for a blind session, and the
 * page is handed its result. The expected quantities are never loaded on that
 * path at all — not fetched and discarded, not passed and hidden. The only
 * read of `inventory_count_expectations` in this file is on the reconciliation
 * screen, which is where the comparison belongs.
 */

import { can, holdsGrant, type Actor, type Resource } from '@/lib/authz/can'
import {
  buildCountSheet,
  type CountSessionRecord,
  type CountSheet,
  type CountVarianceRecord,
} from '@/lib/inventory/counts'
import {
  estimateExposure,
  type ReplacementExposure,
} from '@/lib/inventory/loss'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, type ShellContext } from '../../../_lib/context'
import { loadInventoryModule } from '../../_lib/module'
import { SupabaseCountRepository, orNotProvisioned } from './repository'

/** The ceiling on the session list. Longer than this is a report. */
export const SESSION_PAGE_SIZE = 50

type ReadyContext = Extract<ShellContext, { status: 'ready' }>

function countResource(organizationId: string, propertyId: string): Resource {
  return { organizationId, propertyId, family: 'operations' }
}

/* --------------------------------------------------------- the list view -- */

export type CountsState =
  /** The business has not turned the stock module on. Their choice. */
  | { kind: 'module_off'; provisioned: boolean }
  /** The tables are not in this deployment. Not an error and not a choice. */
  | { kind: 'not_provisioned' }
  | {
      kind: 'ready'
      sessions: readonly CountSessionRecord[]
      propertyNames: ReadonlyMap<string, string>
      /** May this person start and record a count, or only read one? */
      mayCount: boolean
      /** The property the shell has selected, or null for all of them. */
      propertyId: string | null
    }

export async function countsState(args: {
  actor: Actor
  context: ReadyContext
}): Promise<CountsState> {
  const { actor, context } = args

  const stock = await loadInventoryModule({ actor, context })
  if (!stock.capabilities.counting) {
    return { kind: 'module_off', provisioned: stock.provisioned }
  }

  const db = await createClient()
  const repository = new SupabaseCountRepository(db)

  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId

  const loaded = await orNotProvisioned(() =>
    repository.listSessions({
      organizationId: actor.organizationId,
      propertyIds: propertyId === null ? [] : [propertyId],
      limit: SESSION_PAGE_SIZE,
    }),
  )

  if (!loaded.ok) return { kind: 'not_provisioned' }

  // The second floor. The query was narrowed; every row is checked again.
  const sessions = loaded.value.filter((session) =>
    can(
      actor,
      'inventory.view',
      countResource(actor.organizationId, session.propertyId),
    ),
  )

  return {
    kind: 'ready',
    sessions,
    propertyNames: stock.propertyNames,
    mayCount: holdsGrant(actor, 'inventory.adjust'),
    propertyId,
  }
}

/* ------------------------------------------------------- the sheet view -- */

export type SheetState =
  | { kind: 'module_off'; provisioned: boolean }
  | { kind: 'not_provisioned' }
  | { kind: 'not_found' }
  /** The session belongs to a property outside this membership's scope. */
  | { kind: 'not_readable' }
  | {
      kind: 'ready'
      session: CountSessionRecord
      sheet: CountSheet
      mayCount: boolean
      propertyName: string | null
    }

export async function sheetState(args: {
  actor: Actor
  context: ReadyContext
  sessionId: string
}): Promise<SheetState> {
  const { actor, context, sessionId } = args

  const stock = await loadInventoryModule({ actor, context })
  if (!stock.capabilities.counting) {
    return { kind: 'module_off', provisioned: stock.provisioned }
  }

  const db = await createClient()
  const repository = new SupabaseCountRepository(db)

  const loaded = await orNotProvisioned(async () => {
    const session = await repository.loadSession({
      organizationId: actor.organizationId,
      sessionId,
    })
    if (session === null) return null

    const lines = await repository.loadLines({
      organizationId: actor.organizationId,
      sessionId,
    })
    return { session, lines }
  })

  if (!loaded.ok) return { kind: 'not_provisioned' }
  if (loaded.value === null) return { kind: 'not_found' }

  const { session, lines } = loaded.value

  if (
    !can(
      actor,
      'inventory.view',
      countResource(actor.organizationId, session.propertyId),
    )
  ) {
    return { kind: 'not_readable' }
  }

  // A blind session takes the blind branch, which has no `expected` argument
  // to pass. Nothing on this path reads `inventory_count_expectations`.
  const sheet = session.blind
    ? buildCountSheet({ blind: true, session, lines })
    : buildCountSheet({
        blind: false,
        session,
        lines,
        expected: new Map(
          (
            await repository.loadExpected({
              organizationId: actor.organizationId,
              sessionId,
            })
          ).map((one) => [one.itemId, one]),
        ),
      })

  return {
    kind: 'ready',
    session,
    sheet,
    mayCount: holdsGrant(actor, 'inventory.adjust'),
    propertyName: stock.propertyNames.get(session.propertyId) ?? null,
  }
}

/* ------------------------------------------------ the reconciliation view -- */

export type ReconciliationState =
  | { kind: 'module_off'; provisioned: boolean }
  | { kind: 'not_provisioned' }
  | { kind: 'not_found' }
  | { kind: 'not_readable' }
  | {
      kind: 'ready'
      session: CountSessionRecord
      variances: readonly CountVarianceRecord[]
      /** Counted, matched, and therefore not on the list below. */
      matched: number
      /** Never counted. Not a variance and not exposure. */
      uncounted: number
      /**
       * The money, inside the object that explains it. There is no plain
       * number on this state for a component to render on its own.
       */
      exposure: ReplacementExposure
      mayClassify: boolean
      propertyName: string | null
    }

export async function reconciliationState(args: {
  actor: Actor
  context: ReadyContext
  sessionId: string
}): Promise<ReconciliationState> {
  const { actor, context, sessionId } = args

  const stock = await loadInventoryModule({ actor, context })
  if (!stock.capabilities.counting) {
    return { kind: 'module_off', provisioned: stock.provisioned }
  }

  const db = await createClient()
  const repository = new SupabaseCountRepository(db)

  const loaded = await orNotProvisioned(async () => {
    const session = await repository.loadSession({
      organizationId: actor.organizationId,
      sessionId,
    })
    if (session === null) return null

    const [variances, lines] = await Promise.all([
      repository.listVariances({
        organizationId: actor.organizationId,
        sessionId,
      }),
      repository.loadLines({
        organizationId: actor.organizationId,
        sessionId,
      }),
    ])

    return { session, variances, lines }
  })

  if (!loaded.ok) return { kind: 'not_provisioned' }
  if (loaded.value === null) return { kind: 'not_found' }

  const { session, variances, lines } = loaded.value

  if (
    !can(
      actor,
      'inventory.view',
      countResource(actor.organizationId, session.propertyId),
    )
  ) {
    return { kind: 'not_readable' }
  }

  const uncounted = lines.filter((line) => line.countedQuantity === null).length
  const withVariance = new Set(variances.map((one) => one.itemId))
  const matched = lines.filter(
    (line) => line.countedQuantity !== null && !withVariance.has(line.itemId),
  ).length

  return {
    kind: 'ready',
    session,
    variances,
    matched,
    uncounted,
    exposure: estimateExposure(
      variances.map((one) => ({
        itemId: one.itemId,
        label: one.label,
        variance: one.variance,
        classification: one.classification,
        replacementCostAgorot: one.replacementCostAgorot,
      })),
    ),
    mayClassify: holdsGrant(actor, 'inventory.adjust'),
    propertyName: stock.propertyNames.get(session.propertyId) ?? null,
  }
}
