/**
 * What the bookings list is filtered by, as a pure function of the URL.
 *
 * The filter lives in the query string rather than in component state, which
 * is not a style preference: a filtered list is a thing people send each other
 * ("look at September in וילה הגליל"), and a filter held in memory produces a
 * link that opens on somebody else's screen showing something different.
 *
 * It is plain TypeScript with a test beside it because two of the decisions
 * here are the kind that are wrong in a way no screenshot reveals: whether a
 * filter is *active* (which decides between "you have no bookings" and "your
 * filter matched nothing" — the distinction `empty-presets.ts` exists to
 * protect), and the Hebrew summary shown back to a person who cannot see why
 * their data vanished.
 */

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import {
  BOOKING_STATUSES,
  BOOKING_STATUS_LABEL,
  formatDayMonthYear,
  isIsoDate,
  type BookingStatus,
} from '@/lib/booking'

export const BOOKING_FILTER_KEYS = {
  search: 'q',
  status: 'status',
  from: 'from',
  to: 'to',
} as const

export type BookingFilters = {
  /** Free text, matched against the reference and the guest's name. */
  search: string
  status: BookingStatus | null
  /** Stays that end on or after this date. ISO, or null. */
  from: string | null
  /** Stays that start before or on this date. ISO, or null. */
  to: string | null
}

export const EMPTY_BOOKING_FILTERS: BookingFilters = {
  search: '',
  status: null,
  from: null,
  to: null,
}

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

const STATUSES = new Set<string>(BOOKING_STATUSES)

/**
 * Read the filter out of the URL, refusing anything that is not one.
 *
 * A status the enum does not contain and a date that is not a date are dropped
 * rather than passed to the query. They would reach PostgREST as a literal and
 * come back as a database error the user cannot act on, and the honest
 * behaviour for a hand-edited URL is to ignore the part that means nothing.
 */
export function parseBookingFilters(params: SearchParams): BookingFilters {
  const rawStatus = first(params[BOOKING_FILTER_KEYS.status])
  const rawFrom = first(params[BOOKING_FILTER_KEYS.from])
  const rawTo = first(params[BOOKING_FILTER_KEYS.to])

  return {
    search: (first(params[BOOKING_FILTER_KEYS.search]) ?? '').trim(),
    status:
      rawStatus !== null && STATUSES.has(rawStatus)
        ? (rawStatus as BookingStatus)
        : null,
    from: rawFrom !== null && isIsoDate(rawFrom) ? rawFrom : null,
    to: rawTo !== null && isIsoDate(rawTo) ? rawTo : null,
  }
}

export function hasActiveFilters(filters: BookingFilters): boolean {
  return (
    filters.search.length > 0 ||
    filters.status !== null ||
    filters.from !== null ||
    filters.to !== null
  )
}

/**
 * The filter, said back to the person whose data it is hiding.
 *
 * Shown inside the "no results" empty state. `propertyName` comes from the
 * shell rather than from the query string, because narrowing to a property is
 * a filter the user did not set on this screen and is the one they are most
 * likely to have forgotten about.
 */
export function describeFilters(
  filters: BookingFilters,
  propertyName?: string | null,
): string {
  const parts: string[] = []

  if (propertyName) parts.push(propertyName)
  if (filters.search.length > 0) parts.push(`חיפוש: ${filters.search}`)
  if (filters.status !== null) {
    parts.push(BOOKING_STATUS_LABEL[filters.status])
  }
  if (filters.from !== null && filters.to !== null) {
    parts.push(
      `${formatDayMonthYear(filters.from)} – ${formatDayMonthYear(filters.to)}`,
    )
  } else if (filters.from !== null) {
    parts.push(`מ-${formatDayMonthYear(filters.from)}`)
  } else if (filters.to !== null) {
    parts.push(`עד ${formatDayMonthYear(filters.to)}`)
  }

  return parts.join(' · ')
}

/**
 * The filter as a query string, without the keys that are not set.
 *
 * Empty values are omitted rather than written as `?q=&status=`, so a cleared
 * filter produces a clean URL and "is anything filtered" stays readable from
 * the address bar.
 */
export function toQueryString(filters: BookingFilters): string {
  const params = new URLSearchParams()

  if (filters.search.length > 0) {
    params.set(BOOKING_FILTER_KEYS.search, filters.search)
  }
  if (filters.status !== null) {
    params.set(BOOKING_FILTER_KEYS.status, filters.status)
  }
  if (filters.from !== null) params.set(BOOKING_FILTER_KEYS.from, filters.from)
  if (filters.to !== null) params.set(BOOKING_FILTER_KEYS.to, filters.to)

  const query = params.toString()
  return query.length > 0 ? `?${query}` : ''
}

/**
 * Refuse a reversed date window.
 *
 * `from` after `to` matches nothing at all, and a list that silently renders
 * empty for it is indistinguishable from a business with no bookings. The
 * screen states it instead.
 */
export function dateRangeIssue(filters: BookingFilters): string | null {
  if (filters.from === null || filters.to === null) return null
  if (filters.from <= filters.to) return null
  return 'תאריך הסיום מוקדם מתאריך ההתחלה, ולכן שום הזמנה לא תתאים לסינון.'
}
