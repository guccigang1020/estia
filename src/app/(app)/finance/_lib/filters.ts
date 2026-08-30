/**
 * What the three finance lists are filtered by, as a pure function of the URL.
 *
 * The same decision `bookings/_lib/filters.ts` made, for the same reason: a
 * filtered list is a thing people send each other — "look at the payments that
 * came back unknown" — and a filter held in component state produces a link
 * that opens on somebody else's screen showing something different.
 *
 * ── Why this is generic where the bookings filter is not ──────────────────
 *
 * Three screens filter by a status and by nothing else, over three different
 * frozen vocabularies. Writing the parser three times would be three places
 * for the same mistake, and the mistake is not hypothetical: a status the
 * enum does not contain, passed through to PostgREST, comes back as a database
 * error the reader cannot act on. So the allowed tuple is a parameter, always
 * the contract's own tuple, and anything outside it is dropped rather than
 * queried — which is the honest behaviour for a hand-edited URL.
 *
 * The labels are a parameter for the same reason: `PAYMENT_STATUS_LABEL` and
 * `COMMISSION_STATUS_LABEL` belong to the domain, and a copy here would be a
 * second Hebrew name for a state that already has one.
 */

import { firstParam, type SearchParams } from '@/app/(auth)/_lib/search-params'

/** The one key every finance list reads. Kept as a constant so the form,
 * the parser and the query string cannot spell it differently. */
export const FINANCE_STATUS_KEY = 'status'

export type StatusFilter<S extends string> = {
  /** Null means "every status", which is the unfiltered list. */
  status: S | null
}

/**
 * Read the status out of the URL, refusing anything that is not one.
 *
 * `allowed` is always the contract's tuple — `PAYMENT_STATUSES`,
 * `INVOICE_STATUSES`, `COMMISSION_STATUSES` — so a status added to the
 * database and to the contract is filterable here on the same commit, and a
 * value that is not in the contract never reaches the query.
 */
export function parseStatusFilter<S extends string>(
  params: SearchParams,
  allowed: readonly S[],
): StatusFilter<S> {
  const raw = firstParam(params[FINANCE_STATUS_KEY])
  if (raw === null) return { status: null }
  return {
    status: (allowed as readonly string[]).includes(raw) ? (raw as S) : null,
  }
}

/**
 * Is anything hiding rows?
 *
 * `propertyId` is included because narrowing to one property is a filter the
 * reader did not set on this screen — it is the shell's property switcher —
 * and it is the one they are most likely to have forgotten about. Getting this
 * wrong tells a business with fifty payments that it has never taken money.
 */
export function hasActiveStatusFilter<S extends string>(
  filter: StatusFilter<S>,
  propertyId: string | null,
): boolean {
  return filter.status !== null || propertyId !== null
}

/**
 * The filter, said back to the person whose data it is hiding.
 *
 * Shown inside the "no results" empty state, so the reader can see what is in
 * the way rather than concluding the module is broken.
 */
export function describeStatusFilter<S extends string>(
  filter: StatusFilter<S>,
  labels: Record<S, string>,
  propertyName?: string | null,
): string {
  const parts: string[] = []
  if (propertyName) parts.push(propertyName)
  if (filter.status !== null) parts.push(labels[filter.status])
  return parts.join(' · ')
}
