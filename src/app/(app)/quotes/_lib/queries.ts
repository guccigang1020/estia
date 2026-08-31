/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the quotes screen.
 *
 * ══ THERE IS NO `quotes` TABLE, AND THIS FILE DOES NOT PRETEND THERE IS ═══
 *
 * Say it plainly, because the route is called `/quotes`. `supabase/migrations`
 * creates sixty tables and none of them is `quotes`. `quote.view`,
 * `quote.create`, `quote.update` and `quote.send` exist in the permission
 * catalogue, and `calendar/_lib/quote.ts` prices a proposed stay — but pricing
 * a stay is a *calculation*, performed on demand and stored nowhere. A quote in
 * ESTIA today is not a document.
 *
 * What the product does persist is the thing a quote leaves behind:
 *
 *   · **a hold** — `holds`, with `reason = 'agent_quote'` where a seller placed
 *     it. The dates are taken off the market while the customer decides, and
 *     `converted_to_booking_id`, `released_at` and `expires_at` between them
 *     record exactly what became of the offer;
 *   · **a discount approval** — `approvals` with `approval_type = 'discount'`,
 *     raised when the quote went below the agent's cap. That row is the
 *     negotiation, and it exists precisely so the negotiation does not leave the
 *     product for WhatsApp.
 *
 * So this screen is those two things, said as what they are. The alternative —
 * inventing a `quotes` table, or drawing a pipeline out of nothing — would be
 * the one kind of fiction the charter forbids: a screen that asserts a record
 * exists when nobody wrote one.
 *
 * ── The outcome is derived, and derived once ──────────────────────────────
 *
 * `quoteOutcome` below is the only place the four columns become an answer, so
 * the list, the counts and the empty state cannot disagree about how many
 * offers are still open. Order matters: a hold that became a booking is `won`
 * even though its expiry has since passed, and a released hold is `released`
 * even though it also expired — the *first* thing that happened is what became
 * of it.
 *
 * ── Money ─────────────────────────────────────────────────────────────────
 *
 * A hold has none. It occupies dates; what those dates would cost is the
 * pricing engine's answer at the moment somebody asks, and freezing a figure
 * onto this list would be quoting a price the engine never produced. The
 * approvals carry the two figures the *approval* is about — what was asked for
 * and the ceiling it exceeded — which are stored on the row and are integers.
 */

import { can, holdsGrant, type Actor, type Resource } from '@/lib/authz/can'
import { HOLD_REASONS, type HoldReason } from '@/lib/booking'
import {
  QUOTE_OUTCOMES,
  type QuoteOutcome,
} from '@/app/(app)/agents/_lib/labels'
import {
  asAgorot,
  asEnum,
  asIsoDate,
  asNumberOrNull,
  asString,
  asStringOrNull,
  asTimestamp,
  asTimestampOrNull,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'

/* ---------------------------------------------------------------- shared -- */

export const QUOTE_PAGE_SIZE = 100

/**
 * The resource a question about a quote is asked about.
 *
 * `family: 'booking'` — `RESOURCE_FAMILIES` lists "bookings, holds, quotes,
 * leads" under it explicitly. That is what confines an external seller to their
 * own: their default scope is `own_records`, only `inventory` is overridden, and
 * every other family falls through to the default. So the same `hold.view`
 * serves a receptionist looking at the desk's offers and an agent looking at
 * theirs, and the scope answers "whose".
 */
function quoteResource(
  organizationId: string,
  propertyId: string,
  createdByUserId: string,
): Resource {
  return { organizationId, propertyId, createdByUserId, family: 'booking' }
}

/* ----------------------------------------------------------------- rows -- */

export type QuoteListItem = {
  id: string
  propertyId: string
  unitId: string
  /** The unit's code, e.g. `RIM-04`. Null when the unit is unreadable. */
  unitLabel: string | null
  checkIn: string
  checkOut: string
  reason: HoldReason
  /** Who made the offer. The agent, or the desk. */
  issuedByUserId: string
  issuedByName: string | null
  issuedAt: string
  expiresAt: string
  releasedAt: string | null
  convertedToBookingId: string | null
  note: string | null
  outcome: QuoteOutcome
}

const HOLD_COLUMNS =
  'id, organization_id, property_id, unit_id, check_in, check_out, reason, ' +
  'held_by_user_id, expires_at, released_at, converted_to_booking_id, note, ' +
  'created_at'

export type QuoteListArgs = {
  db: Db
  actor: Actor
  organizationId: string
  /** A single property, or null for every property in scope. */
  propertyId: string | null
  /** One outcome, or null for all four. */
  outcome: QuoteOutcome | null
  /** The instant the outcome is decided against. Injected so it is testable. */
  now: Date
  limit?: number
}

/**
 * The offers this reader may see, newest first.
 *
 * Ordered by `created_at` and not by `expires_at`: an expired offer has an
 * expiry in the past and a live one has it in the future, so ordering by it
 * would interleave the two and bury today's work.
 */
export async function listQuotes(
  args: QuoteListArgs,
): Promise<readonly QuoteListItem[]> {
  const { db, actor, organizationId, propertyId, outcome, now } = args

  let query = db
    .from('holds')
    .select(HOLD_COLUMNS)
    .eq('organization_id', organizationId)

  if (propertyId !== null) query = query.eq('property_id', propertyId)

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(args.limit ?? QUOTE_PAGE_SIZE)

  if (error) throw error

  const rows = toRows(data).filter((row) =>
    can(
      actor,
      'hold.view',
      quoteResource(
        organizationId,
        asString(row, 'property_id'),
        asString(row, 'held_by_user_id'),
      ),
    ),
  )

  const [units, people] = await Promise.all([
    unitLabels(
      db,
      organizationId,
      rows.map((row) => asString(row, 'unit_id')),
    ),
    profileNames(
      db,
      rows.map((row) => asString(row, 'held_by_user_id')),
    ),
  ])

  const items = rows.map((row) => {
    const issuedBy = asString(row, 'held_by_user_id')
    return {
      id: asString(row, 'id'),
      propertyId: asString(row, 'property_id'),
      unitId: asString(row, 'unit_id'),
      unitLabel: units.get(asString(row, 'unit_id')) ?? null,
      checkIn: asIsoDate(row, 'check_in'),
      checkOut: asIsoDate(row, 'check_out'),
      reason: asEnum(row, 'reason', HOLD_REASONS),
      issuedByUserId: issuedBy,
      issuedByName: people.get(issuedBy) ?? null,
      issuedAt: asTimestamp(row, 'created_at'),
      expiresAt: asTimestamp(row, 'expires_at'),
      releasedAt: asTimestampOrNull(row, 'released_at'),
      convertedToBookingId: asStringOrNull(row, 'converted_to_booking_id'),
      outcome: quoteOutcome(row, now),
      note: asStringOrNull(row, 'note'),
    } satisfies QuoteListItem
  })

  // Filtered after the read, because the outcome is not a column. Doing it in
  // SQL would mean writing the same four-way rule a second time in PostgREST
  // filters, and the day the two disagreed a screen would show a different
  // count from the list under it.
  return outcome === null
    ? items
    : items.filter((item) => item.outcome === outcome)
}

/**
 * What became of one offer.
 *
 * Order is the rule, and it is stated rather than implied: a hold that became a
 * booking is `won` whatever its expiry now says; a released hold is `released`
 * even though its expiry has also passed. The first thing that happened is what
 * became of it, and everything after that is bookkeeping.
 *
 * `expires_at` is compared against an injected `now` rather than `Date.now()`,
 * so the test can stand at a chosen moment instead of racing the clock the
 * dataset was built from.
 */
export function quoteOutcome(row: Row, now: Date): QuoteOutcome {
  if (asStringOrNull(row, 'converted_to_booking_id') !== null) return 'won'
  if (asTimestampOrNull(row, 'released_at') !== null) return 'released'
  return Date.parse(asTimestamp(row, 'expires_at')) <= now.getTime()
    ? 'expired'
    : 'open'
}

/** How many offers exist for this organization, before any filter. */
export async function countQuotes(
  db: Db,
  organizationId: string,
  propertyId: string | null,
): Promise<number> {
  let query = db
    .from('holds')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)

  if (propertyId !== null) query = query.eq('property_id', propertyId)

  const { count, error } = await query
  if (error) throw error
  return count ?? 0
}

/** The tally by outcome, over exactly the rows on screen. */
export function quoteTally(
  quotes: readonly QuoteListItem[],
): Record<QuoteOutcome, number> {
  const tally = Object.fromEntries(
    QUOTE_OUTCOMES.map((outcome) => [outcome, 0]),
  ) as Record<QuoteOutcome, number>

  for (const quote of quotes) tally[quote.outcome] += 1
  return tally
}

/* ------------------------------------------------------- the negotiation -- */

/**
 * A discount an agent asked for beyond their cap.
 *
 * `approvals` with `approval_type = 'discount'`. The row exists because
 * `evaluateAgentDiscount` returns `requires_approval` rather than a refusal —
 * an agent who is simply told no takes the negotiation to WhatsApp and the sale
 * leaves the system, which is the whole design of `discounts.ts`.
 *
 * The two figures are what the *decider* needs: what was asked for and the
 * ceiling it exceeded, so the size of the exception is visible rather than
 * merely its existence. Both are stored on the row and neither is recomputed.
 */
export type DiscountRequest = {
  id: string
  propertyId: string | null
  status: string
  requestedByUserId: string
  requestedByName: string | null
  requestedAt: string
  reason: string
  requestedBps: number | null
  limitBps: number | null
  requestedAgorot: number | null
  limitAgorot: number | null
  decidedByName: string | null
  decidedAt: string | null
  decisionNote: string | null
  expiresAt: string | null
}

/**
 * The discount requests this reader may see, newest first.
 *
 * `null` — never an empty list — for a reader who holds neither
 * `approval.decide` nor `approval.request`, because "nobody has asked for a
 * discount" and "you may not see who has" are different sentences and the
 * screen renders them differently. Both grants are gated on the `approvals`
 * entitlement, so an organization without it gets `null` and a plain
 * explanation rather than an empty panel implying a quiet month.
 */
export async function listDiscountRequests(args: {
  db: Db
  actor: Actor
  organizationId: string
  propertyId: string | null
  limit?: number
}): Promise<readonly DiscountRequest[] | null> {
  const { db, actor, organizationId, propertyId } = args

  if (
    !holdsGrant(actor, 'approval.decide') &&
    !holdsGrant(actor, 'approval.request')
  ) {
    return null
  }

  let query = db
    .from('approvals')
    .select(
      'id, property_id, approval_type, status, requested_by, requested_at, ' +
        'reason, requested_value_bps, limit_value_bps, requested_agorot, ' +
        'limit_agorot, decided_by, decided_at, decision_note, expires_at',
    )
    .eq('organization_id', organizationId)
    .eq('approval_type', 'discount')

  if (propertyId !== null) query = query.eq('property_id', propertyId)

  const { data, error } = await query
    .order('requested_at', { ascending: false })
    .limit(args.limit ?? QUOTE_PAGE_SIZE)

  if (error) throw error

  const rows = toRows(data).filter((row) => {
    // `approvals.property_id` is genuinely nullable — 0011 says it is the one
    // nullable property anchor, because a request can be about the business
    // rather than about a place. A discount request always has a property, but
    // the read does not assume it: a null anchor asks the organization-wide
    // question, which only an organization-wide scope reaches.
    const property = asStringOrNull(row, 'property_id')
    const resource: Resource = {
      organizationId,
      createdByUserId: asString(row, 'requested_by'),
      family: 'booking',
    }
    if (property !== null) resource.propertyId = property
    return can(actor, 'approval.request', resource)
  })

  const names = await profileNames(db, [
    ...rows.map((row) => asString(row, 'requested_by')),
    ...rows
      .map((row) => asStringOrNull(row, 'decided_by'))
      .filter((id): id is string => id !== null),
  ])

  return rows.map((row) => {
    const decidedBy = asStringOrNull(row, 'decided_by')
    const requestedBy = asString(row, 'requested_by')

    return {
      id: asString(row, 'id'),
      propertyId: asStringOrNull(row, 'property_id'),
      status: asString(row, 'status'),
      requestedByUserId: requestedBy,
      requestedByName: names.get(requestedBy) ?? null,
      requestedAt: asTimestamp(row, 'requested_at'),
      reason: asString(row, 'reason'),
      requestedBps: asNumberOrNull(row, 'requested_value_bps'),
      limitBps: asNumberOrNull(row, 'limit_value_bps'),
      requestedAgorot: nullableAgorot(row, 'requested_agorot'),
      limitAgorot: nullableAgorot(row, 'limit_agorot'),
      decidedByName: decidedBy === null ? null : (names.get(decidedBy) ?? null),
      decidedAt: asTimestampOrNull(row, 'decided_at'),
      decisionNote: asStringOrNull(row, 'decision_note'),
      expiresAt: asTimestampOrNull(row, 'expires_at'),
    }
  })
}

/* --------------------------------------------------------------- shared -- */

/**
 * `asAgorot` refuses null and these two columns are nullable — a request can be
 * about a percentage with no shekel figure at all. Checked before the integer
 * assertion rather than after, so a legitimate null does not throw and a genuine
 * float still does.
 */
function nullableAgorot(row: Row, column: string): number | null {
  return row[column] === null || row[column] === undefined
    ? null
    : asAgorot(row, column)
}

/**
 * The unit's code, for a list that must not print a uuid.
 *
 * Skipped without `unit.manage`-level reach? No — deliberately not gated at
 * all: `units_select` narrows by `unit_in_scope()` on its own terms, and a unit
 * this reader cannot read simply does not come back and leaves the label null.
 * Adding an application-side grant check here would refuse the *label* to
 * somebody the database was willing to give the row to.
 */
async function unitLabels(
  db: Db,
  organizationId: string,
  unitIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(unitIds)]
  if (unique.length === 0) return new Map()

  const { data, error } = await db
    .from('units')
    .select('id, code, name')
    .eq('organization_id', organizationId)
    .in('id', unique)

  if (error) throw error

  const labels = new Map<string, string>()
  for (const row of toRows(data)) {
    const code = asStringOrNull(row, 'code')
    const name = asStringOrNull(row, 'name')
    const label = [code, name].filter((part) => part !== null).join(' · ')
    if (label.length > 0) labels.set(asString(row, 'id'), label)
  }
  return labels
}

async function profileNames(
  db: Db,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return new Map()

  const { data, error } = await db
    .from('user_profiles')
    .select('id, full_name')
    .in('id', unique)

  if (error) throw error

  const names = new Map<string, string>()
  for (const row of toRows(data)) {
    const name = asStringOrNull(row, 'full_name')
    if (name !== null) names.set(asString(row, 'id'), name)
  }
  return names
}
