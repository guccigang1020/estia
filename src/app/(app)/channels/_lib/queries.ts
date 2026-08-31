/**
 * EXECUTION CONTEXT — SERVER ONLY. The read behind the channels screen.
 *
 * ══ THERE IS NO CHANNEL INTEGRATION, AND THIS FILE PROVES IT RATHER THAN ══
 * ══ ASSERTING IT ═════════════════════════════════════════════════════════
 *
 * No `channels` table, no `channel_connections`, no sync log, no mapping
 * between a unit and an Airbnb listing. `channel.manage` exists in the
 * permission catalogue and `channels` is a real entitlement Pro carries, and
 * behind them is nothing at all.
 *
 * The screen could simply say so from a constant. It does not, and the
 * difference matters: a hard-coded "not connected" is a claim that goes stale
 * the day somebody wires an integration up, and it would keep saying "not
 * connected" over a live one. So the answer is **derived from the data the
 * product would have if a channel existed** — bookings whose `source` says they
 * came from an OTA, and the `source_channel` string beside them.
 *
 * That read has a second use, and it is the honest half of this screen. A
 * business that types its Booking.com arrivals in by hand *does* have channel
 * bookings, and they are worth showing: how many, from where, and what they are
 * worth. What it does not have is synchronisation — and the distinction between
 * "we know about these bookings" and "these calendars are kept in step" is
 * exactly the one a double booking is made of.
 *
 * ── What would have to exist ──────────────────────────────────────────────
 *
 * Written down here rather than as a roadmap note, because the next person to
 * open this file should not have to rediscover it: a connection record per
 * channel per property, a listing mapping per unit, a sync cursor, and an
 * idempotency key per inbound reservation — `ARCHITECTURE.md` already requires
 * the last of those for channel sync specifically. None of the four exists.
 */

import { can, holdsGrant, type Actor, type Resource } from '@/lib/authz/can'
import { BOOKING_SOURCES, type BookingSource } from '@/lib/booking'
import { sumAgorot } from '@/lib/finance'
import {
  asAgorot,
  asEnum,
  asString,
  asStringOrNull,
  toRows,
  type Db,
} from '@/lib/persistence'

/* ---------------------------------------------------------------- shared -- */

/**
 * The booking sources that mean "an online travel agent sold this".
 *
 * `BOOKING_SOURCES` in `booking/types.ts` is a frozen contract and is consumed
 * here, never redefined: `satisfies readonly BookingSource[]` is what makes a
 * value this file cannot spell fail the typecheck rather than reach a query the
 * database's own enum would reject. The tuple carries no "is an OTA" marker, so
 * the *membership* is declared here — and the test beside this file asserts it
 * against the contract, because a source added there without being classified
 * here would be silently counted as direct, understating exactly the channel
 * cost a business is trying to measure.
 *
 * `other_channel` covers Expedia and every OTA the contract does not name
 * individually. Naming a fifth one is a migration on the `booking_source` enum
 * plus a label plus every exhaustive switch that reads it — a contract change,
 * not a screen's decision.
 */
export const OTA_SOURCES = [
  'airbnb',
  'booking_com',
  'vrbo',
  'other_channel',
] as const satisfies readonly BookingSource[]

export type OtaSource = (typeof OTA_SOURCES)[number]

function channelResource(organizationId: string, propertyId: string): Resource {
  return { organizationId, propertyId, family: 'booking' }
}

/* ------------------------------------------------------------ the answer -- */

/**
 * One channel, as far as the product can honestly describe it.
 *
 * `connected` is deliberately absent as a field. There is nothing in the
 * database that could set it, and a boolean nobody can compute is a boolean
 * that eventually gets set to `true` by a component with a comment saying
 * "temporary". What is here instead is what can be counted.
 */
export type ChannelActivity = {
  source: OtaSource
  bookingCount: number
  /** The free-text `source_channel` values seen, deduplicated. */
  labels: readonly string[]
  /** `null` without `booking.view_price`, and never zero. */
  revenueAgorot: number | null
}

export type ChannelPicture = {
  channels: readonly ChannelActivity[]
  /** Bookings from every source, so the OTA share is a real proportion. */
  totalBookings: number
  otaBookings: number
  /**
   * `null` when this reader may not read bookings at all — which is a different
   * sentence from "there are no channel bookings" and is rendered as such.
   */
  readable: boolean
}

const BOOKING_COLUMNS =
  'id, property_id, source, source_channel, total_agorot, status'

/**
 * What each channel has actually produced, and whether anything is synchronised.
 *
 * One read over `bookings`, classified in memory. Not four counted queries: the
 * proportion is the point — "eleven of our forty bookings came from an OTA" is
 * the sentence a business acts on — and four `head` counts cannot produce it
 * without a fifth query for the denominator.
 */
export async function channelPicture(args: {
  db: Db
  actor: Actor
  organizationId: string
  propertyId: string | null
  limit?: number
}): Promise<ChannelPicture> {
  const { db, actor, organizationId, propertyId } = args

  if (!holdsGrant(actor, 'booking.view')) {
    return { channels: [], totalBookings: 0, otaBookings: 0, readable: false }
  }

  let query = db
    .from('bookings')
    .select(BOOKING_COLUMNS)
    .eq('organization_id', organizationId)

  if (propertyId !== null) query = query.eq('property_id', propertyId)

  const { data, error } = await query.limit(args.limit ?? 500)
  if (error) throw error

  const rows = toRows(data).filter((row) =>
    can(
      actor,
      'booking.view',
      channelResource(organizationId, asString(row, 'property_id')),
    ),
  )

  const maySeePrice = holdsGrant(actor, 'booking.view_price')

  const buckets = new Map<
    OtaSource,
    { count: number; labels: Set<string>; amounts: number[] }
  >()

  for (const row of rows) {
    const source = asEnum(row, 'source', BOOKING_SOURCES)
    if (!isOta(source)) continue

    const bucket = buckets.get(source) ?? {
      count: 0,
      labels: new Set<string>(),
      amounts: [],
    }
    bucket.count += 1

    const label = asStringOrNull(row, 'source_channel')
    if (label !== null && label.trim().length > 0) bucket.labels.add(label)

    if (maySeePrice) bucket.amounts.push(asAgorot(row, 'total_agorot'))
    buckets.set(source, bucket)
  }

  const channels = OTA_SOURCES.map((source) => {
    const bucket = buckets.get(source)
    return {
      source,
      bookingCount: bucket?.count ?? 0,
      labels: bucket ? [...bucket.labels].sort() : [],
      revenueAgorot: maySeePrice ? sumAgorot(bucket?.amounts ?? []) : null,
    }
  })

  return {
    channels,
    totalBookings: rows.length,
    otaBookings: channels.reduce(
      (sum, channel) => sum + channel.bookingCount,
      0,
    ),
    readable: true,
  }
}

function isOta(source: BookingSource): source is OtaSource {
  return (OTA_SOURCES as readonly string[]).includes(source)
}

/**
 * Is anything actually connected?
 *
 * The answer is `false`, and it is a function rather than a constant so that the
 * day a connection record exists this is where the query goes — one place, named
 * for the question, with the screen already reading it. A `const CONNECTED =
 * false` inlined in a component is a value nobody ever finds again.
 *
 * It takes the picture so that "we receive bookings from Booking.com" cannot be
 * mistaken for "Booking.com is connected". Those bookings were typed in by a
 * person; nothing is kept in step, and the whole risk of an unconnected channel
 * is that the calendars drift and the same night is sold twice.
 */
export type ConnectionState = {
  /** No connection record exists, because no table could hold one. */
  anyConnected: false
  /** True when bookings from an OTA exist despite nothing being connected. */
  manualChannelBookings: boolean
  /**
   * What would have to exist for this to become answerable. Rendered on the
   * screen so an owner reading it knows what they are waiting for.
   */
  missing: readonly string[]
}

export function connectionState(picture: ChannelPicture): ConnectionState {
  return {
    anyConnected: false,
    manualChannelBookings: picture.otaBookings > 0,
    missing: MISSING_PIECES,
  }
}

/**
 * The four records a channel integration needs, none of which exists.
 *
 * Listed rather than summarised, because "not built yet" is a sentence that
 * makes a business wait and this is a sentence they can plan against.
 */
const MISSING_PIECES: readonly string[] = [
  'חיבור לערוץ עבור כל נכס — מי מחובר, למי, ומתי אושר',
  'מיפוי בין יחידה במערכת לבין מודעה בערוץ',
  'סמן סנכרון, כדי לדעת עד איזה רגע שני הצדדים מסונכרנים',
  'מפתח ייחודי לכל הזמנה נכנסת, כדי ששליחה חוזרת לא תיצור הזמנה כפולה',
]
