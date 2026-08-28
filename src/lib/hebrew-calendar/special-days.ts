/**
 * Festivals, fasts, chol hamoed and bein hazmanim.
 *
 * A port of the legacy `HOL` table, with one structural change and no
 * behavioural ones.
 *
 * **The structural change.** The legacy built `HOL` once, at page load, for
 * the seven Hebrew years around `new Date().getFullYear()`. That is a calendar
 * that stops working — silently, returning "no holiday" rather than an error —
 * for any date more than about four years out, which is inside the horizon of
 * a guesthouse taking bookings for next Sukkot but not this one. Here the
 * table is computed per Hebrew year, on demand, and memoised. Any year works.
 *
 * **What was not changed.** Every date rule, every Hebrew name and the
 * precedence between overlapping days are the legacy's, verbatim. In
 * particular the festival set is the **Israeli** one — one day of yom tov, so
 * Shemini Atzeret and Simchat Torah are the same 22 Tishrei and chol hamoed
 * Pesach runs 16–20 Nisan. That is correct for an Israeli guesthouse and
 * wrong for a diaspora one, and it is a product decision rather than a bug.
 *
 * **What the table does not contain.** The legacy list is not the complete set
 * of Jewish observances, and this port did not invent additions. Absent, and
 * therefore never returned: Rosh Chodesh, Tzom Gedaliah, Asara BeTevet,
 * Ta'anit Esther, Purim Katan, Yom HaShoah, Yom Yerushalayim, Sigd, and the
 * eves of Sukkot and Shavuot. Adding any of them is a product decision with a
 * pricing consequence, not a defect to be quietly fixed in a port.
 */

import {
  daysInHebrewMonth,
  fixedToHebrew,
  hebrewNewYear,
  hebrewToFixed,
  purimAdar,
  toHebrewDate,
} from './arithmetic'
import { fixedDayOfWeek, fixedToIso, isoToFixed } from './gregorian'
import type {
  FixedDay,
  HebrewMonth,
  IsoDate,
  SpecialDay,
  SpecialDayKind,
} from './types'
import { HEBREW_MONTH, SPECIAL_DAY_PRECEDENCE } from './types'

// ── Building one Hebrew year ──────────────────────────────────────────────

const SATURDAY = 6
const MONDAY = 1
const FRIDAY = 5

/**
 * Every special day of one Hebrew year, keyed by civil date.
 *
 * Each entry is ordered by descending precedence, so `[0]` is the day's
 * headline and the rest is context. The legacy kept only the headline; a
 * guesthouse rota wants to know that Purim also falls inside bein hazmanim,
 * so nothing is discarded here.
 */
function buildHebrewYear(hebrewYear: number): Map<IsoDate, SpecialDay[]> {
  const entries: SpecialDay[] = []

  /** Fixed day of a Hebrew date in this year. */
  const at = (month: HebrewMonth, day: number): FixedDay =>
    hebrewToFixed({ year: hebrewYear, month, day })

  const put = (
    fixed: FixedDay,
    name: string,
    shortName: string,
    kind: SpecialDayKind,
  ): void => {
    entries.push({
      date: fixedToIso(fixed),
      hebrewDate: fixedToHebrew(fixed),
      name,
      shortName,
      kind,
    })
  }

  const span = (
    fromFixed: FixedDay,
    toFixed: FixedDay,
    name: string,
    shortName: string,
    kind: SpecialDayKind,
  ): void => {
    for (let fixed = fromFixed; fixed <= toFixed; fixed += 1) {
      put(fixed, name, shortName, kind)
    }
  }

  const adar = purimAdar(hebrewYear)

  // Insertion order is the legacy's, and it is load-bearing: ties within one
  // precedence band are resolved first-wins, so reordering these blocks could
  // change which name a date reports.

  // ── Bein hazmanim ──
  // The yeshiva vacations. Not holy days, but they empty the cities and fill
  // the guesthouses, which is why the legacy tracked them at all.
  for (const period of beinHazmanimSpans(hebrewYear)) {
    span(
      period.fromFixed,
      period.toFixed,
      period.name,
      period.shortName,
      'bein_hazmanim',
    )
  }

  // ── Chol hamoed ──
  // Israeli reckoning: the intermediate days run 16–20, because there is one
  // day of yom tov at each end rather than two.
  span(
    at(HEBREW_MONTH.nisan, 16),
    at(HEBREW_MONTH.nisan, 20),
    'חול המועד פסח',
    'חוה״מ פסח',
    'chol_hamoed',
  )
  span(
    at(HEBREW_MONTH.tishrei, 16),
    at(HEBREW_MONTH.tishrei, 20),
    'חול המועד סוכות',
    'חוה״מ סוכות',
    'chol_hamoed',
  )
  // Hoshana Rabbah closes chol hamoed Sukkot; it is not itself yom tov.
  put(at(HEBREW_MONTH.tishrei, 21), 'הושענא רבה', 'הושענא רבה', 'chol_hamoed')

  // ── Yom tov ──
  put(at(HEBREW_MONTH.tishrei, 1), 'ראש השנה', 'ראש השנה', 'yom_tov')
  put(at(HEBREW_MONTH.tishrei, 2), 'ראש השנה ב׳', 'ראש השנה', 'yom_tov')
  put(at(HEBREW_MONTH.tishrei, 10), 'יום כיפור', 'יום כיפור', 'yom_tov')
  put(at(HEBREW_MONTH.tishrei, 15), 'סוכות', 'סוכות', 'yom_tov')
  // In Israel Shemini Atzeret and Simchat Torah are one day, 22 Tishrei.
  put(at(HEBREW_MONTH.tishrei, 22), 'שמחת תורה', 'שמחת תורה', 'yom_tov')
  put(at(HEBREW_MONTH.nisan, 15), 'פסח', 'פסח', 'yom_tov')
  put(at(HEBREW_MONTH.nisan, 21), 'שביעי של פסח', 'שביעי של פסח', 'yom_tov')
  put(at(HEBREW_MONTH.sivan, 6), 'שבועות', 'שבועות', 'yom_tov')

  // ── Minor days ──
  put(at(HEBREW_MONTH.tishrei, 9), 'ערב יום כיפור', 'ערב כיפור', 'minor')
  // 29 Elul: the last day of the outgoing year, whatever its length.
  put(at(HEBREW_MONTH.elul, 29), 'ערב ראש השנה', 'ערב ר״ה', 'minor')
  put(at(HEBREW_MONTH.nisan, 14), 'ערב פסח', 'ערב פסח', 'minor')

  // Chanukah runs eight days from 25 Kislev. Counted in fixed days rather
  // than Hebrew days on purpose: in a deficient year Kislev has 29 days and
  // the festival runs into Tevet, and day arithmetic would have to know that.
  for (let night = 0; night < 8; night += 1) {
    put(
      at(HEBREW_MONTH.kislev, 25) + night,
      `חנוכה · נר ${night + 1}`,
      'חנוכה',
      'minor',
    )
  }

  put(at(HEBREW_MONTH.shevat, 15), 'ט״ו בשבט', 'ט״ו בשבט', 'minor')
  // Purim falls in the *second* Adar of a leap year — see `purimAdar`.
  put(at(adar, 14), 'פורים', 'פורים', 'minor')
  put(at(adar, 15), 'שושן פורים', 'שושן פורים', 'minor')
  put(at(HEBREW_MONTH.iyar, 18), 'ל״ג בעומר', 'ל״ג בעומר', 'minor')
  put(at(HEBREW_MONTH.av, 15), 'ט״ו באב', 'ט״ו באב', 'minor')

  // Both summer fasts are postponed a day when they fall on Shabbat, which
  // may not be a fast day. (17 Tammuz and 9 Av can only ever land on Shabbat,
  // never on Friday, so one forward step is the whole rule.)
  put(postponeOffShabbat(at(HEBREW_MONTH.av, 9)), 'תשעה באב', 'ט׳ באב', 'minor')
  put(
    postponeOffShabbat(at(HEBREW_MONTH.tammuz, 17)),
    'צום י״ז בתמוז',
    'י״ז בתמוז',
    'minor',
  )

  // Yom HaAtzmaut is 5 Iyar, moved by law so that Yom HaZikaron — the day
  // before — never abuts Shabbat: Friday or Shabbat pulls it back to
  // Thursday, Monday pushes it on to Tuesday.
  const independence = adjustIndependenceDay(at(HEBREW_MONTH.iyar, 5))
  put(independence, 'יום העצמאות', 'העצמאות', 'minor')
  put(independence - 1, 'יום הזיכרון', 'יום הזיכרון', 'minor')

  return groupByDate(entries)
}

/** A fast may not be kept on Shabbat, so it moves to Sunday. */
function postponeOffShabbat(fixed: FixedDay): FixedDay {
  return fixedDayOfWeek(fixed) === SATURDAY ? fixed + 1 : fixed
}

/**
 * The statutory adjustment of Independence Day.
 *
 * Israeli law moves 5 Iyar so that neither Yom HaZikaron nor Yom HaAtzmaut
 * runs into Shabbat: Friday → Thursday, Shabbat → Thursday, Monday → Tuesday.
 * (Monday is moved because Yom HaZikaron would otherwise begin on Saturday
 * night, immediately after Shabbat, leaving no time to prepare.)
 */
function adjustIndependenceDay(fixed: FixedDay): FixedDay {
  const weekday = fixedDayOfWeek(fixed)
  if (weekday === FRIDAY) return fixed - 1
  if (weekday === SATURDAY) return fixed - 2
  if (weekday === MONDAY) return fixed + 1
  return fixed
}

function groupByDate(entries: SpecialDay[]): Map<IsoDate, SpecialDay[]> {
  const byDate = new Map<IsoDate, SpecialDay[]>()
  for (const entry of entries) {
    const existing = byDate.get(entry.date)
    if (existing) existing.push(entry)
    else byDate.set(entry.date, [entry])
  }
  // Stable sort by descending precedence: equal-precedence days keep the
  // legacy's insertion order, which is what decided ties there too.
  for (const list of byDate.values()) {
    list.sort(
      (a, b) => SPECIAL_DAY_PRECEDENCE[b.kind] - SPECIAL_DAY_PRECEDENCE[a.kind],
    )
  }
  return byDate
}

// ── Bein hazmanim ─────────────────────────────────────────────────────────

interface BeinHazmanimSpan {
  name: string
  shortName: string
  fromFixed: FixedDay
  toFixed: FixedDay
}

/**
 * The three bein hazmanim periods of a Hebrew year, as fixed-day spans.
 *
 * Nisan 1–22, Av 10–30 and Tishrei 1–23, exactly as the legacy had them. They
 * bracket Pesach, the Nine Days and the Tishrei festival run respectively.
 */
function beinHazmanimSpans(hebrewYear: number): BeinHazmanimSpan[] {
  const at = (month: HebrewMonth, day: number): FixedDay =>
    hebrewToFixed({ year: hebrewYear, month, day })
  return [
    {
      name: 'בין הזמנים ניסן',
      shortName: 'בין הזמנים',
      fromFixed: at(HEBREW_MONTH.nisan, 1),
      toFixed: at(HEBREW_MONTH.nisan, 22),
    },
    {
      name: 'בין הזמנים אב',
      shortName: 'בין הזמנים',
      fromFixed: at(HEBREW_MONTH.av, 10),
      toFixed: at(
        HEBREW_MONTH.av,
        daysInHebrewMonth(hebrewYear, HEBREW_MONTH.av),
      ),
    },
    {
      name: 'בין הזמנים תשרי',
      shortName: 'בין הזמנים',
      fromFixed: at(HEBREW_MONTH.tishrei, 1),
      toFixed: at(HEBREW_MONTH.tishrei, 23),
    },
  ]
}

/** One bein hazmanim period as civil dates, inclusive of both ends. */
export interface BeinHazmanimPeriod {
  name: string
  shortName: string
  from: IsoDate
  to: IsoDate
}

/**
 * The bein hazmanim periods of a Hebrew year.
 *
 * Exposed separately from `specialDaysBetween` because staffing plans a
 * *period*, not a list of days: "we are fully booked for the three weeks of
 * bein hazmanim Nisan" is the shape of the question.
 */
export function beinHazmanimPeriods(hebrewYear: number): BeinHazmanimPeriod[] {
  return beinHazmanimSpans(hebrewYear).map((period) => ({
    name: period.name,
    shortName: period.shortName,
    from: fixedToIso(period.fromFixed),
    to: fixedToIso(period.toFixed),
  }))
}

// ── Lookup ────────────────────────────────────────────────────────────────

/**
 * Built years, memoised.
 *
 * Unbounded, deliberately. The key is a Hebrew year, so the cache can only
 * grow to the number of distinct years the process is ever asked about — a
 * booking system reaches a few decades either side of today, which is a few
 * hundred entries of a hundred-odd days each. There is no eviction to write
 * because there is no growth to bound.
 */
const yearCache = new Map<number, Map<IsoDate, SpecialDay[]>>()

function hebrewYearTable(hebrewYear: number): Map<IsoDate, SpecialDay[]> {
  const cached = yearCache.get(hebrewYear)
  if (cached) return cached
  const table = buildHebrewYear(hebrewYear)
  yearCache.set(hebrewYear, table)
  return table
}

/**
 * Every special day of a Hebrew year, in civil-date order.
 *
 * The days of a Hebrew year are contiguous in fixed-day terms, and every rule
 * above is anchored inside its own year — Chanukah crosses Kislev into Tevet
 * but never into the next Rosh Hashanah — so one year's table is complete on
 * its own and lookups never need to consult a neighbour.
 */
export function hebrewYearSpecialDays(hebrewYear: number): SpecialDay[] {
  return [...hebrewYearTable(hebrewYear).values()]
    .flat()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

/**
 * Everything that applies to a civil date, highest precedence first.
 *
 * Usually empty or one entry; two when a named day falls inside bein hazmanim,
 * which most of Pesach and Sukkot does.
 */
export function specialDaysOn(iso: IsoDate): SpecialDay[] {
  const hebrewYear = toHebrewDate(iso).year
  return hebrewYearTable(hebrewYear).get(iso) ?? []
}

/**
 * The single special day a calendar cell should show, or `null`.
 *
 * This is the legacy `HOL[key]` lookup: one entry per date, precedence
 * resolved.
 */
export function specialDayOn(iso: IsoDate): SpecialDay | null {
  return specialDaysOn(iso)[0] ?? null
}

/** Is this civil date chol hamoed (Pesach or Sukkot, Hoshana Rabbah included)? */
export function isCholHaMoed(iso: IsoDate): boolean {
  return specialDaysOn(iso).some((day) => day.kind === 'chol_hamoed')
}

/**
 * Is this civil date inside a bein hazmanim period?
 *
 * Deliberately checks *all* the day's entries, not just the headline one. The
 * legacy could only ever report bein hazmanim on a date where nothing else
 * happened, which made all of Pesach look like term time.
 */
export function isBeinHazmanim(iso: IsoDate): boolean {
  return specialDaysOn(iso).some((day) => day.kind === 'bein_hazmanim')
}

/** Is this civil date yom tov — a festival day on which work is forbidden? */
export function isYomTov(iso: IsoDate): boolean {
  return specialDaysOn(iso).some((day) => day.kind === 'yom_tov')
}

/**
 * Every special day in `[from, to]`, inclusive of both ends, in date order.
 *
 * Inclusive because this answers "what is in this stretch of calendar". For a
 * booking, whose check-out date is not occupied, use `specialDaysInStay`.
 */
export function specialDaysBetween(from: IsoDate, to: IsoDate): SpecialDay[] {
  const start = isoToFixed(from)
  const end = isoToFixed(to)
  const found: SpecialDay[] = []
  for (let fixed = start; fixed <= end; fixed += 1) {
    found.push(...specialDaysOn(fixedToIso(fixed)))
  }
  return found
}

/** The Hebrew years any part of `[fromFixed, toFixed]` falls in. */
export function hebrewYearsSpanning(from: IsoDate, to: IsoDate): number[] {
  const first = toHebrewDate(from).year
  const last = toHebrewDate(to).year
  const years: number[] = []
  for (let year = first; year <= last; year += 1) years.push(year)
  return years
}

/** Rosh Hashanah of `hebrewYear` as a civil date. */
export function roshHashanahDate(hebrewYear: number): IsoDate {
  return fixedToIso(hebrewNewYear(hebrewYear))
}
