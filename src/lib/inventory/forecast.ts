/**
 * The time-aware stock forecast. The heart of this module.
 *
 * ══ The one thing this file exists to get right ═══════════════════════════
 *
 * **A forecast is not `total stock − total future requirement`.**
 *
 *     Fifty bath towels in the cupboard.
 *     Friday:   Villa A needs 25.
 *     Saturday: Villa B needs 30.
 *     Friday's towels do not come back clean before Saturday.
 *
 * A total says 50 ≥ 30 and reports nothing. The true answer is that Saturday
 * is five short, and it is knowable on Wednesday. The only way to reach it is
 * to walk the days in order and carry a running position, because the whole
 * subject is *when things come back*: from guest use through the wash, from
 * another property in a van, from a purchase that arrives Thursday.
 *
 * `forecast.test.ts` runs exactly that case and asserts the five. It also runs
 * it with a one-day turnaround, where the honest answer becomes zero, because
 * an engine that always reports a shortage is as useless as one that never
 * does.
 *
 * ══ The walk ══════════════════════════════════════════════════════════════
 *
 * For each (property, item), one pass from today to the horizon:
 *
 *     opening  = what is clean and present at the start of the day
 *     incoming = laundry returns + transfers + stock consumed earlier,
 *                coming back after the turnaround
 *     expected = opening + incoming              ← what the day can draw on
 *     required = the reservations falling on that day
 *     shortage = max(0, required − expected)
 *     closing  = expected − min(required, expected)
 *
 * and the part that makes it a *cycle* rather than a drain: whatever the day
 * actually consumed is scheduled to come back on `date + turnaroundDays`,
 * because a guest house's towels are not consumed, they are circulated.
 *
 * ── Two traps, both of which produce plausible wrong numbers ──────────────
 *
 * **Do not subtract `quantity_reserved` from the opening position.** It is the
 * running total of the very reservations that make up the demand lines. Doing
 * both consumes the same towels twice and manufactures shortages that do not
 * exist — the failure mode that makes people stop reading the screen.
 *
 * **Do not schedule a return without a stated turnaround.** With
 * `linenTurnaroundDays === null` the business has not said how long a wash
 * takes, and the engine schedules nothing. That understates availability. It
 * is the correct direction to be wrong in: over-reporting a shortage costs a
 * phone call, and under-reporting one costs a changeover.
 *
 * ── Where the buffer sits ─────────────────────────────────────────────────
 *
 * The safety buffer never causes a shortage. It is the floor kept for the
 * booking not yet taken, and eating into it is a decision a manager is
 * entitled to make — so a breach is a `warning` beside a satisfied day, never
 * a `critical` on a day that is actually fine. That is the same rule
 * `src/lib/preparation/inventory.ts` already applies, kept identical on
 * purpose: two modules that disagree about what "short" means will eventually
 * show two numbers for one cupboard.
 */

import { addDays } from '../booking/dates'
import { ALLOCATABLE_INVENTORY_STATES } from '../contracts/states'
import { safetyBufferFor } from './settings'
import { buildActions, suggestedActionFrom } from './actions'
import type {
  DemandLine,
  ExpectedReturn,
  ForecastItem,
  ForecastResult,
  ForecastRow,
  InventoryCapabilities,
  InventorySettings,
  ShortageAlert,
  TransferSuggestion,
} from './types'

export interface ForecastInput {
  /** ISO date the walk starts on, in the property's calendar. */
  today: string
  /** Days walked, inclusive of `today`. Clamped to the settings horizon. */
  horizonDays?: number
  settings: InventorySettings
  capabilities: InventoryCapabilities
  items: readonly ForecastItem[]
  /** The claims. Reservations, and nothing invented. */
  demand: readonly DemandLine[]
  /** From the laundry port, from transfers already approved, from purchases. */
  returns: readonly ExpectedReturn[]
  /** `id → name`, for the sentence an alert prints. */
  propertyNames?: ReadonlyMap<string, string>
}

/** The horizons the screens offer. `0` means today alone. */
export const FORECAST_WINDOWS: readonly number[] = [0, 7, 14, 30]

/**
 * The whole forecast, or an honest refusal to compute one.
 *
 * Never throws for a business that has the module off. `computed: false` with
 * a reason is the answer, and the screens print the reason — "nothing to
 * report" and "we do not do this" are different sentences and a caller must
 * not have to guess which an empty list meant.
 */
export function forecastStock(input: ForecastInput): ForecastResult {
  const horizon = clampHorizon(input)
  const from = input.today
  const to = addDays(from, horizon)

  const empty = {
    from,
    to,
    rows: [] as readonly ForecastRow[],
    alerts: [] as readonly ShortageAlert[],
    transfers: [] as readonly TransferSuggestion[],
  }

  if (!input.capabilities.enabled) {
    return { ...empty, computed: false, skippedReason: 'module_off' }
  }
  if (!input.capabilities.forecast) {
    return {
      ...empty,
      computed: false,
      skippedReason: 'no_forecast_capability',
    }
  }
  if (input.items.length === 0) {
    return { ...empty, computed: false, skippedReason: 'no_items' }
  }

  const dates = daysFrom(from, horizon)
  const rows: ForecastRow[] = []
  const alerts: ShortageAlert[] = []

  for (const item of input.items) {
    rows.push(...walkOneItem(item, dates, input))
  }

  for (const row of rows) {
    const alert = alertFor(row, input)
    if (alert !== null) alerts.push(alert)
  }

  alerts.sort(bySeverityThenDate)

  return {
    from,
    to,
    rows,
    alerts,
    transfers: suggestTransfers(rows, input),
    computed: true,
    skippedReason: null,
  }
}

/* ------------------------------------------------------------- the walk -- */

function walkOneItem(
  item: ForecastItem,
  dates: readonly string[],
  input: ForecastInput,
): ForecastRow[] {
  const demand = indexDemand(input.demand, item)
  const known = indexReturns(input.returns, item)
  // Returns this walk schedules for itself: what today consumes, coming back
  // after the turnaround. Kept apart from `known` so the two cannot be
  // double-counted — `known` is batches that have already left, this is stock
  // that has not yet been used.
  const circulated = new Map<string, number>()

  const buffer = safetyBufferFor(input.settings, item)
  const turnaround = input.capabilities.circulation
    ? input.settings.linenTurnaroundDays
    : null

  // The opening position is what is *usable*, not what is owned. Forty sets in
  // a laundry van are the business's property and are not Friday's answer.
  let opening = item.onHandClean
  const out: ForecastRow[] = []

  for (const date of dates) {
    const incoming = (known.get(date) ?? 0) + (circulated.get(date) ?? 0)
    const expectedClean = opening + incoming
    const required = demand.get(date)?.quantity ?? 0
    const shortage = Math.max(0, required - expectedClean)
    const consumed = Math.min(required, expectedClean)
    const closing = expectedClean - consumed

    out.push({
      date,
      propertyId: item.propertyId,
      itemId: item.itemId,
      label: item.label,
      openingClean: opening,
      incoming,
      required,
      expectedClean,
      shortage,
      closingClean: closing,
      safetyBuffer: buffer,
      // Enough for today, and the remainder drops under the floor. Never true
      // on a day that is already short: a day cannot be both.
      breachesBuffer: shortage === 0 && buffer > 0 && closing < buffer,
      reserved: item.reservedTotal,
    })

    // The circulation. This is the line that makes Friday's towels unavailable
    // on Saturday and available again on Sunday.
    if (turnaround !== null && consumed > 0) {
      const back = addDays(date, turnaround)
      circulated.set(back, (circulated.get(back) ?? 0) + consumed)
    }

    opening = closing
  }

  return out
}

/**
 * Only the days that are worth a row.
 *
 * Not used by `walkOneItem` — the walk needs every day, because a position
 * carried forward cannot skip one — but by the screens, which would otherwise
 * render thirty flat rows per item.
 */
export function significantRows(
  rows: readonly ForecastRow[],
  options: { today: string } = { today: '' },
): readonly ForecastRow[] {
  return rows.filter(
    (row) =>
      row.required > 0 ||
      row.shortage > 0 ||
      row.incoming > 0 ||
      row.breachesBuffer ||
      row.date === options.today,
  )
}

/* ---------------------------------------------------------------- alerts -- */

function alertFor(
  row: ForecastRow,
  input: ForecastInput,
): ShortageAlert | null {
  if (row.shortage === 0 && !row.breachesBuffer) return null

  const severity = row.shortage > 0 ? 'critical' : 'warning'
  const daysAhead = daysBetween(input.today, row.date)
  const propertyName = input.propertyNames?.get(row.propertyId) ?? null
  const bookingIds = bookingsFor(input.demand, row)

  const actions = buildActions({
    row,
    capabilities: input.capabilities,
    settings: input.settings,
  })

  return {
    id: `${row.propertyId}:${row.itemId}:${row.date}`,
    severity,
    date: row.date,
    propertyId: row.propertyId,
    propertyName,
    itemId: row.itemId,
    label: row.label,
    required: row.required,
    expectedClean: row.expectedClean,
    shortage: row.shortage,
    safetyBuffer: row.safetyBuffer,
    bookingIds,
    daysAhead,
    message: explain(row, severity),
    suggestedAction: suggestedActionFrom(actions),
    actions,
  }
}

/**
 * The arithmetic, said out loud.
 *
 * Every alert shows the three numbers it came from. A screen that printed
 * "shortage: 6" and nothing else is a black box, and a person cannot tell a
 * real shortage from a stale reservation without opening the database.
 */
export function explain(
  row: ForecastRow,
  severity: 'warning' | 'critical' = row.shortage > 0 ? 'critical' : 'warning',
): string {
  if (severity === 'critical') {
    return (
      `נדרשים ${row.required}, צפויים נקיים ${row.expectedClean}, ` +
      `חסרים ${row.shortage}.`
    )
  }

  return (
    `נדרשים ${row.required}, צפויים נקיים ${row.expectedClean}. ` +
    `נשארים ${row.closingClean} מול מלאי ביטחון ${row.safetyBuffer}.`
  )
}

/**
 * Which alerts are worth raising `inventory.projected_shortage` for.
 *
 * The forecast computes the whole horizon; the *alert* is narrower. A ninety
 * day warning list is a wall nobody reads, and an alert that is never read is
 * worse than no alert because it is believed to be working.
 */
export function alertsWorthRaising(
  alerts: readonly ShortageAlert[],
  settings: InventorySettings,
): readonly ShortageAlert[] {
  return alerts.filter(
    (alert) => alert.daysAhead <= settings.shortageWarningHorizonDays,
  )
}

/**
 * The event name for one alert.
 *
 * `inventory.shortage_detected` is the one somebody is standing in front of;
 * `inventory.projected_shortage` is the one that has not happened yet. The
 * frozen contract keeps them apart because they call for different actions and
 * arrive at different times, and collapsing them here would undo that.
 */
export function eventNameFor(
  alert: ShortageAlert,
): 'inventory.shortage_detected' | 'inventory.projected_shortage' {
  return alert.daysAhead <= 0
    ? 'inventory.shortage_detected'
    : 'inventory.projected_shortage'
}

/* ------------------------------------------------------------- transfers -- */

/**
 * What could be moved instead of bought. Suggestions only.
 *
 * A source only offers what it can spare *for the whole horizon* — the minimum
 * of its closing positions, less its own buffer. Offering a property's Tuesday
 * surplus when it is short on Thursday solves one shortage by creating
 * another, and that is the mistake this function is written to avoid.
 */
function suggestTransfers(
  rows: readonly ForecastRow[],
  input: ForecastInput,
): readonly TransferSuggestion[] {
  if (!input.capabilities.transfers) return []

  const suggestions: TransferSuggestion[] = []
  // Mutated as suggestions are made, so two short properties cannot both be
  // promised the same three pillows.
  const spare = new Map<string, number>()

  for (const row of rows) {
    const key = `${row.propertyId}:${row.itemId}`
    const free = Math.max(0, row.closingClean - row.safetyBuffer)
    const current = spare.get(key)
    spare.set(key, current === undefined ? free : Math.min(current, free))
  }

  const shortages = rows
    .filter((row) => row.shortage > 0)
    .sort((a, b) => a.date.localeCompare(b.date))

  for (const short of shortages) {
    let outstanding = short.shortage

    for (const [key, available] of [...spare.entries()].sort(
      (a, b) => b[1] - a[1],
    )) {
      if (outstanding <= 0) break
      const [propertyId, itemId] = key.split(':')
      if (itemId !== short.itemId) continue
      if (propertyId === short.propertyId) continue
      if (available <= 0) continue

      const quantity = Math.min(available, outstanding)
      spare.set(key, available - quantity)
      outstanding -= quantity

      suggestions.push({
        itemId: short.itemId,
        label: short.label,
        fromPropertyId: propertyId,
        fromPropertyName: input.propertyNames?.get(propertyId) ?? null,
        toPropertyId: short.propertyId,
        toPropertyName: input.propertyNames?.get(short.propertyId) ?? null,
        quantity,
        neededBy: short.date,
        sourceSurplusAfter: available - quantity,
      })
    }
  }

  return suggestions
}

/* ----------------------------------------------------------- shared bits -- */

/**
 * What of an item is clean and usable, from the per-state counts.
 *
 * `ALLOCATABLE_INVENTORY_STATES` is the contract's answer to "what may still be
 * promised", and it has one member today. Reading it rather than writing
 * `=== 'available'` is what makes widening it one edit instead of a search.
 */
export function cleanStockOf(
  byState: Readonly<Partial<Record<string, number>>>,
): number {
  let total = 0
  for (const state of ALLOCATABLE_INVENTORY_STATES) {
    total += byState[state] ?? 0
  }
  return total
}

function clampHorizon(input: ForecastInput): number {
  const asked = input.horizonDays ?? input.settings.forecastHorizonDays
  return Math.max(0, Math.min(asked, input.settings.forecastHorizonDays, 365))
}

function daysFrom(start: string, horizon: number): string[] {
  const out: string[] = []
  for (let offset = 0; offset <= horizon; offset += 1) {
    out.push(addDays(start, offset))
  }
  return out
}

const MS_PER_DAY = 86_400_000

function daysBetween(from: string, to: string): number {
  const left = Date.parse(`${from}T00:00:00Z`)
  const right = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(left) || Number.isNaN(right)) return 0
  return Math.round((right - left) / MS_PER_DAY)
}

interface DayDemand {
  quantity: number
  bookingIds: string[]
}

function indexDemand(
  demand: readonly DemandLine[],
  item: ForecastItem,
): ReadonlyMap<string, DayDemand> {
  const byDate = new Map<string, DayDemand>()

  for (const line of demand) {
    if (line.itemId !== item.itemId) continue
    if (line.propertyId !== item.propertyId) continue

    const existing = byDate.get(line.date) ?? { quantity: 0, bookingIds: [] }
    existing.quantity += line.quantity
    if (
      line.bookingId !== null &&
      !existing.bookingIds.includes(line.bookingId)
    ) {
      existing.bookingIds.push(line.bookingId)
    }
    byDate.set(line.date, existing)
  }

  return byDate
}

function indexReturns(
  returns: readonly ExpectedReturn[],
  item: ForecastItem,
): ReadonlyMap<string, number> {
  const byDate = new Map<string, number>()

  for (const entry of returns) {
    if (entry.itemId !== item.itemId) continue
    if (entry.propertyId !== item.propertyId) continue
    byDate.set(entry.date, (byDate.get(entry.date) ?? 0) + entry.quantity)
  }

  return byDate
}

function bookingsFor(
  demand: readonly DemandLine[],
  row: ForecastRow,
): readonly string[] {
  const ids: string[] = []
  for (const line of demand) {
    if (line.date !== row.date) continue
    if (line.itemId !== row.itemId) continue
    if (line.propertyId !== row.propertyId) continue
    if (line.bookingId === null) continue
    if (!ids.includes(line.bookingId)) ids.push(line.bookingId)
  }
  return ids
}

function bySeverityThenDate(a: ShortageAlert, b: ShortageAlert): number {
  if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1
  const byDate = a.date.localeCompare(b.date)
  if (byDate !== 0) return byDate
  return b.shortage - a.shortage
}
