/**
 * Shabbat: which day it is, and — honestly — what this module cannot tell you
 * about when it starts.
 *
 * ## The limitation, stated up front
 *
 * Shabbat begins at sunset on Friday and ends at nightfall on Saturday. Both
 * are **astronomical events**: they depend on the observer's latitude,
 * longitude, elevation and the day of the year, and neither can be derived
 * from a calendar date alone. Jerusalem and Eilat are 250km apart and light
 * candles minutes apart; Haifa and Tel Aviv differ again. On top of that, the
 * customary candle-lighting offset before sunset is itself local — 40 minutes
 * in Jerusalem, 18 or 20 elsewhere — and nightfall has several competing
 * halakhic definitions.
 *
 * The legacy product did not compute these times, and neither does this
 * module. **No clock time here is invented.** `shabbatWindow` returns the two
 * civil dates the boundary falls on and `null` for both times, and
 * `SHABBAT_TIMES_UNAVAILABLE` says why. A guesthouse that needs real candle-
 * lighting times needs a property location and a solar-position calculation,
 * and that is a separate, deliberate piece of work — not something to fake
 * with a fixed offset that would be wrong by up to an hour across the country
 * and across the year.
 *
 * What this module *can* say with certainty is which civil day is Shabbat and
 * which evening it begins on, and that is enough for the calendar grid,
 * for "is this booking over a Shabbat", and for pricing a weekend.
 */

import { addDays, dayOfWeek, fixedToIso, isoToFixed } from './gregorian'
import type { DayOfWeek, IsoDate } from './types'

/** Weekday indices, named. Shabbat is Saturday; erev Shabbat is Friday. */
const FRIDAY: DayOfWeek = 5
const SATURDAY: DayOfWeek = 6

/**
 * Why every time field in `ShabbatWindow` is `null`.
 *
 * Exported so a UI can show the reason rather than an empty cell, and so that
 * nobody later mistakes the nulls for a bug and "fixes" them with a guess.
 */
export const SHABBAT_TIMES_UNAVAILABLE =
  'זמני כניסת ויציאת השבת תלויים במיקום גאוגרפי ובחישוב זריחה ושקיעה, ' +
  'ואינם ניתנים לחישוב מתאריך בלבד. המודול מספק את גבולות היום בלבד.'

/** English form of the same limitation, for logs and developer messages. */
export const SHABBAT_TIMES_UNAVAILABLE_EN =
  'Candle-lighting and havdalah times depend on the property location and a ' +
  'solar calculation, and cannot be derived from a date alone. This module ' +
  'reports the day boundary only.'

/** Is this civil date Shabbat? */
export function isShabbat(iso: IsoDate): boolean {
  return dayOfWeek(iso) === SATURDAY
}

/** Is this civil date erev Shabbat — the Friday Shabbat comes in on? */
export function isErevShabbat(iso: IsoDate): boolean {
  return dayOfWeek(iso) === FRIDAY
}

/**
 * The day boundary of a Shabbat.
 *
 * Times are deliberately absent; see the file header and
 * `SHABBAT_TIMES_UNAVAILABLE`.
 */
export interface ShabbatWindow {
  /** The Saturday itself, `YYYY-MM-DD`. */
  shabbatDate: IsoDate
  /** The Friday on whose evening Shabbat begins. Always the day before. */
  beginsEveningOf: IsoDate
  /** The Saturday on whose evening Shabbat ends. Same day as `shabbatDate`. */
  endsEveningOf: IsoDate
  /**
   * Never a time. `null` means "not computed", never "no candle lighting".
   * See `SHABBAT_TIMES_UNAVAILABLE`.
   */
  candleLighting: null
  havdalah: null
}

function windowForSaturday(saturday: IsoDate): ShabbatWindow {
  return {
    shabbatDate: saturday,
    beginsEveningOf: addDays(saturday, -1),
    endsEveningOf: saturday,
    candleLighting: null,
    havdalah: null,
  }
}

/**
 * The Shabbat of the week containing `iso`.
 *
 * The week is taken as Sunday–Saturday, the Hebrew convention, so every date
 * resolves to the Shabbat that *closes* its week: Sunday looks forward six
 * days, Friday looks forward one, Saturday returns itself.
 */
export function shabbatWindow(iso: IsoDate): ShabbatWindow {
  return windowForSaturday(addDays(iso, SATURDAY - dayOfWeek(iso)))
}

/**
 * Every Shabbat falling in `[from, to]`, inclusive of both ends.
 *
 * Returned as civil dates because that is what a calendar grid and a pricing
 * table both key on.
 */
export function shabbatDatesBetween(from: IsoDate, to: IsoDate): IsoDate[] {
  const start = isoToFixed(from)
  const end = isoToFixed(to)
  // Compared as day numbers rather than as strings: ISO ordering happens to
  // match chronological ordering for four-digit years and stops doing so
  // outside them, and a calendar should not depend on that coincidence.
  const dates: IsoDate[] = []
  for (
    let fixed = start + ((SATURDAY - dayOfWeek(from) + 7) % 7);
    fixed <= end;
    fixed += 7
  ) {
    dates.push(fixedToIso(fixed))
  }
  return dates
}
