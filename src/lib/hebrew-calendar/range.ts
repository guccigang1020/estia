/**
 * What a date range contains, calendrically.
 *
 * This is the function pricing and staffing actually call. Everything else in
 * the module exists so that this one can answer, for a proposed stay: which
 * nights are Shabbat, which are yom tov, which fall in chol hamoed, and which
 * sit inside bein hazmanim — the four facts that move an Israeli guesthouse's
 * nightly rate and its rota.
 *
 * The range convention is the booking domain's, half-open `[checkIn,
 * checkOut)`: the guest does not occupy the check-out night, so a Friday-to-
 * Sunday stay has two nights, one of which is Shabbat, and the Sunday is not
 * counted. Getting this wrong in a pricing engine charges for a night nobody
 * slept, which is the kind of error a guest notices and a manager cannot
 * explain.
 */

import { fixedToIso, isoToFixed } from './gregorian'
import { isShabbat, shabbatDatesBetween } from './shabbat'
import { specialDaysBetween, specialDaysOn } from './special-days'
import type { IsoDate, SpecialDay, StayRange } from './types'

/** What the calendar has to say about a stay. */
export interface RangeCalendarSummary {
  /** Nights occupied: `checkOut − checkIn`. Zero for a same-day range. */
  nights: number
  /** Every occupied night that is a Saturday. */
  shabbatDates: IsoDate[]
  /** Festival days on which work is forbidden. */
  yomTov: SpecialDay[]
  /** Intermediate days of Pesach and Sukkot, Hoshana Rabbah included. */
  cholHaMoed: SpecialDay[]
  /** Fasts, Purim, Chanukah, national days and festival eves. */
  minorHolidays: SpecialDay[]
  /** Yeshiva vacation days, including those masked by a festival. */
  beinHazmanim: SpecialDay[]
  /**
   * The nights that carry a premium: Shabbat, yom tov and chol hamoed.
   *
   * Deduplicated and sorted. Bein hazmanim is deliberately *not* in here —
   * it is a demand signal spanning three weeks at a time, not a per-night
   * surcharge, and rolling it in would silently mark most of Nisan as peak.
   */
  peakDates: IsoDate[]
}

/** Half-open `[checkIn, checkOut)` as an inclusive pair, or `null` if empty. */
function inclusiveNightBounds(
  range: StayRange,
): { from: IsoDate; to: IsoDate } | null {
  const checkIn = isoToFixed(range.checkIn)
  const checkOut = isoToFixed(range.checkOut)
  if (checkOut <= checkIn) return null
  return { from: fixedToIso(checkIn), to: fixedToIso(checkOut - 1) }
}

/**
 * Every special day falling on an occupied night of a stay.
 *
 * Half-open: the check-out date is excluded. A guest checking out on the
 * morning of Yom Kippur was not staying for Yom Kippur.
 */
export function specialDaysInStay(range: StayRange): SpecialDay[] {
  const bounds = inclusiveNightBounds(range)
  if (!bounds) return []
  return specialDaysBetween(bounds.from, bounds.to)
}

/** Every occupied night of a stay that is Shabbat. */
export function shabbatNightsInStay(range: StayRange): IsoDate[] {
  const bounds = inclusiveNightBounds(range)
  if (!bounds) return []
  return shabbatDatesBetween(bounds.from, bounds.to)
}

/**
 * The full calendrical picture of a stay.
 *
 * A reversed or zero-length range yields an empty summary rather than an
 * error: availability code passes ranges around freely and an exception here
 * would turn a validation problem into a crash in the pricing path. Range
 * validity is the booking domain's business, not the calendar's.
 */
export function summarizeStay(range: StayRange): RangeCalendarSummary {
  const bounds = inclusiveNightBounds(range)
  if (!bounds) {
    return {
      nights: 0,
      shabbatDates: [],
      yomTov: [],
      cholHaMoed: [],
      minorHolidays: [],
      beinHazmanim: [],
      peakDates: [],
    }
  }

  const nights = isoToFixed(range.checkOut) - isoToFixed(range.checkIn)
  const special = specialDaysBetween(bounds.from, bounds.to)
  const shabbatDates = shabbatDatesBetween(bounds.from, bounds.to)

  const yomTov = special.filter((day) => day.kind === 'yom_tov')
  const cholHaMoed = special.filter((day) => day.kind === 'chol_hamoed')

  const peak = new Set<IsoDate>(shabbatDates)
  for (const day of [...yomTov, ...cholHaMoed]) peak.add(day.date)

  return {
    nights,
    shabbatDates,
    yomTov,
    cholHaMoed,
    minorHolidays: special.filter((day) => day.kind === 'minor'),
    beinHazmanim: special.filter((day) => day.kind === 'bein_hazmanim'),
    peakDates: [...peak].sort((a, b) => isoToFixed(a) - isoToFixed(b)),
  }
}

/**
 * Is this single night a premium one — Shabbat, yom tov or chol hamoed?
 *
 * The per-night form of `peakDates`, for callers pricing a night at a time.
 */
export function isPeakNight(iso: IsoDate): boolean {
  if (isShabbat(iso)) return true
  return specialDaysOn(iso).some(
    (day) => day.kind === 'yom_tov' || day.kind === 'chol_hamoed',
  )
}
