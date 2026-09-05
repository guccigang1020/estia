/**
 * EXECUTION CONTEXT — SERVER ONLY. What a visitor with no account can reach.
 *
 * ── The whole public surface is four function calls ───────────────────────
 *
 * `anon` holds no privilege on any table in 0042. This file calls
 * `site_public_snapshot`, `site_public_availability_facts`,
 * `site_public_rate_facts` and `site_public_booking_request`, and there is no
 * fifth thing a public page can do.
 *
 * That is why "a visitor must never see an unpublished change" holds: this
 * module has no query against `site_pages` or `site_sections` to forget a
 * filter in. It reads a snapshot, and a snapshot exists only because somebody
 * with `site.publish` created it.
 *
 * ── The two things that are NOT in the snapshot ───────────────────────────
 *
 * Availability and price, both computed live, both through the canonical
 * engines and neither reimplemented here:
 *
 *   `publicAvailability` builds an `AvailabilitySource` over the facts
 *   function and hands it to `checkAvailability` / `availabilityCalendar` from
 *   `src/lib/booking/availability.ts`. Every occupancy decision, every
 *   minimum-nights floor and every hold-expiry test happens inside that
 *   engine. There is no overlap test in this file.
 *
 *   `publicQuote` reads the unit's rate columns and calls `priceStay` from
 *   `src/lib/booking/pricing.ts`. There is no multiplication in this file.
 *
 * The SQL cannot let a draft through either: both facts functions check the
 * requested unit against the PUBLISHED snapshot's `bookableUnitIds` before
 * they read anything. Adding a unit to a draft page does not make it
 * quotable.
 */

import {
  availabilityCalendar,
  checkAvailability,
  priceStay,
  type AvailabilityResult,
  type AvailabilitySource,
  type AvailabilityWindow,
  type DayAvailability,
  type Hold,
  type OccupyingBooking,
  type StayQuote,
  type UnitAvailabilityRules,
} from '../booking'
import { AppError, BusinessRuleError } from '../errors'
import type { Db } from '../persistence'
import type { SiteSnapshot } from './types'

/* ------------------------------------------------------------- refusals -- */

const REFUSALS: Readonly<
  Record<string, { userMessage: string; status: number }>
> = {
  site_not_found: {
    userMessage: 'לא מצאנו אתר בכתובת הזו.',
    status: 404,
  },
  site_not_published: {
    userMessage: 'האתר הזה עדיין אינו באוויר.',
    status: 404,
  },
  site_unit_not_bookable: {
    userMessage: 'היחידה הזו אינה מוצעת להזמנה באתר.',
    status: 404,
  },
  site_range_invalid: {
    userMessage: 'תאריך העזיבה חייב להיות מאוחר מתאריך ההגעה.',
    status: 422,
  },
  site_range_too_wide: {
    userMessage: 'טווח התאריכים רחב מדי.',
    status: 422,
  },
  site_request_invalid: {
    userMessage: 'הבקשה אינה תקינה. רעננו את הדף ונסו שוב.',
    status: 422,
  },
}

export const SITE_REFUSAL_CODES = Object.keys(REFUSALS)

export class SiteRefusedError extends BusinessRuleError {
  constructor(code: string, userMessage: string, status: number) {
    super({
      code,
      userMessage,
      status,
      message: `Public site refused: ${code}`,
    })
  }
}

type PostgrestErrorish = {
  message?: string | null
  hint?: string | null
  code?: string | null
}

/**
 * Turn a database refusal into one the page can render.
 *
 * An unrecognised refusal keeps the database's own Hebrew hint rather than
 * discarding it, and labels the code `site_refused_*` so the gap between the
 * two halves shows up instead of passing for a designed message — the same
 * treatment `src/lib/guest-portal/session.ts` gives its refusals.
 */
function refusalFrom(error: PostgrestErrorish): SiteRefusedError | null {
  const raised = (error.message ?? '').trim()
  const known = REFUSALS[raised]
  if (known)
    return new SiteRefusedError(raised, known.userMessage, known.status)

  const hint = (error.hint ?? '').trim()
  if (raised.length > 0 && hint.length > 0) {
    return new SiteRefusedError(`site_refused_${raised}`, hint, 422)
  }

  return null
}

function unreadable(what: string): AppError {
  return new AppError({
    code: 'site_unreadable',
    status: 502,
    message: `${what} returned an unreadable payload`,
    userMessage: 'לא הצלחנו לטעון את הדף. נסו לרענן.',
    retryable: true,
    dataOutcome: 'unknown',
  })
}

async function callPublic(
  db: Db,
  fn: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await db.rpc(fn, args)

  if (error) {
    const refusal = refusalFrom(error as PostgrestErrorish)
    if (refusal) throw refusal
    throw error
  }

  return data
}

/* -------------------------------------------------------- the snapshot -- */

export type PublicSite = {
  siteId: string
  slug: string
  versionId: string
  publishedAt: string | null
  snapshot: SiteSnapshot
}

/**
 * Resolve a host — a slug or a verified custom domain — to what is published.
 *
 * `db` is the anonymous client; that is the ordinary case, since the visitor
 * has no session. Throws `site_not_published` for a site whose draft exists
 * and has never been published, which is the case the route renders a 404 for.
 */
export async function publicSite(db: Db, host: string): Promise<PublicSite> {
  const trimmed = host.trim()
  if (trimmed.length === 0) {
    throw new SiteRefusedError(
      'site_not_found',
      REFUSALS.site_not_found.userMessage,
      404,
    )
  }

  const data = await callPublic(db, 'site_public_snapshot', { p_host: trimmed })

  if (typeof data !== 'object' || data === null) {
    throw unreadable('site_public_snapshot')
  }

  const row = data as Record<string, unknown>
  const snapshot = row.snapshot

  if (typeof snapshot !== 'object' || snapshot === null) {
    throw unreadable('site_public_snapshot')
  }

  return {
    siteId: String(row.siteId ?? ''),
    slug: String(row.slug ?? ''),
    versionId: String(row.versionId ?? ''),
    publishedAt: typeof row.publishedAt === 'string' ? row.publishedAt : null,
    snapshot: snapshot as SiteSnapshot,
  }
}

/* ----------------------------------------------------- the ONE engine -- */

/**
 * An `AvailabilitySource` over the public facts function.
 *
 * This is the entire integration. The interface is
 * `src/lib/booking/availability.ts`'s own, the engine that consumes it is that
 * file's own, and this class supplies rows. It performs no overlap test, no
 * expiry test and no minimum-nights arithmetic — the engine's documentation is
 * explicit that it does not trust its source to have filtered anything, and
 * this source deliberately earns that.
 *
 * One round trip serves all three `load*` calls, memoised per window, because
 * the SQL function returns bookings, holds and rules together and calling it
 * three times for one calendar would be three times the work for one answer.
 */
class PublicAvailabilitySource implements AvailabilitySource {
  /** Keyed by window, for the two calls that receive one. */
  private byWindow = new Map<string, Promise<PublicFacts>>()

  /**
   * Keyed by unit, for the one call that does not.
   *
   * `loadRules` is asked for a UNIT, not a window — the engine's interface says
   * so, because a unit's minimum stay is not a property of the dates being
   * asked about. The facts function returns the rules alongside the window's
   * bookings, so this second index records which unit each answer was for.
   *
   * The first version returned "the last thing cached", which happened to work
   * because every path primes one window before asking. It would have returned
   * the WRONG unit's minimum stay the day anything asked about two units in one
   * request — a public site with a unit grid checking availability across
   * rooms is exactly that day.
   */
  private byUnit = new Map<string, Promise<PublicFacts>>()

  constructor(
    private readonly db: Db,
    private readonly host: string,
  ) {}

  private facts(window: AvailabilityWindow): Promise<PublicFacts> {
    const key = `${window.unitId}:${window.range.checkIn}:${window.range.checkOut}`
    const existing = this.byWindow.get(key)
    if (existing) return existing

    const pending = readFacts(this.db, this.host, window)
    this.byWindow.set(key, pending)
    this.byUnit.set(window.unitId, pending)
    return pending
  }

  async loadBookings(
    window: AvailabilityWindow,
  ): Promise<readonly OccupyingBooking[]> {
    return (await this.facts(window)).bookings
  }

  async loadHolds(window: AvailabilityWindow): Promise<readonly Hold[]> {
    return (await this.facts(window)).holds
  }

  async loadRules(
    _organizationId: string,
    unitId: string,
  ): Promise<UnitAvailabilityRules | null> {
    // `organizationId` is deliberately unused: the SQL function derives the
    // tenant from the published site, and a public caller has no organization
    // to be trusted about. Accepting it and ignoring it is the interface's
    // shape; reading it would be reading an argument a stranger supplied.
    const pending = this.byUnit.get(unitId)

    // A cold call answers `null`, which the engine reads as "not configured
    // for sale" and denies by default. That is the engine's own documented
    // behaviour and the safe direction — inventing a permissive default here
    // would sell a unit nobody configured.
    if (!pending) return null

    return (await pending).rules
  }

  /** Warm the cache so `loadRules` has an answer regardless of call order. */
  async prime(window: AvailabilityWindow): Promise<void> {
    await this.facts(window)
  }
}

type PublicFacts = {
  rules: UnitAvailabilityRules | null
  bookings: readonly OccupyingBooking[]
  holds: readonly Hold[]
}

async function readFacts(
  db: Db,
  host: string,
  window: AvailabilityWindow,
): Promise<PublicFacts> {
  const data = await callPublic(db, 'site_public_availability_facts', {
    p_host: host,
    p_unit_id: window.unitId,
    p_from: window.range.checkIn,
    p_to: window.range.checkOut,
  })

  if (typeof data !== 'object' || data === null) {
    throw unreadable('site_public_availability_facts')
  }

  const row = data as Record<string, unknown>

  return {
    rules: readRules(row.rules),
    bookings: Array.isArray(row.bookings)
      ? (row.bookings as OccupyingBooking[])
      : [],
    holds: Array.isArray(row.holds) ? (row.holds as Hold[]) : [],
  }
}

/**
 * The unit's rules, including the ones stored in `metadata`.
 *
 * Read exactly the way `SupabaseBookingRepository.loadRules` reads them, from
 * the same columns, because two readings of one unit's minimum stay is two
 * answers to "may this be sold" — and the public site giving a different
 * answer from the internal calendar is the bug this whole arrangement exists
 * to prevent.
 */
function readRules(value: unknown): UnitAvailabilityRules | null {
  if (typeof value !== 'object' || value === null) return null

  const row = value as Record<string, unknown>
  const unitId = typeof row.unitId === 'string' ? row.unitId : ''
  if (unitId.length === 0) return null

  const rules: UnitAvailabilityRules = {
    unitId,
    minimumNights:
      typeof row.minimumNights === 'number' && row.minimumNights > 0
        ? row.minimumNights
        : 1,
  }

  const metadata =
    typeof row.metadata === 'object' && row.metadata !== null
      ? (row.metadata as Record<string, unknown>)
      : {}

  const byArrival = metadata.minimumNightsByArrival
  if (isRecordOfNumbers(byArrival)) rules.minimumNightsByArrival = byArrival

  const blocked = readDateList(metadata.blockedDates)
  if (blocked) rules.blockedDates = blocked
  const noArrival = readDateList(metadata.noArrivalDates)
  if (noArrival) rules.noArrivalDates = noArrival
  const noDeparture = readDateList(metadata.noDepartureDates)
  if (noDeparture) rules.noDepartureDates = noDeparture

  return rules
}

function isRecordOfNumbers(
  value: unknown,
): value is Readonly<Record<string, number>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  return Object.values(value as Record<string, unknown>).every(
    (entry) => typeof entry === 'number' && Number.isFinite(entry),
  )
}

function readDateList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const dates = value.filter(
    (entry): entry is string =>
      typeof entry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry),
  )
  return dates.length > 0 ? dates : undefined
}

/* ---------------------------------------------------- the public answers -- */

/**
 * Can a visitor have these dates?
 *
 * Every word of the answer comes from `checkAvailability`. The unit must be in
 * the published snapshot's `bookableUnitIds`, which the SQL enforces and this
 * function checks first so a draft unit produces the honest "not offered here"
 * rather than a database refusal the page has to translate.
 */
export async function publicAvailability(input: {
  db: Db
  host: string
  snapshot: SiteSnapshot
  organizationId: string
  unitId: string
  checkIn: string
  checkOut: string
  now: Date
}): Promise<AvailabilityResult> {
  assertBookable(input.snapshot, input.unitId)

  const source = new PublicAvailabilitySource(input.db, input.host)
  const window: AvailabilityWindow = {
    organizationId: input.organizationId,
    unitId: input.unitId,
    range: { checkIn: input.checkIn, checkOut: input.checkOut },
  }

  await source.prime(window)
  return checkAvailability(source, window, { now: input.now })
}

/** Free/busy for a window. What the public calendar draws. */
export async function publicCalendar(input: {
  db: Db
  host: string
  snapshot: SiteSnapshot
  organizationId: string
  unitId: string
  from: string
  to: string
  now: Date
}): Promise<readonly DayAvailability[]> {
  assertBookable(input.snapshot, input.unitId)

  const source = new PublicAvailabilitySource(input.db, input.host)
  const window: AvailabilityWindow = {
    organizationId: input.organizationId,
    unitId: input.unitId,
    range: { checkIn: input.from, checkOut: input.to },
  }

  await source.prime(window)
  return availabilityCalendar(source, window, { now: input.now })
}

export type PublicRateFacts = {
  unitId: string
  unitName: string
  propertyId: string | null
  baseNightlyAgorot: number
  extraGuestNightlyAgorot: number
  cleaningFeeAgorot: number
  depositAgorot: number
  standardGuests: number
  maxGuests: number
  minNights: number
  currency: string
  taxRateBps: number
  taxIncludedInPrice: boolean
}

export async function publicRateFacts(
  db: Db,
  host: string,
  snapshot: SiteSnapshot,
  unitId: string,
): Promise<PublicRateFacts> {
  assertBookable(snapshot, unitId)

  const data = await callPublic(db, 'site_public_rate_facts', {
    p_host: host,
    p_unit_id: unitId,
  })

  if (typeof data !== 'object' || data === null) {
    throw unreadable('site_public_rate_facts')
  }

  const row = data as Record<string, unknown>
  const count = (key: string, fallback = 0): number =>
    typeof row[key] === 'number' && Number.isFinite(row[key] as number)
      ? (row[key] as number)
      : fallback

  return {
    unitId: String(row.unitId ?? unitId),
    unitName: String(row.unitName ?? ''),
    propertyId: typeof row.propertyId === 'string' ? row.propertyId : null,
    baseNightlyAgorot: count('baseNightlyAgorot'),
    extraGuestNightlyAgorot: count('extraGuestNightlyAgorot'),
    cleaningFeeAgorot: count('cleaningFeeAgorot'),
    depositAgorot: count('depositAgorot'),
    standardGuests: count('standardGuests', 2),
    maxGuests: count('maxGuests', 2),
    minNights: count('minNights', 1),
    currency: typeof row.currency === 'string' ? row.currency : 'ILS',
    taxRateBps: count('taxRateBps'),
    taxIncludedInPrice: row.taxIncludedInPrice !== false,
  }
}

/**
 * What these dates cost, from the canonical pricing engine.
 *
 * Every line comes from `priceStay`. This function's whole job is to read the
 * unit's rate columns and translate `tax_rate_bps` into the percentage the
 * engine wants — no arithmetic beyond that division, and no number invented.
 *
 * `taxIncludedInPrice` is honoured by NOT passing a tax rate: an Israeli
 * guesthouse quoting VAT-inclusive prices should show one figure, and adding a
 * tax line to a rate that already contains it would overcharge by 17%.
 */
export async function publicQuote(input: {
  db: Db
  host: string
  snapshot: SiteSnapshot
  unitId: string
  checkIn: string
  checkOut: string
  guests: number
}): Promise<{ quote: StayQuote; facts: PublicRateFacts }> {
  const facts = await publicRateFacts(
    input.db,
    input.host,
    input.snapshot,
    input.unitId,
  )

  const quote = priceStay({
    range: { checkIn: input.checkIn, checkOut: input.checkOut },
    baseNightlyAgorot: facts.baseNightlyAgorot,
    guests: Math.max(1, input.guests),
    includedGuests: facts.standardGuests,
    extraGuestNightlyAgorot: facts.extraGuestNightlyAgorot,
    cleaningFeeAgorot: facts.cleaningFeeAgorot,
    // A deposit is refundable and is not part of what the stay costs. Shown
    // separately by the engine, which keeps it out of `stayTotalAgorot`.
    depositAgorot: facts.depositAgorot,
    ...(facts.taxIncludedInPrice || facts.taxRateBps === 0
      ? {}
      : { taxRatePercent: facts.taxRateBps / 100, taxLabel: 'מע״מ' }),
  })

  return { quote, facts }
}

/* ------------------------------------------------------------ the enquiry -- */

export type BookingRequestInput = {
  db: Db
  host: string
  unitId: string
  checkIn: string
  checkOut: string
  adults: number
  children: number
  infants: number
  contactName: string
  contactPhone: string
  contactEmail: string | null
  message: string | null
  quotedTotalAgorot: number | null
  /** Derived from the enquiry, not from the request. See below. */
  submissionKey: string
}

/**
 * Send an enquiry.
 *
 * NOT a booking. The SQL function writes one row to `site_booking_requests`
 * and touches neither `bookings` nor `holds` — a visitor with no account
 * cannot hold a night, and the exclusion constraint that prevents a double
 * booking is reached through the operation layer with an actor.
 *
 * `deduplicated` comes back true when this submission key already landed,
 * which is what a double-tap on a poor signal produces. The page shows the
 * same confirmation either way, because from the visitor's side both are
 * "we have your enquiry".
 */
export async function sendBookingRequest(
  input: BookingRequestInput,
): Promise<{ requestId: string; deduplicated: boolean }> {
  const data = await callPublic(input.db, 'site_public_booking_request', {
    p_host: input.host,
    p_unit_id: input.unitId,
    p_check_in: input.checkIn,
    p_check_out: input.checkOut,
    p_adults: input.adults,
    p_children: input.children,
    p_infants: input.infants,
    p_contact_name: input.contactName,
    p_contact_phone: input.contactPhone,
    p_contact_email: input.contactEmail,
    p_message: input.message,
    p_quoted_agorot: input.quotedTotalAgorot,
    p_submission_key: input.submissionKey,
  })

  if (typeof data !== 'object' || data === null) {
    throw unreadable('site_public_booking_request')
  }

  const row = data as Record<string, unknown>
  return {
    requestId: String(row.requestId ?? ''),
    deduplicated: row.deduplicated === true,
  }
}

/**
 * A submission key derived from the enquiry itself.
 *
 * Not a random value the browser generates: a random key changes on every
 * re-render, which makes it useless for the case it exists for. Derived from
 * the unit, the dates and the contact details, so two identical submissions
 * are one request and a genuinely different enquiry is a different one.
 *
 * The same reasoning as `src/lib/store/idempotency.ts`, which derives its key
 * from the purchase rather than from the request.
 */
export function submissionKeyFor(input: {
  unitId: string
  checkIn: string
  checkOut: string
  contactPhone: string
}): string {
  const material = [
    input.unitId,
    input.checkIn,
    input.checkOut,
    input.contactPhone.replace(/\D/g, ''),
  ].join('|')

  // A stable 64-character hex digest, computed without a crypto import so this
  // module stays usable in every runtime the app renders in. FNV-1a over four
  // offsets: not a security primitive and not used as one — collisions here
  // would merge two enquiries, which is why the material includes the
  // telephone number rather than only the dates.
  return [0x811c9dc5, 0x01000193, 0xdeadbeef, 0x7fffffff]
    .map((seed) => fnv1a(material, seed).toString(16).padStart(16, '0'))
    .join('')
}

function fnv1a(value: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * THE DRAFT GATE, ON THE BOOKING PATH, IN TYPESCRIPT AS WELL AS IN SQL.
 *
 * The SQL functions check this too and are the real floor — a caller reaching
 * them another way is still refused. This check exists so the page produces
 * "this unit is not offered here" rather than translating a database error,
 * and so `public.test.ts` can assert the rule without a database.
 */
function assertBookable(snapshot: SiteSnapshot, unitId: string): void {
  if (!snapshot.bookableUnitIds.includes(unitId)) {
    throw new SiteRefusedError(
      'site_unit_not_bookable',
      REFUSALS.site_unit_not_bookable.userMessage,
      404,
    )
  }
}
