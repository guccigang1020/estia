/**
 * What Autopilot was worth this month — and the honest half of that sentence.
 *
 * ── Six counts and one estimate ───────────────────────────────────────────
 *
 * Actions automated, issues prevented, reminders sent, shortages detected,
 * bookings protected and manual tasks avoided are COUNTS. They are sums over
 * rows the execution layer already wrote, and this file adds them up and does
 * nothing else to them.
 *
 * Time saved is an ESTIMATE, and it is a different kind of thing. Nobody
 * measured how long a manager would have taken to draft that laundry order,
 * because the manager did not draft it. The figure is a per-action-kind
 * minutes table multiplied by counts, and every part of that sentence is a
 * judgment somebody should be able to disagree with.
 *
 * ── Why the estimate is a class and not a number ──────────────────────────
 *
 * "ESTIA saved you 47 hours" is the single most quotable line this product
 * will ever produce, and it will end up on a slide. If it can be rendered as a
 * bare number, it will be — and then it is a measurement claim the business
 * cannot support.
 *
 * So `TimeSavedEstimate` has no `minutes` property. The number lives inside
 * `method`, next to the table it came from and the sentence saying it is not
 * measured, so any code path that reaches the figure is already holding the
 * thing that explains it. `formatted` and `toString` both carry the word
 * הערכה, and the constructor is private, so nothing outside this file can
 * fabricate an estimate with an empty method. Making that a property of the
 * type rather than a note in a comment is the whole point: comments do not
 * survive a rushed dashboard.
 *
 * There is deliberately no `valueOf`. `Number(estimate)` is `NaN` rather than
 * a quiet 2820, so arithmetic on the estimate fails where it is written.
 */

import { AUTOPILOT_ACTIONS, type AutopilotActionKind } from '../actions'

/* ---------------------------------------------------------- minutes table -- */

/**
 * How long the same thing takes a person, by hand, in minutes.
 *
 * HEURISTIC — every row. These are estimates of ordinary office work, not
 * measurements of anybody's day, and they are exported so a customer who
 * thinks drafting a laundry order takes them two minutes rather than seven can
 * say so and see the report change. A number that cannot be argued with is a
 * number nobody believes twice.
 *
 * The values include the work AROUND the action as well as the action —
 * noticing it was needed, finding the row, deciding — because that is what a
 * person actually spends, and counting only the keystrokes would understate
 * every line by the same amount.
 */
export const MINUTES_PER_ACTION: Readonly<Record<AutopilotActionKind, number>> =
  {
    'brief.compose': 12,
    'exception.raise': 2,
    'readiness.explain': 4,

    'task.create': 3,
    'task.assign': 2,
    'preparation.generate': 8,
    'workplan.publish': 6,
    'stock_count.request': 3,
    'laundry.draft_order': 7,
    'hold.release_expired': 2,
    'inventory.flag_shortage': 4,
    'maintenance.raise_priority': 2,

    'guest.send_reminder': 4,
    'guest.send_arrival_info': 5,
    'guest.request_review': 3,
    'cleaner.notify': 2,
    'cleaner.escalate': 4,
    'laundry.send_order': 5,
    'laundry.request_earlier': 6,
    'provider.chase': 4,
    'agent.remind': 3,
    'team.notify': 2,

    'price.suggest': 10,
    'upsell.offer': 5,
    'opportunity.publish': 8,
    'booking.suggest_extension': 6,
    'inventory.suggest_transfer': 7,
    'procurement.draft': 12,

    'payment.request': 5,
    'access.issue_code': 3,
    'access.revoke_code': 3,
    'booking.cancel': 10,
    'payment.refund': 8,
  }

/**
 * Which actions count as a reminder.
 *
 * Named rather than derived from the safety level, because `team.notify` and
 * `guest.send_arrival_info` are external communications and are not reminders
 * — one is an alert to staff and the other is information the guest was owed.
 */
export const REMINDER_KINDS: readonly AutopilotActionKind[] = [
  'guest.send_reminder',
  'agent.remind',
  'provider.chase',
  'cleaner.escalate',
]

/* ------------------------------------------------------------- the estimate -- */

export interface EstimateLine {
  kind: AutopilotActionKind
  /** Hebrew, from the action catalogue. One label, not two. */
  label: string
  minutesEach: number
  count: number
  minutes: number
}

export interface EstimateMethod {
  /** The word that marks the figure. Hebrew. */
  qualifier: string
  /** Every kind that contributed. The reader's way to disagree. */
  table: readonly EstimateLine[]
  /** The sum. Inside the method, deliberately — see the file header. */
  totalMinutes: number
  /** Hebrew: how it was computed, and what it is not. */
  disclaimer: string
}

const QUALIFIER = 'הערכה'

const DISCLAIMER =
  'המספר הוא הערכה ולא מדידה. הוא מחושב לפי טבלת דקות משוערת לכל סוג ' +
  'פעולה, מוכפלת במספר הפעמים שהפעולה בוצעה. איש לא מדד כמה זמן הפעולות ' +
  'האלה היו לוקחות בפועל.'

/** Hebrew, `4 שעות ו-20 דקות`. Whole minutes; nothing here rounds a count. */
export function formatMinutes(total: number): string {
  const hours = Math.floor(total / 60)
  const minutes = total % 60

  if (hours === 0) return `${minutes} דקות`
  if (minutes === 0) return `${hours} שעות`
  return `${hours} שעות ו-${minutes} דקות`
}

/**
 * An estimated duration that cannot be rendered without saying so.
 *
 * The constructor is private and `from` is the only way in, so every instance
 * has a method with a table and a disclaimer. There is no `minutes` field on
 * the instance: the figure is `method.totalMinutes`, which a caller reaches
 * only by holding the object that explains it.
 */
export class TimeSavedEstimate {
  readonly method: EstimateMethod
  /** The only renderable form. Always carries the qualifier. */
  readonly formatted: string

  private constructor(method: EstimateMethod, formatted: string) {
    this.method = method
    this.formatted = formatted
  }

  static from(table: readonly EstimateLine[]): TimeSavedEstimate {
    const totalMinutes = table.reduce((sum, line) => sum + line.minutes, 0)

    const method: EstimateMethod = {
      qualifier: QUALIFIER,
      table,
      totalMinutes,
      disclaimer: DISCLAIMER,
    }

    return new TimeSavedEstimate(
      method,
      `${QUALIFIER}: כ-${formatMinutes(totalMinutes)} של עבודה ידנית`,
    )
  }

  /** So even a careless string coercion carries the word. */
  toString(): string {
    return this.formatted
  }
}

/* ---------------------------------------------------------------- report -- */

export interface ValueInputs {
  window: { from: string; to: string }
  /**
   * How many of each action actually ran, from `autopilot_actions`.
   *
   * Counts of executed rows, supplied by the caller. Nothing here decides what
   * "executed" means — `ExecutionOutcome` in `types.ts` already does, including
   * the `executed_unaudited` case, and a second opinion about it here would be
   * exactly the drift the module contract forbids.
   */
  executed: Readonly<Partial<Record<AutopilotActionKind, number>>>
  /**
   * Exceptions resolved before their deadline passed.
   *
   * Counted by the caller from `autopilot_exceptions`, because "prevented"
   * means the deadline and the resolution are compared — and that comparison
   * belongs to whoever owns the exception, not here.
   */
  issuesPrevented: number
  /** Bookings at least one prevented issue touched. Deduplicated here. */
  bookingIdsProtected: readonly string[]
}

export interface AutomationValueReport {
  window: { from: string; to: string }
  /** Counts. Every one of these is a sum over rows. */
  actionsAutomated: number
  issuesPrevented: number
  remindersSent: number
  shortagesDetected: number
  bookingsProtected: number
  manualTasksAvoided: number
  /** An estimate, and typed so it cannot be shown as anything else. */
  timeSaved: TimeSavedEstimate
  /** Hebrew, for the top of the screen. */
  caption: string
}

function countOf(
  executed: Readonly<Partial<Record<AutopilotActionKind, number>>>,
  kind: AutopilotActionKind,
): number {
  return executed[kind] ?? 0
}

/**
 * Build the report.
 *
 * The six counts come first and are plain arithmetic. The estimate comes last
 * and is built from the same counts through the minutes table, so the two can
 * never disagree about how many actions there were.
 */
export function buildValueReport(inputs: ValueInputs): AutomationValueReport {
  const kinds = Object.keys(AUTOPILOT_ACTIONS) as AutopilotActionKind[]

  let actionsAutomated = 0
  let remindersSent = 0
  let manualTasksAvoided = 0
  const table: EstimateLine[] = []

  for (const kind of kinds) {
    const count = countOf(inputs.executed, kind)
    if (count === 0) continue

    const spec = AUTOPILOT_ACTIONS[kind]
    actionsAutomated += count
    if (REMINDER_KINDS.includes(kind)) remindersSent += count
    // "Manual task avoided" is the internal, reversible work somebody would
    // otherwise have done by hand. External communication is a message that
    // had to be sent either way, so it is counted as a reminder and not as a
    // task avoided — counting it as both would double the same minute.
    if (spec.safety === 'safe_internal') manualTasksAvoided += count

    const minutesEach = MINUTES_PER_ACTION[kind]
    table.push({
      kind,
      label: spec.label,
      minutesEach,
      count,
      minutes: minutesEach * count,
    })
  }

  // Largest contribution first: a reader arguing with the estimate should meet
  // the line that moves it most.
  table.sort((a, b) => b.minutes - a.minutes || a.kind.localeCompare(b.kind))

  const bookingsProtected = new Set(inputs.bookingIdsProtected).size
  const timeSaved = TimeSavedEstimate.from(table)

  return {
    window: inputs.window,
    actionsAutomated,
    issuesPrevented: inputs.issuesPrevented,
    remindersSent,
    shortagesDetected: countOf(inputs.executed, 'inventory.flag_shortage'),
    bookingsProtected,
    manualTasksAvoided,
    timeSaved,
    caption:
      `בין ${inputs.window.from} ל-${inputs.window.to} בוצעו ` +
      `${actionsAutomated} פעולות אוטומטיות. ${timeSaved.formatted}.`,
  }
}
