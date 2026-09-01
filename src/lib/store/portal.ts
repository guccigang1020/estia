/**
 * EXECUTION CONTEXT — SERVER ONLY. The guest store, as a guest sees it.
 *
 * ── Whose session this is ─────────────────────────────────────────────────
 *
 * Not this module's. The capability token, its verification, its refusals and
 * the projection it resolves to all belong to `src/lib/guest-portal`, and the
 * portal's layout resolves it exactly once per request through React `cache`.
 * This module imports `GuestSession` and never reads `bookings.guest_token`
 * itself — two readings of one capability is how one section eventually shows
 * a guest somebody else's stay.
 *
 * ── The bridge, and why it is narrow ──────────────────────────────────────
 *
 * `bookingFactsFrom` turns that projection into `BookingFacts`, which is the
 * only thing the eligibility engine, the personalization ranker and the
 * provider renderer are ever handed. `BookingFacts` carries no name, no
 * telephone number, no agent and no payment detail — so the renderer that
 * builds a message to a DJ cannot leak one, because the type it was given
 * never had one. See `provider-request.ts`.
 *
 * ══ THE ONE OPEN PIECE, STATED PLAINLY ═════════════════════════════════════
 *
 * Reading the catalogue here goes through `StoreRepository`, which is ordinary
 * table reads under row level security. Every `select` policy in 0032 is
 * written as `organization_id in (select public.my_organizations())` plus
 * `has_permission(…, 'product.view')`, and A GUEST HOLDS NEITHER — they are
 * `anon` with a capability, exactly as `guest_portal_session` in 0033 assumes.
 *
 * So for a genuinely anonymous guest in production this returns an EMPTY
 * store. It fails closed: no error, no leak, no partial disclosure — and no
 * sale. Closing it needs one more `SECURITY DEFINER` function beside 0033's,
 * and its shape is in the report accompanying this work. It is not worked
 * around here, and there is no second code path pretending otherwise.
 *
 * What DOES work today, and is what the walkthrough exercises: the owner's
 * "preview as guest", and the demo, where the reader is a member of the
 * organization and the policies admit them.
 */

import {
  defaultServiceAt,
  evaluateEligibility,
  nullOccupancy,
} from './eligibility'
import type { EligibilityVerdict, OccupancyFacts } from './eligibility'
import type { GuestSession } from '../guest-portal'
import { asStringOrNull, toRow, type Db } from '../persistence'
import { sectionsFor, type StoreSection } from './personalization'
import { StoreRepository } from './repository'
import type {
  BookingFacts,
  CatalogueItem,
  StoreCategory,
  StoreItemPropertyOverride,
  StoreSettings,
} from './types'

/* ---------------------------------------------------------------- bridge -- */

/**
 * Statuses in which the stay counts as agreed.
 *
 * `after_confirmation` visibility opens on these. Getting the set wrong either
 * hides the store from a confirmed guest or opens it to somebody who has only
 * enquired, and the second is the one that produces an order against a stay
 * that was never sold.
 */
const CONFIRMED_STATUSES: readonly string[] = [
  'confirmed',
  'checked_in',
  'in_house',
  'checked_out',
  'completed',
]

/**
 * The guest-portal projection, narrowed to what the store may reason about.
 *
 * `propertyCapabilities` is passed in rather than read here, because the
 * amenity list is a property fact and the caller has already loaded the
 * property. An empty list is the safe answer: an item that
 * `requiresCapability` is then refused, and refusing to sell pool heating is
 * better than selling it at a house with no pool.
 *
 * `occasion` comes from the booking's own `eventType`, which the guest stated.
 * §10's rule is that personalization never invents, and this is the difference
 * between reading what somebody told you and guessing from a date.
 */
export function bookingFactsFrom(
  session: GuestSession,
  options: {
    propertyCapabilities?: readonly string[]
    /** Whether the stay itself has been paid. Drives `after_payment`. */
    isPaid?: boolean
  } = {},
): BookingFacts {
  return {
    id: session.bookingId,
    organizationId: session.organizationId,
    propertyId: session.propertyId ?? '',
    reference: session.reference,
    status: session.status,
    checkIn: session.checkIn,
    checkOut: session.checkOut,
    adults: session.adults,
    children: session.children,
    infants: session.infants,
    propertyCapabilities: options.propertyCapabilities ?? [],
    balanceAgorot: session.totalAgorot,
    isConfirmed: CONFIRMED_STATUSES.includes(session.status),
    isPaid: options.isPaid ?? false,
    // `accommodation` is the projection's own default for "nothing stated",
    // and treating it as an occasion would rank every ordinary stay against a
    // tag nobody chose.
    occasion:
      session.eventType && session.eventType !== 'accommodation'
        ? session.eventType
        : null,
  }
}

/**
 * What this house can do, for `requiresCapability`.
 *
 * The amenity ids a property carries are the only capability record the
 * product has today. An unreadable list answers empty, which refuses rather
 * than promises — see `bookingFactsFrom`.
 */
export async function propertyCapabilities(
  db: Db,
  propertyId: string,
): Promise<readonly string[]> {
  const { data, error } = await db
    .from('property_amenities')
    .select('*')
    .eq('property_id', propertyId)

  if (error || !Array.isArray(data)) return []

  return data
    .map((entry) => asStringOrNull(toRow(entry), 'amenity_id') ?? '')
    .filter((id) => id.length > 0)
}

/* ---------------------------------------------------------------- writing -- */

/**
 * THE PORT the coordinator's guest-portal work has to satisfy for a guest to
 * be able to SEND an order rather than only read the store.
 *
 * The production implementation is a `SECURITY DEFINER` database function,
 * for exactly the reason 0027 gives about `accept_invitation` and 0033 gives
 * about `guest_portal_session`: possession of a secret rather than a grant is
 * what authorizes the write, and that decision belongs in the schema beside
 * every other policy rather than in application code.
 *
 *     interface GuestOrderWriter {
 *       place(input: GuestOrderSubmission):
 *         Promise<{ id: string; reference: string }>
 *     }
 *
 * The payload carries snapshotted prices, and the function MUST re-verify each
 * one against the catalogue before writing — a guest posting their own price
 * is the obvious attack. That check is a lookup, not a second pricing engine:
 * the unit price must equal the item's `base_price_agorot` or its property
 * override, and each option delta must equal the stored one. How the parts
 * COMPOSE stays here, in `snapshot.ts`, where there is exactly one of it.
 */
export type GuestOrderSubmission = {
  session: GuestSession
  lines: readonly {
    itemId: string
    quantity: number
    optionValueIds: readonly string[]
    answers: Readonly<Record<string, string | number>>
  }[]
  requestedForDate: string | null
  guestNotes: string | null
  /** From `idempotency.ts`. Two taps produce the same string. */
  submissionKey: string
}

export interface GuestOrderWriter {
  place(
    input: GuestOrderSubmission,
  ): Promise<{ id: string; reference: string } | null>
}

/* ---------------------------------------------------------------- reading -- */

/** One card in the guest store, with everything the card needs to render. */
export type GuestStoreCard = {
  item: CatalogueItem
  verdict: EligibilityVerdict
  /** The price as it stands NOW, per unit. `null` for a quote product. */
  unitPriceAgorot: number | null
}

export type GuestStoreView = {
  settings: StoreSettings
  /** Sections, already ranked. Never contains an empty one. */
  sections: readonly StoreSection[]
  /** Every card, by item id, so the cart can look one up without re-querying. */
  cards: Readonly<Record<string, GuestStoreCard>>
  categories: readonly StoreCategory[]
  overrides: Readonly<Record<string, StoreItemPropertyOverride>>
  /** True when nothing at all could be offered. Drives the empty state. */
  catalogueIsEmpty: boolean
}

function emptyView(settings: StoreSettings): GuestStoreView {
  return {
    settings,
    sections: [],
    cards: {},
    categories: [],
    overrides: {},
    catalogueIsEmpty: true,
  }
}

/**
 * Refusals a guest is shown rather than spared.
 *
 * The test is whether the sentence gives them something to do. "נפתח 7 ימים
 * לפני ההגעה" does; "בנכס הזה אין בריכה" does not, and a card nobody can act
 * on is noise on a telephone screen.
 */
const SHOWN_DESPITE_REFUSAL: ReadonlySet<string> = new Set([
  'lead_time_not_met',
  'not_visible_yet',
  'capacity_full',
  'max_per_booking_reached',
  'outside_permitted_window',
  'blocked_by_rule',
])

/**
 * Everything the guest store needs, in one call.
 *
 * The ORDER of the three steps is the design:
 *
 *   1. read the catalogue the owner actually created,
 *   2. refuse what cannot be offered on THIS booking (`evaluateEligibility`),
 *   3. rank and section what survived (`sectionsFor`).
 *
 * Step 3 receives only what survived step 2, which is what makes §10 true by
 * construction rather than by discipline: personalization has nothing to
 * surface except products the owner created and this booking can actually
 * have.
 */
export async function guestStoreView(input: {
  db: Db
  booking: BookingFacts
  now: Date
  occupancy?: OccupancyFacts
  /** `guest` applies the visibility rules. `staff` sees the whole catalogue. */
  audience?: 'guest' | 'staff'
}): Promise<GuestStoreView> {
  const repository = new StoreRepository(input.db)
  const { booking } = input
  const audience = input.audience ?? 'guest'

  const settings = await repository.settings({
    organizationId: booking.organizationId,
    propertyId: booking.propertyId,
  })

  if (settings.mode === 'off') return emptyView(settings)
  if (audience === 'guest' && !settings.guestStoreEnabled) {
    return emptyView(settings)
  }

  const [items, categories, overrides, rules] = await Promise.all([
    repository.items({
      organizationId: booking.organizationId,
      activeOnly: true,
    }),
    repository.categories(booking.organizationId),
    booking.propertyId
      ? repository.propertyOverrides({
          organizationId: booking.organizationId,
          propertyId: booking.propertyId,
        })
      : Promise.resolve({} as Record<string, StoreItemPropertyOverride>),
    repository.availabilityRules(booking.organizationId),
  ])

  if (items.length === 0) return emptyView(settings)

  const occupancy =
    input.occupancy ??
    (await nullOccupancy({
      organizationId: booking.organizationId,
      propertyId: booking.propertyId,
      bookingId: booking.id,
      from: input.now,
      to: input.now,
    }))

  const [usage, bookingUsage] = await Promise.all([
    repository.usageByItem({
      organizationId: booking.organizationId,
      propertyId: booking.propertyId || null,
      date: booking.checkIn,
    }),
    bookingUsageFor(repository, booking),
  ])

  const cards: Record<string, GuestStoreCard> = {}
  const offered: CatalogueItem[] = []

  for (const item of items) {
    const override = overrides[item.id] ?? null

    const verdict = evaluateEligibility({
      item,
      settings,
      booking,
      override,
      rules: rules.filter(
        (rule) =>
          rule.propertyId === null || rule.propertyId === booking.propertyId,
      ),
      occupancy,
      usage: {
        onDate: usage[item.id] ?? 0,
        onBooking: bookingUsage[item.id] ?? 0,
      },
      serviceAt: defaultServiceAt(item, booking, input.now),
      now: input.now,
      audience,
    })

    const price =
      item.pricingModel === 'quote'
        ? null
        : (override?.priceOverrideAgorot ?? item.basePriceAgorot ?? null)

    cards[item.id] = { item, verdict, unitPriceAgorot: price }

    if (verdict.eligible || SHOWN_DESPITE_REFUSAL.has(verdict.reason ?? '')) {
      offered.push(item)
    }
  }

  return {
    settings,
    sections: sectionsFor({
      items: offered,
      categories,
      booking,
      now: input.now,
    }),
    cards,
    categories,
    overrides,
    catalogueIsEmpty: offered.length === 0,
  }
}

/** How many of each item this booking has already bought. */
async function bookingUsageFor(
  repository: StoreRepository,
  booking: BookingFacts,
): Promise<Record<string, number>> {
  const orders = await repository.orders({
    organizationId: booking.organizationId,
    bookingId: booking.id,
    limit: 50,
  })

  const usage: Record<string, number> = {}
  for (const order of orders) {
    if (order.status === 'cancelled' || order.status === 'refunded') continue
    for (const line of order.lines) {
      if (!line.itemId) continue
      usage[line.itemId] = (usage[line.itemId] ?? 0) + line.quantity
    }
  }
  return usage
}
