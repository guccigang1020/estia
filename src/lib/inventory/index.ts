/**
 * The stock engine.
 *
 * What is here that was not before: a forecast that walks days rather than
 * summing totals, reservation against a booking with the concurrency answer
 * written down, shortage alerts that show their arithmetic, and the three
 * `advanced` capabilities — transfers, discrepancies, procurement suggestions.
 *
 * What is deliberately **not** here: the linen transition table. That is
 * `LINEN_TRANSITIONS` in `src/lib/preparation/inventory.ts`, it is the
 * transition authority, and it stays there. `checkInventory` in the same file
 * is the present-tense check — "is there enough for this booking, now" — and
 * this module is the future-tense one. Two files, one vocabulary, no second
 * copy of either.
 *
 * Nothing in this directory imports `src/lib/laundry/**`. See
 * `laundry-port.ts` for why, and for the interface that module satisfies
 * instead.
 */

export {
  INVENTORY_MODE_LABEL,
  INVENTORY_MODE_OPTIONS,
  INVENTORY_MODE_SUMMARY,
  capabilitiesFor,
  defaultInventorySettings,
  safetyBufferFor,
  startingSettingsFor,
} from './settings'

export {
  FORECAST_WINDOWS,
  alertsWorthRaising,
  cleanStockOf,
  eventNameFor,
  explain,
  forecastStock,
  significantRows,
  type ForecastInput,
} from './forecast'

export {
  SHORTAGE_ACTION_LABEL,
  actionIsAvailable,
  buildActions,
  suggestedActionFrom,
} from './actions'

export {
  assertReservationsEnabled,
  claimDateOf,
  coversDate,
  planReservation,
  type ReservableItem,
  type ReservationPlan,
  type ReservationRequest,
} from './reservation'

export {
  NULL_LAUNDRY_PORT,
  fixedLaundryPort,
  type InLaundryCount,
  type InventoryLaundryPort,
  type LaundryOutlook,
  type LaundryOutlookQuery,
} from './laundry-port'

export {
  DISCREPANCY_RESOLUTION_HELP,
  DISCREPANCY_RESOLUTION_LABEL,
  explainDiscrepancy,
  findDiscrepancies,
  isOpen,
  resolutionEffect,
  type CountBack,
  type ResolutionEffect,
} from './discrepancy'

export {
  IMPORT_COLUMNS,
  IMPORT_TEMPLATE_HEADER,
  importTemplateCsv,
  parseDelimited,
  parseImport,
  planImport,
  type ExistingItem,
  type ParseResult,
} from './import'

export * from './types'
