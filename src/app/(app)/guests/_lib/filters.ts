/**
 * What the guest list is filtered by, as a pure function of the URL.
 *
 * The same decision `bookings/_lib/filters.ts` made, for the same reason: a
 * filtered list is a thing people send each other — "the guests we blocked",
 * "everyone tagged חוזרת" — and a filter held in component state produces a
 * link that opens on somebody else's screen showing something different.
 *
 * It is plain TypeScript with a test beside it because two of the decisions
 * here are wrong in a way no screenshot reveals: whether a filter is *active*
 * (which decides between "you have no guests" and "your filter matched
 * nothing" — the distinction `empty-presets.ts` exists to protect), and the
 * Hebrew summary shown back to somebody who cannot see why their guest list
 * emptied out.
 *
 * ── Why there is no language or nationality filter ────────────────────────
 *
 * Both columns exist on `guests` and both are shown on the row. Neither is
 * filterable here, and that is a gap in the schema rather than an omission on
 * this screen: `language` is `text not null default 'he'` with no check
 * constraint, and `nationality` is any two upper-case letters. There is no
 * vocabulary to build an honest options list from, and a free-text box that
 * silently matches nothing when somebody types "עברית" instead of "he" is
 * worse than no control at all. `tags` is filterable precisely because the
 * options are derived from the rows themselves — see `listGuestTags`.
 */

import { firstParam, type SearchParams } from '@/app/(auth)/_lib/search-params'

export const GUEST_FILTER_KEYS = {
  search: 'q',
  tag: 'tag',
  status: 'status',
  consent: 'consent',
} as const

/** Blocked is a fact with a reason attached, so it is worth filtering on. */
export const GUEST_STATUSES = ['active', 'blocked'] as const

export type GuestStatusFilter = (typeof GUEST_STATUSES)[number]

export const GUEST_STATUS_LABEL: Record<GuestStatusFilter, string> = {
  active: 'פעילים',
  blocked: 'חסומים',
}

/** "May we email this person" — the question an export or a campaign asks. */
export const GUEST_CONSENTS = ['granted', 'withheld'] as const

export type GuestConsentFilter = (typeof GUEST_CONSENTS)[number]

export const GUEST_CONSENT_LABEL: Record<GuestConsentFilter, string> = {
  granted: 'אישרו דיוור',
  withheld: 'לא אישרו דיוור',
}

export type GuestFilters = {
  /**
   * Free text. Matched against the name always, and against the e-mail and the
   * telephone only for a reader who may see them — see `listGuests`.
   */
  search: string
  /** One tag, exactly as stored. Null for "every tag". */
  tag: string | null
  status: GuestStatusFilter | null
  consent: GuestConsentFilter | null
}

export const EMPTY_GUEST_FILTERS: GuestFilters = {
  search: '',
  tag: null,
  status: null,
  consent: null,
}

const STATUSES = new Set<string>(GUEST_STATUSES)
const CONSENTS = new Set<string>(GUEST_CONSENTS)

/**
 * Read the filter out of the URL, refusing anything that is not one.
 *
 * A status or a consent value the vocabulary does not contain is dropped
 * rather than passed to the query, exactly as the bookings filter drops an
 * unknown booking status: a hand-edited URL should have the part that means
 * nothing ignored, not turned into a database error the reader cannot act on.
 *
 * A tag is *not* validated against a vocabulary, because there is no
 * vocabulary — `guests.tags` is free text the business invents. An unknown tag
 * is a filter that matches nothing, which is a truthful answer and produces
 * the "no results" empty state naming the tag that emptied the list.
 */
export function parseGuestFilters(params: SearchParams): GuestFilters {
  const rawTag = firstParam(params[GUEST_FILTER_KEYS.tag])
  const rawStatus = firstParam(params[GUEST_FILTER_KEYS.status])
  const rawConsent = firstParam(params[GUEST_FILTER_KEYS.consent])

  const tag = rawTag === null ? null : rawTag.trim()

  return {
    search: (firstParam(params[GUEST_FILTER_KEYS.search]) ?? '').trim(),
    tag: tag !== null && tag.length > 0 ? tag : null,
    status:
      rawStatus !== null && STATUSES.has(rawStatus)
        ? (rawStatus as GuestStatusFilter)
        : null,
    consent:
      rawConsent !== null && CONSENTS.has(rawConsent)
        ? (rawConsent as GuestConsentFilter)
        : null,
  }
}

export function hasActiveGuestFilters(filters: GuestFilters): boolean {
  return (
    filters.search.length > 0 ||
    filters.tag !== null ||
    filters.status !== null ||
    filters.consent !== null
  )
}

/**
 * The filter, said back to the person whose data it is hiding.
 *
 * Shown inside the "no results" empty state. `propertyName` comes from the
 * shell rather than from the query string, because narrowing to a property is
 * a filter the reader did not set on this screen and is the one they are most
 * likely to have forgotten about — and on this screen it is a sharper trap
 * than elsewhere, since a guest with no stay at that property disappears
 * entirely.
 */
export function describeGuestFilters(
  filters: GuestFilters,
  propertyName?: string | null,
): string {
  const parts: string[] = []

  if (propertyName) parts.push(propertyName)
  if (filters.search.length > 0) parts.push(`חיפוש: ${filters.search}`)
  if (filters.tag !== null) parts.push(`תגית: ${filters.tag}`)
  if (filters.status !== null) parts.push(GUEST_STATUS_LABEL[filters.status])
  if (filters.consent !== null) parts.push(GUEST_CONSENT_LABEL[filters.consent])

  return parts.join(' · ')
}

/**
 * The filter as a query string, without the keys that are not set.
 *
 * Empty values are omitted rather than written as `?q=&tag=`, so a cleared
 * filter produces a clean URL and "is anything filtered" stays readable from
 * the address bar.
 */
export function toGuestQueryString(filters: GuestFilters): string {
  const params = new URLSearchParams()

  if (filters.search.length > 0) {
    params.set(GUEST_FILTER_KEYS.search, filters.search)
  }
  if (filters.tag !== null) params.set(GUEST_FILTER_KEYS.tag, filters.tag)
  if (filters.status !== null) {
    params.set(GUEST_FILTER_KEYS.status, filters.status)
  }
  if (filters.consent !== null) {
    params.set(GUEST_FILTER_KEYS.consent, filters.consent)
  }

  const query = params.toString()
  return query.length > 0 ? `?${query}` : ''
}
