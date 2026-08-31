/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the guest screens.
 *
 * ── Where the guest domain is, and where it is not ────────────────────────
 *
 * There is no `src/lib/guests`. The guest "domain" is spread across four
 * places that already exist and are not re-decided here:
 *
 *   · `supabase/migrations/0009_booking_core.sql` — the table, the
 *     deduplication rule (`guests_organization_phone_idx` over the generated
 *     `phone_e164`), and the constraints. `guests_blocked_reason` is why a
 *     reason is only ever shown beside `is_blocked`.
 *   · `src/lib/authz/permissions.ts` — `SENSITIVE_FIELDS` names
 *     `guest.name`, `guest.phone`, `guest.email` and `guest.document_id` as
 *     four separate fields behind four separate grants. This file does not
 *     invent a fifth and does not merge two.
 *   · `src/lib/authz/roles.ts` — `GUEST_DATA_LEVELS`, the ladder an external
 *     seller is placed on.
 *   · `src/lib/persistence/booking.ts` — `createGuest`, the only existing
 *     write path, which creates a guest carrying nothing but a name.
 *
 * What does **not** exist is a `GuestRepository` port, a guest operation in
 * the service pipeline, or a `guestResource()` helper of the kind
 * `state-machine.ts` exports for bookings. Three consequences are visible in
 * this file and each is written down where it bites rather than worked around
 * silently: `guestResource` below is local, "a stay that happened" is defined
 * here because no domain predicate answers it, and the create action beside
 * this file writes a row directly under `assertCan` rather than through an
 * operation. All three are gaps in the domain, not decisions this screen was
 * entitled to make on its own.
 *
 * ── Why the reads are plain queries ───────────────────────────────────────
 *
 * The same reasoning `finance/_lib/queries.ts` sets out. Every read here runs
 * on the request-scoped Supabase client under row level security, which is the
 * tenant boundary: `guests_select` is scoped to `my_organizations()`, so a
 * wrong organization id in this file returns nothing rather than another
 * business's customer list.
 *
 * ── The narrowing above the row ───────────────────────────────────────────
 *
 * A guest carries no `property_id`. `can.ts` is explicit that a resource with
 * no location is organization-wide and is therefore only reachable by an
 * organization-wide scope — which would show a property manager an empty guest
 * list, for ever. So the question is asked once per property the guest has
 * actually stayed at, by the engine, with a real resource each time: a reader
 * whose scope reaches any property this guest stayed at may see the guest.
 * Nothing about the scope rule is reimplemented here; only the resource the
 * question is asked about is composed. See `reachesGuest`.
 */

import {
  can,
  holdsGrant,
  redact,
  type Actor,
  type Resource,
} from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import { BOOKING_STATUSES, localDate, type BookingStatus } from '@/lib/booking'
import {
  asAgorot,
  asBoolean,
  asEnum,
  asIsoDate,
  asNumber,
  asString,
  asStringArray,
  asStringOrNull,
  asTimestampOrNull,
  toRow,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'

import type { GuestFilters } from './filters'

/* ---------------------------------------------------------------- shared -- */

/** The ceiling on one page. The same number and reasoning as `BOOKING_PAGE_SIZE`. */
export const GUEST_PAGE_SIZE = 100

/**
 * How many rows a tag filter may scan.
 *
 * `guests.tags` is `text[]`, and the honest filter for it is `.contains()`,
 * which the demo client does not implement — `src/lib/demo/client.ts` supports
 * `eq · neq · is · lt · lte · gt · gte · in · like · ilike` and throws on
 * anything else, deliberately. So the tag filter is applied in memory over a
 * bounded scan, and the screen says out loud when the scan hit its ceiling
 * rather than letting a list quietly stop. It is a real limitation and it is
 * reported rather than hidden: the fix is `.contains('tags', [tag])` once the
 * demo client can answer it, which turns this into a one-line change.
 */
export const GUEST_TAG_SCAN_SIZE = 500

/**
 * The resource an authorization question about a guest is asked about.
 *
 * `family: 'guest'` so a membership that narrows the guest family separately —
 * `scopeOverrides` on `Actor` — is honoured. `propertyId` is set only when the
 * question is "may they reach this guest *through this stay*"; the bare form
 * is the organization-wide question.
 */
function guestResource(organizationId: string, propertyId?: string): Resource {
  const resource: Resource = { organizationId, family: 'guest' }
  if (propertyId !== undefined) resource.propertyId = propertyId
  return resource
}

/**
 * `%` and `_` are wildcards in `ilike`. A guest called "100%" must match
 * themselves rather than every guest in the business.
 *
 * The twin of the private `escapeLike` in `bookings/_lib/queries.ts`. Copied
 * rather than shared because that one is not exported and reaching into
 * another screen's `_lib` to export it is a wider change than a four-line
 * function is worth; if a third caller appears, it belongs in `@/lib/persistence`.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

/* ------------------------------------------------------------- the stay -- */

/**
 * The two statuses in which the guest did not sleep in the unit.
 *
 * THIS IS A GAP IN THE DOMAIN, NAMED WHERE IT IS FELT. `src/lib/booking`
 * exports `OCCUPYING_STATUSES` — which of them hold the calendar — and
 * `TERMINAL_STATUSES` — which of them are finished. Neither answers the
 * question a guest CRM asks, which is "did this person actually stay". A
 * completed stay is not occupying, and `TERMINAL_STATUSES` puts `completed`
 * beside `cancelled`. So the exclusion is written once, here, from the two
 * statuses whose names leave nothing to interpret, and it is reported as
 * belonging in `src/lib/booking/types.ts` beside the other two sets.
 */
const DID_NOT_STAY: readonly BookingStatus[] = ['cancelled', 'no_show']

const DID_NOT_STAY_SET = new Set<BookingStatus>(DID_NOT_STAY)

/** One stay of one guest, as both the list summary and the detail page need it. */
export type GuestStay = {
  bookingId: string
  reference: string
  status: BookingStatus
  checkIn: string
  checkOut: string
  propertyId: string | null
  unitId: string
  /** Null when the unit row is not readable. The id is not shown in its place. */
  unitName: string | null
  /** The stored booking total. Withheld without `booking.view_price`. */
  totalAgorot?: number
  /** False for `cancelled` and `no_show`. See `DID_NOT_STAY`. */
  happened: boolean
}

const STAY_REDACTIONS = [
  { key: 'totalAgorot', requires: 'booking.view_price' },
] as const satisfies ReadonlyArray<{ key: keyof GuestStay; requires: Grant }>

const STAY_COLUMNS =
  'id, guest_id, reference, status, check_in, check_out, property_id, ' +
  'unit_id, total_agorot, units(name)'

/** The resource an authorization question about one of a guest's stays is asked about. */
function stayResource(organizationId: string, propertyId: string | null) {
  const resource: Resource = { organizationId, family: 'booking' }
  if (propertyId !== null) resource.propertyId = propertyId
  return resource
}

/** An embed comes back as an object or, for some shapes, a one-element array. */
function embeddedField(value: unknown, field: string): string | null {
  const record = Array.isArray(value) ? value[0] : value
  if (typeof record !== 'object' || record === null) return null
  const raw = (record as Record<string, unknown>)[field]
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

function toStay(row: Row): GuestStay {
  const status = asEnum(row, 'status', BOOKING_STATUSES)
  return {
    bookingId: asString(row, 'id'),
    reference: asString(row, 'reference'),
    status,
    checkIn: asIsoDate(row, 'check_in'),
    checkOut: asIsoDate(row, 'check_out'),
    propertyId: asStringOrNull(row, 'property_id'),
    unitId: asString(row, 'unit_id'),
    unitName: embeddedField(row.units, 'name'),
    totalAgorot: asAgorot(row, 'total_agorot'),
    happened: !DID_NOT_STAY_SET.has(status),
  }
}

/**
 * Every stay of these guests, in one round trip.
 *
 * `guests(full_name)` is *not* embedded the other way round — `guests.bookings`
 * is not among the embeds `src/lib/demo/client.ts` declares, and an undeclared
 * embed throws there by design. Two queries and a join in memory is the shape
 * this screen can actually run, and it is also the cheaper one: the same
 * booking row would otherwise be re-read once per guest.
 *
 * Note the absence of `!inner` and the absence of a guest filter beyond the
 * ids: `bookings_select` needs `booking.view`, which a reader may hold without
 * `guest.view` and the reverse. A reader without it gets no rows here and a
 * guest list with no stay history, which is the privacy rule working rather
 * than an outage.
 *
 * TWO GATES, NOT ONE. `holdsGrant` decides whether to issue the query at all —
 * grant and plan, no scope, which is exactly the question that can be answered
 * before a row exists. `can()` then decides row by row, with the stay's own
 * property, because row level security scopes this query to the organization
 * and not to the property: without the second gate a property manager reading
 * one guest would be handed that guest's stays at the property they do not
 * manage.
 */
async function loadStays(
  db: Db,
  actor: Actor,
  organizationId: string,
  guestIds: readonly string[],
): Promise<Map<string, GuestStay[]>> {
  const byGuest = new Map<string, GuestStay[]>()
  if (guestIds.length === 0) return byGuest

  // Asked before the query rather than after: a reader who may not see
  // bookings at all should not have one issued on their behalf.
  if (!holdsGrant(actor, 'booking.view')) return byGuest

  const { data, error } = await db
    .from('bookings')
    .select(STAY_COLUMNS)
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .in('guest_id', [...guestIds])
    .order('check_in', { ascending: false })

  if (error) throw error

  for (const row of toRows(data)) {
    const stay = toStay(row)
    const resource = stayResource(organizationId, stay.propertyId)

    if (!can(actor, 'booking.view', resource)) continue

    const guestId = asString(row, 'guest_id')
    const visible = redact(actor, stay, STAY_REDACTIONS, resource)
    const existing = byGuest.get(guestId)
    if (existing) existing.push(visible)
    else byGuest.set(guestId, [visible])
  }

  return byGuest
}

/* ------------------------------------------------------------- the row --- */

/**
 * One line of the guest list.
 *
 * The three contact fields are optional in the type because `redact()`
 * genuinely removes them. `fullName` missing and `fullName: null` are
 * different facts — "you may not see this person's name" and "this row has no
 * name", the second of which the table's `full_name not null` constraint makes
 * impossible — and the type keeps them apart so no component reads
 * `undefined` out of a field it was told was a string.
 */
export type GuestListItem = {
  id: string
  /** Withheld without `guest.view_name`. Never replaced by "אורח". */
  fullName?: string
  /** Withheld without `guest.view_phone`. */
  phone?: string | null
  /** Withheld without `guest.view_email`. */
  email?: string | null
  /** `text not null default 'he'`, so always present and never validated. */
  language: string
  /** ISO-3166 alpha-2, or null where nobody recorded one. */
  nationality: string | null
  city: string | null
  tags: readonly string[]
  isBlocked: boolean
  marketingConsent: boolean
  /** Stays that are neither cancelled nor a no-show, and are already over. */
  stayCount: number
  /** The same, still to come. */
  upcomingCount: number
  /** Check-out of the most recent stay that happened, or null. */
  lastStayOn: string | null
  /** Check-in of the next stay to come, or null. */
  nextArrivalOn: string | null
  /**
   * The stored totals of every stay that happened, added up. Withheld as a
   * whole without `booking.view_price` — see `staysValue`.
   */
  staysValueAgorot?: number
}

const GUEST_REDACTIONS = [
  { key: 'fullName', requires: 'guest.view_name' },
  { key: 'phone', requires: 'guest.view_phone' },
  { key: 'email', requires: 'guest.view_email' },
] as const satisfies ReadonlyArray<{
  key: keyof GuestListItem
  requires: Grant
}>

const LIST_COLUMNS =
  'id, full_name, email, phone, phone_e164, language, nationality, city, ' +
  'tags, is_blocked, marketing_consent'

/**
 * What the listed stays are worth, or `undefined` when the money is withheld.
 *
 * `undefined` rather than zero when a stay's `totalAgorot` was redacted: a
 * reader who may not see one booking's price may certainly not see the sum of
 * six. The same rule `paymentTotals` applies, and for the same reason.
 */
function staysValue(stays: readonly GuestStay[]): number | undefined {
  let total = 0
  for (const stay of stays) {
    if (!stay.happened) continue
    if (stay.totalAgorot === undefined) return undefined
    total += stay.totalAgorot
  }
  return total
}

/**
 * Which stays are behind us and which are ahead, as of a given moment.
 *
 * `localDate` is the domain's own conversion against `PROPERTY_TIME_ZONE`, not
 * `toISOString().slice(0, 10)`. A guest who checked out this morning at 09:00
 * in Israel is `06:00Z` today, and the naive slice would file a late-evening
 * check-out under tomorrow — on the screen somebody uses to decide whether to
 * ring them about their stay.
 */
function summariseStays(
  stays: readonly GuestStay[],
  now: Date,
): Pick<
  GuestListItem,
  'stayCount' | 'upcomingCount' | 'lastStayOn' | 'nextArrivalOn'
> {
  const today = localDate(now)

  let stayCount = 0
  let upcomingCount = 0
  let lastStayOn: string | null = null
  let nextArrivalOn: string | null = null

  for (const stay of stays) {
    if (!stay.happened) continue

    // Half-open, exactly as `DateRange` defines it: the check-out day is not
    // occupied, so a stay whose check-out is today is over.
    if (stay.checkOut <= today) {
      stayCount += 1
      if (lastStayOn === null || stay.checkOut > lastStayOn) {
        lastStayOn = stay.checkOut
      }
    } else {
      upcomingCount += 1
      if (nextArrivalOn === null || stay.checkIn < nextArrivalOn) {
        nextArrivalOn = stay.checkIn
      }
    }
  }

  return { stayCount, upcomingCount, lastStayOn, nextArrivalOn }
}

/**
 * May this reader see this guest at all?
 *
 * Two questions, in this order, and the engine answers both:
 *
 *   1. the organization-wide one — an `all_organization` scope reaches every
 *      guest, including one who has never booked;
 *   2. one per property the guest has stayed at — which is how a
 *      property-scoped membership reaches a record that carries no property.
 *
 * A reader lacking `guest.view` fails both, since `authorize` settles the
 * grant before it ever looks at scope.
 *
 * The second question is answered from stays this reader can *see*, which
 * couples guest reach to booking reach for anyone not organization-wide. That
 * is the coherent reading — you reach the guest through the stay — but it is a
 * coupling, and it is one more argument for a `guestResource()` in the domain
 * deciding this once for every caller instead of here.
 */
function reachesGuest(
  actor: Actor,
  organizationId: string,
  stays: readonly GuestStay[],
): boolean {
  if (can(actor, 'guest.view', guestResource(organizationId))) return true

  return stays.some(
    (stay) =>
      stay.propertyId !== null &&
      can(actor, 'guest.view', guestResource(organizationId, stay.propertyId)),
  )
}

/* ------------------------------------------------------------ the list --- */

export type ListGuestsArgs = {
  db: Db
  actor: Actor
  organizationId: string
  /** A single property, or null for every property in scope. */
  propertyId: string | null
  filters: GuestFilters
  limit?: number
  /** Injected rather than read, so the summary is deterministic in a test. */
  now?: Date
}

export type GuestListPage = {
  items: readonly GuestListItem[]
  /**
   * True when a tag filter stopped at `GUEST_TAG_SCAN_SIZE` rather than at the
   * end of the table, so the screen can say so instead of implying the list is
   * complete.
   */
  tagScanTruncated: boolean
}

/**
 * The guests this reader may see, by name.
 *
 * ── Searching a field you may not read ────────────────────────────────────
 *
 * The search matches the name always, and the e-mail and telephone **only for
 * a reader who holds those grants**. This is the same rule `listBookings`
 * applies when it puts the guest-name search behind an inner join: somebody
 * who may not read a telephone number must not be able to confirm one by
 * typing it and watching a row appear. A redacted column that is still
 * searchable is not redacted.
 *
 * `.or()` is not available — the demo client refuses it deliberately, and
 * PostgREST's `or` across columns would need the same care about which
 * columns this reader may match — so the variants are separate queries merged
 * by id, exactly as the bookings search is.
 */
export async function listGuests(args: ListGuestsArgs): Promise<GuestListPage> {
  const { db, actor, organizationId, propertyId, filters } = args
  const limit = args.limit ?? GUEST_PAGE_SIZE
  const now = args.now ?? new Date()

  // A tag filter is applied in memory, so it needs a wider window than the
  // page it will produce. See `GUEST_TAG_SCAN_SIZE`.
  const fetchLimit = filters.tag === null ? limit : GUEST_TAG_SCAN_SIZE

  const rows = await fetchGuestRows(db, actor, {
    organizationId,
    filters,
    limit: fetchLimit,
  })

  const tag = filters.tag
  const tagged =
    tag === null
      ? rows
      : rows.filter((row) => asStringArray(row, 'tags').includes(tag))

  const stays = await loadStays(
    db,
    actor,
    organizationId,
    tagged.map((row) => asString(row, 'id')),
  )

  const items: GuestListItem[] = []

  for (const row of tagged) {
    const id = asString(row, 'id')
    const guestStays = stays.get(id) ?? []

    if (!reachesGuest(actor, organizationId, guestStays)) continue

    // The shell's property switcher, applied to a record that has no property
    // of its own: a guest belongs to the selected property if they have stayed
    // there. A guest with no stay at all therefore disappears under a property
    // selection, which is why `hasActiveFilters` counts the switcher.
    if (
      propertyId !== null &&
      !guestStays.some((stay) => stay.propertyId === propertyId)
    ) {
      continue
    }

    const visible =
      propertyId === null
        ? guestStays
        : guestStays.filter((stay) => stay.propertyId === propertyId)

    const value = staysValue(visible)

    const item: GuestListItem = {
      id,
      fullName: asString(row, 'full_name'),
      phone: asStringOrNull(row, 'phone'),
      email: asStringOrNull(row, 'email'),
      language: asString(row, 'language'),
      nationality: asStringOrNull(row, 'nationality'),
      city: asStringOrNull(row, 'city'),
      tags: asStringArray(row, 'tags'),
      isBlocked: asBoolean(row, 'is_blocked'),
      marketingConsent: asBoolean(row, 'marketing_consent'),
      ...summariseStays(visible, now),
      // Spread conditionally rather than assigned as `undefined`: the key's
      // *absence* is the statement "withheld", and a key holding `undefined`
      // would answer `'staysValueAgorot' in item` with true — which is the
      // check that tells a withheld figure from an absent one.
      ...(value === undefined ? {} : { staysValueAgorot: value }),
    }

    // No resource: the row-level scope question was answered by `reachesGuest`
    // above, and a guest who has stayed at two properties has no single
    // property id to ask it about. Only the grant decides here, which is what
    // every existing `redact` call site does.
    items.push(redact(actor, item, GUEST_REDACTIONS))

    if (items.length === limit) break
  }

  return {
    items,
    tagScanTruncated: tag !== null && rows.length === GUEST_TAG_SCAN_SIZE,
  }
}

/**
 * The guest rows themselves, before anything is decided about them.
 *
 * Split out because the search turns one query into as many as three, and
 * because the merge has to happen on raw rows: the sort is by `full_name`,
 * which is the first thing `redact` takes away from a reader without
 * `guest.view_name`.
 */
async function fetchGuestRows(
  db: Db,
  actor: Actor,
  args: {
    organizationId: string
    filters: GuestFilters
    limit: number
  },
): Promise<Row[]> {
  const { filters, limit } = args

  const build = () => {
    let query = db
      .from('guests')
      .select(LIST_COLUMNS)
      .eq('organization_id', args.organizationId)
      .is('deleted_at', null)

    if (filters.status !== null) {
      query = query.eq('is_blocked', filters.status === 'blocked')
    }
    if (filters.consent !== null) {
      query = query.eq('marketing_consent', filters.consent === 'granted')
    }
    return query
  }

  if (filters.search.length === 0) {
    const { data, error } = await build().order('full_name').limit(limit)
    if (error) throw error
    return toRows(data)
  }

  const pattern = `%${escapeLike(filters.search)}%`

  // Which columns this reader may match on. A field they cannot read is a
  // field they cannot search — see the header of `listGuests`.
  const columns: string[] = ['full_name']
  if (holdsGrant(actor, 'guest.view_email')) columns.push('email')
  if (holdsGrant(actor, 'guest.view_phone')) {
    // Both spellings. `phone` is what was typed at the desk — "+972 54-220-1188"
    // — and `phone_e164` is the generated, punctuation-free deduplication key.
    // Somebody searching "0542201188" matches neither, because normalising an
    // Israeli number is `public.normalize_phone_il`, a SQL function with no
    // TypeScript twin. That is a real gap and it is reported rather than
    // approximated by a second normaliser that could disagree with the first.
    columns.push('phone', 'phone_e164')
  }

  const results = await Promise.all(
    columns.map((column) => build().ilike(column, pattern).limit(limit)),
  )

  const merged = new Map<string, Row>()
  for (const result of results) {
    if (result.error) throw result.error
    for (const row of toRows(result.data)) merged.set(asString(row, 'id'), row)
  }

  return [...merged.values()]
    .sort((a, b) =>
      asString(a, 'full_name').localeCompare(asString(b, 'full_name'), 'he'),
    )
    .slice(0, limit)
}

/**
 * How many guests exist for this organization, before any filter.
 *
 * The number `resolveEmptyReason` needs to tell "nobody has ever booked" apart
 * from "your filter hid all twenty-seven". Asked as a `head` count so it costs
 * no rows.
 *
 * Deliberately *not* narrowed by the reader's scope: it is the organization's
 * own count, and a property-scoped reader who can reach none of them would be
 * told "you have no guests yet", which is false. The page handles that case
 * separately rather than by bending this number — see `/guests/page.tsx`.
 */
export async function countGuests(
  db: Db,
  organizationId: string,
): Promise<number> {
  const { count, error } = await db
    .from('guests')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .is('deleted_at', null)

  if (error) throw error
  return count ?? 0
}

/**
 * Every tag in use, sorted, for the filter's options.
 *
 * Derived from the rows rather than declared: `guests.tags` is a working
 * vocabulary the business invents — the column comment in 0009 says as much —
 * so a hard-coded list would go stale the first time somebody types a new one.
 * One column, no join.
 */
export async function listGuestTags(
  db: Db,
  organizationId: string,
): Promise<readonly string[]> {
  const { data, error } = await db
    .from('guests')
    .select('tags')
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .limit(GUEST_TAG_SCAN_SIZE)

  if (error) throw error

  const tags = new Set<string>()
  for (const row of toRows(data)) {
    for (const tag of asStringArray(row, 'tags')) tags.add(tag)
  }

  return [...tags].sort((a, b) => a.localeCompare(b, 'he'))
}

/* ----------------------------------------------------------- one guest --- */

/**
 * One guest, in full.
 *
 * Everything the list carries plus the fields only the detail screen shows.
 * `documentNumber` sits behind `guest.view_document_id`, which is a *third*
 * circle: the column comment in 0009 says "almost no role needs to see this",
 * and none of the shipped presets grants it — see the report beside this
 * screen.
 */
export type GuestDetail = {
  id: string
  fullName?: string
  phone?: string | null
  phoneAlt?: string | null
  email?: string | null
  language: string
  nationality: string | null
  dateOfBirth: string | null
  city: string | null
  addressLine1: string | null
  postalCode: string | null
  country: string | null
  tags: readonly string[]
  /**
   * The free-text note the business keeps about this person.
   *
   * NOT behind a field grant, and that is a finding rather than a choice:
   * `SENSITIVE_FIELDS` gates the name, the telephone, the e-mail and the
   * identity document, and says nothing about `guests.notes` — so anybody
   * holding `guest.view` reads it. `bookings.internal_notes` *is* gated, by
   * `booking.note.internal`, which is the precedent this column is missing.
   */
  notes: string | null
  marketingConsent: boolean
  /** When consent was given. Null whenever consent was not. */
  marketingConsentAt: string | null
  isBlocked: boolean
  blockedReason: string | null
  documentType?: string | null
  documentNumber?: string | null
  documentCountry?: string | null
  createdAt: string | null
  /** Optimistic locking. Carried so an edit screen can send it back. */
  version: number
}

const DETAIL_REDACTIONS = [
  { key: 'fullName', requires: 'guest.view_name' },
  { key: 'phone', requires: 'guest.view_phone' },
  { key: 'phoneAlt', requires: 'guest.view_phone' },
  { key: 'email', requires: 'guest.view_email' },
  { key: 'documentType', requires: 'guest.view_document_id' },
  { key: 'documentNumber', requires: 'guest.view_document_id' },
  { key: 'documentCountry', requires: 'guest.view_document_id' },
] as const satisfies ReadonlyArray<{ key: keyof GuestDetail; requires: Grant }>

const DETAIL_COLUMNS =
  'id, full_name, email, phone, phone_alt, language, nationality, ' +
  'date_of_birth, id_document_type, id_document_number, id_document_country, ' +
  'address_line1, city, postal_code, country, tags, notes, ' +
  'marketing_consent, marketing_consent_at, is_blocked, blocked_reason, ' +
  'created_at, version'

export type LoadGuestArgs = {
  db: Db
  actor: Actor
  organizationId: string
  guestId: string
  now?: Date
}

export type GuestRecord = {
  guest: GuestDetail
  stays: readonly GuestStay[]
  summary: Pick<
    GuestListItem,
    'stayCount' | 'upcomingCount' | 'lastStayOn' | 'nextArrivalOn'
  >
  staysValueAgorot?: number
}

/**
 * One guest and their history, or `null`.
 *
 * `null` covers three situations on purpose: no such row, a row in another
 * tenant that row level security refused, and a row this reader's scope does
 * not reach. Telling them apart on screen would confirm that a guest exists to
 * somebody probing ids, which is the leak. The page renders `notFound()` for
 * all three, exactly as the booking detail page does.
 */
export async function loadGuest(
  args: LoadGuestArgs,
): Promise<GuestRecord | null> {
  const { db, actor, organizationId, guestId } = args
  const now = args.now ?? new Date()

  const { data, error } = await db
    .from('guests')
    .select(DETAIL_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('id', guestId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = toRow(data)
  const stayMap = await loadStays(db, actor, organizationId, [guestId])
  const stays = stayMap.get(guestId) ?? []

  if (!reachesGuest(actor, organizationId, stays)) return null

  const guest: GuestDetail = {
    id: asString(row, 'id'),
    fullName: asString(row, 'full_name'),
    phone: asStringOrNull(row, 'phone'),
    phoneAlt: asStringOrNull(row, 'phone_alt'),
    email: asStringOrNull(row, 'email'),
    language: asString(row, 'language'),
    nationality: asStringOrNull(row, 'nationality'),
    dateOfBirth: asStringOrNull(row, 'date_of_birth'),
    city: asStringOrNull(row, 'city'),
    addressLine1: asStringOrNull(row, 'address_line1'),
    postalCode: asStringOrNull(row, 'postal_code'),
    country: asStringOrNull(row, 'country'),
    tags: asStringArray(row, 'tags'),
    notes: asStringOrNull(row, 'notes'),
    marketingConsent: asBoolean(row, 'marketing_consent'),
    marketingConsentAt: asTimestampOrNull(row, 'marketing_consent_at'),
    isBlocked: asBoolean(row, 'is_blocked'),
    blockedReason: asStringOrNull(row, 'blocked_reason'),
    documentType: asStringOrNull(row, 'id_document_type'),
    documentNumber: asStringOrNull(row, 'id_document_number'),
    documentCountry: asStringOrNull(row, 'id_document_country'),
    createdAt: asTimestampOrNull(row, 'created_at'),
    version: asNumber(row, 'version'),
  }

  const value = staysValue(stays)

  return {
    guest: redact(actor, guest, DETAIL_REDACTIONS),
    stays,
    summary: summariseStays(stays, now),
    ...(value === undefined ? {} : { staysValueAgorot: value }),
  }
}

/* ---------------------------------------------------------- money paid --- */

/**
 * What this guest has actually paid, as opposed to what their stays were
 * worth.
 *
 * Two different facts, and a CRM that shows one of them labelled as the other
 * is a CRM somebody will chase a paid guest with. The stays' value is the sum
 * of `bookings.total_agorot`; this is the sum of `payments.captured_agorot`,
 * which is money that arrived.
 *
 * Behind `payment.view`, not `booking.view_price`: they are different grants
 * and the role set genuinely separates them — reception holds both, an
 * external agent holds neither, and the catalogue permits a role holding the
 * price and not the ledger. `null` means "this reader may not be told", which
 * is not the same as ₪0 and is not rendered as one.
 */
export async function guestPaymentTotals(
  db: Db,
  actor: Actor,
  organizationId: string,
  bookingIds: readonly string[],
): Promise<{ capturedAgorot: number; refundedAgorot: number } | null> {
  // Grant and plan first, without a resource — the question that can be
  // answered before a row exists.
  if (!holdsGrant(actor, 'payment.view')) return null
  if (bookingIds.length === 0) return { capturedAgorot: 0, refundedAgorot: 0 }

  const { data, error } = await db
    .from('payments')
    .select('property_id, captured_agorot, amount_refunded_agorot')
    .eq('organization_id', organizationId)
    .in('booking_id', [...bookingIds])

  if (error) throw error

  // Then scope, row by row, with the payment's own property — the same
  // narrowing `listPayments` applies, because row level security scopes this
  // to the organization and not to the property.
  const rows = toRows(data).filter((row) =>
    can(actor, 'payment.view', {
      organizationId,
      family: 'finance',
      propertyId: asString(row, 'property_id'),
    }),
  )

  let capturedAgorot = 0
  let refundedAgorot = 0
  for (const row of rows) {
    capturedAgorot += asAgorot(row, 'captured_agorot')
    refundedAgorot += asAgorot(row, 'amount_refunded_agorot')
  }

  return { capturedAgorot, refundedAgorot }
}
