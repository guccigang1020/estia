/**
 * Whether the business is in its quiet window right now.
 *
 * ── Why this is not `notifications/quiet-hours.ts`, and why it imports it ──
 *
 * That module answers a different question. It asks whether one *delivery* on
 * one *channel* at one *severity* may go out, and it answers with a deferral
 * instant, because a notification that is held is a row with a `scheduled_for`
 * and a screen that says "waiting until seven". Autopilot has no delivery, no
 * channel and no severity at this point: it is deciding whether an ACTION may
 * be automatic, and quiet hours narrow that to `ask_approval` rather than
 * postponing anything. Handing `quietHoursVerdict` a fabricated channel and a
 * fabricated severity to extract a boolean out of it would be a lie in the
 * arguments to get an answer out of the wrong question.
 *
 * What is genuinely shared is the clock — parsing `HH:MM`, rendering a local
 * wall-clock minute in a named zone, and knowing that a window from 22:00 to
 * 07:00 wraps midnight. Those three are imported rather than rewritten, so
 * there is exactly one implementation of the midnight wrap in the product and
 * the daylight-saving reasoning in that file's header covers this one too.
 *
 * ── The window itself does not live in `autopilot_settings` ───────────────
 *
 * 0046 stores briefing times, not a quiet window: a business has one quiet
 * window and it already configured it on the notifications screen. So this
 * takes the window as an argument, and the caller reads it from
 * `notification_settings` — one answer to "when may ESTIA disturb people",
 * asked by two modules.
 */

import {
  localMinutes,
  minutesOfDay,
  withinWindow,
} from '../../notifications/quiet-hours'

/** The business's quiet window, as the notifications settings store it. */
export interface QuietWindow {
  enabled: boolean
  /** `HH:MM`, local to `timezone`. */
  start: string
  end: string
  /** An IANA zone name — `Asia/Jerusalem`. */
  timezone: string
}

/**
 * Is `now` inside the window?
 *
 * An unparseable window answers `true`, which is the same direction
 * `quietHoursVerdict` fails in and for a smaller version of the same reason.
 * Here the cost of being wrong towards quiet is that an action a business
 * would have let run automatically waits for somebody to press a button; the
 * cost of being wrong the other way is a guest's telephone at 03:00. Those are
 * not comparable, so a broken configuration is treated as night.
 */
export function inQuietHours(window: QuietWindow, now: Date): boolean {
  if (!window.enabled) return false

  const start = minutesOfDay(window.start)
  const end = minutesOfDay(window.end)
  if (start < 0 || end < 0) return true

  const minute = localMinuteOrUnknown(now, window.timezone)
  if (minute < 0) return true

  return withinWindow(minute, start, end)
}

/**
 * The local minute, or `-1` when the zone name is not one `Intl` knows.
 *
 * `Intl.DateTimeFormat` throws a `RangeError` on an unrecognised zone rather
 * than falling back to UTC, and a settings row carrying `Asia/Jerusalm` would
 * otherwise take down the whole policy engine on a typo. It is caught here and
 * turned into the same "cannot tell" the unparseable window produces, so both
 * failures fail in the same direction.
 */
function localMinuteOrUnknown(now: Date, timeZone: string): number {
  try {
    return localMinutes(now, timeZone)
  } catch {
    return -1
  }
}
