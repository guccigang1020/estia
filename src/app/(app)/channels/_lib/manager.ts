/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the channel manager.
 *
 * ══ THE TABLES MAY NOT EXIST YET, AND THIS FILE HANDLES THAT AS A STATE ═════
 *
 * `src/lib/channels/**` is written against a schema that has been proposed and
 * not yet applied — the migration is the coordinator's to write. So every read
 * here is wrapped, and a "relation does not exist" is turned into
 * `kind: 'not_provisioned'` rather than a 500.
 *
 * That is not a workaround. It is the same shape the screen has needed all
 * along: the existing `queries.ts` beside this file argues at length that a
 * hard-coded "not connected" is a claim that goes stale the day somebody wires
 * an integration up. A *derived* "the channel manager is not installed in this
 * deployment" goes away by itself the moment the migration runs, with no
 * change to this file or the screen — and until then it says something true
 * and specific instead of showing an error page.
 *
 * ── Three floors, and the menu is none of them ────────────────────────────
 *
 *   1. `requireDistributionGrant('channel.manage')` refuses the route, and
 *      distinguishes "your package does not include this" from "you may not
 *      do this" — see `agents/_lib/gate.ts`.
 *   2. The selected property narrows every query, and **every row that
 *      survives it is checked again** with `can()` against the property it
 *      names. A query built wrong then returns short rather than wide, which
 *      is the failure direction that matters. An organization-wide connector
 *      (`property_id is null`) is checked against the organization instead,
 *      because it genuinely covers everything.
 *   3. Row level security refuses regardless of both. The policies the
 *      migration must carry are stated in this module's report; every one of
 *      them checks `has_permission(organization_id, 'channel.manage')` plus
 *      `property_in_scope` where the row names a property.
 *
 * ── What is deliberately not read ─────────────────────────────────────────
 *
 * No guest name, no phone, no email, and no booking total. A channel exception
 * is an operational row — "this listing is not mapped, this reservation could
 * not be created" — and a person who may configure channels is not thereby
 * somebody who may read a guest's details. The reservation id and the listing
 * id are enough to act, and they are what the exception carries.
 */

import { can, holdsGrant, type Actor, type Resource } from '@/lib/authz/can'
import { connectorHealth, fleetHealth } from '@/lib/channels/health'
import { bySeverityThenAge, tallyExceptions } from '@/lib/channels/exceptions'
import { planMappings } from '@/lib/channels/mapping'
import type {
  ChannelException,
  Connector,
  Listing,
  ListingMapping,
  SyncStatus,
} from '@/lib/channels/types'
import type { MappingPlan, UnitFact } from '@/lib/channels/mapping'
import type { FleetHealth } from '@/lib/channels/health'
import { SupabaseChannelRepository } from '@/lib/channels/repository'
import { asString, toRows, type Db } from '@/lib/persistence'

/* ---------------------------------------------------------------- shared -- */

/** The window health counts failures over. A day: long enough to see a pattern. */
export const HEALTH_WINDOW_HOURS = 24

/** The exception centre's ceiling. Longer than this is a report, not a queue. */
export const EXCEPTION_PAGE_SIZE = 100

function channelResource(
  organizationId: string,
  propertyId: string | null,
): Resource {
  return propertyId === null
    ? { organizationId, family: 'settings' }
    : { organizationId, propertyId, family: 'settings' }
}

/**
 * Is this the database telling us the channel manager was never installed?
 *
 * Two codes, because the two layers report it differently: Postgres raises
 * `42P01` for an unknown relation, and PostgREST answers `PGRST205` when the
 * table is not in its schema cache at all. Anything else is a real failure and
 * is rethrown — swallowing every error here would turn a broken policy into a
 * screen that says "not installed", which is the most misleading sentence this
 * page could produce.
 */
function isMissingSchema(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return code === '42P01' || code === 'PGRST205'
}

async function orNotProvisioned<T>(
  read: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await read() }
  } catch (error) {
    if (isMissingSchema(error)) return { ok: false }
    throw error
  }
}

/* ----------------------------------------------------------- health view -- */

export type ConnectorView = {
  connector: Connector
  status: SyncStatus
}

export type ChannelManagerState =
  /**
   * The tables are not there. Not an error, and not "coming soon": a specific,
   * checkable fact the screen reports in one sentence.
   */
  | { kind: 'not_provisioned' }
  /** The reader may not configure channels. Different from "nothing exists". */
  | { kind: 'not_readable' }
  | {
      kind: 'ready'
      connectors: readonly ConnectorView[]
      fleet: FleetHealth
      exceptions: readonly ChannelException[]
      tally: ReturnType<typeof tallyExceptions>
    }

export type ManagerArgs = {
  db: Db
  actor: Actor
  organizationId: string
  /** `null` when the shell is showing every property. */
  propertyId: string | null
}

/**
 * Every connector, with its health, and the exceptions waiting on a person.
 *
 * One repository, three reads per connector, and the health arithmetic done in
 * the domain — `connectorHealth` is a pure function and is tested without a
 * database, which is why it is not a SQL view. A view would put the staleness
 * thresholds in the schema, where nobody can see them and nothing can test
 * them against a clock.
 */
export async function channelManagerState(
  args: ManagerArgs,
): Promise<ChannelManagerState> {
  const { db, actor, organizationId, propertyId } = args

  if (!holdsGrant(actor, 'channel.manage')) return { kind: 'not_readable' }

  const repo = new SupabaseChannelRepository(db)

  const loaded = await orNotProvisioned(async () => {
    const connectors = await repo.listConnectors(organizationId, propertyId)
    const exceptions = await repo.listExceptions(organizationId, {
      limit: EXCEPTION_PAGE_SIZE,
    })
    return { connectors, exceptions }
  })

  if (!loaded.ok) return { kind: 'not_provisioned' }

  // The second floor. The query was narrowed; every row is checked again.
  const connectors = loaded.value.connectors.filter((connector) =>
    can(
      actor,
      'channel.manage',
      channelResource(organizationId, connector.propertyId),
    ),
  )

  const exceptions = loaded.value.exceptions
    .filter((exception) =>
      can(
        actor,
        'channel.manage',
        channelResource(organizationId, exception.propertyId),
      ),
    )
    .sort(bySeverityThenAge)

  const views: ConnectorView[] = []

  for (const connector of connectors) {
    const counters = await repo.syncCounters(
      organizationId,
      connector.id,
      HEALTH_WINDOW_HOURS,
    )

    const open = exceptions.filter(
      (exception) =>
        exception.connectorId === connector.id &&
        (exception.state === 'open' || exception.state === 'acknowledged'),
    ).length

    views.push({
      connector,
      status: connectorHealth({
        connector,
        pendingOutbound: counters.pendingOutbound,
        recentFailures: counters.recentFailures,
        failedEntities: counters.failedEntities,
        openExceptions: open,
        now: new Date(),
      }),
    })
  }

  return {
    kind: 'ready',
    connectors: views,
    fleet: fleetHealth(views.map((view) => view.status)),
    exceptions,
    tally: tallyExceptions(exceptions),
  }
}

/* ------------------------------------------------------------ setup view -- */

export type SetupState =
  | { kind: 'not_provisioned' }
  | { kind: 'not_readable' }
  /** No connector has been created. The first step of the flow. */
  | { kind: 'no_connectors'; units: readonly UnitFact[] }
  | {
      kind: 'ready'
      connectors: readonly Connector[]
      selected: Connector
      listings: readonly Listing[]
      mappings: readonly ListingMapping[]
      units: readonly UnitFact[]
      plan: MappingPlan
    }

/**
 * What the mapping flow needs: the connector, what discovery found, what has
 * been matched, and what this business actually has to sell.
 */
export async function setupState(
  args: ManagerArgs & { connectorId?: string },
): Promise<SetupState> {
  const { db, actor, organizationId, propertyId } = args

  if (!holdsGrant(actor, 'channel.manage')) return { kind: 'not_readable' }

  const repo = new SupabaseChannelRepository(db)
  const units = await sellableUnits(args)

  const loaded = await orNotProvisioned(() =>
    repo.listConnectors(organizationId, propertyId),
  )
  if (!loaded.ok) return { kind: 'not_provisioned' }

  const connectors = loaded.value.filter((connector) =>
    can(
      actor,
      'channel.manage',
      channelResource(organizationId, connector.propertyId),
    ),
  )

  if (connectors.length === 0) return { kind: 'no_connectors', units }

  const selected =
    connectors.find((connector) => connector.id === args.connectorId) ??
    connectors[0]

  const [listings, mappings] = await Promise.all([
    repo.listListings(organizationId, selected.id),
    repo.listMappings(organizationId, selected.id),
  ])

  return {
    kind: 'ready',
    connectors,
    selected,
    listings,
    mappings,
    units,
    plan: planMappings({ listings, mappings, units }),
  }
}

/**
 * The units a listing may be mapped to.
 *
 * `sellable` is `status = 'active'` and nothing else. A unit in `draft`,
 * `maintenance`, `inactive` or `archived` is not something a channel may be
 * pointed at — mapping a listing to one produces an integration that validates
 * on this screen and then refuses every reservation that arrives through it,
 * which is the worst of both. The check belongs to the accommodation schema
 * and is read from it rather than restated.
 */
async function sellableUnits(args: ManagerArgs): Promise<readonly UnitFact[]> {
  const { db, actor, organizationId, propertyId } = args

  let query = db
    .from('units')
    .select('id, property_id, name, status')
    .eq('organization_id', organizationId)

  if (propertyId !== null) query = query.eq('property_id', propertyId)

  const { data, error } = await query.order('name')
  if (error) {
    if (isMissingSchema(error)) return []
    throw error
  }

  return toRows(data)
    .filter((row) =>
      can(
        actor,
        'unit.manage',
        channelResource(organizationId, asString(row, 'property_id')),
      ),
    )
    .map((row) => ({
      unitId: asString(row, 'id'),
      propertyId: asString(row, 'property_id'),
      name: asString(row, 'name'),
      sellable: asString(row, 'status') === 'active',
    }))
}
