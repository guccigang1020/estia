/**
 * The forward demand curve.
 *
 * "בשבעה הימים הקרובים: 112 מגבות רחצה ו-74 מערכות מצעים."
 *
 * ── Why this is the screen that sells the module ──────────────────────────
 *
 * Everything else in this directory tells somebody what is happening now. This
 * tells them what is about to, which is the only version of the information
 * that can still be acted on: a shortage found on Friday morning is a problem,
 * and the same shortage seen on Tuesday is a phone call.
 *
 * ── Confirmed bookings only, and the caller enforces it ───────────────────
 *
 * A forecast built from enquiries and options is a forecast that tells a
 * business to buy linen for stays that never happen. `ForecastEntry` carries
 * no status field on purpose: filtering happens in the query, where the
 * booking's own vocabulary lives (`src/lib/booking/types.ts`), and a second
 * definition of "confirmed" inside the laundry module is exactly the kind of
 * drift the frozen contracts exist to stop. `forecast.test.ts` asserts the
 * engine sums what it is given; the query asserts what it is given.
 *
 * ── The horizon is a number, not a menu ───────────────────────────────────
 *
 * The product offers 3, 7, 14 and 30 days, and that offer lives in two places
 * that are allowed to hold business numbers: a check constraint in
 * `0029_laundry.sql` and the screen's own labels. THIS FILE ACCEPTS ANY
 * POSITIVE INTEGER, and `no-hardcoded-numbers.test.ts` proves it by running
 * the forecast over a randomly chosen horizon and asserting the window is that
 * many days long. A horizon baked in here would be a number about the business
 * living in the engine, which is the one thing this module refuses to do.
 */

import type { Requirement } from '../preparation/types'
import { addDays, isoDay } from './dates'
import { profileIndex } from './settings'
import type {
  ForecastDay,
  ForecastEntry,
  ForecastItem,
  LaundryForecast,
  LaundryItemProfile,
  LaundrySettings,
} from './types'

export interface ForecastInput {
  settings: LaundrySettings
  profiles: readonly LaundryItemProfile[]
  /** Confirmed bookings only. See the header. */
  entries: readonly ForecastEntry[]
  /** ISO date the window opens. Usually today. */
  from: string
  /** Overrides the settings' horizon. For a screen offering a choice. */
  horizonDays?: number
  /** Narrow to one property. `null` is every property in the caller's scope. */
  propertyId?: string | null
}

/**
 * Build the curve.
 *
 * Every day in the window appears, including the empty ones. A forecast that
 * omitted quiet days would render as a dense wall of work and hide the gaps
 * that are the whole point of looking forward.
 */
export function buildForecast(input: ForecastInput): LaundryForecast {
  const { settings, profiles, entries, from } = input
  const horizonDays = Math.max(
    1,
    input.horizonDays ?? settings.forecastHorizonDays,
  )
  const propertyId = input.propertyId ?? null

  const index = profileIndex(profiles)
  const to = addDays(from, horizonDays - 1)

  const inWindow = entries.filter((entry) => {
    if (propertyId !== null && entry.propertyId !== propertyId) return false
    const day = isoDay(`${entry.requiredOn}T00:00:00.000Z`)
    return day >= from && day <= to
  })

  const days: ForecastDay[] = []
  const running = new Map<string, ForecastItem>()

  for (let offset = 0; offset < horizonDays; offset += 1) {
    const date = addDays(from, offset)
    const onThisDay = inWindow.filter((entry) => entry.requiredOn === date)

    const items = new Map<string, ForecastItem>()

    for (const entry of onThisDay) {
      for (const requirement of entry.requirements) {
        const profile = index.get(requirement.itemId)
        // The same filter the engine applies, for the same reason: a forecast
        // that counted mattresses and coffee would be a forecast of
        // preparation, which already has its own screen.
        if (!profile || !profile.laundryManaged || !profile.washable) continue

        add(items, profile, requirement)
        add(running, profile, requirement)
      }
    }

    const list = sorted(items)

    days.push({
      date,
      items: list,
      units: list.reduce((sum, item) => sum + item.quantity, 0),
      bookingIds: onThisDay.map((entry) => entry.bookingId),
    })
  }

  const totals = sorted(running)

  return {
    from,
    to,
    horizonDays,
    days,
    totals,
    bookingCount: inWindow.length,
    headline: headlineFor(horizonDays, totals),
  }
}

/**
 * Add one canonical requirement into a running tally.
 *
 * `requirement.quantity` is COPIED. The forecast is a sum of numbers
 * preparation produced; it does not know how many guests there are and must
 * never learn.
 *
 * The item's laundry buffer is deliberately NOT applied here. A forecast is a
 * demand curve, and the buffer is spare capacity ordered against damage — a
 * curve inflated by it would make a business buy linen for a shortage it does
 * not have. The buffer appears when an order is built, which is where it is
 * actually needed.
 */
function add(
  into: Map<string, ForecastItem>,
  profile: LaundryItemProfile,
  requirement: Requirement,
): void {
  const existing = into.get(profile.itemId)

  into.set(profile.itemId, {
    itemId: profile.itemId,
    label: profile.label,
    unit: profile.unit,
    quantity: (existing?.quantity ?? 0) + requirement.quantity,
  })
}

/** Biggest first: what a manager needs to act on is at the top. */
function sorted(items: Map<string, ForecastItem>): readonly ForecastItem[] {
  return [...items.values()].sort((a, b) => b.quantity - a.quantity)
}

/**
 * The headline, as one Hebrew sentence.
 *
 * Named items, not a total. "בשבעה הימים הקרובים, 186 פריטים" is a number
 * nobody can act on; the two items that dominate the week are the ones
 * somebody counts in a cupboard.
 */
export function headlineFor(
  horizonDays: number,
  totals: readonly ForecastItem[],
): string {
  const window = `ב-${horizonDays} הימים הקרובים`

  if (totals.length === 0) {
    return `${window} אין דרישות כביסה מהזמנות מאושרות.`
  }

  const named = totals
    .map((item) => `${item.quantity} ${item.label}`)
    .join(', ')

  return `${window}: ${named}.`
}

/**
 * The day with the most work in the window.
 *
 * The forecast's most useful single fact after the total, because it is where
 * a shortage will actually happen — demand is not spread evenly and a week's
 * total divided by seven has never once described a real Friday.
 */
export function busiestDay(forecast: LaundryForecast): ForecastDay | null {
  return forecast.days.reduce<ForecastDay | null>(
    (busiest, day) =>
      busiest === null || day.units > busiest.units ? day : busiest,
    null,
  )
}
