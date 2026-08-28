/**
 * The Hebrew calendar contract.
 *
 * Ported from the frozen legacy product (`_reference/estia_live.html`), which
 * has run a real guesthouse for years. The arithmetic there is the standard
 * fixed-calendar algorithm and it is correct; what it lacked was types, names
 * and any proof. This module supplies all three.
 *
 * Two conventions bind everything here:
 *
 *   1. **Dates cross the wire as ISO `YYYY-MM-DD` strings**, matching the rest
 *      of the domain (see `src/lib/booking/types.ts`). No `Date` objects in the
 *      public API: a `Date` carries a time zone, and a calendar date does not.
 *
 *   2. **A Hebrew date is attached to a civil date, not to a moment.** The
 *      Hebrew day actually begins at sunset the previous evening, so the
 *      mapping here is the conventional daytime one: the Hebrew date returned
 *      for 2026-04-02 is the one in force during the daylight of that civil
 *      day. `hebrewDayBeginsEveningOf` makes the offset explicit rather than
 *      leaving it as folklore.
 */

// ── Civil dates ───────────────────────────────────────────────────────────

/**
 * A civil date in the proleptic Gregorian calendar, `YYYY-MM-DD`.
 *
 * Proleptic matters: the calendar arithmetic runs the Gregorian rules back
 * past 1582 without a Julian switchover, exactly as the legacy code did and as
 * every computational calendar library does. It is only visible for dates
 * centuries before the product's range.
 */
export type IsoDate = string

/**
 * A Rata Die fixed day number: days elapsed since the (proleptic) Gregorian
 * date 0001-01-01, which is RD 1.
 *
 * This is the pivot every conversion goes through. The legacy code called it
 * `abs` and hard-coded 719163 as the RD of 1970-01-01; the same constant
 * appears here, named.
 */
export type FixedDay = number

/** 0 = Sunday … 6 = Saturday, matching `Date.prototype.getDay`. */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6

// ── Hebrew dates ──────────────────────────────────────────────────────────

/**
 * Hebrew month numbers, in the biblical ordering the legacy code used.
 *
 * The ordering is a genuine trap, so it is spelled out. Months are numbered
 * from Nisan, but the *year* turns at Tishrei (month 7). So within Hebrew year
 * 5786, Tishrei (7) comes first and Elul (6) comes last, and 1 Nisan 5786
 * falls roughly six months *after* 1 Tishrei 5786.
 *
 * Adar is the other trap. In a common year there is one Adar, number 12. In a
 * leap year there are two: Adar I is 12 and Adar II is 13. Purim, and a
 * yahrzeit, fall in Adar II — the *second* Adar — which is why 12 is not
 * simply "the Adar".
 */
export const HEBREW_MONTH = {
  nisan: 1,
  iyar: 2,
  sivan: 3,
  tammuz: 4,
  av: 5,
  elul: 6,
  tishrei: 7,
  cheshvan: 8,
  kislev: 9,
  tevet: 10,
  shevat: 11,
  /** Adar in a common year; Adar I ("Adar Rishon") in a leap year. */
  adar: 12,
  /** Adar II ("Adar Sheni"). Exists in leap years only. */
  adarII: 13,
} as const

export type HebrewMonth = (typeof HEBREW_MONTH)[keyof typeof HEBREW_MONTH]

/** A date in the Hebrew calendar. */
export interface HebrewDate {
  /** Anno Mundi, e.g. 5786. Always the full year, never abbreviated. */
  year: number
  month: HebrewMonth
  /** 1-based, 1…30. */
  day: number
}

/**
 * The only six lengths a Hebrew year can have.
 *
 * Common years are 353 (deficient), 354 (regular) or 355 (complete); leap
 * years add a 30-day Adar I to each, giving 383, 384 and 385. Anything else
 * means the arithmetic is broken, which is why the test suite asserts this for
 * every year in its range rather than trusting it.
 */
export const HEBREW_YEAR_LENGTHS = [353, 354, 355, 383, 384, 385] as const

export type HebrewYearLength = (typeof HEBREW_YEAR_LENGTHS)[number]

/**
 * How a year distributes its variable days.
 *
 * Cheshvan and Kislev are the calendar's shock absorbers: the postponement
 * rules fix Rosh Hashanah first, and these two months then stretch or shrink
 * to make the year come out to a legal length.
 *
 *   - `deficient`  — Kislev is 29 days (year length ends in 3)
 *   - `regular`    — Cheshvan 29, Kislev 30 (ends in 4)
 *   - `complete`   — Cheshvan is 30 days (ends in 5)
 */
export type HebrewYearKind = 'deficient' | 'regular' | 'complete'

// ── Special days ──────────────────────────────────────────────────────────

/**
 * What kind of day this is, commercially.
 *
 * These are the legacy `HOL` table's four types, renamed. The order below is
 * also the precedence order when several apply to one date — see
 * `SPECIAL_DAY_PRECEDENCE`.
 *
 *   - `bein_hazmanim` — the yeshiva holiday periods. Not a holy day at all,
 *     but the single biggest driver of Israeli guesthouse occupancy, which is
 *     why the legacy product tracked it alongside the festivals.
 *   - `minor` — fasts, Purim, Chanukah, the modern national days, and the
 *     eves of the major festivals. Work is permitted.
 *   - `chol_hamoed` — the intermediate days of Pesach and Sukkot. Peak
 *     domestic-tourism weeks in Israel.
 *   - `yom_tov` — the festival days themselves, on which work is forbidden.
 */
export type SpecialDayKind =
  'bein_hazmanim' | 'minor' | 'chol_hamoed' | 'yom_tov'

/**
 * Precedence when more than one special day lands on the same civil date.
 *
 * Ported verbatim from the legacy `PRI` map. Bein hazmanim is deliberately
 * lowest: the Tishrei period covers all of Sukkot, and a calendar cell reading
 * "bein hazmanim" on Yom Kippur would be useless. Higher wins.
 */
export const SPECIAL_DAY_PRECEDENCE: Record<SpecialDayKind, number> = {
  bein_hazmanim: 1,
  minor: 2,
  chol_hamoed: 3,
  yom_tov: 4,
}

/** One special day, resolved onto a civil date. */
export interface SpecialDay {
  /** The civil date it is observed on, `YYYY-MM-DD`. */
  date: IsoDate
  /** The Hebrew date of that civil day. */
  hebrewDate: HebrewDate
  /** Full Hebrew name, e.g. `חול המועד פסח`. */
  name: string
  /** Abbreviated Hebrew name for calendar cells, e.g. `חוה״מ פסח`. */
  shortName: string
  kind: SpecialDayKind
}

// ── Ranges ────────────────────────────────────────────────────────────────

/**
 * A stay, half-open as `[checkIn, checkOut)`.
 *
 * Structurally identical to `DateRange` in `src/lib/booking/types.ts` and it
 * means the same thing — the guest does not occupy the check-out night. It is
 * restated rather than imported so that the calendar has no dependency on the
 * booking module; a calendar that cannot be used without the booking domain is
 * a calendar that will be copied instead of reused.
 */
export interface StayRange {
  /** Inclusive first night, `YYYY-MM-DD`. */
  checkIn: IsoDate
  /** Exclusive, `YYYY-MM-DD`. The guest leaves on this date. */
  checkOut: IsoDate
}
