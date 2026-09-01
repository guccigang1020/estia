/**
 * Day arithmetic, done in UTC and without a millisecond constant.
 *
 * Two rules, both of which exist because of a specific way this goes wrong.
 *
 * **Days are added through the calendar, not through milliseconds.** The
 * obvious `instant + days * 86_400_000` is wrong twice a year: Israel moves its
 * clocks, and a forecast window built by adding a fixed number of milliseconds
 * loses or gains an hour across the boundary and silently drops a day off the
 * end of a thirty-day horizon. `setUTCDate` walks the calendar and cannot.
 *
 * **Hours are added through milliseconds, and that is fine.** A turnaround of
 * 48 hours is a duration, not a calendar step: a provider who says "back in two
 * days" means two days of machines running, and if the clocks change in between
 * the linen is still back after 48 hours of washing. The two cases genuinely
 * differ, and using one mechanism for both is what produces an off-by-one that
 * nobody can reproduce in July.
 *
 * There is no timezone conversion here at all. A required-by is an instant and
 * is compared to another instant; a forecast day is a UTC calendar date and is
 * only ever compared to another one. Mixing the two is the third way this goes
 * wrong, and keeping the two shapes in different functions is what stops it.
 */

/** Milliseconds in an hour. Both factors are facts about the clock. */
const MS_PER_HOUR = 60 * 60 * 1000

/** The UTC calendar date of an instant, as `YYYY-MM-DD`. */
export function isoDay(instant: string | Date): string {
  const at = typeof instant === 'string' ? new Date(instant) : instant
  if (Number.isNaN(at.getTime())) return ''
  return at.toISOString().split('T')[0] ?? ''
}

/** The first instant of a UTC calendar date. */
export function startOfDay(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00.000Z`).toISOString()
}

/**
 * `days` calendar days after `isoDate`, as a UTC calendar date.
 *
 * Negative offsets walk backwards, which is what a "collect this many days
 * before it is needed" rule asks for.
 */
export function addDays(isoDate: string, days: number): string {
  const at = new Date(`${isoDate}T00:00:00.000Z`)
  if (Number.isNaN(at.getTime())) return ''
  at.setUTCDate(at.getUTCDate() + days)
  return isoDay(at)
}

/** `hours` after `instant`, as an ISO instant. A duration, not a calendar step. */
export function addHours(instant: string, hours: number): string {
  const at = new Date(instant)
  if (Number.isNaN(at.getTime())) return ''
  return new Date(at.getTime() + hours * MS_PER_HOUR).toISOString()
}

/**
 * Hours from `from` to `to`, rounded up, never below zero.
 *
 * Rounded up because the question it answers is "how late is this", and being
 * twenty minutes late is being an hour late as far as somebody standing in an
 * unmade bedroom is concerned. Clamped at zero so a caller can sort by it
 * without treating a comfortable margin as a negative shortfall.
 */
export function hoursBetween(from: string, to: string): number {
  const start = new Date(from).getTime()
  const end = new Date(to).getTime()
  if (Number.isNaN(start) || Number.isNaN(end)) return 0
  return Math.max(0, Math.ceil((end - start) / MS_PER_HOUR))
}

/** Is `a` strictly after `b`. Both ISO instants. */
export function isAfter(a: string, b: string): boolean {
  return new Date(a).getTime() > new Date(b).getTime()
}

/** The earlier of two ISO instants. Empty strings lose to a real one. */
export function earliest(a: string, b: string): string {
  if (a.length === 0) return b
  if (b.length === 0) return a
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b
}

/**
 * There is deliberately no weekday helper here.
 *
 * Pickup and delivery days are stored as ISO weekday numbers and they are
 * PRESENTATION: a screen renders "אוסף בימי ראשון ורביעי", and the arithmetic
 * that would turn "Wednesday" into "the next Wednesday on or after the 4th"
 * needs the length of a week as a literal. That is a fact about the calendar
 * rather than about towels and it would pass any honest review — but it would
 * also be the first non-structural number in this directory, and the value of
 * `no-hardcoded-numbers.test.ts` is entirely in it having no exceptions.
 *
 * Nothing in the engine needs it. `assessTurnaround` takes the collection
 * instant it is given rather than inferring one, which is the more honest
 * design anyway: the van comes when the van comes, and a computed "next
 * Wednesday" that ignores a public holiday is a confident wrong answer where
 * an explicit input is a correct one. The weekday labels live in
 * `src/app/(app)/laundry/_lib/labels.ts`.
 */
