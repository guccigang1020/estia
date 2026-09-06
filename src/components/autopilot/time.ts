/**
 * When something happened, rendered at the property rather than at the server.
 *
 * Every timestamp Autopilot stores is a `timestamptz`, and every one of them
 * is read by somebody standing in a guesthouse in Israel. Rendering with the
 * runtime's default zone would file an action taken at 00:30 local under the
 * previous day on the one screen whose entire subject is when things happened
 * — the same conversion `action-center/_lib/queries.ts` makes with `localDate`
 * for exactly the same reason.
 *
 * ── Why there is no "לפני 5 דקות" here ────────────────────────────────────
 *
 * A relative time is computed from the reader's clock and re-computed on every
 * render, so a server-rendered "לפני 5 דקות" is stale the moment it is sent and
 * is a hydration mismatch waiting to happen. The activity log is a record; a
 * record says 14:07, and 14:07 is still true tomorrow.
 *
 * No `'use client'`, and no imports beyond one date constant, so this stays
 * usable from either side of the boundary.
 */

import { PROPERTY_TIME_ZONE } from '@/lib/booking/dates'

const DATE_TIME = new Intl.DateTimeFormat('he-IL', {
  timeZone: PROPERTY_TIME_ZONE,
  dateStyle: 'short',
  timeStyle: 'short',
})

const TIME_ONLY = new Intl.DateTimeFormat('he-IL', {
  timeZone: PROPERTY_TIME_ZONE,
  timeStyle: 'short',
})

/**
 * A stored instant as date and time at the property.
 *
 * Returns `null` for an unparseable value rather than `Invalid Date`. A field
 * that cannot be read must render as absent, and the caller decides what to
 * print in its place — which is never a silently wrong date.
 */
export function formatMoment(value: string | null): string | null {
  if (value === null) return null
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return null
  return DATE_TIME.format(at)
}

/** The clock time alone, for a row whose date is already established. */
export function formatClock(value: string | null): string | null {
  if (value === null) return null
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return null
  return TIME_ONLY.format(at)
}
