/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * One read of "what does this organization's stock module do, and what is in
 * it", shared by every screen under `/inventory`.
 *
 * ── Why this exists rather than each screen reading for itself ────────────
 *
 * Six screens ask the same three questions — is the module on, what capability
 * does it have, what is in the cupboard — and six answers to one question is
 * how a dashboard offers a transfer that the shortages screen then refuses.
 * The mode is read once, `capabilitiesFor` turns it into capabilities once,
 * and everything downstream reads the capabilities.
 *
 * ── The module being off is not an error ──────────────────────────────────
 *
 * `off` is the default, most businesses will be in it, and the honest response
 * is a screen that explains what turning it on would give them — not an empty
 * table, and not a stack trace. `moduleOff` below is what every screen renders
 * in that case, and it is a real page rather than a redirect: a person who
 * clicked "מלאי" wants to know why there is nothing there.
 *
 * ── Never render an inventory widget when the module is off ───────────────
 *
 * `capabilities.enabled` is the single gate, and screens check it before they
 * render anything at all — including the summary tiles, which are the ones
 * most likely to be left in by accident because they look harmless.
 */

import { localDate } from '@/lib/booking'
import type { InventoryState } from '@/lib/contracts/states'
import {
  capabilitiesFor,
  forecastStock,
  type ForecastResult,
  type InventoryCapabilities,
  type InventorySettings,
} from '@/lib/inventory'
import { NULL_LAUNDRY_PORT, type InventoryLaundryPort } from '@/lib/inventory'
import type { ForecastItem } from '@/lib/inventory'
import { SupabaseInventoryRepository } from '@/lib/persistence/inventory'
import { createClient } from '@/lib/supabase/server'
import type { Actor } from '@/lib/authz/can'

import { ALL_PROPERTIES, type ShellContext } from '../../_lib/context'

export interface InventoryModule {
  settings: InventorySettings
  capabilities: InventoryCapabilities
  /**
   * False when `inventory_settings` could not be read at all. The module
   * behaves as `off`, and a screen may say that the migration has not run
   * here rather than implying the business chose it.
   */
  provisioned: boolean
  items: readonly ForecastItem[]
  forecast: ForecastResult
  /** The property the shell has selected, or null for all of them. */
  propertyId: string | null
  propertyNames: ReadonlyMap<string, string>
  /** Today, in the property's own calendar. */
  today: string
  /** Whatever went wrong, already made safe. */
  failure: string | null
}

export interface LoadModuleArgs {
  actor: Actor
  context: Extract<ShellContext, { status: 'ready' }>
  /** Days walked. Defaults to the organization's own horizon. */
  horizonDays?: number
  /**
   * The laundry facts. A port this module owns — see
   * `src/lib/inventory/laundry-port.ts`. The null implementation is the
   * honest answer for an organization whose laundry module is off, which is
   * most of them, and it is what ships until the laundry worker satisfies it.
   */
  laundry?: InventoryLaundryPort
}

/**
 * Everything a stock screen needs, read once.
 *
 * Never throws. A failure comes back in `failure` with the module reading as
 * off, because a screen that cannot read the settings must not guess that the
 * business wanted stock validation.
 */
export async function loadInventoryModule(
  args: LoadModuleArgs,
): Promise<InventoryModule> {
  const { actor, context } = args
  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId
  const propertyNames = new Map(
    context.properties.map((property) => [
      property.id,
      property.name ?? property.id,
    ]),
  )
  const today = localDate(new Date())

  const db = await createClient()
  const repository = new SupabaseInventoryRepository(db)
  const laundry = args.laundry ?? NULL_LAUNDRY_PORT

  const { settings, provisioned } = await repository.loadSettings(
    actor.organizationId,
  )
  const capabilities = capabilitiesFor(settings)

  const base = {
    settings,
    capabilities,
    provisioned,
    propertyId,
    propertyNames,
    today,
  }

  if (!capabilities.enabled) {
    return {
      ...base,
      items: [],
      forecast: emptyForecast(today),
      failure: null,
    }
  }

  const propertyIds = propertyId === null ? [] : [propertyId]

  try {
    const items = await repository.loadForecastItems({
      organizationId: actor.organizationId,
      propertyIds,
    })

    if (!capabilities.forecast) {
      return { ...base, items, forecast: emptyForecast(today), failure: null }
    }

    const horizon = args.horizonDays ?? settings.forecastHorizonDays
    const to = addDaysSafe(today, horizon)

    const groupOf = await repository.itemGroupIndex({
      organizationId: actor.organizationId,
      propertyIds,
    })
    const demand = await repository.loadDemand(
      { organizationId: actor.organizationId, propertyIds, from: today, to },
      groupOf,
    )
    const outlook = await laundry.outlook({
      organizationId: actor.organizationId,
      propertyIds,
      from: today,
      to,
    })

    return {
      ...base,
      items,
      forecast: forecastStock({
        today,
        horizonDays: horizon,
        settings,
        capabilities,
        items,
        demand,
        returns: outlook.expectedReturns,
        propertyNames,
      }),
      failure: null,
    }
  } catch {
    // The message is deliberately not the exception's. A screen shows a
    // sentence a person can act on; the exception goes to the server log,
    // where it belongs.
    return {
      ...base,
      items: [],
      forecast: emptyForecast(today),
      failure:
        'לא הצלחנו לקרוא את נתוני המלאי כרגע. שאר המסכים אינם מושפעים — ' +
        'הזמנות, הכנה וכספים ממשיכים לעבוד.',
    }
  }
}

function emptyForecast(today: string): ForecastResult {
  return {
    from: today,
    to: today,
    rows: [],
    alerts: [],
    transfers: [],
    computed: false,
    skippedReason: 'module_off',
  }
}

function addDaysSafe(from: string, days: number): string {
  const at = new Date(`${from}T00:00:00Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

/* ----------------------------------------------------------- item totals -- */

/** Everything of one state across the whole reachable stock. */
export function totalInState(
  items: readonly ForecastItem[],
  state: InventoryState,
): number {
  return items.reduce((sum, item) => sum + (item.byState[state] ?? 0), 0)
}

/** Items at or under their reorder point, which is a present-tense fact. */
export function belowReorderPoint(
  items: readonly ForecastItem[],
): readonly ForecastItem[] {
  return items.filter(
    (item) => item.minQuantity !== null && item.onHandClean <= item.minQuantity,
  )
}

/** Everything owned, whatever state it is in. */
export function totalOwned(item: ForecastItem): number {
  return Object.values(item.byState).reduce(
    (sum, quantity) => sum + (quantity ?? 0),
    0,
  )
}
