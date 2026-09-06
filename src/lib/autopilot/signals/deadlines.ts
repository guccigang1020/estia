/**
 * When something should have happened, in the time zone where it happens.
 *
 * ── A deadline is a wall clock, never a UTC instant ───────────────────────
 *
 * "The cleaner should start by 11:00" means eleven at the property. At 22:30
 * UTC it is already tomorrow in Israel, and a deadline built by slicing an ISO
 * string files a 23:30 job under the wrong day and reports it as twenty-three
 * hours early. `action-center/_lib/queries.ts` makes the same argument about
 * `localDate` and `PROPERTY_TIME_ZONE`, and this is that argument applied to
 * the time of day as well as the date.
 *
 * So a `Deadline` is a property-local date and a property-local `HH:MM`, and
 * `zonedInstant` is the single place either becomes a real instant.
 *
 * ── Two ways to name a target, one grader ─────────────────────────────────
 *
 * Some expectations are wall-clock — "arrival information goes out at 10:00 on
 * the day of arrival". Others are relative — "the contract should be signed
 * seventy-two hours before the guest walks in", which is an offset from
 * another instant and has no wall clock of its own. Both end as an instant and
 * both are graded by `gradeInstant`, so there is exactly one comparison in
 * this file and exactly one place a threshold can be read wrong.
 *
 * ── The thresholds are policy and are never defaulted here ────────────────
 *
 * "Two hours before arrival" is a long time for a studio and no time at all
 * for a wedding — `preparation/readiness.ts` says it first and it is just as
 * true here. Every threshold is an input. A default in this file would be a
 * business number in an engine, and it would be the number every customer
 * silently ran on.
 */

import { PROPERTY_TIME_ZONE } from '../../booking/dates'
import type { AutopilotRiskState } from '../../contracts/states'
import type { Evidence } from '../types'

const MINUTE_MS = 60_000
const SECOND_MS = 1_000

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const WALL_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/

/* ------------------------------------------------------- zone arithmetic -- */

/**
 * How far the zone is from UTC at a given instant.
 *
 * Formatting the instant in the zone and reading it back as though it were UTC
 * gives the offset by subtraction. This is the only mechanism available
 * without a timezone database, and it is exact: `Intl` carries the real rules,
 * including the year Israel moved its clocks on a different weekend.
 */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)

  const read = (type: string): number => {
    const found = parts.find((part) => part.type === type)
    return found === undefined ? 0 : Number(found.value)
  }

  const asIfUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  )
  // The formatted parts have no milliseconds, so the instant is floored to the
  // second before subtracting. Without that the offset comes back a few
  // hundred milliseconds out and every deadline is fractionally wrong.
  return asIfUtc - Math.floor(at.getTime() / SECOND_MS) * SECOND_MS
}

/**
 * A property-local date and wall clock, as a real instant.
 *
 * Two passes, and the second is the one that matters. The first guess uses the
 * offset in force at the naive time; if the target sits on the far side of a
 * clock change that offset is wrong by an hour, so the offset is read again at
 * the guessed instant and applied. Israel changes its clocks at 02:00, when
 * nothing in this product is scheduled, so the genuinely ambiguous hour is not
 * reachable by any deadline the operation sets — and where it were, this
 * resolves to the offset in force after the transition, which is the later of
 * the two readings and therefore the safer one for a deadline.
 */
export function zonedInstant(
  date: string,
  time: string,
  timeZone: string = PROPERTY_TIME_ZONE,
): Date {
  if (!ISO_DATE.test(date)) {
    throw new RangeError(`Not a property-local date: ${date}`)
  }
  if (!WALL_CLOCK.test(time)) {
    throw new RangeError(`Not a property-local wall clock: ${time}`)
  }

  const naive = Date.parse(`${date}T${time}:00Z`)
  if (Number.isNaN(naive)) throw new RangeError(`Not a date: ${date}T${time}`)

  const firstGuess = new Date(naive - zoneOffsetMs(new Date(naive), timeZone))
  return new Date(naive - zoneOffsetMs(firstGuess, timeZone))
}

/** The wall clock at the property, `HH:MM`. "it is now 13:42". */
export function localTime(
  at: Date,
  timeZone: string = PROPERTY_TIME_ZONE,
): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at)
}

/** Whole minutes from `from` to `to`. Negative once `to` has passed. */
export function minutesBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MINUTE_MS)
}

/* ------------------------------------------------------------- deadlines -- */

export interface Deadline {
  /** Property-local calendar date, `YYYY-MM-DD`. */
  date: string
  /** Property-local wall clock, `HH:MM`. */
  time: string
  /** Minutes before the target at which this becomes `at_risk`. */
  warnMinutesBefore: number
  /** Minutes before the target at which this becomes `critical`. */
  criticalMinutesBefore: number
  timeZone?: string
}

export interface DeadlineVerdict {
  /** Never `ready`. Time alone cannot tell you a thing was done. */
  state: Exclude<AutopilotRiskState, 'ready'>
  targetAt: string
  warnAt: string
  criticalAt: string
  /** Negative once the target has passed. */
  minutesRemaining: number
  overdue: boolean
}

/**
 * Grade a target instant against the clock.
 *
 * The one comparison in this file. `warn` must fire before `critical`, so a
 * policy that has them the wrong way round is corrected rather than obeyed:
 * obeying it would produce a deadline that goes critical and then relaxes to
 * at-risk as it approaches, which is not a thing any person would believe.
 */
export function gradeInstant(
  targetAt: Date,
  warnMinutesBefore: number,
  criticalMinutesBefore: number,
  now: Date,
): DeadlineVerdict {
  const critical = Math.max(0, criticalMinutesBefore)
  const warn = Math.max(critical, Math.max(0, warnMinutesBefore))

  const warnAt = new Date(targetAt.getTime() - warn * MINUTE_MS)
  const criticalAt = new Date(targetAt.getTime() - critical * MINUTE_MS)
  const minutesRemaining = minutesBetween(now, targetAt)

  const state: Exclude<AutopilotRiskState, 'ready'> =
    now.getTime() >= criticalAt.getTime()
      ? 'critical'
      : now.getTime() >= warnAt.getTime()
        ? 'at_risk'
        : 'on_track'

  return {
    state,
    targetAt: targetAt.toISOString(),
    warnAt: warnAt.toISOString(),
    criticalAt: criticalAt.toISOString(),
    minutesRemaining,
    overdue: minutesRemaining < 0,
  }
}

/** The same grading, for a target stated as a property-local wall clock. */
export function gradeDeadline(deadline: Deadline, now: Date): DeadlineVerdict {
  const targetAt = zonedInstant(
    deadline.date,
    deadline.time,
    deadline.timeZone ?? PROPERTY_TIME_ZONE,
  )
  return gradeInstant(
    targetAt,
    deadline.warnMinutesBefore,
    deadline.criticalMinutesBefore,
    now,
  )
}

/* ----------------------------------------------------------- expectation -- */

/**
 * One thing that was supposed to happen, and whether it has.
 *
 * `satisfiedAt` is what lets the grader answer `ready`, and it is the only
 * thing that can. Time never proves a job was done — it only ever proves how
 * long there is left to do it.
 */
export interface Expectation {
  key: string
  /** Hebrew. "החוזה נחתם". */
  label: string
  /** ISO instant. `null` when it has not happened. */
  satisfiedAt: string | null
}

export interface ExpectationVerdict {
  state: AutopilotRiskState
  deadline: DeadlineVerdict
  evidence: readonly Evidence[]
}

/**
 * Grade an expectation whose target is a wall clock at the property.
 *
 * The evidence is built here rather than by each caller so that every screen
 * says the deadline the same way — "היעד: 15:00, נותרו 78 דקות" — and so that
 * "it is now 13:42" comes from the same clock that produced the verdict.
 */
export function gradeExpectation(
  expectation: Expectation,
  deadline: Deadline,
  now: Date,
): ExpectationVerdict {
  const timeZone = deadline.timeZone ?? PROPERTY_TIME_ZONE
  const verdict = gradeDeadline(deadline, now)
  const state: AutopilotRiskState =
    expectation.satisfiedAt === null ? verdict.state : 'ready'

  return {
    state,
    deadline: verdict,
    evidence: deadlineEvidence(expectation, verdict, now, timeZone),
  }
}

/** The same, for a target that is an offset from another instant. */
export function gradeRelativeExpectation(
  expectation: Expectation,
  target: {
    /** The instant the offset is measured back from — usually the arrival. */
    anchorAt: string
    /** How many hours before the anchor this should have happened. */
    hoursBefore: number
    warnMinutesBefore: number
    criticalMinutesBefore: number
  },
  now: Date,
  timeZone: string = PROPERTY_TIME_ZONE,
): ExpectationVerdict {
  const anchor = new Date(target.anchorAt)
  if (Number.isNaN(anchor.getTime())) {
    throw new RangeError(`Not an instant: ${target.anchorAt}`)
  }
  // Hours are a duration and are added in milliseconds, exactly as
  // `laundry/dates.ts` argues: a provider who says "two days" means machine
  // hours, and walking the calendar for that would move the answer twice a
  // year. A wall-clock deadline walks the calendar; this one does not.
  const targetAt = new Date(
    anchor.getTime() - target.hoursBefore * 60 * MINUTE_MS,
  )
  const verdict = gradeInstant(
    targetAt,
    target.warnMinutesBefore,
    target.criticalMinutesBefore,
    now,
  )
  const state: AutopilotRiskState =
    expectation.satisfiedAt === null ? verdict.state : 'ready'

  return {
    state,
    deadline: verdict,
    evidence: deadlineEvidence(expectation, verdict, now, timeZone),
  }
}

function deadlineEvidence(
  expectation: Expectation,
  verdict: DeadlineVerdict,
  now: Date,
  timeZone: string,
): readonly Evidence[] {
  const target = new Date(verdict.targetAt)
  const evidence: Evidence[] = [
    {
      key: `${expectation.key}.target`,
      label: 'היעד',
      value: localTime(target, timeZone),
      source: 'deadlines',
      observedAt: verdict.targetAt,
    },
    {
      key: `${expectation.key}.now`,
      label: 'השעה כעת',
      value: localTime(now, timeZone),
      source: 'deadlines',
      observedAt: now.toISOString(),
    },
    {
      key: `${expectation.key}.minutes_remaining`,
      label: verdict.overdue ? 'דקות באיחור' : 'דקות שנותרו',
      value: Math.abs(verdict.minutesRemaining),
      source: 'deadlines',
    },
  ]

  if (expectation.satisfiedAt !== null) {
    evidence.push({
      key: `${expectation.key}.satisfied`,
      label: expectation.label,
      value: localTime(new Date(expectation.satisfiedAt), timeZone),
      source: 'deadlines',
      observedAt: expectation.satisfiedAt,
    })
  }
  return evidence
}
