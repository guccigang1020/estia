/**
 * Whether a message may wake somebody now, and when it may go if not.
 *
 * ── Two rules, and both of them are about honesty rather than politeness ──
 *
 *   · Quiet hours **defer**, they never drop. A held delivery is a row with
 *     `status = 'deferred'` and a `scheduled_for`, so "nothing was sent" and
 *     "it is waiting until seven" are different states on the screen, and a
 *     business can tell which one it is looking at. 0043 has a check
 *     constraint refusing a `deferred` row with no time, because a deferral
 *     with no time is a message that never goes.
 *
 *   · Quiet hours apply to the channels that **interrupt** — email, SMS,
 *     WhatsApp, push — and never to `in_app`. In-app is pull: opening the
 *     product at eight in the morning and finding what happened overnight is
 *     the point of the channel, not an interruption. Suppressing it overnight
 *     would produce a business with no record of its own nights.
 *
 * ── Why the arithmetic is done here and only the answer is stored ─────────
 *
 * `notification_deliveries.scheduled_for` is `timestamptz`, in UTC. The
 * wall-clock reasoning — "22:00 to 07:00 in Asia/Jerusalem, and the window
 * crosses midnight" — happens once, in this file, and what reaches the
 * database is an instant. A column holding a local time would make every
 * reader re-derive the zone, and the third reader would get it wrong.
 *
 * ── The one approximation, stated ─────────────────────────────────────────
 *
 * `windowEndsAt` adds the remaining minutes to the current instant. Across a
 * daylight-saving transition inside the quiet window that is off by an hour —
 * a message released at 06:00 or 08:00 instead of 07:00, twice a year. The
 * alternative is a full local-midnight reconstruction for a difference nobody
 * can perceive in a notification, so the approximation is deliberate and is
 * written down rather than discovered.
 */

import {
  isPushChannel,
  overridesQuietHours,
  type NotificationChannel,
  type NotificationSettings,
  type NotificationSeverity,
} from './types'

/* --------------------------------------------------------------- clock -- */

/** `HH:MM` as minutes past local midnight. `-1` for anything unparseable. */
export function minutesOfDay(time: string): number {
  const match = /^(\d{1,2}):(\d{2})/.exec(time.trim())
  if (!match) return -1

  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return -1

  return hours * 60 + minutes
}

/** The local wall-clock time at `instant`, in `timeZone`, as minutes. */
export function localMinutes(instant: Date, timeZone: string): number {
  // `en-GB` with `hourCycle: 'h23'` renders `23:40`, and `h23` rather than
  // `h24` because `h24` renders midnight as `24:00` and this would then be
  // 1440 rather than 0 — an off-by-a-whole-day at the one moment quiet hours
  // are most likely to be tested.
  const rendered = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant)

  return minutesOfDay(rendered)
}

/**
 * Is `minute` inside `[start, end)`, on a clock that wraps at midnight?
 *
 * The wrap is the ordinary case, not the exception: 22:00–07:00 is what quiet
 * hours look like in every business that has them, and a naive `start <= m &&
 * m < end` is silent for exactly nobody between those hours.
 */
export function withinWindow(
  minute: number,
  start: number,
  end: number,
): boolean {
  if (start === end) return false
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end
}

/* --------------------------------------------------------------- rules -- */

export type QuietHoursVerdict =
  /** Send it. Either quiet hours are off, or we are outside them. */
  | { held: false }
  /** Hold it. `until` is when it becomes sendable, as an instant. */
  | { held: true; until: Date }

/**
 * May this channel carry this severity, at this instant, for this business?
 *
 * The order of the four refusals is the order in which they stop being
 * questions:
 *
 *   1. `in_app` is never held. It does not interrupt anybody.
 *   2. Quiet hours switched off is switched off.
 *   3. Urgent and critical pass, when the organization allows it — a card
 *      processor down at midnight is a business that wants to be woken, and
 *      `urgentOverridesQuietHours` defaults to true for that reason.
 *   4. Otherwise: are we inside the window?
 */
export function quietHoursVerdict(args: {
  channel: NotificationChannel
  severity: NotificationSeverity
  settings: Pick<
    NotificationSettings,
    | 'quietHoursEnabled'
    | 'quietHoursStart'
    | 'quietHoursEnd'
    | 'timezone'
    | 'urgentOverridesQuietHours'
  >
  now: Date
}): QuietHoursVerdict {
  const { channel, severity, settings, now } = args

  if (!isPushChannel(channel)) return { held: false }
  if (!settings.quietHoursEnabled) return { held: false }
  if (settings.urgentOverridesQuietHours && overridesQuietHours(severity)) {
    return { held: false }
  }

  const start = minutesOfDay(settings.quietHoursStart)
  const end = minutesOfDay(settings.quietHoursEnd)
  // An unparseable window is not a licence to wake somebody at three in the
  // morning. Fail towards silence: the message is written either way, and the
  // in-app channel is unaffected, so the cost of being wrong in this direction
  // is a delay and the cost of being wrong in the other is a telephone call.
  if (start < 0 || end < 0) return { held: true, until: nextHour(now) }

  const minute = localMinutes(now, settings.timezone)
  if (minute < 0) return { held: true, until: nextHour(now) }

  if (!withinWindow(minute, start, end)) return { held: false }

  return { held: true, until: windowEndsAt(now, minute, end) }
}

/**
 * When the current quiet window ends, as an instant.
 *
 * See the header for the daylight-saving approximation this makes.
 */
export function windowEndsAt(now: Date, minute: number, end: number): Date {
  const remaining = minute < end ? end - minute : 1440 - minute + end
  return new Date(now.getTime() + remaining * 60_000)
}

function nextHour(now: Date): Date {
  return new Date(now.getTime() + 60 * 60_000)
}

/**
 * The window as a person reads it, for the settings screen.
 *
 * Returns `null` when quiet hours are off, so a screen cannot accidentally
 * print "22:00–22:00" and imply a rule that is not running.
 */
export function describeQuietHours(
  settings: Pick<
    NotificationSettings,
    'quietHoursEnabled' | 'quietHoursStart' | 'quietHoursEnd'
  >,
): string | null {
  if (!settings.quietHoursEnabled) return null
  return `${settings.quietHoursStart}–${settings.quietHoursEnd}`
}
